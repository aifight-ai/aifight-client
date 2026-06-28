// M1-07 reconnect manager — exponential backoff + jitter + close-code dispatch.
//
// Wraps M1-06 createWSClient() in a stable facade that survives across
// transient disconnects. See docs/plans/m1/M1-07.md for the design TED.
//
// Scope (rev 4 lock):
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

export interface ReconnectingWSClientOptions {
  url: string;
  apiKey: string;
  /** Per-device id sent as X-Device-Id (single-device binding / anti-theft). */
  deviceId?: string;
  expectedProtocolVersion: string;
  initialBackoffMs?: number;
  backoffFactor?: number;
  maxBackoffMs?: number;
  jitter?: JitterStrategy;
  /** Default: undefined → no cap (Roy 拍板 #3). Caller controls termination
   *  via signal + AbortController.abort(timeoutMs). */
  maxAttempts?: number;
  welcomeTimeoutMs?: number;
  pingIntervalMs?: number;
  signal?: AbortSignal;
}

export interface ReconnectEvent {
  readonly type:
    | "attempt-start"
    | "attempt-success"
    | "attempt-failure"
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
  readonly state: "connecting" | "connected" | "backoff" | "closed";
  readonly attempt: number;
  readonly welcome: WSWelcome | null;
  send(msg: WSClientMessage): void;
  onMessage(handler: WSMessageHandler): () => void;
  onError(handler: WSErrorHandler): () => void;
  onClose(handler: ReconnectCloseHandler): () => void;
  onReconnect(handler: ReconnectEventHandler): () => void;
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

const SEVERITY_WARN_THRESHOLD_MS = 5 * 60 * 1_000;
const SEVERITY_ERROR_THRESHOLD_MS = 15 * 60 * 1_000;

/** Whitelist of WS close codes that trigger reconnect (Roy 拍板 #5).
 *  4xxx application-defined codes are always terminal. Anything else not
 *  in this set is also terminal. */
const RETRIABLE_CLOSE_CODES: ReadonlySet<number> = new Set([
  1001, // going away
  1006, // abnormal closure (most common transient)
  1011, // server error
  1012, // service restart
]);

// ─── Private helpers ────────────────────────────────────────────────

function computeBackoff(
  attempt: number,
  initial: number,
  factor: number,
  cap: number,
): number {
  const raw = initial * Math.pow(factor, Math.max(0, attempt - 1));
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
  if (info.code >= 4000 && info.code < 5000) return false;
  return RETRIABLE_CLOSE_CODES.has(info.code);
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
 *  even at a longer interval). 403 stays terminal both ways — it signals a
 *  device-binding takeover (WSDeviceMismatchError, statusCode 403), where
 *  retrying would thrash with the device that displaced us; the user must
 *  re-pair on this machine. */
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

// ─── Implementation class (module-private) ──────────────────────────

class ReconnectingWSClientImpl implements ReconnectingWSClient {
  state: "connecting" | "connected" | "backoff" | "closed" = "connecting";
  attempt = 0;
  welcome: WSWelcome | null = null;

  readonly #opts: ReconnectingWSClientOptions;
  #inner: WSClient | null = null;
  readonly #messageHandlers = new Set<WSMessageHandler>();
  readonly #errorHandlers = new Set<WSErrorHandler>();
  readonly #closeHandlers = new Set<ReconnectCloseHandler>();
  readonly #reconnectHandlers = new Set<ReconnectEventHandler>();
  #cycleStartTime = 0;
  /** Consecutive-failure counter that drives backoff curve (rev 5).
   *  Resets to 0 on every successful welcome. Incremented on each
   *  transient connect failure; set to 1 on retriable server-initiated
   *  close (which is treated as the 1st failure for the new cycle).
   *  Decoupled from `attempt` (which serves caller telemetry and resets
   *  to 0 per TED rev 4). Drives `computeBackoff(#failures, ...)`. */
  #failures = 0;
  #firstConnectResolve: (() => void) | null = null;
  #firstConnectReject: ((err: unknown) => void) | null = null;
  #firstConnectSettled = false;
  #terminating: { code?: number; reason?: string } | null = null;
  #closedDispatched = false;
  #wakeupSleep: ((kind: "abort" | "close") => void) | null = null;
  #innerUnsubs: Array<() => void> = [];

  constructor(opts: ReconnectingWSClientOptions) {
    this.#opts = opts;
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
    let innerUnsub: (() => void) | null = null;
    if (this.#inner !== null && this.state === "connected") {
      innerUnsub = this.#inner.onMessage(handler);
    }
    return () => {
      this.#messageHandlers.delete(handler);
      if (innerUnsub) innerUnsub();
    };
  }

  onError(handler: WSErrorHandler): () => void {
    this.#errorHandlers.add(handler);
    let innerUnsub: (() => void) | null = null;
    if (this.#inner !== null && this.state === "connected") {
      innerUnsub = this.#inner.onError(handler);
    }
    return () => {
      this.#errorHandlers.delete(handler);
      if (innerUnsub) innerUnsub();
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

  async close(code?: number, reason?: string): Promise<void> {
    if (this.state === "closed") return;
    this.#terminating = { code, reason };
    if (this.#wakeupSleep) {
      this.#wakeupSleep("close");
    }
    if (this.#inner !== null) {
      await this.#inner.close(code, reason).catch(() => {
        /* ignore inner close errors */
      });
    } else if (!this.#closedDispatched) {
      // No inner, no pending sleep → directly dispatch terminal close.
      this.#terminate({
        kind: "caller-close",
        code: code ?? 1000,
        closeReason: reason,
        cause: undefined,
      });
    }
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
      this.attempt++;
      this.state = "connecting";
      this.#emit("attempt-start", this.attempt);

      let lastErr: WSClientError | undefined;
      let innerSucceeded = false;
      try {
        const inner = await createWSClient({
          url: this.#opts.url,
          apiKey: this.#opts.apiKey,
          deviceId: this.#opts.deviceId,
          expectedProtocolVersion: this.#opts.expectedProtocolVersion,
          welcomeTimeoutMs: this.#opts.welcomeTimeoutMs,
          pingIntervalMs: this.#opts.pingIntervalMs,
          signal: this.#opts.signal,
        });
        innerSucceeded = true;
        this.#inner = inner;
        this.welcome = inner.welcome;
        this.#wireHandlersTo(inner);
        this.state = "connected";
        const succeededAttempt = this.attempt;
        // Reset BOTH counters on success (rev 5):
        //   - public `attempt` per TED rev 4 (caller-visible cycle counter)
        //   - private `#failures` so backoff curve restarts from 1s on the
        //     next disconnect cycle
        this.attempt = 0;
        this.#failures = 0;
        this.#emit("attempt-success", succeededAttempt);

        // Resolve first-connect facade (idempotent)
        if (!this.#firstConnectSettled) {
          this.#firstConnectSettled = true;
          this.#firstConnectResolve?.();
        }

        const closeInfo = await this.#waitInnerClose(inner);
        this.#dropInnerUnsubs();
        this.#inner = null;

        if (this.#terminating) {
          this.#terminate({
            kind: "caller-close",
            code: this.#terminating.code ?? closeInfo.code,
            closeReason: this.#terminating.reason ?? closeInfo.reason,
            cause: undefined,
          });
          return;
        }
        if (this.#opts.signal?.aborted) {
          this.#terminate({ kind: "signal", cause: undefined });
          return;
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
        // Retriable server-initiated close — count as 1st failure of the new
        // disconnect cycle so backoff curve starts at 1s (rev 5 lock; Roy
        // 拍板 #1 + plan §5.9 字面曲线 1s → 2s → ...).
        this.#failures = 1;
        this.state = "backoff";
        this.#cycleStartTime = Date.now();
      } catch (err) {
        if (innerSucceeded) {
          // Should not reach here — innerSucceeded path doesn't throw.
          throw err;
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
        this.state = "backoff";
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
      const delay = computeJitter(
        cappedBase,
        this.#opts.jitter ?? DEFAULT_JITTER,
      );
      // Emit `attempt-failure` with the ATTEMPT NUMBER associated with
      // this failure event:
      //   - catch path: `this.attempt` is the just-failed attempt number
      //   - close path: `this.attempt` was reset to 0 on success; the
      //     upcoming next attempt will be 1, so report 1 to keep
      //     caller telemetry monotonic and never expose attempt=0.
      const eventAttempt = this.attempt === 0 ? 1 : this.attempt;
      this.#emit("attempt-failure", eventAttempt, delay, lastErr);

      // maxAttempts caps CONSECUTIVE failures (#failures), not attempt
      // counter — success resets the cap so a long-running session
      // doesn't accumulate failures across cycles (rev 5 lock).
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

      const sleepResult = await this.#sleep(delay);
      if (sleepResult === "abort") {
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
      }
      if (sleepResult === "close") {
        this.#terminate({
          kind: "caller-close",
          code: this.#terminating?.code ?? 1000,
          closeReason: this.#terminating?.reason,
          cause: undefined,
        });
        return;
      }
    }
  }

  #sleep(delayMs: number): Promise<"timeout" | "abort" | "close"> {
    return new Promise<"timeout" | "abort" | "close">((resolve) => {
      let settled = false;
      const settle = (v: "timeout" | "abort" | "close") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal && abortListener) {
          signal.removeEventListener("abort", abortListener);
        }
        this.#wakeupSleep = null;
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
      this.#wakeupSleep = (kind) => settle(kind);
    });
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
      this.#innerUnsubs.push(inner.onMessage(h));
    }
    for (const h of this.#errorHandlers) {
      this.#innerUnsubs.push(inner.onError(h));
    }
  }

  #dropInnerUnsubs(): void {
    for (const u of this.#innerUnsubs) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
    this.#innerUnsubs.length = 0;
  }

  #emit(
    type: ReconnectEvent["type"],
    attempt: number,
    nextDelayMs?: number,
    cause?: WSClientError | ReconnectStoppedError,
  ): void {
    const elapsedMs = Date.now() - this.#cycleStartTime;
    const severity =
      type === "give-up"
        ? "error"
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
    this.state = "closed";
    this.#dropInnerUnsubs();
    this.#inner = null;
    this.#emit("give-up", this.attempt, undefined, info.cause);
    const snapshot = [...this.#closeHandlers];
    for (const h of snapshot) {
      try {
        h(info);
      } catch {
        // Swallow handler errors — onClose dispatch must complete
      }
    }
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
