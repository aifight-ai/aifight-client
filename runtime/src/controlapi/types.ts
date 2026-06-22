// M1-16 control API server shared types.
//
// Internal-only. The daemon (M1-18) wires ControlServer with the live
// MultiAgentRouter (M1-10) + per-agent DailyScheduler (M1-15) instances
// + token file source. CLI (M1-17) and OpenClaw plugin (M2) are HTTP
// consumers; they do NOT import these types directly — they consume the
// JSON contract documented in plan §5.4 + Routing Contract in M1-16.md.
//
// Not re-exported from runtime/src/index.ts — controlapi is internal
// only (rev1 decision #15 / rev2 SESSION_STATE rewrite / rev3 Scope
// Fence). Daemon lifecycle (M1-18) constructs ControlServer in-process
// and never exposes it to npm consumers.

import type { AgentInstanceSnapshot } from "../agents/agent";
import type { DailyScheduler } from "../scheduler/daily";
import type { DailyScheduleConfig } from "../scheduler/types";

// ─── Adapter: minimum router interface (rev2 fix #2) ─────────────────
//     Structural surface the control server needs from whatever router
//     the bridge supplies: joinQueue/leaveQueue accept a RouterAgentSelector
//     (string | {name?, id?}), and {name} is a valid selector. Do NOT
//     introduce a non-existent getAgentSnapshot(name).

export interface ControlAgentHandle {
  snapshot(): AgentInstanceSnapshot;
}

export interface ControlJoinQueueOptions {
  readonly oneShot?: boolean;
  readonly count?: number;
}

export interface ControlRouterTarget {
  listAgents(): readonly AgentInstanceSnapshot[];
  /** Throws RouterAgentNotFoundError when no agent matches. Handler
   *  catches by `error.kind === "router_agent_not_found"` (duck-typed,
   *  no instanceof) and maps to HTTP 404. Other RouterError kinds map
   *  to 500 internal_error. */
  getAgent(selector: { readonly name: string }): ControlAgentHandle;
  joinQueue(
    selector: { readonly name: string },
    game: string,
    mode?: string,
    opts?: ControlJoinQueueOptions,
  ): void;
  leaveQueue(selector: { readonly name: string }): void;
}

// ─── Logging ──────────────────────────────────────────────────────────────

export type ControlLogLevel = "info" | "warn" | "error";

export type ControlLogCode =
  | "server_listening"
  | "server_closed"
  | "request_received"
  | "request_completed"
  | "auth_failed"
  | "handler_threw"
  | "shutdown_requested";

export interface ControlLogEvent {
  readonly level: ControlLogLevel;
  readonly code: ControlLogCode;
  readonly message: string;
  readonly method?: string;
  readonly path?: string;
  readonly status?: number;
  readonly durationMs?: number;
  readonly host?: string;
  readonly port?: number;
  /** auth_failed: missing_header | invalid_format | token_mismatch | token_unset */
  readonly reason?: string;
  readonly cause?: unknown;
}

// ─── Server options + lifecycle ──────────────────────────────────────────

export interface ControlServerOptions {
  /** Default "127.0.0.1". server binds 127.0.0.1 only — no remote
   *  exposure path in M1; TLS / remote access is M5+ scope. */
  readonly host?: string;
  /** Default 0 → OS picks an unused port; resolve via address(). */
  readonly port?: number;
  /** Sync, called per request to fetch the currently-valid Bearer
   *  token. Returning null → 401 token_unset (daemon has not generated
   *  the token file yet, or rotated it). M1-18 daemon lifecycle wires
   *  this to a cached token-file reader. */
  readonly tokenSource: () => string | null;
  readonly router: ControlRouterTarget;
  /** agent name → that agent's DailyScheduler. Returning null →
   *  schedule endpoint returns 404 not_found (rev3 fix #2 —
   *  resolveScheduler helper enforces). */
  readonly schedulerLookup?: (agentName: string) => DailyScheduler | null;
  /** rev2 fix #4 — daemon source-of-truth current cfg reader. Used by
   *  GET /schedule + POST /pause + POST /resume when the server's
   *  internal lastSetSchedules cache misses (e.g. first POST /pause
   *  after daemon startup with strategy.json initial schedule). May
   *  return null when the agent has no configured schedule yet. */
  readonly scheduleConfigLookup?: (
    agentName: string,
  ) => DailyScheduleConfig | null;
  /** rev4 fix — daemon graceful stop callback. May return void or
   *  Promise<void>. The server calls it via:
   *    setImmediate(() => {
   *      Promise.resolve()
   *        .then(() => opts.onShutdown?.())
   *        .catch((cause) => safeLog({code:"handler_threw", level:"error", cause, ...}));
   *    });
   *  so neither a synchronous throw NOR a rejected Promise can escape
   *  as an unhandled rejection — both are funnelled through .catch
   *  into safeLog. The client has already received the 200 response by
   *  then, and the failure is logged via onLog without crashing the
   *  server.
   *
   *  rev3 wrote this as `Promise.resolve(opts.onShutdown?.()).catch(...)`
   *  which only caught async rejections — a synchronous throw escaped
   *  the setImmediate callback because `opts.onShutdown?.()` is
   *  evaluated BEFORE `Promise.resolve(...)` runs, so the throw never
   *  reaches Promise.resolve at all. The corrected `.then(() => ...)`
   *  shape relies on the standard Promise behavior that any throw
   *  inside a `.then` callback is automatically converted to a
   *  rejected Promise (and any returned rejected Promise is propagated),
   *  so `.catch` reliably covers both shapes with one path. */
  readonly onShutdown?: () => Promise<void> | void;
  /** Called on lifecycle / request / auth events. Wrapped via safeLog
   *  internally; throws are swallowed so a faulty logger cannot crash
   *  the server (matches M1-15 onNotify pattern). */
  readonly onLog?: (event: ControlLogEvent) => void;
  /** Default 1_048_576 (1 MiB). parseJsonBody aborts and returns 413
   *  payload_too_large past this; rev3 fix #4 requires the 413
   *  response to be flushed BEFORE any best-effort req.destroy(),
   *  so the client receives an HTTP 413 rather than ECONNRESET. */
  readonly bodyLimitBytes?: number;
  /** Defaults to a Date.now-backed clock; injectable for tests
   *  (matches M1-15 SchedulerClock pattern). */
  readonly clock?: { readonly now: () => number };
}

export interface ControlServerAddress {
  readonly host: string;
  readonly port: number;
}

export interface ControlServer {
  /** Bind host:port and resolve with the actual bound port. Throws
   *  ControlServerError("invalid_state") when called twice or after
   *  close(); rejects with ControlServerError("bind_failed") when
   *  the OS rejects the bind (EADDRINUSE / EACCES / ...). */
  listen(): Promise<number>;
  /** Sync; returns null when the server has not yet listened. */
  address(): ControlServerAddress | null;
  /** Drain in-flight requests then close. Idempotent: pre-listen and
   *  post-close calls resolve as no-ops. 5-second grace before forcing
   *  remaining sockets shut via http.Server.closeAllConnections (Node
   *  18.2+). */
  close(): Promise<void>;
}

// ─── Error class (concrete, kind discriminator; M1-15 style) ─────────────

export type ControlServerErrorKind = "invalid_state" | "bind_failed";

export class ControlServerError extends Error {
  override readonly name = "ControlServerError";
  readonly kind: ControlServerErrorKind;
  override readonly cause: unknown;

  constructor(
    kind: ControlServerErrorKind,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.kind = kind;
    this.cause = cause;
  }
}

// ─── HTTP error code enum (rev2 fix #3 + rev3 fix #1 — 9 codes). ────────
//
// The dispatch layer never returns a code outside this set. The Tier B
// 501 details shape `{ retry_after_milestone: "M1-18" }` is enforced by
// the handleNotImplemented factory (rev2 fix #5).

export type ControlErrorCode =
  | "unauthorized"
  | "not_found"
  | "method_not_allowed"
  | "bad_request"
  | "unsupported_media_type"
  | "payload_too_large"
  | "not_implemented"
  | "service_unavailable"
  | "internal_error";

export interface ControlErrorBody {
  readonly error: {
    readonly code: ControlErrorCode;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

// ─── Re-exports of consumed sealed types (convenience for daemon wiring). ─

export type { DailyScheduler, DailyScheduleConfig };
