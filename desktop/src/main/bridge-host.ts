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
// under Electron without a rebuild), plus the runtime's daemon/runtime-files-write
// (node builtins only — see the single-instance guard below). Reading the shared
// config on launch still never opens a connection; it touches the OS keychain
// only to decrypt the stored credentials.

import {
  archiveReplacedBridgeConfig,
  dropClaimCredentialsAfterClaim,
  getBridgeConfigPath,
  readBridgeConfig,
  removeBridgeConfig,
  writeBridgeConfig,
  type BridgeConfig,
} from "@aifight/aifight/bridge/config";
import {
  acquireDaemonLock,
  RuntimeFilesWriteError,
  unlinkRuntimeFiles,
  writePid,
  type LockHandle,
} from "@aifight/aifight/daemon/runtime-files-write";
import { ensureRuntimeHome } from "@aifight/aifight/store/paths";
import fs from "node:fs";
import path from "node:path";
import type { BridgeRunner as BridgeRunnerInstance } from "@aifight/aifight/bridge/runner";
import type { BridgeDecisionTrace } from "@aifight/aifight/bridge/provider";
import type { ServerMessageEnvelope } from "@aifight/aifight/wsclient/frame-handler";
import type { AgentInstanceSnapshot } from "@aifight/aifight/agents/agent";
import type { ReconnectStateSnapshot } from "@aifight/aifight/wsclient/reconnect";
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
import { fetchReplayTail } from "./replay-tail";
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
/** How often the app re-checks a seat held by another bridge. Slow enough to be
 *  free (two syscalls), fast enough that `aifight service stop` feels instant. */
const SEAT_RETRY_INTERVAL_MS = 5_000;

/** Shown while parked: another connection holds the seat, we probe gently. */
const SEAT_TAKEN_MESSAGE =
  "Another connection is using this agent (another machine, or a CLI service beside the app). Standing by — the seat is re-checked every few minutes; Retry checks now.";
/** Parked because the evictor claimed OUR process identity — structurally
 *  impossible unless the single-flight invariant regressed or someone forged
 *  the instance id. Loud on purpose (审查 F7/F10). */
const SEAT_SUPERSEDED_SELF_MESSAGE =
  "Evicted by a connection claiming this app's own identity. Standing by and probing — if this repeats, please report it (possible client bug or identity forgery).";

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
  // Cross-process single-instance guard — see #acquireAgentSeat. Invariant:
  // #lock !== null  ⟺  this host owns the local agent seat (#runner !== null,
  // or a start() in flight). Released on stop, on a failed start, when the
  // reconnect loop gives up, and synchronously on app quit (main.ts).
  #lock: LockHandle | null = null;
  // ── P4 projection plumbing (重连重设计 2026-07-25): phase/uptime/counter
  // derive from facade state snapshots, never from narrating the log stream
  // (the narration model is what wedged the pill on「连接中」while online). ──
  #connUnsub: (() => void) | null = null;
  #lastConnSeq = -1;
  /** totalAttempts at subscription time — the display counter shows the DELTA,
   *  preserving the old "reconnects this session" semantics (审查 F10:
   *  facade.attempt resets on success and cannot feed this UI). */
  #attemptBase: number | null = null;
  #lastConnState: ReconnectStateSnapshot["state"] | null = null;
  /** True once the app entered automatic matchmaking this session; a recovered
   *  connection re-joins the pool (审查 F9: joinAutoMatch used to fire only on
   *  launch, so an agent that reconnected sat online but never played again). */
  #autoMatchWanted = false;
  // In-flight start(), so two callers cannot both get past the "#runner is null"
  // check and race into two runners on one seat (#runner is only assigned after
  // an await). The renderer can trigger start() from several places at once —
  // launch, the Retry button, the seat retry below.
  #starting: Promise<BridgeStatus> | null = null;
  /**
   * D6a (R12): stop() pressed while a start is in flight. During the
   * engine-import window #runner is still null, so stop() has nothing to abort
   * — the resuming #startOnce re-checks this flag at both of its resumption
   * points (post-import, post-start) and honours the stop itself, mirroring
   * agent.ts's post-connect #stopped re-check. Cleared at every #startOnce
   * entry so a consumed stop never leaks into the next start.
   */
  #stopDuringStart = false;
  // Set while we are refusing because another bridge holds the seat: re-checks
  // until it is free, so stopping the other one is enough to recover.
  #seatRetryTimer: ReturnType<typeof setTimeout> | null = null;

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
  /**
   * Complete PUBLIC frame list for a finished match (see replay-tail.ts for
   * why). `replayPath` comes from game_over's replay_url. The bridge's baseUrl
   * may be a ws(s):// endpoint — normalize to the http(s) origin the public
   * API lives on. Returns null on any failure; never throws.
   */
  async getReplayTail(replayPath: string): Promise<readonly import("../shared/ipc").ReplayTailFrame[] | null> {
    if (typeof replayPath !== "string" || replayPath === "") return null;
    let config: BridgeConfig;
    try {
      config = readBridgeConfig();
    } catch {
      return null;
    }
    const base = config.baseUrl?.replace(/\/+$/, "");
    if (!base) return null;
    let origin: string;
    try {
      const u = new URL(base);
      const proto = u.protocol === "ws:" ? "http:" : u.protocol === "wss:" ? "https:" : u.protocol;
      origin = `${proto}//${u.host}`;
    } catch {
      return null;
    }
    try {
      return await fetchReplayTail(origin, replayPath);
    } catch {
      return null;
    }
  }

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
      if (this.#status.phase === "error") {
        // NEVER downgrade an error to "idle". This is only a config read, but the
        // renderer calls it on EVERY view mount — and main.ts start()s the bridge
        // before the first mount, so a failure raised at launch (the agent seat is
        // taken, the engine failed to load) would be wiped before anyone saw it:
        // grey dot, no banner, no reason, no Retry button. Refresh the config
        // fields and keep the explanation.
        this.#setStatus({ ...this.#status, config: toSummary(config) });
        return this.#status;
      }
      // R12 (2026-07-26): don't downgrade an in-flight start to "idle" either.
      // #startOnce sets phase "starting" then awaits the engine import with
      // #runner still null; a view-mount getStatus landing in that window would
      // otherwise rewrite the live "starting" to "idle" (and re-broadcast it),
      // making the app look offline for the whole cold-import stretch. Same
      // "never silently wipe a live status" invariant as the error branch above.
      const phase: BridgeHostPhase =
        this.#runner !== null || this.#starting !== null ? this.#status.phase : "idle";
      this.#setStatus({ phase, config: toSummary(config), message: undefined });
    } catch (cause) {
      this.#setStatus({ phase: "unconfigured", config: undefined, message: describeError(cause) });
    }
    return this.#status;
  }

  /**
   * Claim the local agent seat before opening any connection.
   *
   * The desktop app and the `aifight` CLI service share ONE agent identity under
   * ~/.aifight. The server keeps a single connection per agent and evicts the
   * older one, so two local bridges do not coexist — they take turns kicking each
   * other off, forever (2026-07-24: ~160 connect/evict cycles in 40 minutes, and
   * every flip can interrupt a live match). The fix has two halves: the server now
   * says WHY it evicted you (close code 4409) so the loser backs off instead of
   * racing straight back, and this guard stops the second bridge on this machine
   * from ever entering the fight.
   *
   * The guard is the same advisory lockfile `aifight bridge run` takes, so it is
   * symmetric and first-come-first-served: whoever starts second refuses, loudly
   * and with instructions. We deliberately never kill the other process — the pid
   * in that file may be stale and PIDs get reused.
   *
   * Returns null on success, or the status fields describing the refusal.
   */
  #acquireAgentSeat(): Pick<BridgeStatus, "message" | "code" | "codeParams"> | null {
    // acquireDaemonLock is not reentrant: a second call from this process throws
    // even though we already own the seat (e.g. 重连 after the loop gave up).
    if (this.#lock !== null) return null;
    try {
      ensureRuntimeHome();
      const lock = acquireDaemonLock();
      try {
        // The pid is what lets the NEXT launch tell "app crashed, lock is stale"
        // from "another bridge is alive". Without it a hard kill would leave a
        // lock nobody can prove is dead, and every later start would refuse.
        writePid(process.pid);
      } catch (cause) {
        lock.release();
        throw cause;
      }
      this.#lock = lock;
      return null;
    } catch (cause) {
      if (cause instanceof RuntimeFilesWriteError && cause.kind === "lock_held_by_other") {
        const pid = cause.heldByPid;
        // Two codes rather than one with an optional param: i18next renders a
        // missing {{pid}} as the raw placeholder, which would be worse than a
        // sentence that simply doesn't name the process.
        //
        // `detail` carries the runtime's own sentence verbatim. It is not
        // decoration: for a lock left behind by a crash whose pid the OS has
        // since reused, it is the ONLY text that says what actually helps
        // (delete the lock file) — every message we could compose from
        // heldByPid alone tells the user to stop a process that isn't there.
        return {
          code: pid !== undefined ? "lockHeld" : "lockHeldUnknown",
          codeParams: pid !== undefined ? { pid, detail: cause.message } : { detail: cause.message },
          message:
            (pid !== undefined
              ? `Another AIFight bridge (PID ${pid}) is already running this agent on this computer.`
              : "Another AIFight bridge is already running this agent on this computer.") +
            `\n${cause.message}`,
        };
      }
      const detail = cause instanceof Error ? cause.message : describeError(cause);
      return {
        code: "lockFailed",
        codeParams: { detail },
        message: `Could not claim the local agent lock.\n${detail}`,
      };
    }
  }

  /** Re-attempt the seat while another bridge holds it. Silent: the banner is
   *  already up and says what to do, so a successful retry simply replaces it
   *  with a running bridge. */
  #scheduleSeatRetry(): void {
    this.#cancelSeatRetry();
    this.#seatRetryTimer = setTimeout(() => {
      this.#seatRetryTimer = null;
      if (this.#runner !== null || this.#lock !== null) return;
      void this.start().catch(() => undefined);
    }, SEAT_RETRY_INTERVAL_MS);
    // Never hold the app open just to poll for a lock.
    this.#seatRetryTimer.unref?.();
  }

  #cancelSeatRetry(): void {
    if (this.#seatRetryTimer === null) return;
    clearTimeout(this.#seatRetryTimer);
    this.#seatRetryTimer = null;
  }

  /**
   * Release the local agent seat so a standby CLI service (or the next start)
   * can take it. Safe to call when we hold nothing.
   *
   * Holding the lock proves no other bridge is running, so any token/port left in
   * the runtime home is a crashed predecessor's litter — clearing it matches what
   * `aifight bridge run` does on its own shutdown.
   */
  #releaseAgentSeat(): void {
    const lock = this.#lock;
    if (lock === null) return;
    this.#lock = null;
    try {
      unlinkRuntimeFiles({ onLog: () => undefined });
    } catch {
      // Best-effort: never let cleanup failure block a stop/quit path.
    }
    try {
      lock.release();
    } catch {
      // Ditto — release() is already idempotent and swallows ENOENT.
    }
  }

  /**
   * Start the bridge against the shared config. Lazily loads the engine on first
   * call. Returns the resulting status instead of throwing; failures surface as
   * phase "error" / "unconfigured" so the UI can render them.
   */
  async start(): Promise<BridgeStatus> {
    if (this.#runner !== null) {
      // Already running. If we are PARKED (seat held elsewhere), the Retry
      // button's intent is "check the seat now" — poke the facade instead of
      // silently returning the stale status.
      if (this.#lastConnState === "parked" || this.#lastConnState === "backoff") {
        this.#runner.poke();
      }
      return this.#status;
    }
    // Join an in-flight start instead of beginning a second one.
    if (this.#starting !== null) return this.#starting;
    const run = this.#startOnce();
    this.#starting = run;
    try {
      return await run;
    } finally {
      this.#starting = null;
    }
  }

  async #startOnce(): Promise<BridgeStatus> {
    // A manual start supersedes any pending seat retry — and begins with a
    // clean stop intent (see #stopDuringStart).
    this.#cancelSeatRetry();
    this.#stopDuringStart = false;

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

    // One agent, one bridge per machine — claim the seat BEFORE we can connect.
    const conflict = this.#acquireAgentSeat();
    if (conflict !== null) {
      this.#setStatus({ phase: "error", config: summary, ...conflict });
      // Keep checking. The user's fix is to stop the other bridge, and having
      // to come back and press Reconnect after doing so is a step they should
      // not need — especially since the holder is usually a background service
      // they cannot see.
      this.#scheduleSeatRetry();
      return this.#status;
    }

    let runner: BridgeRunnerInstance;
    try {
      // Lazy: pulls the engine (and its native deps) only now, never at app load.
      const { BridgeRunner } = await import("@aifight/aifight/bridge/runner");
      runner = new BridgeRunner({
        config,
        clientKind: "desktop",
        onLog: (event) => {
          this.#noteActivity();
          // Phase/counter narration is GONE (重连重设计 2026-07-25 P4): the pill
          // used to flip to "starting" on attempt events and only flip back on a
          // welcome frame that — as the redesign audit proved — never reaches
          // this handler (the handshake consumes it), so any single reconnect
          // wedged the UI on「连接中」while actually online for hours. Phase,
          // uptime and the reconnect counter now derive exclusively from
          // #applyConnSnapshot (facade state projection).
          if (event.code === "reconnect.give_up" || event.code === "reconnect.closed") {
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
            this.#connUnsub?.();
            this.#connUnsub = null;
            this.#connectedAt = null;
            // Seat release ONLY after stop() truly finished (审查 F3): the old
            // fire-and-forget released the lock while a mid-dial zombie of the
            // stopping runner could still land — a live connection holding the
            // seat with no lock, which is exactly what invited the standby CLI
            // service in alongside. stop() is bounded now (P1), so this settles.
            void (async () => {
              if (runner !== null) await runner.stop().catch(() => {});
              this.#releaseAgentSeat();
            })();
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
          // NOTE: no welcome handling here — the handshake consumes the welcome
          // frame before this handler exists (redesign audit F1), so a branch on
          // it is dead code. Live games + phase recovery come from
          // #applyConnSnapshot, whose snapshots carry the welcome payload.
          this.#callbacks.onServerMessage?.(message);
        },
      });
    } catch (cause) {
      // Loading or constructing the engine failed: give the seat back, or the
      // CLI service can never take over and our own next start() would refuse.
      this.#releaseAgentSeat();
      this.#setStatus({ phase: "error", config: summary, message: describeError(cause) });
      return this.#status;
    }
    // D6a checkpoint 1: stop() landed while we were importing the engine —
    // before #runner existed for it to abort. Honouring the stop is our job
    // now: proceeding to runner.start() would hand stop() a first-connect
    // await that legitimately pends for as long as the server is unreachable.
    if (this.#stopDuringStart) {
      await runner.stop().catch(() => {});
      this.#releaseAgentSeat();
      this.#setStatus({ phase: "stopped", config: summary, message: undefined });
      return this.#status;
    }
    this.#runner = runner;

    try {
      await runner.start();
      // D6a checkpoint 2: stop() raced the tail of the connect and its abort
      // lost — the runner is up but the user asked for it to be down. Tear it
      // down before anything can observe it as live.
      if (this.#stopDuringStart) {
        this.#runner = null;
        await runner.stop().catch(() => {});
        this.#releaseAgentSeat();
        this.#setStatus({ phase: "stopped", config: summary, message: undefined });
        return this.#status;
      }
      this.#noteActivity();
      // P4: from here phase/uptime/counter derive from the facade projection.
      // Subscribing replays the standing snapshot synchronously (state
      // "connected"), which sets phase running + connectedAt through
      // #applyConnSnapshot; the direct set below is only the fallback for a
      // sandwich build whose runtime predates the projection API.
      this.#lastConnSeq = -1;
      this.#attemptBase = null;
      this.#lastConnState = null;
      this.#connUnsub?.();
      this.#connUnsub = runner.onConnectionStateChange((snap) =>
        this.#applyConnSnapshot(snap),
      );
      if (this.#status.phase !== "running") {
        this.#connectedAt = Date.now();
        this.#setStatus({ phase: "running", config: summary, message: undefined });
      }
    } catch (cause) {
      this.#runner = null;
      this.#connectedAt = null;
      await runner.stop().catch(() => {});
      this.#releaseAgentSeat();
      this.#setStatus({ phase: "error", config: summary, message: describeError(cause) });
    }
    return this.#status;
  }

  async stop(): Promise<BridgeStatus> {
    // Stop means stop: a pending seat retry would quietly bring us back.
    this.#cancelSeatRetry();
    // Let an in-flight start finish first. Without this, a stop landing while
    // start() is awaiting the engine import sees #runner === null, takes the
    // branch below, and hands back a seat the resuming start is about to put a
    // live connection on — leaving a running bridge holding no lock, which is
    // precisely how a standby CLI service ends up connecting alongside us.
    // Failures are the starting caller's to report, not ours.
    //
    // 审查 F5: "finish first" must not mean "wait out a server outage" — the
    // first-connect promise legitimately pends forever while the server is
    // down. When #runner is already set, runner.stop() aborts the in-flight
    // connect (AgentInstance threads an abort into the facade). When it is NOT
    // set — the engine-import window, D6a — there is nothing to abort yet, and
    // before the flag below existed this await simply waited out the outage:
    // the Stop invoke hung for hours and the bridge then connected anyway when
    // the server returned. #stopDuringStart is what makes the resuming start
    // honour the stop at its next resumption point, so this await settles on
    // import speed rather than server availability.
    if (this.#starting !== null) {
      this.#stopDuringStart = true;
      const startingRunner = this.#runner;
      if (startingRunner !== null) void startingRunner.stop().catch(() => {});
      await this.#starting.catch(() => undefined);
    }
    this.#connUnsub?.();
    this.#connUnsub = null;
    const runner = this.#runner;
    if (runner === null) {
      // Belt and braces: normally the seat is already free here, but a release
      // that got skipped would silently lock the user out of their own agent.
      this.#releaseAgentSeat();
      this.#setStatus({
        phase: this.#status.config !== undefined ? "stopped" : "idle",
        message: undefined,
      });
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
    // Release only after the socket is really down, so a CLI service waking up
    // the instant we let go cannot overlap with our last frames.
    this.#releaseAgentSeat();
    this.#setStatus({ phase: "stopped", message: undefined });
    return this.#status;
  }

  /**
   * Synchronous seat release for app quit (`before-quit`), where Electron gives
   * us no chance to await stop(). Dropping the lockfile is a couple of unlink
   * syscalls; the socket dies with the process a moment later.
   *
   * Without this, a quit would leave the lock behind with our (now dead) pid —
   * recoverable on the next launch via the pid liveness probe, but it would make
   * a standby CLI service wait for its next restart instead of taking over now.
   */
  releaseAgentSeatSync(): void {
    // Cancel first: a retry firing between here and process death would re-take
    // the seat on the way out and leave the lock behind for a dying process.
    this.#cancelSeatRetry();
    this.#releaseAgentSeat();
  }

  /**
   * Device-mismatch recovery (F1 takeover, button 2): forget THIS device's local
   * bridge identity. Stops the runner, ARCHIVES the current bridge.json (recoverable
   * — same helper `aifight setup --replace-local-identity` uses), then removes it so
   * `readConfigSummary()` reports "unconfigured" and the renderer returns to
   * onboarding, where the user can re-pair with a Dashboard code. This never touches
   * the server: the agent, its record, and its rating stay intact; only local
   * credentials are cleared. Never throws — failures come back as { ok:false }.
   */
  async removeLocalIdentity(): Promise<{ ok: boolean; error?: string; status?: BridgeStatus }> {
    let existing: BridgeConfig | undefined;
    try {
      existing = readBridgeConfig();
    } catch (cause) {
      const configPath = getBridgeConfigPath();
      if (!fs.existsSync(configPath)) {
        // No local identity to remove — already unconfigured. Report success so the
        // UI simply falls through to onboarding.
        return { ok: true, status: this.readConfigSummary() };
      }
      await this.stop();
      try {
        archiveUnreadableBridgeConfig(configPath);
        removeBridgeConfig();
      } catch (archiveOrRemoveCause) {
        return {
          ok: false,
          error: describeError(archiveOrRemoveCause),
          status: this.readConfigSummary(),
        };
      }
      this.#callbacks.onLog?.({
        level: "warning",
        code: "desktop.bridge_identity_quarantined",
        message: `Unreadable bridge identity was quarantined before removal: ${describeError(cause)}`,
      });
      return { ok: true, status: this.readConfigSummary() };
    }
    await this.stop();
    try {
      const archivePath = archiveReplacedBridgeConfig(existing);
      if (archivePath === null) {
        return {
          ok: false,
          error: "Could not archive the local bridge identity; nothing was removed.",
          status: this.readConfigSummary(),
        };
      }
      removeBridgeConfig();
    } catch (cause) {
      return { ok: false, error: describeError(cause), status: this.readConfigSummary() };
    }
    return { ok: true, status: this.readConfigSummary() };
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
  /** P4 projection applier — THE single writer of phase/uptime/counter while a
   *  runner is alive. Snapshots are seq-guarded so a stale/reordered one can
   *  never overwrite a newer state (审查 F6). */
  #applyConnSnapshot(snap: ReconnectStateSnapshot): void {
    if (snap.seq <= this.#lastConnSeq) return;
    this.#lastConnSeq = snap.seq;
    this.#noteActivity();
    if (this.#attemptBase === null) this.#attemptBase = snap.totalAttempts;
    this.#reconnects = Math.max(0, snap.totalAttempts - this.#attemptBase);
    if (snap.welcome !== null) {
      // Live-games refresh, relocated from the dead welcome-message branch:
      // the snapshot carries the welcome payload the handshake consumed.
      const games = parseWelcomeGames(snap.welcome.data);
      if (games !== null) this.#liveGames = games;
    }
    if (this.#runner === null) return; // teardown raced this snapshot
    const prev = this.#lastConnState;
    this.#lastConnState = snap.state;
    switch (snap.state) {
      case "connected": {
        this.#connectedAt = snap.connectedAt ?? Date.now();
        this.#setStatus({ phase: "running", config: this.#status.config, message: undefined });
        // 审查 F9: automatic matchmaking re-arms on EVERY recovery. It used to
        // fire only on launch, so a bridge that reconnected sat online but
        // never played again until the app was restarted.
        if (prev !== null && prev !== "connected" && this.#autoMatchWanted) {
          void this.joinAutoMatch();
        }
        break;
      }
      case "connecting":
      case "backoff":
      case "suspended": {
        this.#connectedAt = null;
        if (this.#status.phase === "running") {
          this.#setStatus({ phase: "starting", config: this.#status.config, message: undefined });
        }
        break;
      }
      case "parked": {
        this.#connectedAt = null;
        const self = snap.parkedReason === "superseded-self";
        this.#setStatus({
          phase: "error",
          config: this.#status.config,
          message: self ? SEAT_SUPERSEDED_SELF_MESSAGE : SEAT_TAKEN_MESSAGE,
          code: self ? "seatSupersededSelf" : "seatTakenParked",
        });
        break;
      }
      case "closed":
        // Terminal — the reconnect.give_up log branch owns teardown/message.
        break;
    }
  }

  /** Host sleep hand-off (P5): gracefully hand the seat back before the
   *  machine sleeps, so the server shows this agent offline within a second
   *  instead of holding a zombie until its read deadline. Wired to Electron
   *  powerMonitor "suspend" in main.ts; safe no-op when not running. */
  suspendForSleep(): void {
    this.#runner?.suspendConnection();
  }

  /** Wake hand-off (P2): dial immediately with a fresh backoff curve instead
   *  of resuming a stale frozen countdown. Wired to powerMonitor "resume". */
  pokeAfterWake(): void {
    this.#runner?.poke();
  }

  async joinAutoMatch(): Promise<void> {
    if (this.#runner === null) return;
    this.#autoMatchWanted = true;
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
      // Also drop the re-arm intent: a reconnect while paused must NOT sneak
      // the agent back into the pool (the F9 re-arm honours the pause).
      this.#autoMatchWanted = false;
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
  async setAgentPolicy(patch: { maxGamesPerDay?: unknown }): Promise<{ ok: boolean; error?: string }> {
    const ep = this.#meEndpoint("/api/agents/me/policy");
    if (ep === null) return { ok: false, error: "not configured" };
    // R12 (2026-07-26): validate the renderer-supplied cap here (ipc.ts forwards
    // the patch untyped). A malformed value (e.g. {}) would otherwise drop
    // max_games_per_day, send only {auto_requeue:false}, silently turn off
    // auto-matching server-side, and erase the local autoDailyLimit field. The
    // 10000 ceiling mirrors the server bound (maxPolicyGamesPerDay).
    const cap = patch?.maxGamesPerDay;
    if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 0 || cap > 10000) {
      return { ok: false, error: "invalid policy patch: maxGamesPerDay must be an integer in [0, 10000]" };
    }
    const body: Record<string, unknown> = {
      max_games_per_day: cap,
      auto_requeue: cap > 0,
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
      this.#persistDailyLimitLocally(cap);
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
    // `code`/`codeParams` label THIS patch's message and nothing else. Drop them
    // unless the patch re-supplies them: an inherited code would relabel a later,
    // unrelated failure with the wrong translated text (every other call site
    // clears `message` explicitly but knows nothing about codes).
    this.#status = { ...this.#status, code: undefined, codeParams: undefined, ...patch };
    this.#callbacks.onStatus?.(this.#status);
  }
}

function archiveUnreadableBridgeConfig(configPath: string): string {
  const dir = path.dirname(configPath);
  const archivePath = path.join(dir, `bridge.unreadable-${Date.now()}-${process.pid}.json`);
  fs.copyFileSync(configPath, archivePath);
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(archivePath, 0o600);
    } catch {
      // Best effort: the runtime home is still private; removal must not fail
      // solely because chmod is unavailable on the platform/filesystem.
    }
  }
  return archivePath;
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
