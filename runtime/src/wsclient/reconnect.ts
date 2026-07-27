// M1-07 reconnect manager — exponential backoff + jitter + close-code dispatch.
//
// Wraps M1-06 createWSClient() in a stable facade that survives across
// transient disconnects. See docs/plans/m1/M1-07.md for the original design
// TED and docs/agent-bridge/RECONNECT_REDESIGN_2026-07-25.md for the 2026-07-25
// redesign this file now implements (P1 single-flight close semantics, P2
// deadline-based retries + poke + sleep detection, P3 identity-based eviction
// handling replacing the yield ladder, P4 state projection, P5 suspended).
//
// Scope (rev 4 lock, still honoured):
//   - factory + ReconnectingWSClient facade only
//   - 5 Roy 拍板: exponential 1s base × 2 cap 30s; full jitter; no max-attempts
//     cap by default; error classes per TED; close whitelist 1001/1006/1011/1012
//   - 2026-06-28 amendment (owner directive): a reconnect (post first-success)
//     never permanently gives up over a transient server blip — 401/404 are
//     retriable on reconnect (terminal only on first-connect); auth-class
//     retries use a 60s cap. See isRetriableError. 403 stays terminal (re-pair).
//   - inline error class ReconnectStoppedError (NOT in wsclient/errors.ts)
//   - local ReconnectCloseInfo / ReconnectCloseHandler — facade.onClose does
//     NOT reuse M1-06 WSCloseHandler (rev 2 Codex C3)
//   - first-connect: fatal → factory Promise reject; transient → factory
//     Promise pending until first success / abort / maxAttempts (rev 2 Codex C2)
//
// NOT in scope:
//   - FSM / match routing / LLM (M1-08+)
//   - package boundary re-export (M1-07b)

import {
  createWSClient,
  type WSClient,
  type WSClientMessage,
  type WSWelcome,
  type WSCloseInfo,
  type WSMessageHandler,
  type WSErrorHandler,
} from "./client";
import { CLOSE_CODE_REPLACED } from "./capabilities";
// rev 2 Codex C3: deliberately NOT importing WSCloseHandler — facade.onClose
// uses local ReconnectCloseHandler. WSCloseInfo is imported only for the
// internal close-code dispatch path; it is never exposed via facade.onClose.
import {
  WSClientError,
  WSConnectError,
  WSHandshakeError,
  WSWelcomeTimeoutError,
  WSWelcomeInvalidError,
  WSProtocolVersionError,
  WSClosedError,
  WSAbortedError,
} from "./errors";

// ─── Public types ───────────────────────────────────────────────────

/** Reasons the reconnect facade can transition to terminal "closed" state.
 *  ReconnectCloseInfo.kind and ReconnectStoppedError.kind share this union —
 *  5 values used consistently across onClose handler, give-up event, and
 *  cause chain (rev 2 Codex C4). */
export type ReconnectStopReason =
  | "caller-close"
  | "signal"
  | "fatal-close"
  | "fatal-error"
  | "max-attempts";

/** Inline error class — reconnect's own final-state error. Lives at the top
 *  of reconnect.ts, NOT in wsclient/errors.ts (scope fence #1).
 *  rev 2 Codex C4: renamed from ReconnectAbortedError to ReconnectStoppedError. */
export class ReconnectStoppedError extends Error {
  override readonly name = "ReconnectStoppedError";
  readonly kind: ReconnectStopReason;
  readonly cause: WSClientError | undefined;
  constructor(
    kind: ReconnectStopReason,
    cause: WSClientError | undefined,
    message: string,
  ) {
    super(message);
    this.kind = kind;
    this.cause = cause;
  }
}

/** Terminal-close info passed to facade.onClose handler (rev 2 Codex C3).
 *  NOT a re-use of M1-06 WSCloseInfo — facade close semantics are wider than
 *  a single WS close frame. **No wasClean field** (M1-06 WSCloseInfo also
 *  doesn't have one; rev 1 wrote it incorrectly, rev 2 removed). */
export interface ReconnectCloseInfo {
  readonly kind: ReconnectStopReason;
  readonly code?: number;
  readonly closeReason?: string;
  readonly cause?: WSClientError | ReconnectStoppedError;
}

export type ReconnectCloseHandler = (info: ReconnectCloseInfo) => void;

/** Backoff jitter strategy. Default "full" (rev 2 Roy 拍板 #2). */
export type JitterStrategy = "none" | "full" | "equal";

/** Why the facade is sitting in "parked" (seat lost to another connection). */
export type ParkedReason = "seat-taken" | "superseded-self";

/** Result of one ask-before-dial seat probe (redesign P3). `connected` is
 *  whether ANY connection currently holds this agent's seat server-side;
 *  `instanceMatches` is whether that holder reported OUR process instance id
 *  (i.e. it is a zombie of this very process — reclaiming it is correct). */
export interface SeatProbeResult {
  readonly connected: boolean;
  readonly instanceMatches: boolean;
}

/** Live snapshot of the facade's state machine (redesign P4). The UI derives
 *  its phase from THIS — never from narrating the event stream, which is what
 *  wedged the desktop pill on "connecting" while actually online. */
export interface ReconnectStateSnapshot {
  readonly state:
    | "connecting"
    | "connected"
    | "backoff"
    | "parked"
    | "suspended"
    | "closed";
  /** Attempt counter of the CURRENT disconnect cycle (resets on success). */
  readonly attempt: number;
  /** Cumulative attempts over this facade's lifetime — never resets. This is
   *  the number the desktop host historically surfaced as「重连次数」(审查
   *  F10: facade.attempt resets on success, so it alone cannot feed that UI). */
  readonly totalAttempts: number;
  /** Wall-clock ms of the next scheduled dial, null when not in backoff. */
  readonly nextRetryAt: number | null;
  /** Wall-clock ms the CURRENT session connected, null when not connected. */
  readonly connectedAt: number | null;
  readonly welcome: WSWelcome | null;
  readonly parkedReason: ParkedReason | null;
  /** Monotonic per-facade sequence. Consumers must drop snapshots whose seq is
   *  ≤ the last applied one (IPC reorder/stale-pull guard, 审查 F6). */
  readonly seq: number;
}

export type ReconnectStateHandler = (snap: ReconnectStateSnapshot) => void;

export interface ReconnectingWSClientOptions {
  url: string;
  apiKey: string;
  /** Per-device id sent as X-Device-Id (single-device binding / anti-theft). */
  deviceId?: string;
  /** Which program is running this agent — see WSClientOptions.clientKind. */
  clientKind?: string;
  /** Override the process instance id (tests simulating two processes only). */
  instanceId?: string;
  expectedProtocolVersion: string;
  initialBackoffMs?: number;
  backoffFactor?: number;
  maxBackoffMs?: number;
  jitter?: JitterStrategy;
  /** Default: undefined → no cap (Roy 拍板 #3). Caller controls termination
   *  via signal + AbortController.abort(timeoutMs).
   *
   *  Counts CONSECUTIVE failures. Since 2026-07-24 a connect that succeeds but
   *  dies again within `stabilityWindowMs` counts as a continuation rather than
   *  a reset, so a link that flaps fast enough can now exhaust this cap even
   *  though every attempt technically connected. The bridge sets no cap — it
   *  must never give up — so this only affects direct callers of the facade. */
  maxAttempts?: number;
  welcomeTimeoutMs?: number;
  pingIntervalMs?: number;
  /** Passed through to each inner WSClient — see WSClientOptions.livenessTimeoutMs. */
  livenessTimeoutMs?: number;
  /** How long a session must survive after welcome before its eventual close
   *  counts as a fresh disconnect cycle (backoff restarts at 1s). Sessions
   *  shorter than this are treated as flaps and keep escalating the existing
   *  curve. Default DEFAULT_STABILITY_WINDOW_MS (30s). */
  stabilityWindowMs?: number;
  /** Parked-state probe cadence (redesign P3). Defaults 5min + up to 1min
   *  jitter. Exposed for tests. */
  parkedProbeIntervalMs?: number;
  parkedProbeJitterMs?: number;
  signal?: AbortSignal;
  /** Ask-before-dial seat probe (redesign P3, 审查 F4). Called while parked,
   *  before every re-dial. Return null (or throw) when the probe endpoint is
   *  unavailable — the facade then falls back to dialing blind, which matches
   *  the pre-redesign behaviour against old servers. When it answers: the
   *  facade dials only if the seat is empty or held by OUR OWN process
   *  (reclaiming a zombie of ourselves); a seat held by someone else keeps us
   *  parked so we never rip an active connection out of a live match. */
  probeSeat?: () => Promise<SeatProbeResult | null>;
  /** R13-F08: called after a reconnect attempt failed with a 401 handshake, so
   *  a credential rotated out from under this process (e.g. re-pairing rewrote
   *  the bridge config while it kept running) is picked up without a restart.
   *  Returning a non-empty key different from the one in use swaps the
   *  credential and restarts the backoff curve (fresh credential = fresh
   *  cycle, so the next attempt comes quickly). Errors and empty/null returns
   *  keep the cached key. Never called on first-connect 401 (still terminal)
   *  or for non-auth failures. */
  refreshApiKey?: () => Promise<string | null | undefined> | string | null | undefined;
}

export interface ReconnectEvent {
  readonly type:
    | "attempt-start"
    | "attempt-success"
    | "attempt-failure"
    | "parked"
    | "superseded-self"
    | "give-up";
  readonly attempt: number;
  readonly nextDelayMs?: number;
  readonly cause?: WSClientError | ReconnectStoppedError;
  readonly elapsedMs: number;
  readonly severity: "info" | "warning" | "error";
}

export type ReconnectEventHandler = (ev: ReconnectEvent) => void;

/** Stable facade — caller holds this reference indefinitely. Inner WSClient
 *  is mutable across reconnects; facade type is stable. */
export interface ReconnectingWSClient {
  readonly state: ReconnectStateSnapshot["state"];
  readonly attempt: number;
  readonly totalAttempts: number;
  readonly welcome: WSWelcome | null;
  readonly nextRetryAt: number | null;
  readonly connectedAtMs: number | null;
  readonly parkedReason: ParkedReason | null;
  send(msg: WSClientMessage): void;
  onMessage(handler: WSMessageHandler): () => void;
  onError(handler: WSErrorHandler): () => void;
  onClose(handler: ReconnectCloseHandler): () => void;
  onReconnect(handler: ReconnectEventHandler): () => void;
  /** State-machine projection (redesign P4). Fires on every state edge —
   *  including connected, which the legacy event stream never surfaced. The
   *  handler is also invoked once immediately with the current snapshot so a
   *  late subscriber cannot miss the standing state. */
  onStateChange(handler: ReconnectStateHandler): () => void;
  /** Snapshot getter (pull counterpart of onStateChange, for IPC bootstrap). */
  snapshot(): ReconnectStateSnapshot;
  /** Wake the loop NOW (redesign P2): in backoff → dial immediately; parked →
   *  probe immediately; suspended → resume with a fresh curve and dial. No-op
   *  while connected/connecting/closed. */
  poke(): void;
  /** Enter the non-terminal suspended state (redesign P5): gracefully close
   *  the inner socket (wire-level 1000 "host sleeping" — the server frees the
   *  seat instantly instead of holding a zombie until its read deadline), stop
   *  scheduling retries, keep the facade alive. poke() resumes. NOT close():
   *  close() stays terminal (审查 F12 — a literal close() per lid-close would
   *  tear the bridge down and race the seat lock). */
  suspend(): void;
  close(code?: number, reason?: string): Promise<void>;
}

// ─── Defaults (Roy 拍板 #1 + #2 + #3) ────────────────────────────────

const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_BACKOFF_FACTOR = 2;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
/** Gentler backoff ceiling for auth-class reconnect failures (401/404 after a
 *  healthy session). A server restart self-heals within seconds, but a truly
 *  revoked/wiped credential 401s forever — so cap the steady-state retry at 60s
 *  (vs 30s for network) to avoid hammering a dead credential, while still
 *  recovering within ~a minute of the server returning (2026-06-28). */
const AUTH_MAX_BACKOFF_MS = 60_000;
const DEFAULT_JITTER: JitterStrategy = "full";

/** A session that dies sooner than this after a successful welcome is a FLAP,
 *  not the start of a fresh disconnect cycle — so it must NOT reset the backoff
 *  curve. Without this the curve is pinned at ~1s forever whenever the server
 *  drops us immediately every time (connect-then-instant-death faults: backend
 *  crash-loop, a proxy that upgrades then resets). KEPT by the 2026-07-25
 *  redesign (审查 F5): identity-based eviction handling replaces only the 4409
 *  yield ladder — it cannot see this fault class, which has nothing to do with
 *  seat contention. 30s is far longer than any storm's session (~1s) yet short
 *  enough that a real session — even a brief one — still counts as "connected
 *  once" and restarts from 1s. */
const DEFAULT_STABILITY_WINDOW_MS = 30_000;

/** Parked-state probe cadence (redesign P3). The 2026-07-24 yield ladder
 *  (30-60s escalating to 5-10min, #replacedStreak) is GONE: it existed only
 *  because an evicted client could not tell its own successor from a rival, so
 *  it guessed from timing. The server now answers that question outright
 *  (same_instance boolean in the 4409 reason), and a genuine rival puts us in
 *  "parked": ask the presence endpoint every ~5min whether the seat has freed
 *  up, and only dial when it is empty or held by our own zombie — never a
 *  blind dial that would rip the rival (possibly mid-match) off the seat
 *  (审查 F4: blind 5-min dials would trade the seat forever between two
 *  clients on the lock-bypass paths). */
const DEFAULT_PARKED_PROBE_INTERVAL_MS = 300_000;
const DEFAULT_PARKED_PROBE_JITTER_MS = 60_000;
/** First parked probe comes sooner: the common real-world eviction is a stale
 *  belief (the rival already died, or it was our own zombie the server hadn't
 *  reaped), and waiting a full 5min to discover an empty seat is needless
 *  downtime. */
const PARKED_FIRST_PROBE_DELAY_MS = 10_000;

/** Deadline sleep internals (redesign P2). Sleeps are chunked so a laptop that
 *  slept through the timer is detected: each chunk knows when it EXPECTED to
 *  fire, and an overshoot beyond WALL_JUMP_THRESHOLD_MS means the process was
 *  frozen (system sleep / App Nap) — the loop then treats it as a wake: curve
 *  reset, dial now. setTimeout alone cannot do this: a 10-min timer set 1 min
 *  before lid-close fires 9 min after lid-open. */
const SLEEP_CHUNK_MS = 30_000;
const WALL_JUMP_THRESHOLD_MS = 90_000;

const SEVERITY_WARN_THRESHOLD_MS = 5 * 60 * 1_000;
const SEVERITY_ERROR_THRESHOLD_MS = 15 * 60 * 1_000;

/** Whitelist of WS close codes that trigger reconnect (Roy 拍板 #5).
 *  4xxx application-defined codes are terminal EXCEPT CLOSE_CODE_REPLACED.
 *  Anything else not in this set is also terminal. */
const RETRIABLE_CLOSE_CODES: ReadonlySet<number> = new Set([
  1001, // going away
  1005, // no status received — the peer sent an EMPTY close payload. Our own
  //       server does this on any hard close that loses the race with its
  //       write pump, so treating it as terminal made every server restart a
  //       coin flip between "reconnects" and "bridge dead until relaunch".
  1006, // abnormal closure (most common transient)
  1011, // server error
  1012, // service restart
  1013, // try again later
]);

// ─── Private helpers ────────────────────────────────────────────────

function computeBackoff(
  attempt: number,
  initial: number,
  factor: number,
  cap: number,
): number {
  // A zero/negative base is a hot retry loop: every delay is 0 no matter how far
  // the curve has escalated, and 0 * Infinity is NaN, which setTimeout treats as
  // "fire now". Only reachable through an explicit initialBackoffMs, but there is
  // no useful reading of "retry with no delay at all".
  if (!(initial > 0)) return Math.min(1, cap);
  const raw = initial * Math.pow(factor, Math.max(0, attempt - 1));
  if (!Number.isFinite(raw)) return cap;
  return Math.min(raw, cap);
}

function computeJitter(cappedBase: number, strategy: JitterStrategy): number {
  switch (strategy) {
    case "none":
      return cappedBase;
    case "full":
      return Math.floor(Math.random() * cappedBase);
    case "equal":
      return Math.floor(cappedBase / 2 + (Math.random() * cappedBase) / 2);
  }
}

function isRetriableClose(info: WSCloseInfo): boolean {
  if (info.code === CLOSE_CODE_REPLACED) return true;
  if (info.code >= 4000 && info.code < 5000) return false;
  return RETRIABLE_CLOSE_CODES.has(info.code);
}

/** Parse the 4409 close reason. beta.25+ servers send JSON
 *  `{"reason":"replaced_by_new_connection","same_instance":true|false}`;
 *  older servers send opaque text. Unknown/unparsable → null (treated as
 *  "someone else" — the conservative reading, and the correct one during the
 *  deploy window where the server predates the field, 审查 F6). */
function parseReplacedSameInstance(reason: string | undefined): boolean | null {
  if (!reason) return null;
  try {
    const parsed: unknown = JSON.parse(reason);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { same_instance?: unknown }).same_instance === "boolean"
    ) {
      return (parsed as { same_instance: boolean }).same_instance;
    }
  } catch {
    /* legacy plain-text reason */
  }
  return null;
}

/** Roy 拍板 #4: WSClientError class dispatch.
 *  `connectedBefore` distinguishes a first-connect failure from a reconnect.
 *  401/404 are terminal on the FIRST connect — a genuinely bad or unclaimed
 *  credential (or a wrong URL) should surface as an error, not spin forever —
 *  but RETRIABLE once we've connected before: a 401/404 after a healthy session
 *  almost always means the server is mid-restart (auth/DB not yet ready) or is
 *  briefly 404-routing during a deploy, both of which self-heal. A bridge that
 *  worked a moment ago must never permanently give up over a transient server
 *  blip (2026-06-28 owner directive: keep retrying through multi-hour outages,
 *  even at a longer interval). 403 stays terminal both ways — it is one of the two
 *  binding refusals (WSDeviceMismatchError: another MACHINE holds this agent;
 *  WSClientMismatchError: the other AIFight client on THIS machine holds it), and
 *  neither can be retried into success. Only redeeming a Dashboard pairing code
 *  changes the answer, so retrying would just thrash against whoever displaced us. */
function isRetriableError(err: unknown, connectedBefore: boolean): boolean {
  if (err instanceof WSAbortedError) return false;
  if (err instanceof WSWelcomeInvalidError) return false;
  if (err instanceof WSProtocolVersionError) return false;
  if (err instanceof WSConnectError) return true;
  if (err instanceof WSWelcomeTimeoutError) return true;
  if (err instanceof WSHandshakeError) {
    const sc = err.statusCode;
    if (sc === 403) return false; // device-mismatch / forbidden → re-pair, never thrash
    if (sc === 401 || sc === 404) return connectedBefore;
    if (sc === 408 || sc === 429) return true;
    if (sc >= 500 && sc < 600) return true;
    return false; // other 4xx conservatively terminal
  }
  return false; // unknown error → terminal (defensive)
}

function severityForElapsed(elapsedMs: number): "info" | "warning" | "error" {
  if (elapsedMs >= SEVERITY_ERROR_THRESHOLD_MS) return "error";
  if (elapsedMs >= SEVERITY_WARN_THRESHOLD_MS) return "warning";
  return "info";
}

/** Interruption kinds shared by the deadline sleep and the parked/suspended
 *  waits. "timeout" = deadline reached; "wake" = wall-clock jump detected
 *  (system slept through us); the rest are caller verbs. */
type WaitOutcome = "timeout" | "wake" | "poke" | "suspend" | "abort" | "close";

// ─── Implementation class (module-private) ──────────────────────────

class ReconnectingWSClientImpl implements ReconnectingWSClient {
  state: ReconnectStateSnapshot["state"] = "connecting";
  attempt = 0;
  totalAttempts = 0;
  welcome: WSWelcome | null = null;
  nextRetryAt: number | null = null;
  connectedAtMs: number | null = null;
  parkedReason: ParkedReason | null = null;

  readonly #opts: ReconnectingWSClientOptions;
  /** Credential used for the next connect attempt. Starts as opts.apiKey and
   *  may be swapped by refreshApiKey after a 401 reconnect failure (R13-F08). */
  #apiKey: string;
  #inner: WSClient | null = null;
  readonly #messageHandlers = new Set<WSMessageHandler>();
  readonly #errorHandlers = new Set<WSErrorHandler>();
  readonly #closeHandlers = new Set<ReconnectCloseHandler>();
  readonly #reconnectHandlers = new Set<ReconnectEventHandler>();
  readonly #stateHandlers = new Set<ReconnectStateHandler>();
  #cycleStartTime = 0;
  /** Consecutive-failure counter that drives backoff curve (rev 5).
   *  Resets to 0 on every successful welcome. Incremented on each
   *  transient connect failure; set to 1 on retriable server-initiated
   *  close (which is treated as the 1st failure for the new cycle).
   *  Decoupled from `attempt` (which serves caller telemetry and resets
   *  to 0 per TED rev 4). Drives `computeBackoff(#failures, ...)`. */
  #failures = 0;
  /** Wall-clock ms when the current/last session reached "connected".
   *  Together with stabilityWindowMs this distinguishes a real session
   *  (its close starts a fresh cycle) from a FLAP (its close must keep
   *  escalating the existing curve). 0 = never connected. */
  #connectedAt = 0;
  /** Consecutive sessions that died INSIDE the stability window. Drives the
   *  curve for a flapping link, so "connect → dropped instantly → reconnect"
   *  escalates 1s → 2s → 4s instead of retrying at ~1s forever.
   *
   *  Deliberately separate from #failures: a run of failed CONNECTS (the user's
   *  wi-fi was down) must not make the first short session that follows start
   *  from the top of the curve. Reset by any session that outlives the window. */
  #flapStreak = 0;
  #firstConnectResolve: (() => void) | null = null;
  #firstConnectReject: ((err: unknown) => void) | null = null;
  #firstConnectSettled = false;
  #terminating: { code?: number; reason?: string } | null = null;
  #closedDispatched = false;
  /** Resolvers waiting for terminal close — close() awaits one of these so a
   *  caller that closed mid-dial gets a Promise that resolves only after the
   *  loop truly dispatched terminal state (P1: close() must not lie). */
  #closedWaiters: Array<() => void> = [];
  /** Wakes whichever wait (#sleepUntil chunk / parked wait / suspended wait)
   *  is currently pending. Null when the loop is not waiting. */
  #wakeWait: ((kind: Exclude<WaitOutcome, "timeout" | "wake">) => void) | null =
    null;
  /** Suspend request flag (redesign P5). Checked at every loop juncture; set
   *  by suspend(), cleared when the loop enters the suspended wait's exit. */
  #suspendRequested = false;
  /** Poke request that arrived while no wait was pending (e.g. during a dial).
   *  Consumed at the next wait so a poke is never lost to a race. */
  #pokePending = false;
  /** Abort controller for the IN-FLIGHT dial only (P1). close()/suspend()
   *  abort it so a caller-close or lid-close cannot leave a dial completing in
   *  the background and resurrecting a facade that already reported closed —
   *  the zombie-connection root cause of the 2026-07-25 self-eviction spiral. */
  #dialAbort: AbortController | null = null;
  /** Per-handler inner-socket unsubscribe, keyed by the caller's handler.
   *  Keeping these keyed (not a flat array) makes the unsubscribe returned by
   *  onMessage/onError authoritative across reconnects: #wireHandlersTo refreshes
   *  the entry to the CURRENT inner on every reconnect, and the returned closure
   *  looks the live unsub up here rather than calling a dead inner's captured
   *  unsub — which after a reconnect detached nothing and leaked the handler
   *  onto the live socket (connection-1). */
  readonly #messageInnerUnsubs = new Map<WSMessageHandler, () => void>();
  readonly #errorInnerUnsubs = new Map<WSErrorHandler, () => void>();
  #seq = 0;

  constructor(opts: ReconnectingWSClientOptions) {
    this.#opts = opts;
    this.#apiKey = opts.apiKey;
  }

  send(msg: WSClientMessage): void {
    if (this.state !== "connected" || this.#inner === null) {
      throw new WSClosedError(
        `cannot send while ReconnectingWSClient.state="${this.state}"`,
      );
    }
    this.#inner.send(msg);
  }

  onMessage(handler: WSMessageHandler): () => void {
    this.#messageHandlers.add(handler);
    if (this.#inner !== null && this.state === "connected") {
      this.#messageInnerUnsubs.set(handler, this.#inner.onMessage(handler));
    }
    return () => {
      this.#messageHandlers.delete(handler);
      // Authoritative across reconnects: call the CURRENT inner's unsub for this
      // handler (refreshed by #wireHandlersTo), not one captured at registration.
      const innerUnsub = this.#messageInnerUnsubs.get(handler);
      if (innerUnsub !== undefined) {
        this.#messageInnerUnsubs.delete(handler);
        innerUnsub();
      }
    };
  }

  onError(handler: WSErrorHandler): () => void {
    this.#errorHandlers.add(handler);
    if (this.#inner !== null && this.state === "connected") {
      this.#errorInnerUnsubs.set(handler, this.#inner.onError(handler));
    }
    return () => {
      this.#errorHandlers.delete(handler);
      const innerUnsub = this.#errorInnerUnsubs.get(handler);
      if (innerUnsub !== undefined) {
        this.#errorInnerUnsubs.delete(handler);
        innerUnsub();
      }
    };
  }

  onClose(handler: ReconnectCloseHandler): () => void {
    this.#closeHandlers.add(handler);
    return () => {
      this.#closeHandlers.delete(handler);
    };
  }

  onReconnect(handler: ReconnectEventHandler): () => void {
    this.#reconnectHandlers.add(handler);
    return () => {
      this.#reconnectHandlers.delete(handler);
    };
  }

  onStateChange(handler: ReconnectStateHandler): () => void {
    this.#stateHandlers.add(handler);
    // Late subscriber gets the standing state immediately — the projection
    // must never depend on being subscribed before an edge fired (审查 F6).
    try {
      handler(this.snapshot());
    } catch {
      /* projection handler errors must not break the caller */
    }
    return () => {
      this.#stateHandlers.delete(handler);
    };
  }

  snapshot(): ReconnectStateSnapshot {
    return {
      state: this.state,
      attempt: this.attempt,
      totalAttempts: this.totalAttempts,
      nextRetryAt: this.nextRetryAt,
      connectedAt: this.connectedAtMs,
      welcome: this.welcome,
      parkedReason: this.parkedReason,
      seq: this.#seq,
    };
  }

  poke(): void {
    if (this.state === "closed") return;
    if (this.#wakeWait !== null) {
      this.#wakeWait("poke");
      return;
    }
    // No wait pending (mid-dial, mid-close-drain): remember it so the next
    // wait consumes it instead of the poke evaporating.
    this.#pokePending = true;
  }

  suspend(): void {
    if (this.state === "closed" || this.state === "suspended") return;
    this.#suspendRequested = true;
    // Abort an in-flight dial: a dial completing during system sleep prep
    // would be exactly the resurrection window P1 closes.
    this.#dialAbort?.abort();
    if (this.#wakeWait !== null) {
      this.#wakeWait("suspend");
    }
    if (this.#inner !== null) {
      // Wire-level graceful close — the server frees the seat NOW instead of
      // discovering a dead peer at its read deadline (≤60s). The run loop sees
      // the close, notices #suspendRequested, and parks in "suspended" instead
      // of scheduling a retry.
      void this.#inner.close(1000, "host sleeping").catch(() => {
        /* best-effort; server read-deadline (≤60s) is the fallback */
      });
    }
  }

  async close(code?: number, reason?: string): Promise<void> {
    if (this.state === "closed") return;
    this.#terminating = { code, reason };
    // P1: a close must also stop an IN-FLIGHT dial — without this the dial
    // lands later, rewrites #inner/state, and resurrects a facade the caller
    // was told is closed (the 2026-07-25 zombie root cause).
    this.#dialAbort?.abort();
    if (this.#wakeWait !== null) {
      this.#wakeWait("close");
    }
    if (this.#inner !== null) {
      await this.#inner.close(code, reason).catch(() => {
        /* ignore inner close errors */
      });
    }
    if (this.#closedDispatched) return;
    // The loop owns terminal dispatch on every path that is currently awaiting
    // something (#sleepUntil / parked / suspended / in-flight dial → abort).
    // But if the loop is NOT waiting anywhere (e.g. close() called before the
    // loop's first await, or between awaits), nobody would ever dispatch — so
    // wait a microtask-bounded beat for the loop, then dispatch directly.
    await new Promise<void>((resolve) => {
      this.#closedWaiters.push(resolve);
      // Let the loop's pending continuations run first.
      setImmediate(() => {
        if (!this.#closedDispatched) {
          this.#terminate({
            kind: "caller-close",
            code: code ?? 1000,
            closeReason: reason,
            cause: undefined,
          });
        }
      });
    });
  }

  /** Wires up the first-connect promise resolvers and runs the main loop
   *  in the background. Called only by createReconnectingWSClient(). */
  begin(
    firstConnectResolve: () => void,
    firstConnectReject: (err: unknown) => void,
  ): void {
    this.#firstConnectResolve = firstConnectResolve;
    this.#firstConnectReject = firstConnectReject;
    void this.#runLoop();
  }

  async #runLoop(): Promise<void> {
    this.#cycleStartTime = Date.now();

    if (this.#opts.signal?.aborted) {
      this.#fail(
        "signal",
        undefined,
        "ReconnectingWSClient pre-aborted by signal",
      );
      return;
    }

    while (this.state !== "closed") {
      // A suspend that raced ahead of the dial parks first.
      if (this.#suspendRequested) {
        const resume = await this.#suspendWait();
        if (resume !== "resume") return; // terminal dispatched inside
        continue;
      }

      this.attempt++;
      this.totalAttempts++;
      this.#setState("connecting");
      this.#emit("attempt-start", this.attempt);

      let lastErr: WSClientError | undefined;
      let innerSucceeded = false;
      try {
        const inner = await this.#dial();
        innerSucceeded = true;

        // P1 resurrection guard: the dial may have raced a close()/abort that
        // already dispatched (or is dispatching) terminal state. A connection
        // landing after that point must be discarded, never installed — the
        // pre-redesign code wrote #inner/state unconditionally here, which is
        // how a "closed" facade came back to life as an unowned zombie holding
        // the agent's seat (2026-07-25 incident).
        if (
          this.#closedDispatched ||
          this.#terminating !== null ||
          this.#opts.signal?.aborted === true
        ) {
          void inner.close(1000, "superseded by caller close").catch(() => {});
          if (!this.#closedDispatched) {
            this.#terminate({
              kind: this.#terminating !== null ? "caller-close" : "signal",
              code: this.#terminating?.code ?? 1000,
              closeReason: this.#terminating?.reason,
              cause: undefined,
            });
          }
          return;
        }
        if (this.#suspendRequested) {
          // Lid closed while the dial was in flight and the abort lost the
          // race: hand the seat back and park.
          void inner.close(1000, "host sleeping").catch(() => {});
          const resume = await this.#suspendWait();
          if (resume !== "resume") return;
          continue;
        }

        this.#inner = inner;
        this.welcome = inner.welcome;
        this.#wireHandlersTo(inner);
        const succeededAttempt = this.attempt;
        // Reset BOTH counters on success (rev 5):
        //   - public `attempt` per TED rev 4 (caller-visible cycle counter)
        //   - private `#failures` so backoff curve restarts from 1s on the
        //     next disconnect cycle
        this.attempt = 0;
        this.#failures = 0;
        this.#connectedAt = Date.now();
        this.connectedAtMs = this.#connectedAt;
        this.nextRetryAt = null;
        this.parkedReason = null;
        this.#setState("connected");
        this.#emit("attempt-success", succeededAttempt);

        // Resolve first-connect facade (idempotent)
        if (!this.#firstConnectSettled) {
          this.#firstConnectSettled = true;
          this.#firstConnectResolve?.();
        }

        const closeInfo = await this.#waitInnerClose(inner);
        this.#dropInnerUnsubs();
        this.#inner = null;
        this.connectedAtMs = null;

        // Read through a method: close() mutates #terminating concurrently
        // from outside this loop, which TS's flow analysis cannot see — a
        // direct field read here narrows to null after the early-return above.
        const term = this.#terminatingNow();
        if (term !== null) {
          this.#terminate({
            kind: "caller-close",
            code: term.code ?? closeInfo.code,
            closeReason: term.reason ?? closeInfo.reason,
            cause: undefined,
          });
          return;
        }
        if (this.#opts.signal?.aborted) {
          this.#terminate({ kind: "signal", cause: undefined });
          return;
        }
        if (this.#suspendRequested) {
          // suspend() closed the inner socket gracefully; park (non-terminal).
          const resume = await this.#suspendWait();
          if (resume !== "resume") return;
          continue;
        }
        if (!isRetriableClose(closeInfo)) {
          const cause = new ReconnectStoppedError(
            "fatal-close",
            undefined,
            `close code ${closeInfo.code} not in retry whitelist`,
          );
          this.#terminate({
            kind: "fatal-close",
            code: closeInfo.code,
            closeReason: closeInfo.reason,
            cause,
          });
          return;
        }

        // ── Eviction (4409): identity-based handling, redesign P3. ──
        // The server told us a NEWER connection took this agent's seat, and —
        // on beta.25+ servers — whether that newer connection came from this
        // very process. This replaces the old timing-heuristic yield ladder
        // (#replacedStreak, 30-60s→5-10min): park, ask the presence endpoint
        // before every re-dial, and only take the seat back when it is free or
        // held by our own zombie.
        if (closeInfo.code === CLOSE_CODE_REPLACED) {
          const sameInstance = parseReplacedSameInstance(closeInfo.reason);
          // same_instance=true arriving on the LIVE facade is structurally
          // impossible under P1 single-flight (a legitimate successor of ours
          // only ever evicts a socket we already abandoned). So it is either
          // an internal single-flight regression or a forged instance id —
          // NEVER handle it silently (审查 F7/F9/F10): park like a rival took
          // the seat, and shout in telemetry.
          const reason: ParkedReason =
            sameInstance === true ? "superseded-self" : "seat-taken";
          if (reason === "superseded-self") {
            this.#emit("superseded-self", Math.max(1, this.totalAttempts));
          }
          const verdict = await this.#parkedWait(reason);
          if (verdict !== "dial") return; // terminal dispatched inside
          // Considered exit — fresh cycle, not a blind escalation.
          this.#failures = 0;
          this.#flapStreak = 0;
          continue;
        }

        // Retriable server-initiated close. A session that LASTED counts as the
        // 1st failure of a new disconnect cycle, so the curve starts at 1s
        // (rev 5 lock; Roy 拍板 #1 + plan §5.9 字面曲线 1s → 2s → ...).
        // A session that died inside stabilityWindowMs is a FLAP: resetting to
        // 1 there would pin the curve at ~1s forever (connect-then-instant-
        // death faults), so a flap keeps escalating its own streak (审查 F5:
        // kept by the redesign — this guards a fault class identity cannot).
        const sessionMs = Date.now() - this.#connectedAt;
        const stabilityWindowMs =
          this.#opts.stabilityWindowMs ?? DEFAULT_STABILITY_WINDOW_MS;
        if (sessionMs >= stabilityWindowMs) {
          this.#flapStreak = 0;
          this.#failures = 1;
        } else {
          this.#flapStreak += 1;
          this.#failures = this.#flapStreak;
        }
        // Give the backoff/telemetry path an actual cause. WSClosedError is NOT
        // a WSHandshakeError, so the refreshApiKey and isAuthFailure branches
        // below are unaffected — this only fills in the previously-empty
        // `lastErr` so logs state WHY we are reconnecting.
        lastErr = new WSClosedError(
          `server closed the connection (code ${closeInfo.code}${
            closeInfo.reason ? `: ${closeInfo.reason}` : ""
          })`,
        );
        this.#setState("backoff");
        this.#cycleStartTime = Date.now();
      } catch (err) {
        if (innerSucceeded) {
          // Should not reach here — innerSucceeded path doesn't throw.
          throw err;
        }
        // An abort caused by our own close()/suspend() is a caller verb, not a
        // connection failure — route it to the matching non-failure exit.
        if (err instanceof WSAbortedError) {
          if (this.#terminating !== null) {
            if (!this.#closedDispatched) {
              this.#terminate({
                kind: "caller-close",
                code: this.#terminating.code ?? 1000,
                closeReason: this.#terminating.reason,
                cause: undefined,
              });
            }
            return;
          }
          if (this.#suspendRequested) {
            const resume = await this.#suspendWait();
            if (resume !== "resume") return;
            continue;
          }
        }
        if (err instanceof WSClientError) {
          lastErr = err;
        }
        if (!isRetriableError(err, this.#firstConnectSettled)) {
          const wsErr = err instanceof WSClientError ? err : undefined;
          const kind: ReconnectStopReason =
            err instanceof WSAbortedError ? "signal" : "fatal-error";
          const message =
            err instanceof Error ? err.message : "non-retriable error";
          this.#fail(kind, wsErr, message);
          return;
        }
        // Transient connect failure — count it (rev 5 lock).
        this.#failures++;
        this.#setState("backoff");
      }

      // R13-F08: a 401 on reconnect may mean the credential was rotated out
      // from under this process (re-pair / key rotation rewrote the bridge
      // config). Ask the caller for the current key; a changed key restarts
      // the backoff curve and the next attempt handshakes with it. The
      // never-give-up semantics (2026-06-28 owner directive) are unchanged —
      // this only lets the loop self-heal onto a new credential instead of
      // replaying a revoked one forever.
      if (
        this.#opts.refreshApiKey !== undefined &&
        lastErr instanceof WSHandshakeError &&
        lastErr.statusCode === 401
      ) {
        try {
          const fresh = await this.#opts.refreshApiKey();
          if (typeof fresh === "string" && fresh !== "" && fresh !== this.#apiKey) {
            this.#apiKey = fresh;
            this.#failures = 0; // fresh credential → fresh backoff cycle
          }
        } catch {
          // Keep the cached key — refresh must never break the reconnect loop.
        }
      }

      // ─── Backoff stage ───
      // rev 5 (Codex 预审 fix): backoff curve indexed by `#failures`
      // (consecutive failures), NOT `this.attempt + 1`. Maps 1st failure
      // to 1s, 2nd to 2s, ..., 6th+ capped at 30s per plan §5.9.
      // 2026-06-28: auth-class reconnect failures (401/404) use a gentler 60s
      // cap so a permanently-revoked credential isn't retried every 30s, while
      // network/server failures keep the fast 30s cap for prompt recovery.
      const baseCap = this.#opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
      const isAuthFailure =
        lastErr instanceof WSHandshakeError &&
        (lastErr.statusCode === 401 || lastErr.statusCode === 404);
      const cappedBase = computeBackoff(
        this.#failures,
        this.#opts.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS,
        this.#opts.backoffFactor ?? DEFAULT_BACKOFF_FACTOR,
        isAuthFailure ? Math.max(baseCap, AUTH_MAX_BACKOFF_MS) : baseCap,
      );
      // Full jitter draws from [0, base), so on its own an escalating flap keeps
      // firing sub-second retries and the escalation buys nothing. Once the
      // curve has escalated, put a floor under it. Full jitter stays for the
      // FIRST retry, where spreading a herd of clients after a server restart is
      // what matters. "none" and "equal" are honoured as asked — a caller that
      // named an exact strategy (the tests do) gets it — but "full" is treated
      // the same whether it was passed explicitly or defaulted, because
      // otherwise passing the documented default silently weakens the curve.
      const requested = this.#opts.jitter ?? DEFAULT_JITTER;
      const escalated =
        requested === "full" && this.#failures > 1 ? "equal" : requested;
      const delay = computeJitter(cappedBase, escalated);
      // Emit `attempt-failure` with the ATTEMPT NUMBER associated with
      // this failure event:
      //   - catch path: `this.attempt` is the just-failed attempt number
      //   - close path: `this.attempt` was reset to 0 on success, so report
      //     the consecutive-failure count instead. During a flap storm that
      //     climbs 1,2,3,… (matching the escalating delay) rather than being
      //     pinned at "attempt 1" forever, which read as "stuck" in the logs.
      const eventAttempt =
        this.attempt === 0 ? Math.max(1, this.#failures) : this.attempt;
      this.#emit("attempt-failure", eventAttempt, delay, lastErr);

      // maxAttempts caps CONSECUTIVE failures (#failures), not the attempt
      // counter. A session that outlives the stability window resets it, so a
      // long-running connection never accumulates failures across cycles
      // (rev 5 lock). A session that dies inside the window does NOT: repeated
      // instant drops are one continuous failure, and counting them is the
      // point. The bridge sets no maxAttempts — it must never give up — so this
      // only affects callers of the exported facade.
      if (
        this.#opts.maxAttempts !== undefined &&
        this.#failures >= this.#opts.maxAttempts
      ) {
        this.#fail(
          "max-attempts",
          lastErr,
          `exhausted maxAttempts=${this.#opts.maxAttempts}`,
        );
        return;
      }

      const sleepResult = await this.#sleepUntil(Date.now() + delay);
      this.nextRetryAt = null;
      switch (sleepResult) {
        case "abort":
          this.#terminate({ kind: "signal", cause: undefined });
          if (!this.#firstConnectSettled) {
            this.#firstConnectSettled = true;
            this.#firstConnectReject?.(
              new ReconnectStoppedError(
                "signal",
                undefined,
                "ReconnectingWSClient aborted during backoff",
              ),
            );
          }
          return;
        case "close":
          this.#terminate({
            kind: "caller-close",
            code: this.#terminating?.code ?? 1000,
            closeReason: this.#terminating?.reason,
            cause: undefined,
          });
          return;
        case "suspend": {
          const resume = await this.#suspendWait();
          if (resume !== "resume") return;
          continue;
        }
        case "wake":
          // The machine slept through this backoff (wall-clock jump). Fresh
          // network reality: reset the curve and dial immediately (P2).
          this.#failures = 0;
          this.#flapStreak = 0;
          continue;
        case "poke":
        case "timeout":
          continue;
      }
    }
  }

  /** One dial with its own AbortController (P1). The controller chains the
   *  caller's signal so an external abort still lands, but close()/suspend()
   *  can also abort JUST this dial without the caller's signal firing. */
  async #dial(): Promise<WSClient> {
    const controller = new AbortController();
    this.#dialAbort = controller;
    const upstream = this.#opts.signal;
    const relay = (): void => controller.abort(upstream?.reason);
    if (upstream) {
      if (upstream.aborted) controller.abort(upstream.reason);
      else upstream.addEventListener("abort", relay, { once: true });
    }
    try {
      return await createWSClient({
        url: this.#opts.url,
        apiKey: this.#apiKey,
        deviceId: this.#opts.deviceId,
        clientKind: this.#opts.clientKind,
        instanceId: this.#opts.instanceId,
        expectedProtocolVersion: this.#opts.expectedProtocolVersion,
        welcomeTimeoutMs: this.#opts.welcomeTimeoutMs,
        pingIntervalMs: this.#opts.pingIntervalMs,
        livenessTimeoutMs: this.#opts.livenessTimeoutMs,
        signal: controller.signal,
      });
    } finally {
      this.#dialAbort = null;
      if (upstream) upstream.removeEventListener("abort", relay);
    }
  }

  /** Deadline sleep (P2): chunked so a machine that sleeps through it is
   *  detected as a wall-clock jump ("wake") instead of silently resuming a
   *  stale countdown minutes after lid-open. */
  async #sleepUntil(deadline: number): Promise<WaitOutcome> {
    this.nextRetryAt = deadline;
    this.#project();
    for (;;) {
      const now = Date.now();
      if (now >= deadline) return "timeout";
      const chunk = Math.min(SLEEP_CHUNK_MS, deadline - now);
      const expectedFire = now + chunk;
      const outcome = await this.#interruptibleDelay(chunk);
      if (outcome !== "timeout") return outcome;
      if (Date.now() - expectedFire > WALL_JUMP_THRESHOLD_MS) {
        return "wake";
      }
    }
  }

  /** One interruptible timer tick. Interruptions come from poke()/suspend()/
   *  close()/signal-abort via #wakeWait. */
  #interruptibleDelay(delayMs: number): Promise<WaitOutcome> {
    return new Promise<WaitOutcome>((resolve) => {
      // A poke that raced in while the loop was between waits fires now.
      if (this.#pokePending) {
        this.#pokePending = false;
        resolve("poke");
        return;
      }
      let settled = false;
      const settle = (v: WaitOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal && abortListener) {
          signal.removeEventListener("abort", abortListener);
        }
        this.#wakeWait = null;
        resolve(v);
      };
      const timer = setTimeout(() => settle("timeout"), delayMs);
      const signal = this.#opts.signal;
      let abortListener: (() => void) | null = null;
      if (signal) {
        if (signal.aborted) {
          settle("abort");
          return;
        }
        abortListener = () => settle("abort");
        signal.addEventListener("abort", abortListener);
      }
      this.#wakeWait = (kind) => settle(kind);
    });
  }

  /** Parked wait (P3): the seat belongs to another connection. Probe on a
   *  gentle cadence and return "dial" only when taking the seat is KNOWN to be
   *  non-disruptive (empty, or held by our own process's zombie) — or when the
   *  probe endpoint is unavailable (legacy server), where a blind dial is the
   *  only option and matches pre-redesign behaviour. */
  async #parkedWait(reason: ParkedReason): Promise<"dial" | "stopped"> {
    this.parkedReason = reason;
    this.nextRetryAt = null;
    this.#setState("parked");
    this.#emit("parked", Math.max(1, this.totalAttempts));

    const interval =
      this.#opts.parkedProbeIntervalMs ?? DEFAULT_PARKED_PROBE_INTERVAL_MS;
    const jitterSpan =
      this.#opts.parkedProbeJitterMs ?? DEFAULT_PARKED_PROBE_JITTER_MS;
    let waitMs = Math.min(PARKED_FIRST_PROBE_DELAY_MS, interval);
    for (;;) {
      // Whether THIS round already waited a full probe cadence. Gates the
      // blind-dial fallback below: a blind dial rips the seat holder off
      // unconditionally (newest-wins), so when the probe cannot answer (old
      // server / endpoint down) it may only happen at the ladder-ceiling
      // cadence the old design converged to — never on the 10s fast path,
      // which against an old server would have two parked rivals trading the
      // seat every ~20s, worse than the ladder it replaces.
      const waitedFullCadence = waitMs >= interval;
      const outcome = await this.#sleepUntil(Date.now() + waitMs);
      this.nextRetryAt = null;
      // A poke/wake is the operator (or a lid-open) saying "try now" — human
      // intent overrides the blind-dial caution.
      let operatorIntent = false;
      switch (outcome) {
        case "abort":
          this.#terminate({ kind: "signal", cause: undefined });
          return "stopped";
        case "close":
          this.#terminate({
            kind: "caller-close",
            code: this.#terminating?.code ?? 1000,
            closeReason: this.#terminating?.reason,
            cause: undefined,
          });
          return "stopped";
        case "suspend": {
          const resume = await this.#suspendWait();
          if (resume !== "resume") return "stopped";
          // Woke from sleep while parked: the world may have changed (the
          // rival may be gone). Probe immediately.
          operatorIntent = true;
          break;
        }
        case "wake":
        case "poke":
          operatorIntent = true;
          break;
        case "timeout":
          break;
      }

      // Ask before dialing (审查 F4).
      let verdict: SeatProbeResult | null = null;
      if (this.#opts.probeSeat !== undefined) {
        try {
          verdict = await this.#opts.probeSeat();
        } catch {
          verdict = null;
        }
      }
      // Re-check interruptions that landed during the async probe.
      const term = this.#terminatingNow();
      if (term !== null) {
        this.#terminate({
          kind: "caller-close",
          code: term.code ?? 1000,
          closeReason: term.reason,
          cause: undefined,
        });
        return "stopped";
      }
      if (this.#opts.signal?.aborted) {
        this.#terminate({ kind: "signal", cause: undefined });
        return "stopped";
      }
      if (this.#suspendRequested) {
        const resume = await this.#suspendWait();
        if (resume !== "resume") return "stopped";
      }
      if (verdict !== null) {
        if (verdict.connected === false || verdict.instanceMatches === true) {
          // Seat empty, or held by a zombie of this very process — taking it
          // (back) disrupts nobody.
          this.parkedReason = null;
          return "dial";
        }
      } else if (operatorIntent || waitedFullCadence) {
        // Probe unavailable → blind dial, but only at operator request or the
        // full ladder-ceiling cadence (see waitedFullCadence above).
        this.parkedReason = null;
        return "dial";
      }
      // Seat still held by someone else (or unknown on the fast path) — stay
      // parked, next probe after the full cadence (+ jitter so two parked
      // rivals don't probe in lockstep).
      waitMs = interval + Math.floor(Math.random() * Math.max(0, jitterSpan));
    }
  }

  /** Suspended wait (P5): non-terminal parking for host sleep. Exits on
   *  poke ("resume"), or dispatches terminal state and returns "stopped". */
  async #suspendWait(): Promise<"resume" | "stopped"> {
    this.#suspendRequested = false;
    this.nextRetryAt = null;
    this.connectedAtMs = null;
    this.#setState("suspended");
    for (;;) {
      const outcome = await this.#interruptibleDelay(2_147_000_000);
      switch (outcome) {
        case "poke":
        case "wake":
          // Fresh curve on resume: the network world has changed (P2/P5).
          this.#failures = 0;
          this.#flapStreak = 0;
          return "resume";
        case "abort":
          this.#terminate({ kind: "signal", cause: undefined });
          return "stopped";
        case "close":
          this.#terminate({
            kind: "caller-close",
            code: this.#terminating?.code ?? 1000,
            closeReason: this.#terminating?.reason,
            cause: undefined,
          });
          return "stopped";
        case "suspend":
        case "timeout":
          continue; // already suspended / timer horizon reached — keep waiting
      }
    }
  }

  /** Concurrency-honest read of #terminating: a method-call boundary stops
   *  TS from narrowing the field to null on paths where close() (another
   *  entry point) may have set it during an await. */
  #terminatingNow(): { code?: number; reason?: string } | null {
    return this.#terminating;
  }

  #waitInnerClose(inner: WSClient): Promise<WSCloseInfo> {
    return new Promise<WSCloseInfo>((resolve) => {
      const unsub = inner.onClose((info) => {
        try {
          unsub();
        } catch {
          /* ignore */
        }
        resolve(info);
      });
    });
  }

  #wireHandlersTo(inner: WSClient): void {
    this.#dropInnerUnsubs();
    for (const h of this.#messageHandlers) {
      this.#messageInnerUnsubs.set(h, inner.onMessage(h));
    }
    for (const h of this.#errorHandlers) {
      this.#errorInnerUnsubs.set(h, inner.onError(h));
    }
  }

  #dropInnerUnsubs(): void {
    for (const u of this.#messageInnerUnsubs.values()) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
    this.#messageInnerUnsubs.clear();
    for (const u of this.#errorInnerUnsubs.values()) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
    this.#errorInnerUnsubs.clear();
  }

  /** State setter that also projects (P4). Every state edge — including the
   *  connected one the legacy event stream never carried — reaches
   *  onStateChange subscribers with a fresh monotonic seq. */
  #setState(next: ReconnectStateSnapshot["state"]): void {
    this.state = next;
    this.#project();
  }

  #project(): void {
    this.#seq++;
    const snap = this.snapshot();
    const snapshotHandlers = [...this.#stateHandlers];
    for (const h of snapshotHandlers) {
      try {
        h(snap);
      } catch {
        // Projection handler errors swallowed — must not break loop
      }
    }
  }

  #emit(
    type: ReconnectEvent["type"],
    attempt: number,
    nextDelayMs?: number,
    cause?: WSClientError | ReconnectStoppedError,
  ): void {
    const elapsedMs = Date.now() - this.#cycleStartTime;
    const severity =
      type === "give-up" || type === "superseded-self"
        ? "error"
        : type === "parked"
          ? "warning"
          : type === "attempt-failure"
            ? severityForElapsed(elapsedMs)
            : "info";
    const ev: ReconnectEvent = {
      type,
      attempt,
      nextDelayMs,
      cause,
      elapsedMs,
      severity,
    };
    const snapshot = [...this.#reconnectHandlers];
    for (const h of snapshot) {
      try {
        h(ev);
      } catch {
        // Telemetry handler errors swallowed — must not break loop
      }
    }
  }

  /** Used for fatal-error / max-attempts / pre-aborted-signal paths. Routes
   *  to first-connect Promise reject when first-connect not yet settled,
   *  otherwise routes to onClose only. */
  #fail(
    kind: ReconnectStopReason,
    cause: WSClientError | undefined,
    message: string,
  ): void {
    const stopErr = new ReconnectStoppedError(kind, cause, message);
    this.#terminate({
      kind,
      cause: kind === "fatal-error" || kind === "max-attempts" ? stopErr : undefined,
    });
    if (!this.#firstConnectSettled) {
      this.#firstConnectSettled = true;
      this.#firstConnectReject?.(stopErr);
    }
  }

  #terminate(info: ReconnectCloseInfo): void {
    if (this.#closedDispatched) return;
    this.#closedDispatched = true;
    this.#dropInnerUnsubs();
    this.#inner = null;
    this.connectedAtMs = null;
    this.nextRetryAt = null;
    this.#setState("closed");
    this.#emit("give-up", this.attempt, undefined, info.cause);
    const snapshot = [...this.#closeHandlers];
    for (const h of snapshot) {
      try {
        h(info);
      } catch {
        // Swallow handler errors — onClose dispatch must complete
      }
    }
    const waiters = this.#closedWaiters;
    this.#closedWaiters = [];
    for (const w of waiters) w();
  }
}

// ─── Public factory ─────────────────────────────────────────────────

/**
 * Open a reconnecting WebSocket session. Returns a Promise that:
 *
 *   - **resolves** on the FIRST inner WSClient connect+welcome success
 *   - **rejects** with ReconnectStoppedError on fatal first failure (signal
 *     pre-aborted / WSHandshakeError 401|403|404 / WSWelcomeInvalidError /
 *     WSProtocolVersionError / WSAbortedError / max-attempts during the
 *     first-connect retry chain)
 *   - **stays pending** while transient first failures (WSConnectError /
 *     WSWelcomeTimeoutError / WSHandshakeError 408|429|5xx) drive backoff
 *     and re-attempt, until a success or fatal terminator
 *
 * After the Promise resolves, the returned facade survives across server
 * disconnects: inner WSClient close → backoff → new createWSClient →
 * handlers re-wired. Caller's onMessage / onError / onClose / onReconnect
 * handlers persist across reconnects automatically.
 */
export async function createReconnectingWSClient(
  opts: ReconnectingWSClientOptions,
): Promise<ReconnectingWSClient> {
  const impl = new ReconnectingWSClientImpl(opts);
  await new Promise<void>((resolve, reject) => {
    impl.begin(resolve, reject);
  });
  return impl;
}
