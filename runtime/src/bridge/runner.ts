import { AgentInstance, type AgentInstanceSnapshot } from "../agents/agent";
import { MAX_CONCURRENT_MATCHES } from "../agents/limits";
import { checkLocalDeviceIdentity, getDeviceId } from "../account/device-id";
import { WSClientMismatchError, WSDeviceMismatchError, WSHandshakeError } from "../wsclient/errors";
import type {
  ReconnectingWSClientOptions,
  ReconnectStateHandler,
  ReconnectStateSnapshot,
  SeatProbeResult,
} from "../wsclient/reconnect";
import { PROCESS_INSTANCE_ID } from "../wsclient/instance";
import { CLIENT_CAPABILITY_MATCH_FEED } from "../wsclient/capabilities";
import type { ServerMessageEnvelope } from "../wsclient/frame-handler";
import { displayGameName } from "./match-narrator";
import { PROTOCOL_VERSION } from "../index";
import type { MsgGameOver } from "../protocol/types";
import { loadLocalStrategy } from "../strategy/local-strategy";
import {
  createLocalMatchSessionStore,
  type LocalMatchSessionStore,
} from "../session/local-match-session-store";
import type { AgentDecisionProvider } from "../agents/agent";
import { readBridgeConfig, type BridgeConfig } from "./config";
import { pickAutomaticGame, standbyGamePool } from "./auto-join";
import { declareStandbyGames } from "./daily-policy";
import {
  buildBridgeDecisionProvider,
  createMockRuntimeProvider,
  type BridgeDecisionTrace,
  type BridgeRuntimeProvider,
} from "./provider";
import { createDirectLLMRuntimeProvider } from "./direct-llm-provider";
import { MatchContextTracker } from "./match-context-tracker";
import { appendUsageRecord } from "../usage/usage-log";
import { loadAgentProfile, resolveAgentDir } from "../profile/profile-loader";
import { runSelfReview } from "../review/self-review";
import { exportReviewMarkdown, reviewMetaFromExport } from "../review/review-markdown";
import { fetchNoFollow } from "../net/guarded-fetch";
import { envNotifyLocale } from "../notify/locale";
import type { LLMConfig } from "../profile/config-schema";

export interface BridgeRunnerOptions {
  readonly config: BridgeConfig;
  /**
   * Which program this is: "desktop" or "cli".
   *
   * REQUIRED, and deliberately not defaulted. The server binds an agent to one
   * client on its device and refuses any other — but a connection that declares
   * no kind binds nothing and is always let through, so a caller that silently
   * inherited a default would reopen the very hole this closes (the app and the
   * CLI share ~/.aifight/device.key, so the device check cannot separate them).
   * Making it required means a new embedder has to answer the question.
   */
  readonly clientKind: "desktop" | "cli";
  /**
   * Declare the `match_feed` capability at the WS handshake
   * (X-AIFight-Capabilities), opting this connection into the server's
   * realtime per-player event feed (design: docs/design/LIVE_MATCH_FEED_DESIGN_2026-07-30.md
   * v2). Consumption is render/log only — the runtime routes feed frames to
   * onServerMessage + the session log and the FSM ignores them, so declaring
   * this never triggers LLM calls or changes decision behavior.
   *
   * DEFAULT true: the official clients (this CLI, and the desktop app through
   * its bridge-host) are exactly the clients the feed is built for, so they
   * declare by default — today BOTH simply rely on this default, neither
   * passes the option explicitly (the CLI's feed frames only land in its
   * session logs — narrator consumption is a later phase). The wsclient layer
   * omits the header unless handed capability tokens, so only a client wired
   * through BridgeRunner (or one that opts in deliberately) ever declares;
   * third-party runtimes that never upgrade never send the header, and the
   * server gates per-connection, so their behavior is unchanged either way.
   */
  readonly matchFeed?: boolean;
  readonly runtimeProvider?: BridgeRuntimeProvider;
  readonly autoJoinGame?: "texas_holdem" | "liars_dice" | "coup";
  readonly autoJoinMode?: string;
  readonly autoJoinOneShot?: boolean;
  readonly connect?: ConstructorParameters<typeof AgentInstance>[0]["connect"];
  readonly onLog?: (event: BridgeRunnerLogEvent) => void;
  /** Optional live forward of decision traces (e.g. the desktop cockpit). Session persistence is unaffected. */
  readonly onTrace?: (trace: BridgeDecisionTrace) => void;
  /** Optional live forward of raw server messages (match events, lifecycle) for the desktop cockpit. Session persistence is unaffected. */
  readonly onServerMessage?: (message: ServerMessageEnvelope) => void;
  readonly sessionStore?: LocalMatchSessionStore | false;
}

export interface BridgeRunnerLogEvent {
  readonly level: "info" | "warning" | "error";
  readonly code: string;
  readonly message: string;
}

/** Thrown by BridgeRunner.start() when the server rejects this device — the
 *  agent's credential is bound to a different machine. Carries an actionable
 *  message that the desktop ("error" status) and CLI surface verbatim. */
export class BridgeDeviceMismatchError extends Error {
  readonly code = "device_mismatch" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "BridgeDeviceMismatchError";
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

const DEVICE_MISMATCH_MESSAGE = [
  "This device's identity doesn't match this agent.",
  "For your security, an AIFight agent is tied to one device identity. This can happen if you",
  "updated AIFight, reinstalled, cleared AIFight's data, or switched to another computer or",
  "user account — not only when you move to a genuinely different machine.",
  "Your agent, its match record, and its rating are safe on the server.",
  "",
  'To control it from this device: open the Dashboard, go to your agent → "Connect Bridge",',
  "copy the pairing code, then run:",
  "  aifight connect <PAIRING_CODE> --replace-local-identity",
  "(--replace-local-identity is required because this device already has local credentials.)",
  "",
  "This moves the agent here and signs the old device out.",
  "(If this agent isn't claimed yet, claim it from its claim link first, then pair.)",
].join("\n");

const FOREIGN_HOME_MESSAGE = [
  "This AIFight identity was set up on a different computer.",
  "The local files were copied here, but the identity itself belongs to the machine that",
  "created them, so this agent cannot connect from here — the server would refuse it.",
  "Your agent, its match record, and its rating are safe.",
  "",
  'To move it to this computer: open the Dashboard, go to your agent → "Connect Bridge",',
  "copy the pairing code, then run:",
  "  aifight connect <PAIRING_CODE> --replace-local-identity",
  "(--replace-local-identity is required because this computer already has local files.)",
  "",
  "This moves the agent here and signs the old computer out.",
].join("\n");

/** Thrown by BridgeRunner.start() when the server accepts the machine but not
 *  this PROGRAM: the agent is bound to the other AIFight client on it. */
export class BridgeClientMismatchError extends Error {
  readonly code = "client_mismatch" as const;
  /** Which client the server says owns the agent ("desktop" | "cli" | ""). */
  readonly boundClient: string;
  constructor(message: string, boundClient: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "BridgeClientMismatchError";
    this.boundClient = boundClient;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

function clientMismatchMessage(boundClient: string): string {
  const owner =
    boundClient === "desktop"
      ? "the AIFight desktop app"
      : boundClient === "cli"
        ? "the aifight background service / command line"
        : "another AIFight client";
  return [
    `This agent is bound to ${owner} on this computer.`,
    "An agent keeps ONE connection, so it belongs to one client at a time — this is what",
    "stops two of them fighting over it. Nothing is lost: your agent, its match record and",
    "its rating are safe. It plays whenever the client it is bound to is running; if that",
    "one is stopped, the agent is simply offline until it starts again — or until you move",
    "the agent here.",
    "",
    'To move it here: open the Dashboard, go to your agent → "Connect Bridge", copy the',
    "pairing code, and give it to THIS client:",
    "  aifight connect <PAIRING_CODE> --replace-local-identity",
    "(--replace-local-identity is required because this computer already has local",
    "credentials — the app and the background service share them.)",
    "(In the desktop app, use the same code on its pairing screen.)",
    "",
    "Pairing hands the agent to whichever client redeems the code; the other one steps",
    "aside on its own, with nothing to stop by hand.",
  ].join("\n");
}

/** Thrown by BridgeRunner.start() when the server rejects this machine's SAVED
 *  CREDENTIAL outright — the very first connect answers 401/404.
 *
 *  This is the normal state of the machine an agent has been moved AWAY from:
 *  redeeming a pairing code rotates the api key, so the config left behind holds
 *  a key that no longer exists. It is terminal for the attempt (replaying a dead
 *  key cannot start working) but recoverable by re-pairing, which is exactly the
 *  shape of the two mismatch errors — so callers treat all three alike.
 *
 *  Note it can ONLY surface on a first connect. Once a connection has succeeded,
 *  a later 401 is retried forever and self-heals via refreshApiKey. */
export class BridgeCredentialRejectedError extends Error {
  readonly code = "credential_rejected" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "BridgeCredentialRejectedError";
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

const CREDENTIAL_REJECTED_MESSAGE = [
  "AIFight no longer recognizes this computer's saved credential.",
  "The usual reason is that the agent was moved to another computer (or another client):",
  "pairing there issues a new key and retires this one. It can also mean the key was",
  "rotated from the Dashboard. Your agent, its match record, and its rating are safe.",
  "",
  'To run it here again: open the Dashboard, go to your agent → "Connect Bridge", copy',
  "the pairing code, then run:",
  "  aifight connect <PAIRING_CODE> --replace-local-identity",
  "(--replace-local-identity is required because this computer already has local",
  "credentials — the retired ones.)",
].join("\n");

/** Walk an error's `cause` chain looking for a rejected credential: a handshake
 *  answered 401 (bad/retired key) or 404 (agent gone). Mirrors the two mismatch
 *  detectors, including their tolerance for a duplicated error class across
 *  bundles, where `instanceof` silently fails. */
function isCredentialRejected(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 8 && cur != null; depth++) {
    if (cur instanceof WSHandshakeError && (cur.statusCode === 401 || cur.statusCode === 404)) {
      return true;
    }
    if (typeof cur === "object" && cur !== null && "statusCode" in cur && "responseBody" in cur) {
      const sc = (cur as { readonly statusCode?: unknown }).statusCode;
      if (sc === 401 || sc === 404) return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** Walk an error's `cause` chain looking for a client-mismatch (403) rejection. */
function findClientMismatch(err: unknown): { boundClient: string } | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 8 && cur != null; depth++) {
    if (cur instanceof WSClientMismatchError) return { boundClient: cur.boundClient };
    // Fallback for a duplicated error class across bundles (same reasoning as
    // isDeviceMismatchError): recognise the server token in the 403 body.
    if (typeof cur === "object" && cur !== null && "responseBody" in cur) {
      const body = (cur as { readonly responseBody?: unknown }).responseBody;
      if (typeof body === "string" && body.includes("client_mismatch")) {
        return { boundClient: /"bound_client"\s*:\s*"([a-z]{1,32})"/.exec(body)?.[1] ?? "" };
      }
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** Walk an error's `cause` chain looking for a device-mismatch (403) rejection. */
function isDeviceMismatchError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 8 && cur != null; depth++) {
    if (cur instanceof WSDeviceMismatchError) return true;
    // Fallbacks for when `instanceof` fails (duplicated error class across
    // bundles): match the real "device mismatch" message (a space) and the
    // server "device_mismatch" token, plus the 403 handshake responseBody.
    if (cur instanceof Error && /device[ _]mismatch/i.test(cur.message)) return true;
    if (typeof cur === "object" && cur !== null && "responseBody" in cur) {
      const body = (cur as { readonly responseBody?: unknown }).responseBody;
      if (typeof body === "string" && body.includes("device_mismatch")) return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** Derive the presence-probe URL from the bridge's WS URL:
 *  wss://host/api/ws → https://host/api/agents/me/presence. Null when the WS
 *  URL is unparsable or not the expected shape — the probe then reports
 *  "unavailable" and the facade keeps its cautious blind-dial cadence. */
export function presenceURLFromWSURL(wsUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(wsUrl);
  } catch {
    return null;
  }
  if (parsed.protocol === "wss:") parsed.protocol = "https:";
  else if (parsed.protocol === "ws:") parsed.protocol = "http:";
  else return null;
  if (!parsed.pathname.endsWith("/ws")) return null;
  parsed.pathname = `${parsed.pathname.slice(0, -"/ws".length)}/agents/me/presence`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export class BridgeRunner {
  readonly #opts: BridgeRunnerOptions;
  #agent: AgentInstance | null = null;
  /** Per-match player-view event log + rules summary for the decision prompt. */
  #matchContext = new MatchContextTracker();
  /** R13-F08: last credential observed on disk — logs rotation exactly once. */
  #lastKnownApiKey: string;
  /** R2 standby fallback: self-join when the platform assigns nothing in time. */
  #standbyFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  /** R15 (2026-07-26): connection-state subscribers registered before start()
   *  produced a connected agent. They used to get a no-op unsubscribe and never
   *  a snapshot; now start() attaches them once the reconnect client exists. */
  readonly #pendingConnHandlers = new Set<{
    readonly handler: ReconnectStateHandler;
    unsubscribe: (() => void) | null;
  }>();
  #manualSeries: {
    readonly game: "texas_holdem" | "liars_dice" | "coup";
    readonly mode?: string;
    remainingAfterCurrent: number;
  } | null = null;

  constructor(opts: BridgeRunnerOptions) {
    this.#opts = opts;
    this.#lastKnownApiKey = opts.config.apiKey;
  }

  async start(): Promise<AgentInstanceSnapshot> {
    if (this.#agent !== null) return this.#agent.snapshot();

    // Answer the copied-home case here, before opening a socket. The server
    // refuses it either way, but a 403 four seconds into a connect reads as a
    // network fault; this says what actually happened, in the first moment, and
    // works with no connection at all. A machine that will not identify itself
    // reports "unverifiable" and is waved through — the check never invents a
    // reason to keep someone off their own computer.
    const identity = checkLocalDeviceIdentity();
    if (identity.status === "foreign") {
      this.#log("error", "bridge.device_mismatch", FOREIGN_HOME_MESSAGE);
      throw new BridgeDeviceMismatchError(FOREIGN_HOME_MESSAGE);
    }

    const provider = this.#opts.runtimeProvider ?? providerForConfig(this.#opts.config);
    const sessionStore = this.#createSessionStore();
    const ws: ReconnectingWSClientOptions = {
      url: this.#opts.config.wsUrl,
      apiKey: this.#opts.config.apiKey,
      deviceId: getDeviceId(),
      clientKind: this.#opts.clientKind,
      // Opt into the match_feed push unless the host explicitly declines —
      // see BridgeRunnerOptions.matchFeed for the default-true rationale.
      capabilities:
        this.#opts.matchFeed === false ? undefined : [CLIENT_CAPABILITY_MATCH_FEED],
      expectedProtocolVersion: PROTOCOL_VERSION,
      // R13-F08: after a 401 on reconnect, re-read the bridge config so a
      // credential rotated by re-pairing is picked up without a restart.
      refreshApiKey: () => this.#refreshApiKey(),
      // Redesign P3 先问后拨: while parked (another connection holds the
      // seat), ask the server whether the seat has freed up before dialing —
      // a dial evicts the holder unconditionally. null (endpoint missing /
      // unreachable) lets the facade fall back to its cautious blind-dial
      // cadence.
      probeSeat: () => this.#probeSeat(),
    };

    const agent = new AgentInstance({
      name: this.#opts.config.agentName,
      ws,
      autoConfirmMatches: true,
      decisionProvider: this.#buildDecisionProvider(provider, sessionStore),
      ...(this.#opts.connect !== undefined ? { connect: this.#opts.connect } : {}),
      onServerMessage: (message) => {
        // Feed the match-context tracker first: the very next decision may
        // depend on the events this message carries. Additive only — a tracker
        // failure must never block message handling or session persistence.
        try {
          this.#matchContext.observe(message);
        } catch {
          /* context is best-effort; the decision path degrades gracefully */
        }
        this.#opts.onServerMessage?.(message);
        if (sessionStore === null) return;
        this.#recordSession(() => sessionStore.recordServerMessage(this.#opts.config, message));
      },
      onClientMessage: (message) => {
        if (sessionStore === null) return;
        this.#recordSession(() => sessionStore.recordClientMessage(this.#opts.config, message));
      },
      onReadinessCheck: async (data) => this.#buildRuntimeStatus(provider, data),
      onNotify: (event) => {
        if (event.code === "agent.device_mismatch") {
          this.#log("error", "bridge.device_mismatch", DEVICE_MISMATCH_MESSAGE);
          return;
        }
        this.#log(event.level, event.code, event.message);
      },
      onResult: (gameOver, context) => {
        this.#log(
          "info",
          "bridge.match_complete",
          formatMatchComplete(this.#opts.config, gameOver, context.game),
        );
        this.#continueManualSeries();
        this.#maybeAutoReview(gameOver, sessionStore);
      },
      onFallbackRequired: (effect) => {
        this.#log(
          "warning",
          "bridge.fallback_required",
          `No action sent for match ${effect.actionRequest.data.match_id}; runtime decision failed`,
        );
      },
    });

    this.#agent = agent;
    let snapshot: AgentInstanceSnapshot;
    try {
      snapshot = await agent.start();
    } catch (err) {
      if (isDeviceMismatchError(err)) {
        // Reset so a re-pair (`aifight connect`) + restart can succeed.
        this.#agent = null;
        this.#log("error", "bridge.device_mismatch", DEVICE_MISMATCH_MESSAGE);
        throw new BridgeDeviceMismatchError(DEVICE_MISMATCH_MESSAGE, { cause: err });
      }
      const clientMismatch = findClientMismatch(err);
      if (clientMismatch !== null) {
        // Same reset: pairing from this client is the recovery, and it must be
        // able to start cleanly afterwards.
        this.#agent = null;
        const message = clientMismatchMessage(clientMismatch.boundClient);
        this.#log("error", "bridge.client_mismatch", message);
        throw new BridgeClientMismatchError(message, clientMismatch.boundClient, { cause: err });
      }
      if (isCredentialRejected(err)) {
        // Same reset + same shape as the two mismatches: re-pairing from this
        // client is the recovery, and it has to be able to start cleanly after.
        this.#agent = null;
        this.#log("error", "bridge.credential_rejected", CREDENTIAL_REJECTED_MESSAGE);
        throw new BridgeCredentialRejectedError(CREDENTIAL_REJECTED_MESSAGE, { cause: err });
      }
      // R13 (2026-07-26): any other fatal first-connect error (protocol-version
      // skew, invalid welcome, non-mismatch 4xx) must also clear #agent, or a
      // host that retries start() on the same runner hits the `#agent !== null`
      // short-circuit at start() and gets a success-shaped snapshot of a dead
      // agent that never connected. The three special-cased resets above prove
      // retry-on-same-runner is a supported pattern; this is the missing arm.
      this.#agent = null;
      throw err;
    }
    // R15 (2026-07-26): attach subscribers that arrived before the connection
    // existed; each gets the facade's immediate snapshot fire on attach.
    for (const entry of this.#pendingConnHandlers) {
      entry.unsubscribe = agent.onConnectionStateChange(entry.handler);
    }
    this.#pendingConnHandlers.clear();
    this.#log("info", "bridge.connected", `Connected ${this.#opts.config.agentName}`);
    void this.#warnIfTermsPending();
    if (this.#opts.autoJoinGame !== undefined || this.#opts.autoJoinOneShot !== true) {
      const oneShot = this.#opts.autoJoinOneShot === true;
      // V3 重启精确化: the daily cap / games decision is re-read from disk at
      // EVERY connect edge (the matchingPaused discipline), so `aifight set
      // daily` / `aifight set game` reach a RUNNING bridge within ~a reconnect
      // cycle instead of needing a manual restart. A manual one-shot launch is
      // the exception: its game is explicit and stays frozen.
      const edge = this.#autoJoinDecision();
      const launchedDaily = this.#opts.autoJoinGame !== undefined;
      if (this.#matchingPaused()) {
        if (edge !== null || launchedDaily) {
          this.#log(
            "info",
            "bridge.auto_join_paused",
            "Automatic matching is paused — staying out of the queue (`aifight resume` re-enables it).",
          );
        }
      } else if (edge !== null && !oneShot && this.#standbyFallbackMinutes() > 0) {
        // R2 platform orchestration (owner ruling 2026-07-31): instead of
        // self-queueing into a random game, DECLARE the standby set and let the
        // platform's supply sweep assign one. The fallback timer preserves the
        // legacy behavior end-to-end: old server, sweep knob off, or an idle
        // platform all resolve to a normal self-join a few minutes later.
        this.#declareStandby();
        this.#armStandbyFallback(agent);
      } else if (edge !== null) {
        agent.joinQueue(edge.game, this.#opts.autoJoinMode, { oneShot });
        this.#log(
          "info",
          "bridge.queue_joined",
          oneShot
            ? `Joined ${edge.game} for one manual match`
            : `Joined ${edge.game} for daily automatic matching`,
        );
      } else if (launchedDaily) {
        // Launched for daily auto-join, but the cap is 0 now — the running
        // bridge adopts the new cap right at this connect edge.
        this.#log(
          "info",
          "bridge.auto_join_cap_off",
          "Daily automatic matching is off (cap 0) — staying out of the queue (`aifight set daily <N>` re-enables it).",
        );
      }
      if (!oneShot) {
        // 连接审计 #2 (2026-07-28): the server drops this agent from every
        // queue the moment its socket dies (hub.OnQueueLeave), and the FSM now
        // clears its queue belief on reconnect — so every recovered connection
        // must RE-join, or the agent sits "online" and never plays again until
        // the process restarts. This is the CLI half of the desktop's F9 fix,
        // placed in the shared runner so every host heals the same way.
        // (The subscriber fires once immediately with the current snapshot —
        // prev === null skips it; the launch join above already happened.)
        // Attached even for manual-only launches: the edge decision is re-read
        // on every reconnect, so a cap set mid-run is adopted here too.
        let last: string | null = null;
        agent.onConnectionStateChange((snap) => {
          const prev = last;
          last = snap.state;
          if (snap.state !== "connected" || prev === null || prev === "connected") return;
          if (this.#matchingPaused()) {
            if (this.#autoJoinDecision() !== null || this.#opts.autoJoinGame !== undefined) {
              this.#log(
                "info",
                "bridge.auto_join_paused",
                "Reconnected while automatic matching is paused — not re-joining the queue.",
              );
            }
            return;
          }
          const reEdge = this.#autoJoinDecision();
          if (reEdge === null) {
            if (this.#opts.autoJoinGame !== undefined) {
              this.#log(
                "info",
                "bridge.auto_join_cap_off",
                "Reconnected with the daily cap at 0 — not re-joining the queue.",
              );
            }
            return;
          }
          if (this.#standbyFallbackMinutes() > 0) {
            // Same R2 posture as the first connect: re-declare (the server may
            // have restarted) and re-arm the fallback instead of self-joining.
            this.#declareStandby();
            this.#armStandbyFallback(agent);
            return;
          }
          try {
            agent.joinQueue(reEdge.game, this.#opts.autoJoinMode, { oneShot: false });
            this.#log(
              "info",
              "bridge.queue_rejoined",
              `Reconnected — re-joined the ${reEdge.game} queue`,
            );
          } catch {
            // join_queue sends over the live socket; if it raced a re-drop the
            // next connected edge retries.
          }
        });
      }
    }
    return snapshot;
  }

  /**
   * One-shot, non-blocking check at connect: if the claimed owner still needs to
   * accept the current Terms/Privacy (server terms_pending), surface a gentle
   * notice pointing at the browser dashboard. Agent play is unaffected; the call
   * is best-effort and never throws or blocks the run.
   */
  async #warnIfTermsPending(): Promise<void> {
    try {
      const base = this.#opts.config.baseUrl.replace(/\/+$/, "");
      const res = await fetchNoFollow(`${base}/api/agents/me/status`, {
        headers: { "X-API-Key": this.#opts.config.apiKey },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return;
      const body = (await res.json().catch(() => null)) as { terms_pending?: unknown } | null;
      if (body !== null && body.terms_pending === true) {
        this.#log(
          "warning",
          "bridge.terms_pending",
          `Updated Terms/Privacy must be accepted to keep your agent active. Accept in the CLI: \`aifight accept-terms\` (or in the browser: ${base}/dashboard).`,
        );
      }
    } catch {
      // Best-effort: never block or fail the run on this notice.
    }
  }

  async stop(): Promise<void> {
    this.#clearStandbyFallback();
    if (this.#agent === null) return;
    await this.#agent.stop("bridge stop");
    this.#agent = null;
    this.#manualSeries = null;
  }

  snapshot(): AgentInstanceSnapshot | null {
    return this.#agent?.snapshot() ?? null;
  }

  // ── Reconnect-redesign surface (2026-07-25) for hosts ──

  /** Wake the reconnect loop now (P2). The desktop host calls this on
   *  powerMonitor "resume"; safe no-op when not running. */
  poke(): void {
    this.#agent?.poke();
  }

  /** Hand the seat back and stop retrying until poke() (P5). The desktop host
   *  calls this on powerMonitor "suspend"; safe no-op when not running. */
  suspendConnection(): void {
    this.#agent?.suspendConnection();
  }

  /** Connection-state projection (P4) — hosts derive their UI phase from
   *  THESE snapshots, never by narrating the log stream. Subscribing before
   *  start() completes is allowed: the handler is buffered and attached (with
   *  the facade's immediate snapshot fire) once the connection exists. */
  onConnectionStateChange(handler: ReconnectStateHandler): () => void {
    const agent = this.#agent;
    // connectionSnapshot() is null exactly while the reconnect client does not
    // exist yet (before start() / start() in flight) — attaching then throws.
    if (agent !== null && agent.connectionSnapshot() !== null) {
      return agent.onConnectionStateChange(handler);
    }
    const entry = { handler, unsubscribe: null as (() => void) | null };
    this.#pendingConnHandlers.add(entry);
    return () => {
      this.#pendingConnHandlers.delete(entry);
      entry.unsubscribe?.();
    };
  }

  connectionSnapshot(): ReconnectStateSnapshot | null {
    return this.#agent?.connectionSnapshot() ?? null;
  }

  /** One ask-before-dial probe against /api/agents/me/presence. Returns null
   *  when the endpoint is unavailable (old server, network fault) — the
   *  facade then falls back to its cautious blind-dial cadence. */
  async #probeSeat(): Promise<SeatProbeResult | null> {
    const url = presenceURLFromWSURL(this.#opts.config.wsUrl);
    if (url === null) return null;
    // Probe with the freshest credential we can get: a re-pair may have
    // rotated the key while we were parked (same reason refreshApiKey exists).
    let apiKey = this.#lastKnownApiKey;
    try {
      const fresh = await this.#refreshApiKey();
      if (typeof fresh === "string" && fresh !== "") apiKey = fresh;
    } catch {
      /* keep the cached key */
    }
    try {
      // R13 (2026-07-26): X-API-Key is secret-bearing, so use the no-follow guard
      // like the sibling #warnIfTermsPending — a 3xx to a foreign origin would
      // otherwise replay the platform key to that origin. fetchNoFollow throws on
      // any redirect; the catch below maps that to null (probe unavailable).
      const res = await fetchNoFollow(url, {
        method: "GET",
        headers: {
          "X-API-Key": apiKey,
          "X-AIFight-Instance": PROCESS_INSTANCE_ID,
        },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return null; // 404 = old server; anything else = unknown
      const body: unknown = await res.json();
      if (
        typeof body === "object" &&
        body !== null &&
        typeof (body as { connected?: unknown }).connected === "boolean" &&
        typeof (body as { instance_matches?: unknown }).instance_matches === "boolean"
      ) {
        return {
          connected: (body as { connected: boolean }).connected,
          instanceMatches: (body as { instance_matches: boolean }).instance_matches,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  joinQueue(
    game: "texas_holdem" | "liars_dice" | "coup",
    mode?: string,
    opts: { readonly oneShot?: boolean; readonly count?: number } = {},
  ): void {
    if (opts.oneShot === true || (opts.count ?? 1) > 1) {
      this.requestManualMatches(game, mode, opts.count ?? 1);
      return;
    }
    const agent = this.#requireAgent();
    agent.joinQueue(game, mode);
    this.#log(
      "info",
      "bridge.queue_joined",
      `Joined ${game} for ${mode ?? "default"} matching`,
    );
  }

  leaveQueue(): void {
    const agent = this.#requireAgent();
    this.#manualSeries = null;
    agent.leaveQueue();
  }

  requestManualMatches(
    game: "texas_holdem" | "liars_dice" | "coup",
    mode = "ranked",
    count = 1,
  ): void {
    if (!Number.isInteger(count) || count < 1 || count > 20) {
      throw new Error("manual match count must be an integer between 1 and 20");
    }
    const agent = this.#requireAgent();
    const phase = agent.snapshot().state?.phase;
    if (
      phase === "confirming" ||
      phase === "matching" ||
      phase === "in_match" ||
      phase === "deciding" ||
      phase === "reporting"
    ) {
      throw new Error("agent is already in or entering a match; try again after the current match completes");
    }
    this.#manualSeries = count > 1
      ? { game, mode, remainingAfterCurrent: count - 1 }
      : null;
    agent.joinQueue(game, mode, { oneShot: true });
    this.#log(
      "info",
      "bridge.queue_joined",
      count === 1
        ? `Joined ${game} for one manual match`
        : `Joined ${game} for ${count} manual matches`,
    );
  }

  #log(level: BridgeRunnerLogEvent["level"], code: string, message: string): void {
    this.#opts.onLog?.({ level, code, message });
  }

  /**
   * The pause flag, read FRESH from disk at every connect edge. `aifight
   * pause` writes bridge.json while this bridge is running; a snapshot frozen
   * at construction would keep re-joining on every reconnect until a restart,
   * silently undoing the pause (the same reason refreshApiKey re-reads). When
   * the file is unreadable, fall back to the config the runner started with —
   * a half-written config must never flip a running bridge into paused, and a
   * missing one just means "not paused".
   */
  #matchingPaused(): boolean {
    try {
      return readBridgeConfig().matchingPaused === true;
    } catch {
      return this.#opts.config.matchingPaused === true;
    }
  }

  /**
   * The daily auto-join decision, read FRESH from disk at every connect edge
   * (V3 重启精确化 — same seam and rationale as #matchingPaused): `aifight set
   * daily` / `aifight set game` write bridge.json while this bridge is running,
   * and a snapshot frozen at start() would keep the old cap/games until a
   * manual restart. A running bridge now adopts the new values within ~a
   * reconnect cycle.
   *
   * Rules:
   *   - a manual ONE-SHOT launch keeps its explicit frozen game (the daily
   *     prefs do not apply to it);
   *   - an explicit cap on disk wins (0 = off, and the games list comes from
   *     disk too); with no explicit cap anywhere, the launch-time option is
   *     the fallback — the same "unreadable file must not flip a running
   *     bridge" discipline as #matchingPaused.
   */
  #autoJoinDecision(): { readonly game: "texas_holdem" | "liars_dice" | "coup" } | null {
    if (this.#opts.autoJoinOneShot === true) {
      return this.#opts.autoJoinGame !== undefined ? { game: this.#opts.autoJoinGame } : null;
    }
    let cap = this.#opts.config.autoDailyLimit;
    let games = this.#opts.config.autoGames;
    try {
      const disk = readBridgeConfig();
      cap = disk.autoDailyLimit ?? cap;
      games = disk.autoGames ?? games;
    } catch {
      // Frozen snapshot fallback — see #matchingPaused.
    }
    if (cap !== undefined) {
      if (cap <= 0) return null;
      return { game: pickAutomaticGame(games) };
    }
    return this.#opts.autoJoinGame !== undefined ? { game: this.#opts.autoJoinGame } : null;
  }

  /**
   * How long to wait for the platform to assign a game before self-joining
   * (R2). Fresh from disk like every other standby knob; default 5 minutes.
   * 0 = self-join immediately at the connect edge (the pre-R2 behavior).
   */
  #standbyFallbackMinutes(): number {
    let minutes = this.#opts.config.standbyFallbackJoinMinutes;
    try {
      minutes = readBridgeConfig().standbyFallbackJoinMinutes ?? minutes;
    } catch {
      // Frozen snapshot fallback — see #matchingPaused.
    }
    if (minutes === undefined || !Number.isFinite(minutes) || minutes < 0) return 5;
    return minutes;
  }

  /**
   * Declare the standby set to the platform (fire-and-forget): the games list
   * the supply sweep may assign this agent to. A failure only means the
   * platform cannot orchestrate — the fallback timer covers exactly that, so
   * this logs once and never retries hot. Re-reads the games from disk so a
   * mid-run `aifight set game` reaches the next declaration.
   */
  #declareStandby(): void {
    let games = this.#opts.config.autoGames;
    try {
      games = readBridgeConfig().autoGames ?? games;
    } catch {
      // Frozen snapshot fallback.
    }
    const pool = standbyGamePool(games);
    void declareStandbyGames(this.#opts.config, pool)
      .then(() => {
        this.#log(
          "info",
          "bridge.standby_declared",
          `Standing by for ${pool.join(", ")} — the platform assigns the game (self-join fallback in ${this.#standbyFallbackMinutes()}min).`,
        );
      })
      .catch((cause) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        this.#log(
          "info",
          "bridge.standby_declare_failed",
          `Standby declaration not accepted (${message}) — the self-join fallback will queue normally.`,
        );
      });
  }

  /**
   * Arm (or re-arm) the standby fallback: after #standbyFallbackMinutes with
   * no platform-assigned activity, self-join one game the legacy way. The
   * timer re-arms itself, so a long idle stretch keeps retrying instead of
   * going quiet after one attempt.
   */
  #armStandbyFallback(agent: AgentInstance): void {
    this.#clearStandbyFallback();
    const minutes = this.#standbyFallbackMinutes();
    if (minutes <= 0) return;
    this.#standbyFallbackTimer = setTimeout(() => {
      this.#standbyFallbackTimer = null;
      if (this.#agent === null) return; // stopped

      if (this.#matchingPaused()) {
        this.#armStandbyFallback(agent);
        return;
      }
      const edge = this.#autoJoinDecision();
      if (edge === null) {
        this.#armStandbyFallback(agent);
        return;
      }
      const phase = agent.snapshot().state?.phase;
      if (
        phase === "confirming" ||
        phase === "matching" ||
        phase === "in_match" ||
        phase === "deciding" ||
        phase === "reporting"
      ) {
        // The platform DID orchestrate (queued or playing) — nothing to rescue.
        this.#armStandbyFallback(agent);
        return;
      }
      try {
        agent.joinQueue(edge.game, this.#opts.autoJoinMode, { oneShot: false });
        this.#log(
          "info",
          "bridge.standby_fallback_join",
          `No platform assignment after ${minutes}min — self-joined the ${edge.game} queue (legacy behavior).`,
        );
      } catch {
        // Socket mid-reconnect: the next connect edge re-declares and re-arms.
      }
      this.#armStandbyFallback(agent);
    }, minutes * 60_000);
    this.#standbyFallbackTimer.unref?.();
  }

  #clearStandbyFallback(): void {
    if (this.#standbyFallbackTimer !== null) {
      clearTimeout(this.#standbyFallbackTimer);
      this.#standbyFallbackTimer = null;
    }
  }

  /** R13-F08: re-read the bridge config after a 401 reconnect failure so a
   *  rotated credential is picked up without a restart. Returns the current
   *  key (null when the config is unreadable — keeps the cached key). Logs
   *  only on an actual change, and never logs key material. */
  #refreshApiKey(): string | null {
    try {
      const fresh = readBridgeConfig().apiKey;
      if (typeof fresh !== "string" || fresh === "") return null;
      if (fresh !== this.#lastKnownApiKey) {
        this.#lastKnownApiKey = fresh;
        this.#log(
          "info",
          "bridge.credential_rotated",
          "Bridge credential changed on disk after an authentication failure — reconnecting with the new credential.",
        );
      }
      return fresh;
    } catch {
      return null;
    }
  }

  #createSessionStore(): LocalMatchSessionStore | null {
    if (this.#opts.sessionStore === false) return null;
    if (this.#opts.sessionStore !== undefined) return this.#opts.sessionStore;
    try {
      return createLocalMatchSessionStore();
    } catch (cause) {
      this.#log(
        "warning",
        "bridge.session_store_unavailable",
        `Local match session ledger is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return null;
    }
  }

  #buildDecisionProvider(
    provider: BridgeRuntimeProvider,
    sessionStore: LocalMatchSessionStore | null,
  ): AgentDecisionProvider {
    return {
      decide: async (ctx) => {
        const traces: BridgeDecisionTrace[] = [];
        const startedAt = new Date();
        const decisionProvider = buildBridgeDecisionProvider(provider, {
          loadStrategy: ({ game }) => loadLocalStrategy(this.#opts.config.agentId, game),
          loadMatchContext: ({ matchId }) => this.#matchContext.get(matchId),
          onTrace: (trace) => {
            traces.push(trace);
            this.#opts.onTrace?.(trace);
          },
          ...(this.#opts.config.illegalRetryCount !== undefined
            ? { illegalRetryCount: this.#opts.config.illegalRetryCount }
            : {}),
          // §7A local usage ledger: one JSONL line per model call, written on
          // the user's machine only. appendUsageRecord is silent on failure —
          // stats must never affect play.
          onUsage: (e) => {
            appendUsageRecord({
              ts: new Date().toISOString(),
              match_id: e.matchId,
              game: e.game,
              provider: e.usage.provider,
              model: e.usage.model,
              ...(e.usage.inputTokens !== undefined ? { input_tokens: e.usage.inputTokens } : {}),
              ...(e.usage.outputTokens !== undefined ? { output_tokens: e.usage.outputTokens } : {}),
              ...(e.usage.reasoningTokens !== undefined
                ? { reasoning_tokens: e.usage.reasoningTokens }
                : {}),
              ...(e.usage.cachedTokens !== undefined ? { cached_tokens: e.usage.cachedTokens } : {}),
              ...(e.usage.cacheWriteTokens !== undefined
                ? { cache_write_tokens: e.usage.cacheWriteTokens }
                : {}),
              ...(e.usage.latencyMs !== undefined ? { latency_ms: e.usage.latencyMs } : {}),
              decision_source: e.decisionSource,
            });
          },
        });
        try {
          const action = await decisionProvider.decide(ctx);
          if (sessionStore !== null) {
            const completedAt = new Date();
            this.#recordSession(() =>
              sessionStore.recordDecision({
                config: this.#opts.config,
                context: ctx,
                startedAt,
                completedAt,
                traces,
                action,
              }),
            );
          }
          return action;
        } catch (error) {
          if (sessionStore !== null) {
            const completedAt = new Date();
            this.#recordSession(() =>
              sessionStore.recordDecision({
                config: this.#opts.config,
                context: ctx,
                startedAt,
                completedAt,
                traces,
                error,
              }),
            );
          }
          throw error;
        }
      },
    };
  }

  #recordSession(fn: () => void): void {
    try {
      fn();
    } catch (cause) {
      this.#log(
        "warning",
        "bridge.session_record_failed",
        `Could not update local match session ledger: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  #requireAgent(): AgentInstance {
    if (this.#agent === null) {
      throw new Error("bridge runner is not started");
    }
    return this.#agent;
  }

  #continueManualSeries(): void {
    const series = this.#manualSeries;
    const agent = this.#agent;
    if (series === null || agent === null) return;
    if (series.remainingAfterCurrent <= 0) {
      this.#manualSeries = null;
      return;
    }
    try {
      agent.joinQueue(series.game, series.mode, { oneShot: true });
      series.remainingAfterCurrent -= 1;
      this.#log(
        "info",
        "bridge.queue_joined",
        series.remainingAfterCurrent === 0
          ? `Joined ${series.game} for the final manual match in this request`
          : `Joined ${series.game} for the next manual match; ${series.remainingAfterCurrent} remaining after this one`,
      );
    } catch (cause) {
      this.#manualSeries = null;
      this.#log(
        "error",
        "bridge.manual_requeue_failed",
        `Could not request the next manual match: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  /**
   * Post-match self-review trigger (SELF_REVIEW_DESIGN.md §4). Fire-and-forget:
   * it must never block the agent loop or throw into it. A no-op unless the
   * owner opted in (selfReview.autoMode != "off"); default is off.
   */
  #maybeAutoReview(gameOver: MsgGameOver, store: LocalMatchSessionStore | null): void {
    if (store === null) return;
    if (this.#opts.config.runtimeType !== "direct") return;
    const sessionId = gameOver.data.session_id;
    if (typeof sessionId !== "string" || sessionId === "") return;
    void this.#runAutoReview(sessionId, gameOver, store).catch((cause) => {
      this.#log(
        "warning",
        "bridge.self_review_failed",
        `auto self-review failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    });
  }

  async #runAutoReview(
    sessionId: string,
    gameOver: MsgGameOver,
    store: LocalMatchSessionStore,
  ): Promise<void> {
    const slug = this.#opts.config.directAgentSlug ?? "default";
    let config: LLMConfig | undefined;
    try {
      const { profile } = await loadAgentProfile(resolveAgentDir(slug));
      config = profile.config;
    } catch {
      return; // no usable LLM config → nothing to review with
    }
    if (!config) return;
    const mode = config.selfReview?.autoMode ?? "off";
    if (mode === "off") return;
    if (mode === "losses_only" && !agentLostMatch(this.#opts.config.agentId, gameOver)) return;
    if (store.readSelfReview(sessionId)) return; // already reviewed (reconnect/replay)
    const exported = store.exportSession(sessionId);
    if (!exported) return;
    const review = await runSelfReview({
      exported,
      config,
      trigger: "auto",
      locale: envReviewLocale(),
    });
    store.writeSelfReview(sessionId, review);
    this.#log("info", "bridge.self_review", `Saved auto self-review for ${sessionId}`);
    // Owner opt-in Markdown copy (selfReview.exportDir). Best-effort on top of
    // the JSON above — a failed export must not cost the review, let alone a match.
    const exportDir = config.selfReview?.exportDir;
    if (exportDir !== undefined && exportDir.trim() !== "") {
      try {
        const file = exportReviewMarkdown(
          exportDir,
          review,
          reviewMetaFromExport(exported, this.#opts.config.baseUrl),
        );
        this.#log("info", "bridge.self_review_export", `Exported the review as ${file}`);
      } catch (cause) {
        this.#log(
          "warning",
          "bridge.self_review_export_failed",
          `Could not export the review to ${exportDir}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
  }

  async #buildRuntimeStatus(provider: BridgeRuntimeProvider, data: unknown): Promise<Record<string, unknown>> {
    const requestId = readRequestId(data);
    const checkedAt = new Date().toISOString();
    // Phase 1B readiness handshake — a pure connection/state self-check that NEVER
    // calls the LLM (zero user tokens). Reaching this handler already means the
    // bridge is online (it received the server's readiness_check); we report ready
    // when it also has spare match capacity (idle). Balance/key validity is
    // intentionally NOT probed here — a real match failure is the backstop for that.
    // (Mirrors the server-side contract in internal/hub/readiness_wait.go: the
    // client never spends tokens to answer a readiness probe.)
    const base = {
      request_id: requestId,
      runtime_type: this.#opts.config.runtimeType,
      runtime_name: provider.name,
      checked_at: checkedAt,
    };
    // Generous cap: catches a stuck pile-up, not normal concurrent play. A local
    // "is the user accepting matches?" pause toggle can refine this later. Shared
    // ONE source of truth with the FSM's game_start admission gate (R13-F02).
    const maxConcurrent = MAX_CONCURRENT_MATCHES;
    const activeMatches = this.#agent?.activeMatchCount ?? 0;
    // Capacity travels inside `detail` — the runtime_status schema is closed
    // (additionalProperties:false), so extra top-level keys would fail the
    // client's own outbound validation and the reply would never be sent.
    if (activeMatches >= maxConcurrent) {
      return {
        ...base,
        ready: false,
        detail: `busy: ${activeMatches}/${maxConcurrent} matches in flight`,
      };
    }
    return {
      ...base,
      ready: true,
      detail: `ready (${activeMatches}/${maxConcurrent} matches in flight)`,
    };
  }
}

function readRequestId(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const value = (data as Record<string, unknown>).request_id;
  return typeof value === "string" ? value : "";
}

function formatMatchComplete(config: BridgeConfig, gameOver: MsgGameOver, game?: string): string {
  const lines = [
    `Match complete: ${displayGameName(game)}`,
    `Result: ${resultLabel(config.agentId, gameOver)}`,
  ];
  const replay = fullReplayURL(config.baseUrl, gameOver.data.replay_url);
  if (replay !== undefined) {
    lines.push(`Replay: ${replay}`);
  } else if (gameOver.data.forfeit_reason !== undefined) {
    lines.push(`Forfeit reason: ${gameOver.data.forfeit_reason}`);
  }
  return lines.join("\n");
}

/** The one place that decides what a finished match says about us —
 *  "1st place" / "forfeit" / "opponent forfeit" / "draw". Exported so the
 *  notification layer reports exactly what the bridge log reports. */
export function resultLabel(agentId: string, gameOver: MsgGameOver): string {
  const player = gameOver.data.players.find((p) => p.agent_id === agentId);
  if (player === undefined) return "completed";

  if (gameOver.data.forfeited_by === player.player_id) {
    return "forfeit";
  }
  if (gameOver.data.forfeit_reason !== undefined) {
    return "opponent forfeit";
  }
  if (gameOver.data.result.is_draw) return "draw";

  const ownPayoff = gameOver.data.result.payoffs[player.player_id];
  if (typeof ownPayoff !== "number") {
    return gameOver.data.result.winner === player.player_id ? "1st place" : "completed";
  }
  const higher = Object.values(gameOver.data.result.payoffs).filter((payoff) => payoff > ownPayoff).length;
  return `${ordinal(higher + 1)} place`;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** True when the agent clearly lost (for selfReview autoMode "losses_only").
 *  Reuses resultLabel so the win/draw/forfeit logic stays in one place; an
 *  ambiguous "completed" is treated as not-a-loss to avoid spurious reviews. */
function agentLostMatch(agentId: string, gameOver: MsgGameOver): boolean {
  const label = resultLabel(agentId, gameOver);
  if (label === "forfeit") return true;
  return /^([2-9]|\d{2,})(st|nd|rd|th) place$/.test(label);
}

/** Locale for an auto-triggered review (the headless bridge has no UI locale).
 *  Same environment rule as `aifight review` and the notification channels —
 *  see notify/locale.ts, which is the only place that rule lives. */
function envReviewLocale(): string {
  return envNotifyLocale();
}

export function fullReplayURL(baseUrl: string, replayPath: string | undefined): string | undefined {
  if (replayPath === undefined || replayPath.trim() === "") return undefined;
  try {
    return new URL(replayPath, `${baseUrl.replace(/\/+$/, "")}/`).toString();
  } catch {
    return replayPath;
  }
}

function providerForConfig(config: BridgeConfig): BridgeRuntimeProvider {
  if (config.runtimeType === "mock") return createMockRuntimeProvider();
  return createDirectLLMRuntimeProvider({ agentSlug: config.directAgentSlug ?? "default" });
}
