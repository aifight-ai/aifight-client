// D2 — the Electron main process owns one BridgeRunner: the SAME engine the
// `aifight` CLI runs. It reads the SAME shared config (bridge.json under the
// unified AIFight home) through the runtime's own helpers, so the desktop app
// and the CLI never disagree on where credentials and settings live.
//
// This host only OWNS and OBSERVES the engine. It exposes start/stop plus the
// three live streams — runner logs, decision traces, and raw server messages —
// as plain callbacks. D3 forwards those callbacks over IPC to the renderer; the
// renderer (D4–D6) turns server messages into the live/replay visualization and
// decision traces into the reasoning cockpit. No secrets cross these callbacks.
//
// Lazy engine loading (important): the bridge engine transitively imports
// better-sqlite3 (V8-ABI native, needs electron-rebuild) and `ws` at module
// top-level, so the engine is pulled in only via a dynamic import() inside
// start() — never at module load. The static surface here is readBridgeConfig
// (config.ts → store/paths → node builtins, plus — since F10 — the runtime's
// account/credentials, whose @napi-rs/keyring is an N-API prebuilt that loads
// under Electron without a rebuild). Reading the shared config on launch still
// never opens a connection; it touches the OS keychain only to decrypt the
// stored credentials.

import {
  dropClaimCredentialsAfterClaim,
  readBridgeConfig,
  writeBridgeConfig,
  type BridgeConfig,
} from "@aifight/aifight/bridge/config";
import type { BridgeRunner as BridgeRunnerInstance } from "@aifight/aifight/bridge/runner";
import type { BridgeDecisionTrace } from "@aifight/aifight/bridge/provider";
import type { ServerMessageEnvelope } from "@aifight/aifight/wsclient/frame-handler";
import type { AgentInstanceSnapshot } from "@aifight/aifight/agents/agent";
import type {
  AgentPolicy,
  AgentProfileData,
  BridgeConfigSummary,
  BridgeHostPhase,
  BridgeLogEvent,
  BridgeStatus,
  ConnectionHealth,
  EventsData,
  HexagonData,
  LeaderboardData,
  LeaderboardScope,
} from "../shared/ipc";
import { normalizeLeaderboard } from "./leaderboard";
import { normalizeEvents } from "./events";
import { normalizeAgentProfile } from "./agentProfile";
import {
  FALLBACK_LIVE_GAMES,
  parseGamesResponse,
  parseWelcomeGames,
} from "../shared/games";

/**
 * The games the bundled runtime's TYPED surface accepts (runner.joinQueue and
 * friends pin this union). The live allow-list itself follows the backend (see
 * shared/games.ts + the #liveGames cache below); this union only marks the
 * desktop→runtime boundary cast and widens when the runtime's signatures do.
 */
export type Game = "texas_holdem" | "liars_dice" | "coup";

export interface BridgeHostCallbacks {
  readonly onStatus?: (status: BridgeStatus) => void;
  readonly onLog?: (event: BridgeLogEvent) => void;
  readonly onTrace?: (trace: BridgeDecisionTrace) => void;
  readonly onServerMessage?: (message: ServerMessageEnvelope) => void;
}

/** Shown when the runtime's reconnect loop permanently stops (a terminal
 *  condition only — transient network/auth blips retry forever; see
 *  reconnect.ts isRetriableError). Supplements the banner's localized error
 *  label + 重连 button (App.tsx BridgeErrorBanner). */
const RECONNECT_GAVE_UP_MESSAGE =
  "Connection stopped and could not reconnect automatically. Retry below; if it keeps failing, re-pair this agent from the Dashboard.";

export class BridgeHost {
  readonly #callbacks: BridgeHostCallbacks;
  #runner: BridgeRunnerInstance | null = null;
  #status: BridgeStatus = { phase: "idle" };
  // Connection-health (D11.1): proof the outbound long-lived WebSocket is alive.
  // Derived entirely from this host's own callback wrappers — no runtime/CLI change.
  #connectedAt: number | null = null;
  #reconnects = 0;
  #lastActivityAt: number | null = null;
  // Live-game allow-list — the BACKEND is the single source (shared/games.ts).
  // Filled from every welcome frame (data.games = engine.LiveNames()) and lazily
  // from GET /api/games; null until either has answered. Real data only — the
  // local fallback is never cached, so a later answer always wins.
  #liveGames: readonly string[] | null = null;
  #liveGamesFetch: Promise<readonly string[]> | null = null;

  constructor(callbacks: BridgeHostCallbacks = {}) {
    this.#callbacks = callbacks;
  }

  getStatus(): BridgeStatus {
    return this.#status;
  }

  /** Live connection-health snapshot for the diagnostics panel. In-memory; no disk/network. */
  getConnectionHealth(): ConnectionHealth {
    return {
      phase: this.#status.phase,
      connectedAt: this.#connectedAt,
      reconnects: this.#reconnects,
      lastActivityAt: this.#lastActivityAt,
    };
  }

  #noteActivity(): void {
    this.#lastActivityAt = Date.now();
  }

  /**
   * The URL to open for claiming this agent — the claim link from registration if
   * present, else the platform site. Used by main to shell.openExternal; it embeds
   * a claim token, so it is NEVER returned to the renderer or put in the summary.
   *
   * F41/AIF-11: the value comes from local config, which a local attacker or a
   * copied profile could tamper with — never hand shell.openExternal anything
   * but http(s) on the host we are actually paired with.
   */
  getClaimTarget(): string | null {
    try {
      const config = readBridgeConfig();
      const raw = config.claimUrl ?? config.baseUrl ?? null;
      if (raw === null) return null;
      return safeExternalClaimUrl(raw, config.baseUrl ?? null);
    } catch {
      return null;
    }
  }

  /**
   * The public Terms / Privacy page URL on the paired host, for the in-app consent
   * card's "view the full document" links. Like getClaimTarget, the URL is built
   * from local config and validated to http(s) on the configured host before it
   * can reach shell.openExternal (F41/AIF-11). `kind` is a fixed enum — never a
   * renderer-supplied path — so no arbitrary path can be opened.
   */
  legalDocUrl(kind: "terms" | "privacy"): string | null {
    try {
      const config = readBridgeConfig();
      const base = config.baseUrl?.replace(/\/+$/, "") ?? null;
      if (base === null) return null;
      return safeExternalClaimUrl(`${base}/${kind}`, config.baseUrl ?? null);
    } catch {
      return null;
    }
  }

  /**
   * Desktop → Dashboard passwordless SSO (design: DASHBOARD_SSO_DESIGN.md). Mint a
   * one-time console-handoff token with the agent key, then hand main the returned
   * URL to open in the SYSTEM browser so the user lands on the Dashboard already
   * logged in. The URL embeds a single-use credential, so — exactly like the claim
   * link — it is returned ONLY to main (which opens it) and NEVER to the renderer.
   * `fallback` is the bare dashboard (login page) for when the agent isn't claimed
   * or the handoff fails, so the button always does something sensible.
   *
   * F41/AIF-11: the minted URL is validated against the configured host before it
   * can reach shell.openExternal — a tampered/misconfigured server cannot redirect
   * the OS shell to an arbitrary origin.
   */
  async getDashboardTarget(): Promise<{ url: string | null; fallback: string | null; error?: string }> {
    let config: BridgeConfig;
    try {
      config = readBridgeConfig();
    } catch {
      return { url: null, fallback: null, error: "not configured" };
    }
    const base = config.baseUrl?.replace(/\/+$/, "");
    const fallback = base ? safeExternalClaimUrl(`${base}/dashboard`, config.baseUrl ?? null) : null;
    if (!base || !config.apiKey) return { url: null, fallback, error: "not configured" };

    // Audit-only device id (best-effort; lazily imported to keep this module's
    // load light — see the lazy-engine note at the top of the file).
    let deviceId = "";
    try {
      const mod = await import("@aifight/aifight/account/device-id");
      deviceId = mod.getDeviceId();
    } catch {
      // No device id available — the header is optional (server defaults to "").
    }

    try {
      const res = await fetch(`${base}/api/agents/me/console-token`, {
        method: "POST",
        headers: { "X-API-Key": config.apiKey, ...(deviceId ? { "X-Device-Id": deviceId } : {}) },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const minted = typeof j.url === "string" ? safeExternalClaimUrl(j.url, config.baseUrl ?? null) : null;
        if (minted !== null) return { url: minted, fallback };
      }
      return { url: null, fallback, error: `HTTP ${res.status}` };
    } catch (cause) {
      return { url: null, fallback, error: describeError(cause) };
    }
  }

  /**
   * The agent's CURRENT public identity + record from the platform, via the public
   * GET /api/agents/{id}/profile: the post-claim display name (reflects a Dashboard
   * rename) plus the win/loss/rating summary for the cockpit. name is null when the
   * agent isn't claimed yet (profile 404s) → callers fall back to the bootstrap
   * name; stats is null when there's no public record. No auth; never throws.
   */
  async getAgentProfile(): Promise<AgentProfileData> {
    let config: BridgeConfig;
    try {
      config = readBridgeConfig();
    } catch {
      return { name: null, stats: null };
    }
    const id = config.agentId;
    const base = config.baseUrl?.replace(/\/+$/, "");
    if (!id || !base) return { name: null, stats: null };
    try {
      const res = await fetch(`${base}/api/agents/${encodeURIComponent(id)}/profile`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return { name: null, stats: null }; // 404 while unclaimed
      return normalizeAgentProfile(await res.json());
    } catch {
      return { name: null, stats: null };
    }
  }

  /**
   * The OWN agent's FULL public profile JSON (no auth) for the rich home view:
   * ratings[], rating_history[], summary, ranking, achievements, recent_matches.
   * Returned verbatim for the renderer to cast to @aifight/api-types AgentProfile. Null while
   * unclaimed (404) or on error. Never throws.
   */
  async getOwnProfileRaw(): Promise<Record<string, unknown> | null> {
    let config: BridgeConfig;
    try {
      config = readBridgeConfig();
    } catch {
      return null;
    }
    const id = config.agentId;
    const base = config.baseUrl?.replace(/\/+$/, "");
    if (!id || !base) return null;
    try {
      const res = await fetch(`${base}/api/agents/${encodeURIComponent(id)}/profile`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /**
   * The OWN agent's ability-hexagon radar (render contract §6.0) via the agent
   * key: GET /api/agents/me/radar[/{game}] — self-view, community track, visible
   * regardless of claim state. Null on any error, non-OK status (an old server
   * 404s the route), or unconfigured bridge; the {"enabled":false} switch-off
   * answer is returned verbatim. Never throws — the card simply hides.
   */
  async getOwnRadar(game?: string): Promise<HexagonData | null> {
    const path = game
      ? `/api/agents/me/radar/${encodeURIComponent(game)}`
      : "/api/agents/me/radar";
    const ep = this.#meEndpoint(path);
    if (ep === null) return null;
    try {
      const res = await fetch(ep.url, {
        headers: { "X-API-Key": ep.apiKey },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as HexagonData;
      return typeof body?.enabled === "boolean" ? body : null;
    } catch {
      return null;
    }
  }

  /**
   * Public ranking board for a scope ("all" = cross-game aggregate, else a single
   * game). No auth — the leaderboard is public. Returns null on any error so the
   * renderer can show an empty/retry state. Never throws.
   */
  async getLeaderboard(scope: LeaderboardScope): Promise<LeaderboardData | null> {
    let config: BridgeConfig;
    try {
      config = readBridgeConfig();
    } catch {
      return null;
    }
    const base = config.baseUrl?.replace(/\/+$/, "");
    if (!base) return null;
    // Request up to the top 100 (the server clamps; older servers ignore the param
    // and return their default 50 — graceful degradation).
    const path = (scope === "all" ? "/api/leaderboard" : `/api/leaderboard/${encodeURIComponent(scope)}`) + "?limit=100";
    try {
      const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const json = await res.json();
      return { scope, rows: normalizeLeaderboard(scope, json) };
    } catch {
      return null;
    }
  }

  /**
   * The platform's CURRENT live games, in canonical order. Served from the
   * in-memory cache (welcome frame / earlier fetch), else fetched once from the
   * public GET /api/games; FALLBACK_LIVE_GAMES only while the platform is
   * unreachable (never cached, so a later real answer replaces it). Never throws.
   */
  async getLiveGames(): Promise<readonly string[]> {
    if (this.#liveGames !== null) return this.#liveGames;
    // Single-flight: concurrent callers (several views mounting at once) share
    // one fetch; a failed fetch clears the slot so the next call retries.
    this.#liveGamesFetch ??= this.#fetchLiveGames().finally(() => {
      this.#liveGamesFetch = null;
    });
    return this.#liveGamesFetch;
  }

  async #fetchLiveGames(): Promise<readonly string[]> {
    let config: BridgeConfig;
    try {
      config = readBridgeConfig();
    } catch {
      return FALLBACK_LIVE_GAMES;
    }
    const base = config.baseUrl?.replace(/\/+$/, "");
    if (!base) return FALLBACK_LIVE_GAMES;
    try {
      const res = await fetch(`${base}/api/games`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return FALLBACK_LIVE_GAMES;
      const games = parseGamesResponse(await res.json());
      if (games === null) return FALLBACK_LIVE_GAMES;
      this.#liveGames = games;
      return games;
    } catch {
      return FALLBACK_LIVE_GAMES;
    }
  }

  /** Last-known live games without I/O (welcome/fetch cache, else the local fallback). */
  liveGamesSync(): readonly string[] {
    return this.#liveGames ?? FALLBACK_LIVE_GAMES;
  }

  /**
   * Public list of events (赛事). No auth. Returns null on any error so the
   * renderer can show an empty/retry state. Registration itself is deep-linked to
   * the web (owner-JWT action), not performed here. Never throws.
   */
  async getEvents(): Promise<EventsData | null> {
    let config: BridgeConfig;
    try {
      config = readBridgeConfig();
    } catch {
      return null;
    }
    const base = config.baseUrl?.replace(/\/+$/, "");
    if (!base) return null;
    try {
      const res = await fetch(`${base}/api/events`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const json = await res.json();
      return { events: normalizeEvents(json) };
    } catch {
      return null;
    }
  }

  /**
   * Read the shared bridge.json without opening any connection or loading the
   * engine. Safe to call on launch: surfaces "unconfigured" cleanly when the
   * user has not registered yet. Never throws; never returns secrets.
   */
  readConfigSummary(): BridgeStatus {
    try {
      const config = readBridgeConfig();
      const phase: BridgeHostPhase = this.#runner === null ? "idle" : this.#status.phase;
      this.#setStatus({ phase, config: toSummary(config), message: undefined });
    } catch (cause) {
      this.#setStatus({ phase: "unconfigured", config: undefined, message: describeError(cause) });
    }
    return this.#status;
  }

  /**
   * Start the bridge against the shared config. Lazily loads the engine on first
   * call. Returns the resulting status instead of throwing; failures surface as
   * phase "error" / "unconfigured" so the UI can render them.
   */
  async start(): Promise<BridgeStatus> {
    if (this.#runner !== null) return this.#status;

    let config: BridgeConfig;
    try {
      config = readBridgeConfig();
    } catch (cause) {
      this.#setStatus({ phase: "unconfigured", config: undefined, message: describeError(cause) });
      return this.#status;
    }

    const summary = toSummary(config);
    // Fresh session: reset connection-health counters.
    this.#connectedAt = null;
    this.#reconnects = 0;
    this.#lastActivityAt = null;
    this.#setStatus({ phase: "starting", config: summary, message: undefined });

    // Lazy: pulls the engine (and its native deps) only now, never at app load.
    const { BridgeRunner } = await import("@aifight/aifight/bridge/runner");
    const runner = new BridgeRunner({
      config,
      onLog: (event) => {
        this.#noteActivity();
        // The FSM surfaces every reconnect attempt as this log code
        // (state-machine.ts reconnectEvent → notify "reconnect.attempt_start").
        // Reflect a post-connect drop in the host phase so the renderer's status
        // pill stops showing a stale "online" while we're actually reconnecting —
        // it flips back to running on the next welcome frame below.
        if (event.code === "reconnect.attempt_start") {
          this.#reconnects += 1;
          if (this.#status.phase === "running") {
            this.#connectedAt = null;
            this.#setStatus({ phase: "starting", config: this.#status.config, message: undefined });
          }
        } else if (event.code === "reconnect.give_up" || event.code === "reconnect.closed") {
          // The reconnect loop has permanently stopped. With the 2026-06-28
          // runtime change this only fires on a TRULY terminal condition (a
          // protocol-version mismatch needing a client update, a 403 device
          // takeover, or an aborted/closed transport) — transient network/auth
          // (401/404) blips retry forever and never reach here. Surface it as an
          // error with the 重连 button instead of leaving the host frozen on
          // "starting"/"连接中", and RELEASE the runner so 重连 (→ start()) truly
          // restarts rather than no-opping on a non-null runner.
          const runner = this.#runner;
          this.#runner = null;
          this.#connectedAt = null;
          if (runner !== null) void runner.stop().catch(() => {});
          this.#setStatus({
            phase: "error",
            config: this.#status.config,
            message: RECONNECT_GAVE_UP_MESSAGE,
          });
        }
        this.#callbacks.onLog?.(event);
      },
      onTrace: (trace) => this.#callbacks.onTrace?.(trace),
      onServerMessage: (message) => {
        this.#noteActivity();
        // The welcome frame advertises the platform's CURRENT live games
        // (engine.LiveNames()) — refresh the allow-list on every (re)connect.
        if (message.type === "welcome") {
          const games = parseWelcomeGames(message.data);
          if (games !== null) this.#liveGames = games;
          // A welcome after a reconnect-induced "starting" means we're back
          // online — restore the running phase + fresh connectedAt so the pill,
          // the diagnostics card, and the connected-gated buttons all recover.
          if (this.#status.phase === "starting" && this.#runner !== null) {
            this.#connectedAt = Date.now();
            this.#setStatus({ phase: "running", config: this.#status.config, message: undefined });
          }
        }
        this.#callbacks.onServerMessage?.(message);
      },
    });
    this.#runner = runner;

    try {
      await runner.start();
      this.#connectedAt = Date.now();
      this.#noteActivity();
      this.#setStatus({ phase: "running", config: summary, message: undefined });
    } catch (cause) {
      this.#runner = null;
      this.#connectedAt = null;
      await runner.stop().catch(() => {});
      this.#setStatus({ phase: "error", config: summary, message: describeError(cause) });
    }
    return this.#status;
  }

  async stop(): Promise<BridgeStatus> {
    const runner = this.#runner;
    if (runner === null) {
      this.#setStatus({ phase: this.#status.config !== undefined ? "stopped" : "idle" });
      return this.#status;
    }
    this.#runner = null;
    this.#connectedAt = null;
    try {
      await runner.stop();
    } catch (cause) {
      this.#callbacks.onLog?.({
        level: "warning",
        code: "desktop.bridge_stop_failed",
        message: describeError(cause),
      });
    }
    this.#setStatus({ phase: "stopped", message: undefined });
    return this.#status;
  }

  /** Live agent snapshot for the status panel (D8). Not part of the IPC status payload. */
  snapshot(): AgentInstanceSnapshot | null {
    return this.#runner?.snapshot() ?? null;
  }

  // joinQueue/requestManualMatches take the game as a plain string: the picker
  // lists whatever the backend says is live, and the SERVER validates live-ness.
  // The `as Game` casts mark the boundary into the runtime's narrower typed
  // surface (see the Game union note above).
  joinQueue(game: string, mode?: string, opts: { readonly oneShot?: boolean; readonly count?: number } = {}): void {
    this.#requireRunner().joinQueue(game as Game, mode, opts);
  }

  leaveQueue(): void {
    this.#requireRunner().leaveQueue();
  }

  /**
   * Enter automatic matchmaking: a single non-one-shot queue join. The server then
   * auto-requeues + matches us up to the daily cap at its own pace (the FIRST join
   * must come from us — internal/matchmaking/requeue.go). Gated on the SERVER's
   * current policy (the source of truth, reflecting Dashboard edits): only join
   * when the daily cap > 0. No-op when offline. Never throws.
   */
  async joinAutoMatch(): Promise<void> {
    if (this.#runner === null) return;
    const policy = await this.getAgentPolicy();
    if (policy !== null && policy.maxGamesPerDay <= 0) return; // auto-match disabled server-side
    try {
      this.#runner.joinQueue(pickAutoGame(this.#status.config?.autoGames, this.liveGamesSync()) as Game, "ranked");
    } catch (cause) {
      this.#callbacks.onLog?.({ level: "warning", code: "desktop.automatch_failed", message: describeError(cause) });
    }
  }

  /**
   * Pause/resume automatic matchmaking WITHOUT going offline. Pause = leave the
   * queue (the server stops auto-requeuing us); resume = re-enter the pool (gated
   * on the server cap). Manual matches + challenges are unaffected. Session-only —
   * every app launch starts un-paused.
   */
  async setMatchingPaused(paused: boolean): Promise<void> {
    if (this.#runner === null) return;
    if (paused) {
      try {
        this.#runner.leaveQueue();
      } catch (cause) {
        this.#callbacks.onLog?.({ level: "warning", code: "desktop.pause_failed", message: describeError(cause) });
      }
    } else {
      await this.joinAutoMatch();
    }
  }

  /**
   * Read the agent's CURRENT rate policy from the server (source of truth — reflects
   * Dashboard edits) via the agent-scoped GET /api/agents/me/status. Null on error.
   */
  async getAgentPolicy(): Promise<AgentPolicy | null> {
    const ep = this.#meEndpoint("/api/agents/me/status");
    if (ep === null) return null;
    try {
      const res = await fetch(ep.url, { headers: { "X-API-Key": ep.apiKey }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const j = (await res.json()) as Record<string, unknown>;
      // F10: the claim token/URL are single-use — once the platform reports
      // the agent claimed, scrub them from local storage (idempotent).
      if (j.is_claimed === true) dropClaimCredentialsAfterClaim();
      return {
        maxGamesPerDay: toInt(j.max_games_per_day),
        maxGamesPerHour: toInt(j.max_games_per_hour),
        cooldownSeconds: toInt(j.cooldown_seconds),
        isClaimed: j.is_claimed === true,
        termsPending: j.terms_pending === true,
        // undefined on older servers that don't yet return games_today.
        gamesToday: typeof j.games_today === "number" ? j.games_today : undefined,
        // Server-authoritative display name + numeric public ID (undefined on
        // older servers); the hero renders these so a rename on any device shows.
        name: typeof j.name === "string" ? j.name : undefined,
        publicNo: typeof j.public_no === "number" ? j.public_no : undefined,
        // Current legal versions so the in-app consent card can show WHICH docs
        // changed and echo them back when accepting. undefined on older servers.
        currentTermsVersion: typeof j.current_terms_version === "string" ? j.current_terms_version : undefined,
        currentPrivacyVersion: typeof j.current_privacy_version === "string" ? j.current_privacy_version : undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * Record the owner's acceptance of the CURRENT Terms/Privacy in-app — no browser
   * round-trip — via POST /api/agents/me/accept-legal with the agent key. The
   * server takes the owner from the authenticated agent (never the body) and
   * rejects anything but the current versions, so we re-read them fresh here and
   * echo exactly what the server serves. Returns a result, never throws.
   */
  async acceptLegal(): Promise<{ ok: boolean; error?: string }> {
    const policy = await this.getAgentPolicy();
    if (policy === null) return { ok: false, error: "not configured" };
    if (policy.currentTermsVersion === undefined || policy.currentPrivacyVersion === undefined) {
      return { ok: false, error: "server did not report current versions" };
    }
    const ep = this.#meEndpoint("/api/agents/me/accept-legal");
    if (ep === null) return { ok: false, error: "not configured" };
    try {
      const res = await fetch(ep.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": ep.apiKey },
        body: JSON.stringify({
          terms_version: policy.currentTermsVersion,
          privacy_version: policy.currentPrivacyVersion,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        return { ok: false, error: `HTTP ${res.status}${t ? ": " + t.slice(0, 200) : ""}` };
      }
      return { ok: true };
    } catch (cause) {
      return { ok: false, error: describeError(cause) };
    }
  }

  /**
   * Write the daily auto-match cap to the server (source of truth) via PATCH
   * /api/agents/me/policy; last-write-wins. auto_requeue is derived (cap>0 →
   * auto-match on; 0 → off). The desktop sets ONLY the daily cap — hourly cap is
   * gone and cooldown is a server default. Returns a result, never throws.
   */
  async setAgentPolicy(patch: { maxGamesPerDay: number }): Promise<{ ok: boolean; error?: string }> {
    const ep = this.#meEndpoint("/api/agents/me/policy");
    if (ep === null) return { ok: false, error: "not configured" };
    const body: Record<string, unknown> = {
      max_games_per_day: patch.maxGamesPerDay,
      auto_requeue: patch.maxGamesPerDay > 0,
    };
    try {
      const res = await fetch(ep.url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-API-Key": ep.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        return { ok: false, error: `HTTP ${res.status}${t ? ": " + t.slice(0, 200) : ""}` };
      }
      // Two-ledger sync (mirrors `aifight set daily <N>`): the server is the source
      // of truth for matchmaking, but the LOCAL bridge.json `autoDailyLimit` is what
      // `aifight status` + the desktop diagnostics card read back. The desktop used
      // to write that field ONLY at `aifight setup`, so it stayed pinned at the
      // default while the server cap moved — the two ledgers disagreed (home hero
      // showed 6, diagnostics still showed 2). Reconcile it here, but ONLY after the
      // server confirms, and best-effort so a local-write hiccup never undoes a cap
      // change the platform already accepted.
      this.#persistDailyLimitLocally(patch.maxGamesPerDay);
      return { ok: true };
    } catch (cause) {
      return { ok: false, error: describeError(cause) };
    }
  }

  /**
   * Persist the daily cap into the shared bridge.json (`autoDailyLimit`) so the CLI
   * `aifight status` view and the desktop diagnostics card reflect what the user set
   * here. Skips the write when already in sync (no keychain churn from re-encrypting
   * the config's secret fields), then re-reads + re-emits status so a mounted
   * diagnostics/status view updates without waiting for a remount or focus refetch.
   * Never throws: by the time we reach here the server write is already committed,
   * so a local failure is logged, not surfaced as a failed policy change.
   */
  #persistDailyLimitLocally(maxGamesPerDay: number): void {
    try {
      const config = readBridgeConfig();
      if (config.autoDailyLimit === maxGamesPerDay) return;
      writeBridgeConfig({ ...config, autoDailyLimit: maxGamesPerDay, updatedAt: new Date().toISOString() });
      this.readConfigSummary();
    } catch (cause) {
      this.#callbacks.onLog?.({
        level: "warning",
        code: "desktop.daily_limit_persist_failed",
        message: describeError(cause),
      });
    }
  }

  /**
   * Change the agent's free-form display name via PATCH /api/agents/me/name with
   * the same agent key (no owner login, no web bounce — owner ruling 2026-06-18).
   * The server validates, enforces the anti-impersonation cooldown, records an
   * audit row, and returns the reconciled name + numeric public ID. On the
   * cooldown (HTTP 429) it returns ok:false with the server message and
   * nextRenameAllowedAt so the renderer can explain when it lifts. Never throws.
   */
  async setAgentName(
    patch: { name: string },
  ): Promise<{ ok: boolean; error?: string; name?: string; publicNo?: number; nextRenameAllowedAt?: string }> {
    const ep = this.#meEndpoint("/api/agents/me/name");
    if (ep === null) return { ok: false, error: "not configured" };
    const name = typeof patch?.name === "string" ? patch.name.trim() : "";
    if (name === "") return { ok: false, error: "name is required" };
    try {
      const res = await fetch(ep.url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-API-Key": ep.apiKey, "X-AIFight-Client": "app" },
        body: JSON.stringify({ name }),
        signal: AbortSignal.timeout(8000),
      });
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const nextAllowed = typeof j.next_rename_allowed_at === "string" ? j.next_rename_allowed_at : undefined;
      if (!res.ok) {
        const err = typeof j.error === "string" ? j.error : `HTTP ${res.status}`;
        return { ok: false, error: err, nextRenameAllowedAt: nextAllowed };
      }
      return {
        ok: true,
        name: typeof j.name === "string" ? j.name : name,
        publicNo: typeof j.public_no === "number" ? j.public_no : undefined,
        nextRenameAllowedAt: nextAllowed,
      };
    } catch (cause) {
      return { ok: false, error: describeError(cause) };
    }
  }

  /**
   * Set the agent's avatar to a built-in preset (or clear it) via PUT
   * /api/agents/me/avatar. The desktop authenticates as the agent (bridge key),
   * so this is the agent-self avatar endpoint, not the owner-cookie one.
   */
  async setAgentAvatar(presetId: string | null): Promise<{ ok: boolean; error?: string }> {
    const ep = this.#meEndpoint("/api/agents/me/avatar");
    if (ep === null) return { ok: false, error: "not configured" };
    const body = presetId ? { kind: "preset", preset_id: presetId } : { kind: "none" };
    try {
      const res = await fetch(ep.url, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-API-Key": ep.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        return { ok: false, error: `HTTP ${res.status}${t ? ": " + t.slice(0, 200) : ""}` };
      }
      return { ok: true };
    } catch (cause) {
      return { ok: false, error: describeError(cause) };
    }
  }

  /** Clear the agent's avatar (preset or upload) via DELETE /api/agents/me/avatar. */
  async clearAgentAvatar(): Promise<{ ok: boolean; error?: string }> {
    const ep = this.#meEndpoint("/api/agents/me/avatar");
    if (ep === null) return { ok: false, error: "not configured" };
    try {
      const res = await fetch(ep.url, {
        method: "DELETE",
        headers: { "X-API-Key": ep.apiKey },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        return { ok: false, error: `HTTP ${res.status}${t ? ": " + t.slice(0, 200) : ""}` };
      }
      return { ok: true };
    } catch (cause) {
      return { ok: false, error: describeError(cause) };
    }
  }

  /**
   * Upload a custom avatar image (multipart) via POST /api/agents/me/avatar/upload.
   * The renderer reads the chosen file to an ArrayBuffer and passes it over IPC;
   * the server center-crops + resizes to the three buckets and returns the URL.
   */
  async uploadAgentAvatar(bytes: ArrayBuffer, contentType: string): Promise<{ ok: boolean; avatar_url?: string; error?: string }> {
    const ep = this.#meEndpoint("/api/agents/me/avatar/upload");
    if (ep === null) return { ok: false, error: "not configured" };
    try {
      const form = new FormData();
      form.append("avatar", new Blob([bytes], { type: contentType || "application/octet-stream" }), "avatar");
      const res = await fetch(ep.url, {
        method: "POST",
        headers: { "X-API-Key": ep.apiKey },
        body: form,
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        return { ok: false, error: `HTTP ${res.status}${t ? ": " + t.slice(0, 200) : ""}` };
      }
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { ok: true, avatar_url: typeof j.avatar_url === "string" ? j.avatar_url : undefined };
    } catch (cause) {
      return { ok: false, error: describeError(cause) };
    }
  }

  /** Build an authenticated me-endpoint {url, apiKey} from the shared config; null if unconfigured. */
  #meEndpoint(path: string): { url: string; apiKey: string } | null {
    let config: BridgeConfig;
    try {
      config = readBridgeConfig();
    } catch {
      return null;
    }
    const base = config.baseUrl?.replace(/\/+$/, "");
    if (!base || !config.apiKey) return null;
    return { url: `${base}${path}`, apiKey: config.apiKey };
  }

  requestManualMatches(game: string, mode?: string, count?: number): void {
    this.#requireRunner().requestManualMatches(game as Game, mode, count);
  }

  #requireRunner(): BridgeRunnerInstance {
    if (this.#runner === null) throw new Error("bridge is not running; start it first");
    return this.#runner;
  }

  #setStatus(patch: Partial<BridgeStatus> & Pick<BridgeStatus, "phase">): void {
    this.#status = { ...this.#status, ...patch };
    this.#callbacks.onStatus?.(this.#status);
  }
}

/** Pick only non-secret fields. Never include apiKey / runtimeLocalToken / claimToken. */
function toSummary(config: BridgeConfig): BridgeConfigSummary {
  return {
    agentId: config.agentId,
    agentName: config.agentName,
    baseUrl: config.baseUrl,
    runtimeType: config.runtimeType,
    ...(config.directAgentSlug !== undefined ? { directAgentSlug: config.directAgentSlug } : {}),
    ...(config.autoDailyLimit !== undefined ? { autoDailyLimit: config.autoDailyLimit } : {}),
    ...(config.autoGames !== undefined ? { autoGames: config.autoGames } : {}),
  };
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Pick which game to enter automatic matchmaking for: the agent's configured
 * autoGames filtered to the platform's CURRENT live list, else any live game,
 * chosen at random. The live list follows the backend (welcome frame /
 * /api/games via the host cache) — never a hardcoded copy. The server's
 * auto-requeue keeps re-joining this game after each match. Exported for tests.
 */
export function pickAutoGame(
  autoGames: readonly string[] | undefined,
  liveGames: readonly string[],
): string {
  const configured = (autoGames ?? []).filter((g) => liveGames.includes(g));
  const pool = configured.length > 0 ? configured : liveGames.length > 0 ? liveGames : FALLBACK_LIVE_GAMES;
  return pool[Math.floor(Math.random() * pool.length)]!;
}

function toInt(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0;
}

/** F41/AIF-11: allowlist for the claim URL handed to shell.openExternal.
 *  Local config is tamperable, so only http(s) ever reaches the OS shell —
 *  no file:/smb:/custom protocols — and when a baseUrl is configured the
 *  claim link must be on that same host. http is tolerated only for
 *  loopback dev setups. Exported for tests. */
export function safeExternalClaimUrl(raw: string, baseUrl: string | null): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return null;
  }
  if (baseUrl !== null && raw !== baseUrl) {
    try {
      if (new URL(baseUrl).hostname !== url.hostname) return null;
    } catch {
      return null;
    }
  }
  return url.toString();
}
