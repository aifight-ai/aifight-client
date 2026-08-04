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
// (node builtins only — see the single-instance guard below) and — since 审查
// P1-2 — bridge/update-check (import-free; the version-policy gate in start()).
// Since the declared-model feature (2026-07-30) it also includes ./config-host
// (activeProfileModelSync), whose own header guarantees native-module-free
// imports — the same guarantee main/ipc.ts already relies on by loading it.
// Reading the shared config on launch still never opens a connection; it
// touches the OS keychain only to decrypt the stored credentials.

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
import { checkBridgeUpdate } from "@aifight/aifight/bridge/update-check";
import { ensureRuntimeHome, getRuntimeHome } from "@aifight/aifight/store/paths";
import fs from "node:fs";
import path from "node:path";
// The app version doubles as the bridge version the platform's version policy
// judges: the desktop bundles the runtime in lockstep (same x.y.z-beta.N
// line). Read it from package.json — NOT the runtime's index barrel, which
// eagerly imports better-sqlite3 (see the lazy-engine note at the top of this
// file). bridge/update-check itself is import-free, so it joins the safe
// static surface (config.ts / runtime-files-write) without the native trap.
import desktopPkg from "../../package.json";
import type { BridgeRunner as BridgeRunnerInstance, ResumeMatchingResult } from "@aifight/aifight/bridge/runner";
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
  ChallengeInfo,
  ConnectionHealth,
  DeclaredModelResult,
  EventsData,
  HexagonData,
  LeaderboardData,
  LeaderboardScope,
  MatchEventsPayload,
} from "../shared/ipc";
import { normalizeLeaderboard } from "./leaderboard";
import { queueTransitionOf } from "./queueTruth";
import { getFlag, setFlag } from "./ui-flags";
import { fetchReplayTail } from "./replay-tail";
import { fetchParticipantEvents } from "./match-events";
import { normalizeEvents } from "./events";
import { normalizeAgentProfile } from "./agentProfile";
import { normalizeChallenges } from "./challenges";
import { activeProfileModelSync } from "./config-host";
import { DECLARED_MODEL_MAX_LEN } from "../shared/ipc";
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

/** Trim a declared-model pin to its storable form: ""/absent → null (unpinned).
 *  Over-length input is rejected rather than truncated — a silently cut name on
 *  the PUBLIC leaderboard would not be what the user typed. (bridge.json's
 *  `declaredModel` field + its write-time trim/strip live in the runtime's
 *  bridge/config; this is the renderer-facing validation half.) */
export function sanitizeDeclaredModel(
  raw: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: "declaredModel must be a string" };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (trimmed.length > DECLARED_MODEL_MAX_LEN) {
    return { ok: false, error: `declaredModel must be ${DECLARED_MODEL_MAX_LEN} characters or fewer` };
  }
  return { ok: true, value: trimmed };
}

/** The leaderboard-facing model name: the pin when set, else the active
 *  profile's configured model, else "direct" — the same fallback the platform
 *  shows for a direct-LLM agent with nothing declared. */
export function effectiveDeclaredModel(pinned: string | null, profileModel: string | null | undefined): string {
  if (pinned !== null && pinned !== "") return pinned;
  const local = profileModel?.trim() ?? "";
  return local !== "" ? local : "direct";
}

export interface BridgeHostCallbacks {
  readonly onStatus?: (status: BridgeStatus) => void;
  readonly onLog?: (event: BridgeLogEvent) => void;
  readonly onTrace?: (trace: BridgeDecisionTrace) => void;
  readonly onServerMessage?: (message: ServerMessageEnvelope) => void;
  readonly onMatchEvents?: (payload: MatchEventsPayload) => void;
}

/** Shown when the runtime's reconnect loop permanently stops (a terminal
 *  condition only — transient network/auth blips retry forever; see
 *  reconnect.ts isRetriableError). Supplements the banner's localized error
 *  label + 重连 button (App.tsx BridgeErrorBanner). */
/** How often the app re-checks a seat held by another bridge. Slow enough to be
 *  free (two syscalls), fast enough that `aifight service stop` feels instant. */
const SEAT_RETRY_INTERVAL_MS = 5_000;

/** LIVE_MATCH_FEED F1: participant event-feed cadence while a match is live. */
const MATCH_POLL_INTERVAL_MS = 2_500;
/** Backoff ceiling after consecutive poll failures (2.5s → 5s → 10s, capped). */
const MATCH_POLL_MAX_DELAY_MS = 10_000;
/** LIVE_MATCH_FEED Phase 2: a session whose server-pushed match_feed produced a
 *  frame within this window is feed-healthy, so the REST poll skips its network
 *  tick (the 2.5s heartbeat itself keeps running). Once the feed goes quiet —
 *  the kill switch flipped off, or an old server never sent any — the last
 *  frame ages out and polling takes over within one window. */
const MATCH_FEED_FRESH_MS = 15_000;

/** One armed participant-feed poller (at most one live match per bridge). */
interface MatchPollState {
  readonly sessionId: string;
  /** http(s) API origin + agent key, captured from the config this runner uses. */
  readonly origin: string;
  readonly apiKey: string;
  delayMs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

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

/** 连接审计 #6: the one terminal close retrying can never fix — the client's
 *  protocol version is older than the server requires. Localized in the
 *  renderer via the "updateRequired" code; this text is the raw fallback. */
/** ui-flags key for the persisted 暂停匹配 bit (连接审计 #13, owner ruling
 *  2026-07-28). Main-process storage is deliberate: the connected edge must be
 *  able to honour it BEFORE the renderer has even mounted. */
const MATCHING_PAUSED_FLAG = "matchingPaused";

const VERSION_MISMATCH_MESSAGE =
  "This app is too old for the AIFight server (protocol version mismatch). Update the app, then reconnect — retrying without updating cannot succeed.";

export class BridgeHost {
  readonly #callbacks: BridgeHostCallbacks;
  #runner: BridgeRunnerInstance | null = null;
  #status: BridgeStatus = { phase: "idle" };
  // Connection-health (D11.1): proof the outbound long-lived WebSocket is alive.
  // Derived entirely from this host's own callback wrappers — no runtime/CLI change.
  #connectedAt: number | null = null;
  #reconnects = 0;
  #lastActivityAt: number | null = null;
  /** Last INBOUND protocol frame (连接审计 #9 — logs/snapshots do NOT count). */
  #lastInboundAt: number | null = null;
  /** Server-confirmed queue membership (连接审计 #3/#12) — see queueTruth.ts. */
  #queued: { game: string; mode: string; oneShot: boolean } | null = null;
  /** Reconnect progress for the UI (连接审计 #8), from the facade snapshot. */
  #connInfo: NonNullable<BridgeStatus["conn"]> | null = null;
  /** The runner saw a protocol-version close this run (连接审计 #6) — the
   *  agent.version_mismatch notify always precedes the give_up/closed log,
   *  so this flag is set by the time the terminal error is composed. */
  #closeCauseVersion = false;
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
  /** User pressed 暂停匹配. The connected edge is the ONE owner of automatic
   *  enrollment — it joins whenever this is false (连接审计 #1, 2026-07-28: the
   *  old #autoMatchWanted intent bit was set only on a successful FIRST launch,
   *  so seat-retry / the Retry button connected fine but never enrolled — green
   *  light, zero matches all session). PERSISTED since 连接审计 #13 (owner
   *  ruling): read at construction so the very first connected edge already
   *  honours yesterday's pause — no enrollment window, no silently resumed
   *  spend. See setMatchingPaused. */
  #matchingPaused = getFlag(MATCHING_PAUSED_FLAG);
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
  // LIVE_MATCH_FEED F1: the participant event-feed poller, armed by game_start
  // and disarmed by game_over / match_cancelled / stop. Null while no match is
  // live. Render-only: the feed NEVER triggers an LLM call (the bridge calls
  // the model only on action_request).
  #matchPoll: MatchPollState | null = null;
  // LIVE_MATCH_FEED Phase 2: the last server-pushed match_feed frame, keyed by
  // session. While it is fresh the poller above is redundant and skips its
  // network tick; the renderer folds the push frames through the same
  // seq-dedupe merge either way, so nothing is lost when the poll goes quiet.
  #lastMatchFeed: { readonly sessionId: string; readonly at: number } | null = null;
  /**
   * The live match's opening game_start frame, cached for renderer-reload
   * resync (owner report 2026-08-03): the renderer's board reducer ignores
   * every frame until it has seen a game_start, so a reload mid-match used to
   * lose the live view for good — 观战 fell back to demo while the match kept
   * running. Non-null exactly while a match is live on this bridge session.
   */
  #lastGameStart: ServerMessageEnvelope | null = null;

  constructor(callbacks: BridgeHostCallbacks = {}) {
    this.#callbacks = callbacks;
  }

  /**
   * The cached game_start of the currently live match, or null when none —
   * the renderer-reload resync source (IPC.liveSnapshot, owner report
   * 2026-08-03). Raw protocol frame; the renderer folds it through the same
   * reducer the live stream uses, so information hiding is inherited.
   */
  getLiveMatchSnapshot(): ServerMessageEnvelope | null {
    return this.#lastGameStart;
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
      lastInboundAt: this.#lastInboundAt,
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
   * The agent's own challenges (约战) via the agent key: GET
   * /api/agents/me/challenges — duels the agent hosts OR has accepted,
   * normalized to renderer rows. Null on any error or non-OK status (an old
   * server 404s the route) so the dashboard section simply hides. Never throws.
   */
  async getChallenges(): Promise<readonly ChallengeInfo[] | null> {
    const ep = this.#meEndpoint("/api/agents/me/challenges");
    if (ep === null) return null;
    let agentId: string;
    try {
      agentId = readBridgeConfig().agentId;
    } catch {
      return null;
    }
    try {
      const res = await fetch(ep.url, {
        headers: { "X-API-Key": ep.apiKey },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      return normalizeChallenges(await res.json(), agentId);
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
        //
        // 审查 #7: same-boot pid reuse makes "stop PID N" misleading even when
        // the probe says the pid is alive (the OS recycled it onto an unrelated
        // process). Name the lock file + the manual escape hatch explicitly so
        // the advice never dead-ends; `lockPath` lets the localized strings
        // render the same sentence (the runtime's own text only names the path
        // in the stale-lock case).
        const lockPath = path.join(getRuntimeHome(), "lock");
        const recovery =
          "If you're sure no other bridge is running, quit other AIFight apps " +
          `or delete the lock file at ${lockPath}.`;
        return {
          code: pid !== undefined ? "lockHeld" : "lockHeldUnknown",
          codeParams:
            pid !== undefined
              ? { pid, detail: cause.message, lockPath }
              : { detail: cause.message, lockPath },
          message:
            (pid !== undefined
              ? `Another AIFight bridge (PID ${pid}) is already running this agent on this computer.`
              : "Another AIFight bridge is already running this agent on this computer.") +
            `\n${cause.message}\n${recovery}`,
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
      void this.#startQuietly().catch(() => undefined);
    }, SEAT_RETRY_INTERVAL_MS);
    // Never hold the app open just to poll for a lock.
    this.#seatRetryTimer.unref?.();
  }

  #cancelSeatRetry(): void {
    if (this.#seatRetryTimer === null) return;
    clearTimeout(this.#seatRetryTimer);
    this.#seatRetryTimer = null;
  }

  // ── LIVE_MATCH_FEED F1: participant event-feed polling ─────────────────────
  // Without the Phase 2 push the server sends events to a PLAYER only inside
  // action_request (turn-driven by design, to save LLM tokens) — between our
  // turns the cockpit board would freeze until our next decision. While a match
  // is live this poller mirrors the participant REST feed (no spectator delay,
  // per-player filtered, full history each page) so opponents' moves reach the
  // board within ~2.5s. The renderer dedupes by seq against the turn-driven
  // stream (and against Phase 2's match_feed push). Read-only: nothing here
  // ever feeds a prompt or triggers an LLM call.
  //
  // Phase 2 fallback semantics: once the server pushes match_feed for a session,
  // the tick skips its network call while the feed stays fresh
  // (MATCH_FEED_FRESH_MS); the loop keeps heartbeating so a quiet feed hands
  // back to polling within one window.

  #startMatchEventsPoll(sessionId: string, origin: string, apiKey: string): void {
    this.#cancelMatchEventsPoll();
    if (sessionId === "" || origin === "" || apiKey === "") return;
    this.#matchPoll = { sessionId, origin, apiKey, delayMs: MATCH_POLL_INTERVAL_MS, timer: null };
    // First page immediately — the opening new_hand/blinds may precede our first
    // action_request by seconds when we are not the first to act.
    this.#scheduleMatchPollTick(0);
  }

  #cancelMatchEventsPoll(): void {
    const poll = this.#matchPoll;
    if (poll === null) return;
    this.#matchPoll = null;
    if (poll.timer !== null) clearTimeout(poll.timer);
  }

  #scheduleMatchPollTick(delayMs: number): void {
    const poll = this.#matchPoll;
    if (poll === null) return;
    poll.timer = setTimeout(() => {
      poll.timer = null;
      void this.#matchPollTick(poll);
    }, delayMs);
    // Never hold the app open just to poll a match feed.
    poll.timer.unref?.();
  }

  async #matchPollTick(poll: MatchPollState): Promise<void> {
    // A stopped bridge or a superseded poll generation ends the loop quietly.
    if (this.#matchPoll !== poll || this.#runner === null) return;
    // Phase 2: a feed-healthy session makes the REST poll redundant — skip the
    // network call but keep the 2.5s heartbeat (and heal any earlier backoff),
    // so a feed that stops — kill switch off / old server — hands back to
    // polling within one freshness window.
    const feed = this.#lastMatchFeed;
    if (feed !== null && feed.sessionId === poll.sessionId && Date.now() - feed.at < MATCH_FEED_FRESH_MS) {
      poll.delayMs = MATCH_POLL_INTERVAL_MS;
      this.#scheduleMatchPollTick(poll.delayMs);
      return;
    }
    const events = await fetchParticipantEvents(poll.origin, poll.sessionId, poll.apiKey);
    if (this.#matchPoll !== poll) return; // match ended / session changed mid-flight
    if (events === null) {
      // Silent exponential backoff; the turn-driven stream is unaffected either
      // way, so a failing feed degrades to the pre-F1 experience, never to noise.
      poll.delayMs = Math.min(poll.delayMs * 2, MATCH_POLL_MAX_DELAY_MS);
    } else {
      poll.delayMs = MATCH_POLL_INTERVAL_MS;
      if (events.length > 0) {
        this.#callbacks.onMatchEvents?.({ sessionId: poll.sessionId, events });
      }
    }
    this.#scheduleMatchPollTick(poll.delayMs);
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
      // Already running. If we are PARKED (seat held elsewhere), in backoff, or
      // SUSPENDED (a lid-close whose powerMonitor resume never arrived —
      // 连接审计 #4: that state previously had no manual exit at all), the
      // Retry button's intent is "check now" — poke the facade instead of
      // silently returning the stale status.
      if (
        this.#lastConnState === "parked" ||
        this.#lastConnState === "backoff" ||
        this.#lastConnState === "suspended"
      ) {
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

  /**
   * Seat-retry start (审查 #4): identical to start() but QUIET until the seat
   * is ours. The retry fires every 5s while another bridge holds the lock, and
   * the loud path announces "starting" BEFORE #acquireAgentSeat — so every
   * pass flipped the pill starting→error→starting on a 5s cycle. The quiet
   * path leaves the standing seat-error status untouched until the lock is
   * actually acquired; only then does the normal starting flow begin.
   */
  async #startQuietly(): Promise<BridgeStatus> {
    if (this.#runner !== null) return this.#status;
    if (this.#starting !== null) return this.#starting;
    const run = this.#startOnce({ quiet: true });
    this.#starting = run;
    try {
      return await run;
    } finally {
      this.#starting = null;
    }
  }

  async #startOnce(opts: { readonly quiet?: boolean } = {}): Promise<BridgeStatus> {
    // A manual start supersedes any pending seat retry — and begins with a
    // clean stop intent (see #stopDuringStart).
    this.#cancelSeatRetry();
    this.#stopDuringStart = false;
    const quiet = opts.quiet === true;

    let config: BridgeConfig;
    try {
      config = readBridgeConfig();
    } catch (cause) {
      this.#setStatus({ phase: "unconfigured", config: undefined, message: describeError(cause) });
      return this.#status;
    }

    const summary = toSummary(config);
    // The participant event feed (F1) lives on the http(s) API origin; the
    // bridge's baseUrl may be a ws(s) endpoint. Resolved once per start.
    const restOrigin = httpOriginOf(config.baseUrl);
    // Fresh session: reset connection-health counters + truth projections.
    this.#connectedAt = null;
    this.#reconnects = 0;
    this.#lastActivityAt = null;
    this.#lastInboundAt = null;
    this.#queued = null;
    this.#connInfo = null;
    this.#closeCauseVersion = false;
    this.#lastMatchFeed = null;
    this.#lastGameStart = null;
    // 审查 #4: a LOUD start (launch / Retry button) announces "starting" right
    // away; the quiet seat-retry must not — it fires every 5s while the seat
    // is held, and broadcasting "starting" here is exactly what made the pill
    // flicker starting↔error. The standing seat error simply stays up.
    if (!quiet) this.#setStatus({ phase: "starting", config: summary, message: undefined });

    // One agent, one bridge per machine — claim the seat BEFORE we can connect.
    const conflict = this.#acquireAgentSeat();
    if (conflict !== null) {
      // Quiet retry: the standing status already IS this seat error, so there
      // is nothing new to broadcast — just keep probing.
      if (!quiet) this.#setStatus({ phase: "error", config: summary, ...conflict });
      // Keep checking. The user's fix is to stop the other bridge, and having
      // to come back and press Reconnect after doing so is a step they should
      // not need — especially since the holder is usually a background service
      // they cannot see.
      this.#scheduleSeatRetry();
      return this.#status;
    }
    // Seat acquired — the quiet retry now joins the normal loud flow.
    if (quiet) this.#setStatus({ phase: "starting", config: summary, message: undefined });

    // Platform version policy (审查 P1-2 — CLI parity: bridge-run.ts runs the
    // same gate before dialing). An unsupported build must refuse here instead
    // of connecting into a certain protocol-mismatch close; a recommended
    // update warns but runs; a failed/unreachable check never blocks startup —
    // being offline must not lock the user out of their own agent.
    const versionRefusal = await this.#checkVersionPolicy(config);
    if (versionRefusal !== null) {
      this.#releaseAgentSeat();
      this.#setStatus({ phase: "error", config: summary, ...versionRefusal });
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
          if (event.code === "agent.version_mismatch") this.#closeCauseVersion = true;
          // U8a/D2: the standby declaration is fire-and-forget — standbyGames()
          // only flips when the platform answers, well after the connected-edge
          // status emit. These three codes are the runner's own "the answer
          // landed" signals (accepted, re-declared, refused), so re-project the
          // status on each: without this the 待命 row appears only at the next
          // unrelated emit, or never.
          if (
            event.code === "bridge.standby_declared" ||
            event.code === "bridge.standby_redeclared" ||
            event.code === "bridge.standby_declare_failed"
          ) {
            this.#reemitStatus();
          }
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
            this.#connUnsub?.();
            this.#connUnsub = null;
            this.#connectedAt = null;
            this.#queued = null;
            this.#connInfo = null;
            this.#setStatus({
              phase: "error",
              config: this.#status.config,
              // 连接审计 #6: a version close gets its own message + code — the
              // generic "retry" advice is actively wrong there (only an app
              // update can help), and the renderer keys the 更新 action off it.
              message: this.#closeCauseVersion ? VERSION_MISMATCH_MESSAGE : RECONNECT_GAVE_UP_MESSAGE,
              ...(this.#closeCauseVersion ? { code: "updateRequired" as const } : {}),
            });
            // Teardown is SERIAL and #runner is cleared LAST (审查 #9). The old
            // order nulled #runner up front and released the seat from a
            // fire-and-forget IIFE: a start() landing in between saw no runner,
            // passed the seat check (the lock was still ours), put a NEW runner
            // online — and then the trailing IIFE deleted the lock under it,
            // leaving a live bridge holding no seat. Keeping #runner set until
            // stop() + the seat release have both settled makes a start() in
            // that window simply re-return the error status above; the seat is
            // only handed over once no connection is left to protect. (The
            // release still comes strictly after stop() settles — 审查 F3.)
            void (async () => {
              if (runner !== null) await runner.stop().catch(() => {});
              this.#releaseAgentSeat();
              this.#runner = null;
            })();
          }
          this.#callbacks.onLog?.(event);
        },
        onTrace: (trace) => this.#callbacks.onTrace?.(trace),
        onServerMessage: (message) => {
          this.#noteActivity();
          this.#lastInboundAt = Date.now();
          // 连接审计 #3/#12: the queue truth rides the protocol echoes.
          const q = queueTransitionOf(message);
          if (q !== undefined && JSON.stringify(q) !== JSON.stringify(this.#queued)) {
            this.#queued = q;
            this.#reemitStatus();
          }
          // LIVE_MATCH_FEED F1: the poller follows the match lifecycle — armed by
          // game_start (its match_id IS the per-player session id), disarmed by
          // the terminal frames. The bridge plays at most one match at a time.
          if (message.type === "game_start") {
            // Cache the opening frame for renderer-reload resync
            // (IPC.liveSnapshot): a reloaded renderer replays it into the
            // board reducer, then the 2.5s feed poll catches the board up.
            this.#lastGameStart = message;
            const sid = (message.data as { match_id?: unknown } | undefined)?.match_id;
            if (typeof sid === "string" && restOrigin !== null) {
              this.#startMatchEventsPoll(sid, restOrigin, config.apiKey ?? "");
            }
          } else if (message.type === "game_over" || message.type === "match_cancelled") {
            this.#lastGameStart = null;
            this.#cancelMatchEventsPoll();
          } else if (message.type === "match_feed") {
            // Phase 2: bookkeep the server-pushed feed so the poller can tell a
            // feed-healthy session (skip its tick) from a silent one (resume
            // polling). The frame itself is forwarded to the renderer below.
            const sid = (message.data as { match_id?: unknown } | undefined)?.match_id;
            this.#lastMatchFeed = { sessionId: typeof sid === "string" ? sid : "", at: Date.now() };
          }
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

  /**
   * The platform's bridge-version policy gate (审查 P1-2), the same check the
   * CLI runs in bridge-run.ts before dialing: GET /api/bridge/version via the
   * runtime's checkBridgeUpdate, judged against this app's version.
   *
   *   - "unsupported"        → refuse with the updateRequired code; the
   *     renderer's error banner turns that into the app-update flow (审查
   *     P1-1), which is the ONLY way forward — connecting would end in a
   *     protocol-mismatch close anyway.
   *   - "update_recommended" → warn-and-go (the CLI's [warn] line), surfaced
   *     through the normal log stream.
   *   - "unknown" / a throw  → proceed. The check failing (offline, old server
   *     without the route) must never lock the user out of their own agent.
   *
   * Returns null when the start may proceed.
   */
  async #checkVersionPolicy(config: BridgeConfig): Promise<Pick<BridgeStatus, "message" | "code"> | null> {
    const baseUrl = config.baseUrl?.replace(/\/+$/, "");
    if (!baseUrl) return null;
    let update: Awaited<ReturnType<typeof checkBridgeUpdate>>;
    try {
      update = await checkBridgeUpdate({ baseUrl, currentVersion: desktopPkg.version });
    } catch (cause) {
      // checkBridgeUpdate already maps every failure to "unknown"; this catch
      // is belt-and-braces so a throw can never block a start.
      this.#callbacks.onLog?.({ level: "info", code: "desktop.version_check_failed", message: describeError(cause) });
      return null;
    }
    if (update.status === "unsupported") {
      return { code: "updateRequired", message: update.message };
    }
    if (update.status === "update_recommended") {
      this.#callbacks.onLog?.({ level: "warning", code: "bridge.update_recommended", message: update.message });
    } else if (update.status === "unknown") {
      this.#callbacks.onLog?.({ level: "info", code: "desktop.version_check_skipped", message: update.message });
    }
    return null;
  }

  async stop(): Promise<BridgeStatus> {
    // Stop means stop: a pending seat retry would quietly bring us back.
    this.#cancelSeatRetry();
    // And a live match-feed poller must not outlive the bridge it mirrors.
    this.#cancelMatchEventsPoll();
    this.#lastGameStart = null;
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
    this.#queued = null;
    this.#connInfo = null;
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
   * The games this bridge is standing by for, straight from the runner (U8a) —
   * an availability DECLARATION the platform accepted, not a queue entry. Read
   * live on every status emit rather than mirrored into a field, so the host
   * can never disagree with the runner about it; null whenever no runner exists
   * (stopped, seat refused, still importing the engine).
   */
  #standbyNow(): readonly string[] | null {
    return this.#runner?.standbyGames() ?? null;
  }

  /**
   * Resume automatic matchmaking by restoring the POSTURE (D1 — U8d, owner
   * ruling 2026-08-03). This used to be joinAutoMatch(): read the server cap,
   * pick a game locally (pickAutoGame) and queue for it — the last place a
   * client still chose a game on the user's behalf, which the matchmaking
   * ruling forbids. The runner owns the decision now, identically for the CLI,
   * Telegram and this button:
   *   - default posture → re-declare standby + re-arm the timer, queue nothing;
   *   - legacy posture (`standbyFallbackJoinMinutes` set) → the old self-join;
   *   - daily cap 0 → nothing to resume.
   * Every outcome gets its own desktop log line (the runner's own
   * bridge.matching_resumed is not shown in this app) and a status re-emit:
   * "standby" only DECLARED a pool, so standbyGames() flips a moment later
   * when the platform answers — the standby log codes in start() re-emit
   * again then. Never throws.
   */
  #resumeMatching(): void {
    const runner = this.#runner;
    if (runner === null) return;
    let result: ResumeMatchingResult;
    try {
      result = runner.resumeMatching();
    } catch (cause) {
      // The runner exists but has no connected agent (start still in flight, or
      // a teardown raced us). The pause flag is already cleared, so the next
      // connect edge declares standby on its own.
      this.#callbacks.onLog?.({ level: "warning", code: "desktop.resume_failed", message: describeError(cause) });
      return;
    }
    switch (result.mode) {
      case "standby":
        this.#callbacks.onLog?.({
          level: "info",
          code: "desktop.matching_resumed",
          message: `Matching resumed — standing by for ${result.games.join(", ")}; the platform assigns the game (no self-join).`,
        });
        break;
      case "joined":
        this.#callbacks.onLog?.({
          level: "info",
          code: "desktop.matching_resumed",
          message: `Matching resumed — re-joined the ${result.game} queue (legacy self-join posture).`,
        });
        break;
      case "cap_off":
        this.#callbacks.onLog?.({
          level: "info",
          code: "desktop.matching_resumed",
          message: "Matching resumed, but the daily cap is 0 — nothing automatic to re-enter until the cap is raised.",
        });
        break;
    }
    // Re-emit whatever the runner now believes: a declared pool lights the
    // standby row, and "joined"/"cap_off" clear anything the pre-pause
    // declaration left behind.
    this.#reemitStatus();
  }
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
    // 连接审计 #8: keep the UI's reconnect progress fresh on EVERY snapshot.
    // (?? 0: a sandwich build whose runtime predates the authFailures field.)
    this.#connInfo = { state: snap.state, attempt: snap.attempt, nextRetryAt: snap.nextRetryAt, authFailures: snap.authFailures ?? 0 };
    // 连接审计 #3: any non-connected state means the server has already dropped
    // us from every queue (hub.OnQueueLeave on socket death) — the belief dies
    // with the socket; the connected edge re-earns it via the queue_joined echo.
    if (snap.state !== "connected") this.#queued = null;
    switch (snap.state) {
      case "connected": {
        this.#connectedAt = snap.connectedAt ?? Date.now();
        this.#setStatus({ phase: "running", config: this.#status.config, message: undefined });
        // Enrollment moved into the shared runner (R2, 2026-07-31): every
        // connected edge now DECLARES standby games there, so the platform can
        // assign the game. U8a (2026-08-03) made that declaration the whole
        // story in the default posture — the runner's standby timer only
        // RE-declares, and self-joins a game only when the user set
        // `standbyFallbackJoinMinutes` explicitly. The desktop's own join here
        // would double-enroll (the old two-path first-connect bug), and as of
        // D1 it is gone entirely: the resume button goes through the SAME
        // runner posture (setMatchingPaused(false) → #resumeMatching), so this
        // host no longer joins a queue on any automatic path.
        break;
      }
      case "connecting":
      case "backoff":
      case "suspended": {
        this.#connectedAt = null;
        // 连接审计 #11: a parked error must not outlive parking. Once the
        // facade is dialing again (poke / wake / seat freed), leaving the
        // phase on "error" kept the「席位被占」banner over what is now an
        // ordinary reconnect — masking, e.g., a plain network outage. The
        // parked codes are the ONLY errors reachable here: every other error
        // path (give_up, start failure) nulls #runner first, and the guard
        // above already returned.
        const parkedError =
          this.#status.phase === "error" &&
          (this.#status.code === "seatTakenParked" || this.#status.code === "seatSupersededSelf");
        if (this.#status.phase === "running" || parkedError) {
          this.#setStatus({ phase: "starting", config: this.#status.config, message: undefined });
        } else {
          // Still push the fresh conn/queued projection (attempt counter,
          // next-retry clock) — repeated backoff edges arrive while the phase
          // stays "starting", and without this the pill's countdown froze.
          this.#reemitStatus();
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

  /**
   * Pause/resume automatic matchmaking WITHOUT going offline. Pause = leave the
   * queue (the server stops auto-requeuing us); resume = go back to STANDING BY
   * (D1 — the runner's posture decides; this host never picks a game). Manual
   * matches + challenges are unaffected.
   *
   * PERSISTED across launches (owner ruling, 连接审计 #13): pausing is a spend
   * decision, so it must survive a relaunch. The truth lives HERE, in the main
   * process, precisely so the connected edge can honour it before any enrollment
   * happens — the old renderer-localStorage bit could only re-apply the pause
   * after mount + connect, leaving a window where a match could be picked up and
   * burn tokens. The renderer shows it back via BridgeStatus.matchingPaused and
   * reminds the user every launch (App's paused banner).
   */
  async setMatchingPaused(paused: boolean): Promise<void> {
    // Persist FIRST, unconditionally: the flag is a user preference, not a
    // property of the current connection. (An early return when the bridge is
    // offline would silently drop a pause the user just asked for.)
    this.#matchingPaused = paused;
    setFlag(MATCHING_PAUSED_FLAG, paused);
    // Mirror into the SHARED bridge.json (the CLI's pause flag): the runner's
    // standby declaration + fallback self-join read matchingPaused from there,
    // so a desktop pause must be visible to them or a reconnect edge would
    // quietly re-enter matchmaking (R2; pre-existing gap, now closed).
    try {
      const config = readBridgeConfig();
      if ((config.matchingPaused === true) !== paused) {
        writeBridgeConfig({ ...config, matchingPaused: paused, updatedAt: new Date().toISOString() });
      }
    } catch (cause) {
      this.#callbacks.onLog?.({ level: "warning", code: "desktop.pause_persist_failed", message: describeError(cause) });
    }
    this.#reemitStatus();
    if (this.#runner === null) {
      // No bridge to talk to: the flag alone IS the resume (D1). The next
      // connect edge reads matchingPaused fresh from bridge.json and declares
      // standby there — nothing to re-join, and nothing to apologise for.
      if (!paused) {
        this.#callbacks.onLog?.({
          level: "info",
          code: "desktop.resume_pending",
          message: "Matching resumed — the bridge stands by the next time it connects.",
        });
      }
      return;
    }
    if (paused) {
      // A reconnect while paused must NOT sneak the agent back into the pool —
      // the connected-edge enrollment honours this flag.
      try {
        this.#runner.leaveQueue();
      } catch (cause) {
        this.#callbacks.onLog?.({ level: "warning", code: "desktop.pause_failed", message: describeError(cause) });
      }
    } else {
      // D1: restore the POSTURE through the runner — never pick a game here.
      this.#resumeMatching();
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
   * Set which games this agent auto-matches / stands by for. The selection
   * lives in the shared bridge.json (`autoGames` — same field `aifight set
   * game` writes): preserveMtime because a running bridge re-reads the list at
   * every (re)connect edge, so the write must not read as "restart pending".
   * After the local write we best-effort re-declare standby_games to the
   * platform (R2 orchestration) so the running declaration catches up NOW
   * rather than at the next reconnect; a PATCH failure is logged, never
   * surfaced — the local write already succeeded and the next connect edge
   * re-declares anyway. Nothing on this side picks a game from the list any
   * more (D1) — it is purely the standby pool. Empty selection is rejected
   * here too (the renderer guards first): "no games at all" is what pause /
   * daily-cap-0 are for, mirroring the CLI picker's rule.
   */
  async setAutoGames(games: unknown): Promise<{ ok: boolean; error?: string }> {
    const live = this.liveGamesSync();
    const unique: string[] = [];
    for (const g of Array.isArray(games) ? games : []) {
      if (typeof g !== "string" || !live.includes(g)) {
        return { ok: false, error: `unsupported game: ${String(g)}` };
      }
      if (!unique.includes(g)) unique.push(g);
    }
    if (unique.length === 0) {
      return { ok: false, error: "at least one game is required — pause matching to stop auto-play" };
    }
    try {
      const config = readBridgeConfig();
      writeBridgeConfig(
        { ...config, autoGames: unique, updatedAt: new Date().toISOString() },
        { preserveMtime: true },
      );
    } catch (cause) {
      return { ok: false, error: describeError(cause) };
    }
    this.readConfigSummary();
    const ep = this.#meEndpoint("/api/agents/me/policy");
    if (ep !== null) {
      try {
        const res = await fetch(ep.url, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "X-API-Key": ep.apiKey },
          body: JSON.stringify({ standby_games: unique }),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (cause) {
        this.#callbacks.onLog?.({
          level: "warning",
          code: "desktop.standby_redeclare_failed",
          message: `standby_games not re-declared (${describeError(cause)}); the next connect edge declares the fresh list.`,
        });
      }
    }
    return { ok: true };
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
   * Pin (or clear) the agent's PUBLIC leaderboard model name (declared-model
   * feature, owner decision 2026-07-30). Persists `declaredModel` to the shared
   * bridge.json through the runtime's own writer — the same app-owned direct
   * write path #persistDailyLimitLocally uses (the desktop has no runtime
   * control-API config write; CLI ops stay read/test-only) — then best-effort
   * PATCHes /api/agents/me/policy with the EFFECTIVE name
   * (pin || active profile's model || "direct"), so saving a model config also
   * refreshes the leaderboard name when unpinned. The PATCH is deliberately
   * non-blocking: a failure comes back as ok:true + syncError for a dismissible
   * renderer warning, never as a failed save. Never throws.
   */
  async setDeclaredModel(patch: { declaredModel?: unknown }): Promise<DeclaredModelResult> {
    const clean = sanitizeDeclaredModel(patch?.declaredModel);
    if (!clean.ok) return { ok: false, error: clean.error };
    let config: BridgeConfig;
    try {
      config = readBridgeConfig();
    } catch (cause) {
      return { ok: false, error: describeError(cause) };
    }
    const profileModel = activeProfileModelSync(config.directAgentSlug ?? "default");
    const effective = effectiveDeclaredModel(clean.value, profileModel);
    // Skip the rewrite when the pin is unchanged — every writeBridgeConfig call
    // re-encrypts the secret fields (keychain churn), same reasoning as
    // #persistDailyLimitLocally. (Tolerate a hand-edited untrimmed/empty value:
    // it reads as unpinned, matching the runtime's write-time trim/strip.)
    const currentRaw = config.declaredModel?.trim() ?? "";
    const current = currentRaw === "" ? null : currentRaw;
    if (current !== clean.value) {
      const { declaredModel: _oldPin, ...rest } = config;
      const next: BridgeConfig =
        clean.value === null
          ? { ...rest, updatedAt: new Date().toISOString() }
          : { ...rest, declaredModel: clean.value, updatedAt: new Date().toISOString() };
      try {
        writeBridgeConfig(next);
      } catch (cause) {
        return { ok: false, error: describeError(cause) };
      }
    }
    const syncError = await this.#pushDeclaredModel(effective);
    // Re-emit the summary so mounted views (hero model chip, Models form) show
    // the new pin without waiting for a remount — the same discipline
    // #persistDailyLimitLocally follows.
    this.readConfigSummary();
    return syncError === null ? { ok: true, effective } : { ok: true, effective, syncError };
  }

  /** Best-effort PATCH of the effective declared model to the platform policy
   *  endpoint (agent-key auth). Returns null on success, else the failure text. */
  async #pushDeclaredModel(effective: string): Promise<string | null> {
    const ep = this.#meEndpoint("/api/agents/me/policy");
    if (ep === null) return "not configured";
    try {
      const res = await fetch(ep.url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-API-Key": ep.apiKey },
        body: JSON.stringify({ declared_model: effective }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        return `HTTP ${res.status}${t ? ": " + t.slice(0, 200) : ""}`;
      }
      return null;
    } catch (cause) {
      return describeError(cause);
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
    // `queued`/`conn`/`matchingPaused`/`standby` are NEVER patched by callers —
    // they mirror the host's own fields (and, for standby, the runner's live
    // belief) on every emit, so no call site can carry a stale copy forward.
    this.#status = {
      ...this.#status,
      code: undefined,
      codeParams: undefined,
      ...patch,
      queued: this.#queued,
      conn: this.#connInfo,
      matchingPaused: this.#matchingPaused,
      standby: this.#standbyNow(),
    };
    this.#callbacks.onStatus?.(this.#status);
  }

  /** Re-emit the current status (fresh queued/conn projection, same phase). */
  #reemitStatus(): void {
    this.#setStatus({ phase: this.#status.phase, message: this.#status.message, code: this.#status.code, codeParams: this.#status.codeParams });
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
  const declaredModel = config.declaredModel?.trim();
  const profileModel = activeProfileModelSync(config.directAgentSlug ?? "default");
  return {
    agentId: config.agentId,
    agentName: config.agentName,
    baseUrl: config.baseUrl,
    runtimeType: config.runtimeType,
    ...(config.directAgentSlug !== undefined ? { directAgentSlug: config.directAgentSlug } : {}),
    ...(config.autoDailyLimit !== undefined ? { autoDailyLimit: config.autoDailyLimit } : {}),
    ...(config.autoGames !== undefined ? { autoGames: config.autoGames } : {}),
    ...(declaredModel !== undefined && declaredModel !== "" ? { declaredModel } : {}),
    ...(profileModel !== null ? { profileModel } : {}),
  };
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// pickAutoGame is GONE (D1 — U8d, owner ruling 2026-08-03). It existed for one
// caller, joinAutoMatch(), and its whole job was choosing a game on the user's
// behalf when they pressed 恢复匹配 — the last client-side game pick left after
// U8a cleared the connect edge. Resuming now restores the POSTURE through
// BridgeRunner.resumeMatching() (see #resumeMatching): the platform assigns the
// game. Do not reintroduce a local picker for an automatic path; the manual
// "play one now" flow always names its game explicitly and is unaffected.

function toInt(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0;
}

/** The http(s) origin the REST API lives on; the bridge baseUrl may be ws(s). Null when unusable.
 *  Exported for session-reconcile.ts, which calls the same REST surface. */
export function httpOriginOf(baseUrl: string | undefined): string | null {
  if (baseUrl === undefined) return null;
  try {
    const u = new URL(baseUrl);
    const proto = u.protocol === "ws:" ? "http:" : u.protocol === "wss:" ? "https:" : u.protocol;
    if (proto !== "http:" && proto !== "https:") return null;
    return `${proto}//${u.host}`;
  } catch {
    return null;
  }
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
