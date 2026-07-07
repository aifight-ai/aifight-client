// M1-16 local control API server — node:http (zero new dep), Bearer
// token auth, JSON request/response, 127.0.0.1-bound. plan §5.4.
//
// Internal-only — not re-exported from runtime/src/index.ts (rev1
// decision #15). Daemon lifecycle (M1-18) wires the live router +
// scheduler lookup + token source; CLI (M1-17) / OpenClaw plugin (M2)
// / Hermes MCP (M3) are HTTP consumers and do not import this module.
//
// Step 2 scope: factory + listen/address/close lifecycle + auth +
// dispatch helpers + health + Tier B 501 stubs + Tier C 404 fallback +
// 405 method_not_allowed.
// Step 3 scope: agent + schedule handlers + parseJsonBody (rev3 fix
// #1 + #4) + resolveScheduler (rev3 fix #2) + resolveScheduleCfg
// (rev2 fix #4) + lastSetSchedules cache + DailySchedulerError ->
// 400/503 mapping + RouterAgentNotFoundError duck-type 404 + agent
// snapshot sanitization (drop state.lastError / pendingAction /
// pendingConfirm / lastGameOver / state.transport per spec).
// Step 3b scope: GET /schedule scheduler snapshot sanitization --
// DailySchedulerLastAttempt.cause is `unknown` (M1-15 sealed type)
// and may carry an internal error object with arbitrary enumerable
// fields ({apiKey, stack, ...}). M1-16 multiple places already
// forbid propagating cause to the response body (拍板点 #10 +
// Risks #2 + Step 3 mapDailySchedulerError); GET /schedule joins
// that contract by returning only {atMs, game, outcome} from
// lastAttempt and explicitly omitting cause.
// Step 4 scope: POST /v1/shutdown handler + Group 8/9 regression
// (shutdown success / absent onShutdown / async reject / sync
// throw / onLog throw / handler generic throw / scheduler.snapshot
// throw vs missing scheduler distinction). The shutdown wrap MUST
// use the rev4 setImmediate(() => Promise.resolve().then(() =>
// opts.onShutdown?.()).catch(safeLog)) shape; the rev3 form
// `Promise.resolve(opts.onShutdown?.()).catch(...)` is forbidden
// because it evaluates opts.onShutdown?.() before Promise.resolve
// runs, leaking a synchronous throw out of the setImmediate
// callback as an uncaughtException (Node default exit 1). See
// types.ts onShutdown JSDoc + M1-16.md rev4 Revisions row.

import * as http from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { Buffer } from "node:buffer";
import * as crypto from "node:crypto";

import type { AgentInstanceSnapshot } from "../agents/agent";
import type { DailyScheduler } from "../scheduler/daily";
import type {
  DailyScheduleConfig,
  DailySchedulerLastAttempt,
  DailySchedulerSnapshot,
} from "../scheduler/types";

import type {
  ControlAgentHandle,
  ControlErrorBody,
  ControlErrorCode,
  ControlLogEvent,
  ControlRouterTarget,
  ControlServer,
  ControlServerAddress,
  ControlServerOptions,
} from "./types";
import { ControlServerError } from "./types";

// Hand-sync'd with RUNTIME_VERSION in runtime/src/index.ts (and with
// package.json); all three are enforced at publish time by
// scripts/verify-version-sync.mjs. The control API does not import
// RUNTIME_VERSION from the package root because controlapi is
// internal-only and avoiding the back-reference keeps the module graph
// one-directional (index.ts may eventually re-export controlapi; the
// reverse import would create a cycle once that lands).
const CONTROL_API_VERSION = "0.1.0-beta.12";

const SERVER_HEADER = `aifight-runtime/${CONTROL_API_VERSION}`;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const DEFAULT_BODY_LIMIT_BYTES = 1_048_576;
const CLOSE_GRACE_MS = 5_000;

// ─── Internal HttpError — handler control flow signal ────────────────────
//
// HttpError is the sole way handlers signal a non-200 response shape.
// Dispatch catches it and calls writeError with the status + code +
// message + optional details. Anything else thrown by a handler hits
// the dispatch top-level catch and becomes 500 internal_error +
// handler_threw log (cause is logged but not leaked to the response
// body).

interface HttpErrorDetails {
  readonly [key: string]: unknown;
}

class HttpError extends Error {
  override readonly name = "HttpError";
  readonly status: number;
  readonly code: ControlErrorCode;
  readonly details: HttpErrorDetails | undefined;

  constructor(
    status: number,
    code: ControlErrorCode,
    message: string,
    details?: HttpErrorDetails,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// ─── Route table ────────────────────────────────────────────────────────

interface PatternSegment {
  readonly literal?: string;
  readonly param?: string;
}

interface RoutePattern {
  readonly raw: string;
  readonly segments: readonly PatternSegment[];
}

function tokenizePath(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

function compilePattern(raw: string): RoutePattern {
  const segments = tokenizePath(raw).map<PatternSegment>((seg) =>
    seg.startsWith(":") ? { param: seg.slice(1) } : { literal: seg },
  );
  return { raw, segments };
}

function matchPattern(
  pattern: RoutePattern,
  tokens: readonly string[],
): Readonly<Record<string, string>> | null {
  if (pattern.segments.length !== tokens.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.segments.length; i++) {
    const seg = pattern.segments[i]!;
    const tok = tokens[i]!;
    if (seg.literal !== undefined) {
      if (seg.literal !== tok) return null;
    } else if (seg.param !== undefined) {
      try {
        params[seg.param] = decodeURIComponent(tok);
      } catch {
        // Malformed percent-encoding — treat as no match so dispatch
        // returns 404, matching the "path not found" semantics rather
        // than leaking a URIError stack to the client.
        return null;
      }
    }
  }
  return params;
}

interface HandlerContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
}

type RouteHandler = (ctx: HandlerContext) => void | Promise<void>;

interface Route {
  readonly method: string;
  readonly pattern: RoutePattern;
  readonly handler: RouteHandler;
}

// ─── Body parsing (rev3 fix #1 + #4) ─────────────────────────────────────
//
// Only called by endpoints that accept a JSON body — POST /schedule
// and POST /join in this Step, plus Tier B stubs in the future. NOT
// called from /pause / /resume / /shutdown / /leave (rev3 fix #1).
//
//   - Content-Type must start with application/json (case-insensitive,
//     params allowed). Otherwise 415 unsupported_media_type.
//   - Body bytes are accumulated up to bodyLimitBytes. If a single
//     chunk crosses the limit, parseJsonBody sets aborted = true,
//     ignores subsequent chunks (so we do not OOM the buffer), and
//     throws HttpError(413). The dispatch loop's outer catch turns
//     that into a writeError(413) BEFORE any best-effort socket
//     teardown — rev3 fix #4 forbids req.destroy() prior to writing
//     the 413 JSON, otherwise native fetch sees ECONNRESET instead
//     of a parsable HTTP 413.
//   - Empty body (text.length === 0) is REJECTED with 400 bad_request
//     "request body required" (rev3 fix #1). Only the literal text
//     "null" (which JSON.parse turns into null) yields a null payload
//     to the handler — that is the documented setSchedule(null)
//     channel.
//   - JSON parse failure → 400 bad_request "invalid JSON: ...".

async function parseJsonBody(
  req: IncomingMessage,
  limit: number,
): Promise<unknown> {
  const ctRaw = (req.headers["content-type"] ?? "").toString();
  const ct = ctRaw.split(";")[0]?.trim().toLowerCase() ?? "";
  if (ct !== "application/json") {
    throw new HttpError(
      415,
      "unsupported_media_type",
      "Content-Type must be application/json",
    );
  }

  const chunks: Buffer[] = [];
  let total = 0;
  let aborted = false;

  for await (const chunk of req) {
    if (aborted) continue;
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > limit) {
      aborted = true;
      // rev3 fix #4: do NOT req.destroy() here. The HttpError(413)
      // bubbles to dispatch, which writes the 413 JSON via
      // writeError. The dispatch finally drain handles socket
      // cleanup AFTER the response is flushed.
      throw new HttpError(
        413,
        "payload_too_large",
        `request body exceeds ${limit} bytes`,
      );
    }
    chunks.push(buf);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  // rev3 fix #1: empty body !== JSON null.
  if (text.length === 0) {
    throw new HttpError(400, "bad_request", "request body required");
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new HttpError(
      400,
      "bad_request",
      `invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// ─── Body shape pre-check ────────────────────────────────────────────────
//
// Throws 400 bad_request before any handler-specific work. Verifies
// (a) body is a JSON object (not array / null / scalar) and
// (b) every required field is present (own-property check).

function requireObjectFields(
  body: unknown,
  fields: readonly string[],
  context: string,
): asserts body is Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(
      400,
      "bad_request",
      `${context} body must be a JSON object`,
      { missing_fields: [...fields] },
    );
  }
  const obj = body as Record<string, unknown>;
  const missing = fields.filter((f) => !Object.prototype.hasOwnProperty.call(obj, f));
  if (missing.length > 0) {
    throw new HttpError(
      400,
      "bad_request",
      `missing required fields: ${missing.join(", ")}`,
      { missing_fields: missing },
    );
  }
}

// ─── RouterError duck-type (rev2 fix #2) ─────────────────────────────────
//
// Handler maps router throws to HTTP without `instanceof
// RouterAgentNotFoundError`. The only contract requirement is a
// `kind` discriminator on the thrown object (the router signals
// "not found" with kind === "router_agent_not_found"). Anything
// else escapes to dispatch's generic catch -> 500 internal_error.

function isRouterAgentNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "kind" in err &&
    (err as { kind?: unknown }).kind === "router_agent_not_found"
  );
}

// ─── DailySchedulerError mapping (rev2 fix #3 + 拍板点 #10) ──────────────
//
// invalid_timezone / invalid_count / invalid_min_interval all become
// 400 bad_request with details.validation = the kind discriminator
// (the kind is what the daemon needs to decide whether to retry; the
// human-readable message comes from DailySchedulerError.message).
// invalid_state becomes 503 service_unavailable — the scheduler is
// stopped, the request is unprocessable RIGHT NOW but a retry after
// daemon restart will succeed; this is distinct from internal_error
// which signals an unrecoverable bug.
//
// We never propagate `cause` to the response body because
// DailySchedulerError("invalid_timezone") wraps the original
// RangeError from Intl.DateTimeFormat which would leak Node internal
// stack frames.

function mapDailySchedulerError(err: unknown): HttpError | null {
  if (
    typeof err !== "object" ||
    err === null ||
    !("kind" in err)
  ) {
    return null;
  }
  const kind = (err as { kind?: unknown }).kind;
  const message = err instanceof Error ? err.message : "schedule operation failed";
  if (
    kind === "invalid_timezone" ||
    kind === "invalid_count" ||
    kind === "invalid_min_interval"
  ) {
    return new HttpError(400, "bad_request", message, { validation: kind });
  }
  if (kind === "invalid_state") {
    return new HttpError(
      503,
      "service_unavailable",
      "scheduler stopped",
    );
  }
  return null;
}

// ─── Agent snapshot sanitization ─────────────────────────────────────────
//
// Per M1-16.md Routing Contract sanitization spec:
//   keep snapshot.{name, started, stopped, transport}
//   replace snapshot.state with a curated view that only exposes
//   {phase, agentId, agentName, availableGames, autoConfirmMatches,
//    queue?, activeMatch?, activeMatches?}; drop state.transport (the FSM internal
//    duplicate of the snapshot's higher-level transport field),
//    state.lastError, state.pendingAction(s), state.pendingConfirm,
//    state.lastGameOver -- these contain match-internal data the
//    control surface should not leak to CLI / plugin consumers.
//
// state can be null (agent has not yet seen welcome); preserve that
// as null in the response so consumers can detect "agent registered
// but not connected".

interface SanitizedAgentSnapshot {
  readonly name: string;
  readonly started: boolean;
  readonly stopped: boolean;
  readonly transport: AgentInstanceSnapshot["transport"];
  readonly state: SanitizedAgentState | null;
}

interface SanitizedAgentState {
  readonly phase: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly availableGames: readonly string[];
  readonly autoConfirmMatches: boolean;
  readonly queue?: { readonly game: string; readonly mode: string };
  readonly activeMatch?: {
    readonly sessionId: string;
    readonly game: string;
    readonly startedAt: number;
  };
  readonly activeMatches?: Readonly<Record<string, {
    readonly sessionId: string;
    readonly game: string;
    readonly startedAt: number;
  }>>;
  readonly activeMatchCount?: number;
}

function sanitizeAgentSnapshot(
  snap: AgentInstanceSnapshot,
): SanitizedAgentSnapshot {
  if (snap.state === null) {
    return {
      name: snap.name,
      started: snap.started,
      stopped: snap.stopped,
      transport: snap.transport,
      state: null,
    };
  }
  const s = snap.state;
  const activeMatches = s.activeMatches ?? (
    s.activeMatch !== undefined ? { [s.activeMatch.sessionId]: s.activeMatch } : undefined
  );
  const sanitizedState: SanitizedAgentState = {
    phase: s.phase,
    agentId: s.agentId,
    agentName: s.agentName,
    availableGames: s.availableGames,
    autoConfirmMatches: s.autoConfirmMatches,
    ...(s.queue !== undefined ? { queue: s.queue } : {}),
    ...(s.activeMatch !== undefined ? { activeMatch: s.activeMatch } : {}),
    ...(activeMatches !== undefined ? { activeMatches, activeMatchCount: Object.keys(activeMatches).length } : {}),
  };
  return {
    name: snap.name,
    started: snap.started,
    stopped: snap.stopped,
    transport: snap.transport,
    state: sanitizedState,
  };
}

// ─── Scheduler snapshot sanitization (Step 3b) ───────────────────────────
//
// M1-15 DailySchedulerLastAttempt declares `cause?: unknown`, which
// is populated on join_threw / health_check_threw / snapshot_threw
// paths with the original error object the scheduler caught. That
// object can carry arbitrary enumerable fields (token / stack /
// apiKey from upstream HTTP error responses, etc.) and must NOT
// reach the HTTP response body. This matches the existing M1-16
// contract that DailySchedulerError.cause is dropped when mapping
// invalid_* errors to 400 + details.validation (拍板点 #10) and
// the handler_threw response body sanitisation (dispatch generic
// catch).
//
// Output shape:
//   running, today, remaining, nextFireInMs -- copied verbatim
//   (these are scalars / scalar maps / nullable scalars; no
//    enumerable surface area for an attacker to smuggle data
//    through)
//   lastAttempt: null  OR  { atMs, game, outcome } -- explicitly
//   constructed without spread, so any future addition to
//   DailySchedulerLastAttempt that introduces a new field will NOT
//   silently leak; this file must update sanitizedLastAttempt to
//   surface (or deliberately drop) the new field.

interface SanitizedSchedulerSnapshot {
  readonly running: boolean;
  readonly today: string | null;
  readonly remaining: DailySchedulerSnapshot["remaining"];
  readonly nextFireInMs: number | null;
  readonly lastAttempt: SanitizedSchedulerLastAttempt | null;
}

interface SanitizedSchedulerLastAttempt {
  readonly atMs: number;
  readonly game: DailySchedulerLastAttempt["game"];
  readonly outcome: DailySchedulerLastAttempt["outcome"];
}

function sanitizeSchedulerSnapshot(
  snap: DailySchedulerSnapshot,
): SanitizedSchedulerSnapshot {
  const lastAttempt: SanitizedSchedulerLastAttempt | null =
    snap.lastAttempt === null
      ? null
      : {
          atMs: snap.lastAttempt.atMs,
          game: snap.lastAttempt.game,
          outcome: snap.lastAttempt.outcome,
          // INTENTIONALLY OMIT lastAttempt.cause — see Step 3b
          // header. Do not change to a spread without re-reading
          // the comment.
        };
  return {
    running: snap.running,
    today: snap.today,
    remaining: snap.remaining,
    nextFireInMs: snap.nextFireInMs,
    lastAttempt,
  };
}

// ─── Factory ─────────────────────────────────────────────────────────────

export function createControlServer(
  opts: ControlServerOptions,
): ControlServer {
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  const bodyLimitBytes = opts.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;
  const clock = opts.clock ?? { now: () => Date.now() };

  const startedAtMs = clock.now();

  // ── Route registry ───────────────────────────────────────────────────
  //
  // Step 2 registers: GET /v1/health (Tier A) + 3 Tier B stubs.
  // Step 3 appends 8 Tier A agent + schedule routes (handlers
  //   declared further down in this closure).
  // Step 4 appends POST /v1/shutdown (Tier A — daemon graceful
  //   stop trigger; rev4 .then(() => onShutdown?.()) wrap locked).
  // Tier C paths (/v1/doctor, /v1/results/*, /v1/notifications/*)
  //   stay UNregistered — dispatch returns 404 not_found "path not
  //   found" for any unregistered path.
  //
  // Order is dispatch-immaterial because matchPattern resolves a
  // single (method, pattern) pair; we group by tier for readability.
  const routes: Route[] = [
    // Tier A — health
    {
      method: "GET",
      pattern: compilePattern("/v1/health"),
      handler: handleHealth,
    },
    // Tier A — agents read + queue commands (Step 3)
    {
      method: "GET",
      pattern: compilePattern("/v1/agents"),
      handler: handleListAgents,
    },
    {
      method: "GET",
      pattern: compilePattern("/v1/agents/:name/status"),
      handler: handleGetAgentStatus,
    },
    {
      method: "POST",
      pattern: compilePattern("/v1/agents/:name/join"),
      handler: handleJoinQueue,
    },
    {
      method: "POST",
      pattern: compilePattern("/v1/agents/:name/leave"),
      handler: handleLeaveQueue,
    },
    // Tier A — schedule (Step 3, rev3 fix #1+#2 locked)
    {
      method: "GET",
      pattern: compilePattern("/v1/agents/:name/schedule"),
      handler: handleGetSchedule,
    },
    {
      method: "POST",
      pattern: compilePattern("/v1/agents/:name/schedule"),
      handler: handleSetSchedule,
    },
    {
      method: "POST",
      pattern: compilePattern("/v1/agents/:name/schedule/pause"),
      handler: handlePauseSchedule,
    },
    {
      method: "POST",
      pattern: compilePattern("/v1/agents/:name/schedule/resume"),
      handler: handleResumeSchedule,
    },
    // Tier A — daemon graceful stop trigger (Step 4, rev4 wrap
    //   locked; see handleShutdown comment block for rationale)
    {
      method: "POST",
      pattern: compilePattern("/v1/shutdown"),
      handler: handleShutdown,
    },
    // Tier B 501 stubs (rev2 fix #5 shape:
    //   {error:{code,message,details:{retry_after_milestone}}})
    {
      method: "POST",
      pattern: compilePattern("/v1/agents"),
      handler: handleNotImplemented("M1-18"),
    },
    {
      method: "DELETE",
      pattern: compilePattern("/v1/agents/:name"),
      handler: handleNotImplemented("M1-18"),
    },
    {
      method: "POST",
      pattern: compilePattern("/v1/agents/:name/setup"),
      handler: handleNotImplemented("M1-18"),
    },
  ];

  // ── Schedule cfg cache (rev2 fix #4 + rev3 fix #1) ──────────────────
  //
  // Records the most recent setSchedule cfg per agent. cache hit
  // wins over scheduleConfigLookup so the user's HTTP intent
  // overrides any stale daemon source-of-truth (chokidar reload
  // races are a known M1-18 problem; see M1-16.md Risks #13).
  // Map.has() distinguishes "never set" (cache miss → fall to
  // lookup) from "explicitly set to null" (cache hit returning
  // null, NOT lookup fallback) so that POST /schedule body=null
  // semantics survive subsequent GETs.
  const lastSetSchedules = new Map<string, DailyScheduleConfig | null>();

  // ── safeLog wrap ─────────────────────────────────────────────────────
  //
  // onLog callback throws are swallowed — same pattern as M1-15
  // onNotify. A faulty logger must never crash the server or surface
  // as a request error.
  function safeLog(event: ControlLogEvent): void {
    if (!opts.onLog) return;
    try {
      opts.onLog(event);
    } catch {
      // Intentionally swallowed.
    }
  }

  // ── authenticate (拍板点 #5 + rev2 contract) ────────────────────────
  //
  // 401 reasons (logged via auth_failed):
  //   missing_header — no Authorization header
  //   invalid_format — present but not "Bearer <token>"
  //   token_unset    — opts.tokenSource() returned null (daemon not
  //                    yet ready / token file missing)
  //   token_mismatch — supplied token differs from expected (length
  //                    differs OR timingSafeEqual returns false)
  //
  // crypto.timingSafeEqual REQUIRES equal-length buffers — different
  // lengths throw RangeError. The length pre-check protects against
  // that and short-circuits to token_mismatch directly.
  type AuthResult =
    | { readonly ok: true }
    | {
        readonly ok: false;
        readonly reason:
          | "missing_header"
          | "invalid_format"
          | "token_unset"
          | "token_mismatch";
      };

  function authenticate(req: IncomingMessage): AuthResult {
    const header = req.headers.authorization;
    if (!header) return { ok: false, reason: "missing_header" };
    if (!header.startsWith("Bearer ")) {
      return { ok: false, reason: "invalid_format" };
    }
    const clientToken = header.slice("Bearer ".length);
    const expected = opts.tokenSource();
    if (expected === null) return { ok: false, reason: "token_unset" };
    const a = Buffer.from(clientToken, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length) {
      return { ok: false, reason: "token_mismatch" };
    }
    if (!crypto.timingSafeEqual(a, b)) {
      return { ok: false, reason: "token_mismatch" };
    }
    return { ok: true };
  }

  // ── writeJson / writeError ───────────────────────────────────────────
  //
  // Both are no-ops if the response head is already sent (defensive —
  // shouldn't happen in practice but prevents a double-write throwing
  // and tearing down the connection mid-response).
  //
  // Server header is set on every successful write per 拍板点 #12.
  // Allow header (set by dispatch on 405 path) survives because we
  // use res.setHeader() instead of res.writeHead(status, headers)
  // which would replace the header bag.
  function writeJson(
    res: ServerResponse,
    status: number,
    body: unknown,
  ): void {
    if (res.headersSent) return;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Server", SERVER_HEADER);
    res.statusCode = status;
    res.end(JSON.stringify(body));
  }

  function writeError(
    res: ServerResponse,
    status: number,
    code: ControlErrorCode,
    message: string,
    details?: HttpErrorDetails,
  ): void {
    const body: ControlErrorBody =
      details === undefined
        ? { error: { code, message } }
        : { error: { code, message, details } };
    writeJson(res, status, body);
  }

  // ── Handlers (Step 2 scope only) ─────────────────────────────────────

  function handleHealth(ctx: HandlerContext): void {
    writeJson(ctx.res, 200, {
      status: "ok",
      version: CONTROL_API_VERSION,
      uptimeMs: clock.now() - startedAtMs,
    });
  }

  // rev2 fix #5 — Tier B 501 response shape locks
  // `{ error: { code, message, details: { retry_after_milestone } } }`
  // with retry_after_milestone strictly nested in details, NOT at the
  // top of error.
  function handleNotImplemented(milestone: string): RouteHandler {
    return (ctx) => {
      const path = ctx.url.pathname;
      throw new HttpError(
        501,
        "not_implemented",
        `${path} deferred to ${milestone} daemon lifecycle wiring`,
        { retry_after_milestone: milestone },
      );
    };
  }

  // ── Schedule resolution helpers (rev2 fix #4 cfg + rev3 fix #2 scheduler) ──
  //
  // resolveScheduler is mandatory at the head of every schedule
  // handler: GET / POST / pause / resume must throw HttpError(404)
  // immediately when schedulerLookup is missing or returns null,
  // BEFORE any parseJsonBody / setSchedule call could land on
  // `null`. This forbids the failure mode "client sees 500
  // internal_error because daemon forgot to wire a scheduler for
  // this agent" — that case must register as 404 so the daemon /
  // CLI can recognise it as a wiring oversight.
  //
  // resolveScheduleCfg is the cache > lookup > null cascade. The
  // explicit Map.has() check ensures a cache entry of `null` (set
  // by POST /schedule body=null) wins over scheduleConfigLookup,
  // so the user's deliberate "clear schedule" intent survives a
  // subsequent GET.
  function resolveScheduler(name: string): DailyScheduler {
    const scheduler = opts.schedulerLookup?.(name) ?? null;
    if (!scheduler) {
      throw new HttpError(
        404,
        "not_found",
        `agent '${name}' has no scheduler`,
      );
    }
    return scheduler;
  }

  function resolveScheduleCfg(name: string): DailyScheduleConfig | null {
    if (lastSetSchedules.has(name)) {
      return lastSetSchedules.get(name) ?? null;
    }
    return opts.scheduleConfigLookup?.(name) ?? null;
  }

  // ── 204 helper ──────────────────────────────────────────────────────
  //
  // join / leave / set-schedule / pause / resume return 204 No
  // Content. We still set Server header for parity with writeJson
  // and skip body entirely (Node's res.end() with no payload sends
  // Content-Length: 0).
  function writeNoContent(res: ServerResponse): void {
    if (res.headersSent) return;
    res.setHeader("Server", SERVER_HEADER);
    res.statusCode = 204;
    res.end();
  }

  // ── Tier A: agents read endpoints ───────────────────────────────────
  //
  // listAgents returns a readonly array, but the spec sanitises each
  // snapshot before sending; we do not sort or rearrange (M1-16.md
  // Risks #9 — handler must not assume the array is mutable).
  function handleListAgents(ctx: HandlerContext): void {
    const agents = opts.router.listAgents().map(sanitizeAgentSnapshot);
    writeJson(ctx.res, 200, { agents });
  }

  // RouterAgentNotFoundError is duck-typed via `kind` discriminator;
  // any other RouterError (or non-RouterError) is treated as 500
  // internal_error by the dispatch generic catch.
  function handleGetAgentStatus(ctx: HandlerContext): void {
    const name = ctx.params.name!;
    let handle: ControlAgentHandle;
    try {
      handle = opts.router.getAgent({ name });
    } catch (err) {
      if (isRouterAgentNotFound(err)) {
        throw new HttpError(404, "not_found", `agent '${name}' not found`);
      }
      throw err;
    }
    const snap = handle.snapshot();
    writeJson(ctx.res, 200, { agent: sanitizeAgentSnapshot(snap) });
  }

  // ── Tier A: queue commands ──────────────────────────────────────────

  async function handleJoinQueue(ctx: HandlerContext): Promise<void> {
    const name = ctx.params.name!;
    // POST /join is the only Step 3 endpoint that reads a body.
    const body = await parseJsonBody(ctx.req, bodyLimitBytes);
    requireObjectFields(body, ["game"], "/v1/agents/:name/join");
    const obj = body as {
      game: unknown;
      mode?: unknown;
      one_shot?: unknown;
      oneShot?: unknown;
      count?: unknown;
    };
    if (typeof obj.game !== "string" || obj.game.length === 0) {
      throw new HttpError(
        400,
        "bad_request",
        "field 'game' must be a non-empty string",
        { invalid_field: "game" },
      );
    }
    if (obj.mode !== undefined && typeof obj.mode !== "string") {
      throw new HttpError(
        400,
        "bad_request",
        "field 'mode' must be a string when present",
        { invalid_field: "mode" },
      );
    }
    if (obj.one_shot !== undefined && typeof obj.one_shot !== "boolean") {
      throw new HttpError(
        400,
        "bad_request",
        "field 'one_shot' must be a boolean when present",
        { invalid_field: "one_shot" },
      );
    }
    if (obj.oneShot !== undefined && typeof obj.oneShot !== "boolean") {
      throw new HttpError(
        400,
        "bad_request",
        "field 'oneShot' must be a boolean when present",
        { invalid_field: "oneShot" },
      );
    }
    const count = obj.count;
    if (
      count !== undefined &&
      (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 20)
    ) {
      throw new HttpError(
        400,
        "bad_request",
        "field 'count' must be an integer between 1 and 20 when present",
        { invalid_field: "count" },
      );
    }
    const oneShot = (obj.one_shot ?? obj.oneShot) as boolean | undefined;
    try {
      opts.router.joinQueue(
        { name },
        obj.game,
        obj.mode as string | undefined,
        {
          ...(oneShot !== undefined ? { oneShot } : {}),
          ...(typeof count === "number" ? { count } : {}),
        },
      );
    } catch (err) {
      if (isRouterAgentNotFound(err)) {
        throw new HttpError(404, "not_found", `agent '${name}' not found`);
      }
      throw err;
    }
    writeNoContent(ctx.res);
  }

  // rev3 fix #1 — leave does NOT read a body. Even if the client
  // sends one, dispatch's finally drain swallows it; we never call
  // parseJsonBody so empty-body / wrong-content-type / oversize
  // paths do not gatekeep the operation.
  function handleLeaveQueue(ctx: HandlerContext): void {
    const name = ctx.params.name!;
    try {
      opts.router.leaveQueue({ name });
    } catch (err) {
      if (isRouterAgentNotFound(err)) {
        throw new HttpError(404, "not_found", `agent '${name}' not found`);
      }
      throw err;
    }
    writeNoContent(ctx.res);
  }

  // ── Tier A: schedule endpoints (rev3 fix #1+#2) ─────────────────────

  function handleGetSchedule(ctx: HandlerContext): void {
    const name = ctx.params.name!;
    // rev3 fix #2: throw 404 BEFORE any cfg lookup so the response
    // distinguishes "no scheduler wired" from "scheduler exists but
    // has no cfg".
    const scheduler = resolveScheduler(name);
    const cfg = resolveScheduleCfg(name);
    // Step 3b: snapshot may carry lastAttempt.cause = unknown
    // (internal error object with arbitrary fields like
    // {apiKey, stack, ...}); sanitize before serialising to keep
    // the contract that no `cause` ever reaches the HTTP body.
    const snapshot = sanitizeSchedulerSnapshot(scheduler.snapshot());
    writeJson(ctx.res, 200, { schedule: cfg, snapshot });
  }

  async function handleSetSchedule(ctx: HandlerContext): Promise<void> {
    const name = ctx.params.name!;
    // rev3 fix #2: 404 if no scheduler — we throw BEFORE
    // parseJsonBody so a missing-scheduler request never even reads
    // the body (this is observable in tests: stub setSchedule must
    // not be called when schedulerLookup returns null).
    const scheduler = resolveScheduler(name);
    // rev3 fix #1: empty body → 400; only literal JSON null reaches
    // the handler as null and follows the setSchedule(null) path.
    const body = await parseJsonBody(ctx.req, bodyLimitBytes);

    let parsed: DailyScheduleConfig | null;
    if (body === null) {
      parsed = null;
    } else {
      requireObjectFields(
        body,
        ["enabled", "timezone", "days"],
        "/v1/agents/:name/schedule",
      );
      const obj = body as Record<string, unknown>;
      if (typeof obj.enabled !== "boolean") {
        throw new HttpError(
          400,
          "bad_request",
          "field 'enabled' must be a boolean",
          { invalid_field: "enabled" },
        );
      }
      if (typeof obj.timezone !== "string") {
        throw new HttpError(
          400,
          "bad_request",
          "field 'timezone' must be a string",
          { invalid_field: "timezone" },
        );
      }
      if (
        typeof obj.days !== "object" ||
        obj.days === null ||
        Array.isArray(obj.days)
      ) {
        throw new HttpError(
          400,
          "bad_request",
          "field 'days' must be an object",
          { invalid_field: "days" },
        );
      }
      // We pass through the original body to setSchedule — M1-15
      // performs its own deep validation (timezone resolvability,
      // count bounds, minIntervalSec range). Mapping its errors via
      // mapDailySchedulerError keeps the contract single-sourced.
      // The double cast through unknown is required because the
      // shape pre-check above only narrows to Record<string, unknown>;
      // the real type-shape acceptance is performed by M1-15
      // validateConfig inside setSchedule, not by the HTTP layer.
      parsed = body as unknown as DailyScheduleConfig;
    }

    try {
      scheduler.setSchedule(parsed);
    } catch (err) {
      const httpErr = mapDailySchedulerError(err);
      if (httpErr) throw httpErr;
      throw err; // any non-DailySchedulerError throw → dispatch 500
    }

    lastSetSchedules.set(name, parsed);
    writeNoContent(ctx.res);
  }

  // pause/resume share the same shape: resolve scheduler → resolve
  // cfg via cache > lookup → 400 if cfg null → setSchedule with the
  // toggled `enabled` flag → write the new cfg into cache so a
  // subsequent GET reflects the paused/resumed state without
  // re-querying lookup.
  //
  // rev3 fix #1: NOT calling parseJsonBody — pause/resume have no
  // body. dispatch finally drain handles any client-sent body
  // silently; we never inspect it.
  function handlePauseSchedule(ctx: HandlerContext): void {
    pauseOrResume(ctx, false);
  }

  function handleResumeSchedule(ctx: HandlerContext): void {
    pauseOrResume(ctx, true);
  }

  function pauseOrResume(ctx: HandlerContext, enabled: boolean): void {
    const name = ctx.params.name!;
    const scheduler = resolveScheduler(name);
    const cfg = resolveScheduleCfg(name);
    if (cfg === null) {
      const verb = enabled ? "resume" : "pause";
      throw new HttpError(
        400,
        "bad_request",
        `no schedule to ${verb}; POST /schedule first or configure initial schedule`,
      );
    }
    const next: DailyScheduleConfig = { ...cfg, enabled };
    try {
      scheduler.setSchedule(next);
    } catch (err) {
      const httpErr = mapDailySchedulerError(err);
      if (httpErr) throw httpErr;
      throw err;
    }
    lastSetSchedules.set(name, next);
    writeNoContent(ctx.res);
  }

  // ── Tier A: shutdown (Step 4, rev4 wrap locked) ─────────────────────
  //
  // Contract (M1-16.md rev4 拍板点 #1 row 10 + Routing Contract POST
  // /v1/shutdown + types.ts onShutdown JSDoc + Step 3b commit):
  //
  //   1. Do NOT call parseJsonBody — /shutdown is a no-body endpoint
  //      (rev3 fix #1). Even if a client sends a body, dispatch's
  //      finally drain swallows it; we never inspect it.
  //   2. Log shutdown_requested BEFORE responding so the operator
  //      sees the trigger in the log even if the daemon process
  //      tears down before request_completed can fire.
  //   3. Respond 200 + {status:"shutting_down"} immediately. The
  //      client must observe the response before the daemon starts
  //      stopping; otherwise close() may sever the response socket
  //      and the client sees ECONNRESET instead of HTTP 200.
  //   4. Schedule onShutdown via setImmediate so the response is
  //      flushed first, AND wrap it in the rev4-safe Promise chain
  //      so neither a synchronous throw NOR a returned rejected
  //      Promise can escape as an unhandledRejection /
  //      uncaughtException.
  //
  // The exact wrap shape is:
  //
  //   setImmediate(() => {
  //     Promise.resolve()
  //       .then(() => opts.onShutdown?.())
  //       .catch((cause) => safeLog({code:"handler_threw", ...}));
  //   });
  //
  // Why .then(() => onShutdown?.()) and NOT
  // Promise.resolve(onShutdown?.()):
  //   * The .then(callback) form defers callback execution to a
  //     microtask. Promise standard guarantees that any synchronous
  //     throw inside the .then handler is automatically converted
  //     into a rejected Promise, AND any returned rejected Promise
  //     is propagated. The .catch reliably covers BOTH shapes with
  //     one path.
  //   * The Promise.resolve(callback()) form evaluates callback()
  //     FIRST as the argument to Promise.resolve. JavaScript
  //     evaluates arguments before the function call, so a sync
  //     throw inside callback() escapes BEFORE Promise.resolve is
  //     reached. The .catch on the resulting promise never sees the
  //     throw, and the exception bubbles out of the setImmediate
  //     callback as uncaughtException (Node default exit 1). This
  //     is the bug Codex caught between rev3 and rev4 of the M1-16
  //     TED; do not regress.
  //
  // Multiple POST /v1/shutdown calls trigger onShutdown multiple
  // times — daemon (M1-18) is responsible for idempotent stop
  // (e.g. set a stopping flag and short-circuit subsequent calls).
  // M1-16 does not de-duplicate so it stays paper-thin.
  function handleShutdown(ctx: HandlerContext): void {
    safeLog({
      level: "info",
      code: "shutdown_requested",
      message: "shutdown requested via POST /v1/shutdown",
      method: "POST",
      path: "/v1/shutdown",
    });

    writeJson(ctx.res, 200, { status: "shutting_down" });

    setImmediate(() => {
      Promise.resolve()
        .then(() => opts.onShutdown?.())
        .catch((cause) => {
          safeLog({
            level: "error",
            code: "handler_threw",
            message: `onShutdown threw/rejected: ${describeError(cause)}`,
            cause,
            method: "POST",
            path: "/v1/shutdown",
          });
        });
    });
  }

  // ── dispatch ─────────────────────────────────────────────────────────
  //
  // Order:
  //   1. Build URL + tokenize path
  //   2. Authenticate before route lookup so unauthenticated probes cannot
  //      distinguish registered paths from unknown paths.
  //   3. Find routes whose pattern matches (regardless of method)
  //   4. If no path match → 404 not_found
  //   5. If path matches but method does not → 405 + Allow header
  //      (this also covers OPTIONS — there is no preflight handler
  //      because plan §5.4 + 拍板点 #12 disable CORS entirely)
  //   6. Invoke handler; HttpError → writeError; other throws → 500
  //   7. finally: drain remaining body bytes silently (rev3 fix #4
  //      preparation — even though Step 2 has no body-reading
  //      handler, the contract belongs in dispatch from day one) +
  //      log request_completed with status + duration
  async function dispatch(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const startMs = clock.now();
    const method = req.method ?? "GET";
    // URL constructor needs a base; the headers.host arrives from the
    // OS bind so it is trustworthy on 127.0.0.1, but we still fall
    // back to localhost to satisfy URL parsing when host header is
    // absent (HTTP/1.0 clients).
    const rawUrl = req.url ?? "/";
    const baseUrl = `http://${req.headers.host ?? "localhost"}`;
    let urlObj: URL;
    try {
      urlObj = new URL(rawUrl, baseUrl);
    } catch {
      // Malformed URL — return 400 immediately. We do not attempt to
      // route this; parse failure means we cannot trust the path at
      // all.
      writeError(res, 400, "bad_request", "invalid request URL");
      safeLog({
        level: "info",
        code: "request_completed",
        message: `${method} ${rawUrl} -> 400 (${clock.now() - startMs}ms)`,
        method,
        path: rawUrl,
        status: 400,
        durationMs: clock.now() - startMs,
      });
      return;
    }
    const tokens = tokenizePath(urlObj.pathname);
    let handlerStatus = 0;

    try {
      const auth = authenticate(req);
      if (!auth.ok) {
        safeLog({
          level: "warn",
          code: "auth_failed",
          message: `${method} ${urlObj.pathname}: auth failed (${auth.reason})`,
          method,
          path: urlObj.pathname,
          reason: auth.reason,
        });
        throw new HttpError(
          401,
          "unauthorized",
          `authentication required: ${auth.reason}`,
        );
      }

      // Path match across all methods first.
      const pathMatches = routes
        .map((route) => ({
          route,
          params: matchPattern(route.pattern, tokens),
        }))
        .filter(
          (m): m is { route: Route; params: Readonly<Record<string, string>> } =>
            m.params !== null,
        );

      if (pathMatches.length === 0) {
        throw new HttpError(404, "not_found", "path not found");
      }

      // Method match within path matches.
      const methodMatch = pathMatches.find((m) => m.route.method === method);
      if (!methodMatch) {
        const allowed = pathMatches
          .map((m) => m.route.method)
          .filter((v, i, arr) => arr.indexOf(v) === i)
          .join(", ");
        if (!res.headersSent) res.setHeader("Allow", allowed);
        throw new HttpError(
          405,
          "method_not_allowed",
          `method ${method} not allowed`,
        );
      }

      safeLog({
        level: "info",
        code: "request_received",
        message: `${method} ${urlObj.pathname}`,
        method,
        path: urlObj.pathname,
      });

      await methodMatch.route.handler({
        req,
        res,
        url: urlObj,
        params: methodMatch.params,
      });
      handlerStatus = res.statusCode;
    } catch (err) {
      if (err instanceof HttpError) {
        writeError(res, err.status, err.code, err.message, err.details);
        handlerStatus = err.status;
      } else {
        safeLog({
          level: "error",
          code: "handler_threw",
          message: `handler threw on ${method} ${urlObj.pathname}: ${describeError(err)}`,
          method,
          path: urlObj.pathname,
          cause: err,
        });
        writeError(res, 500, "internal_error", "internal server error");
        handlerStatus = 500;
      }
    } finally {
      // rev3 fix #4 dispatch finally: drain remaining bytes silently
      // so a body-bearing request that the handler did not consume
      // (e.g. unauthenticated POST with body) does not leave the
      // socket half-open. This also primes the contract for Step 3+
      // body-handling endpoints.
      if (!req.complete) {
        req.on("data", () => {});
        req.on("error", () => {});
      }
      safeLog({
        level: "info",
        code: "request_completed",
        message: `${method} ${urlObj.pathname} -> ${handlerStatus} (${clock.now() - startMs}ms)`,
        method,
        path: urlObj.pathname,
        status: handlerStatus,
        durationMs: clock.now() - startMs,
      });
    }
  }

  // ── HTTP server + lifecycle ──────────────────────────────────────────

  const server: Server = http.createServer((req, res) => {
    // dispatch() never throws synchronously, but async errors that
    // escape its internal try/catch (e.g. writeError itself failing
    // on a destroyed socket) are caught here as a last line of
    // defence. If the response head has not yet been sent we still
    // try to emit a 500; otherwise we silently let the connection
    // close. handler_threw is logged either way.
    dispatch(req, res).catch((err) => {
      safeLog({
        level: "error",
        code: "handler_threw",
        message: `dispatch escaped: ${describeError(err)}`,
        method: req.method,
        path: req.url,
        cause: err,
      });
      if (!res.headersSent) {
        try {
          writeError(res, 500, "internal_error", "internal server error");
        } catch {
          try {
            res.end();
          } catch {
            // socket already gone — give up.
          }
        }
      }
    });
  });

  type Lifecycle =
    | "pre-listen"
    | "listening"
    | "closing"
    | "closed"
    | "bind-failed";

  let lifecycle: Lifecycle = "pre-listen";
  let boundHost: string | null = null;
  let boundPort: number | null = null;
  let closingPromise: Promise<void> | null = null;

  function listen(): Promise<number> {
    if (lifecycle === "listening") {
      return Promise.reject(
        new ControlServerError(
          "invalid_state",
          "server already listening",
        ),
      );
    }
    if (
      lifecycle === "closing" ||
      lifecycle === "closed" ||
      lifecycle === "bind-failed"
    ) {
      return Promise.reject(
        new ControlServerError(
          "invalid_state",
          "server has been closed; create a new ControlServer",
        ),
      );
    }
    return new Promise<number>((resolve, reject) => {
      const onError = (err: Error) => {
        lifecycle = "bind-failed";
        reject(
          new ControlServerError(
            "bind_failed",
            `failed to bind ${host}:${port}: ${err.message}`,
            err,
          ),
        );
      };
      server.once("error", onError);
      server.listen({ host, port }, () => {
        server.off("error", onError);
        const addr = server.address();
        if (typeof addr === "string" || addr === null) {
          // UNIX socket or unexpected shape — should not happen on
          // host:port bind, but fail loudly rather than guess.
          lifecycle = "bind-failed";
          reject(
            new ControlServerError(
              "bind_failed",
              `unexpected listen address shape from server.address()`,
            ),
          );
          return;
        }
        boundHost = addr.address;
        boundPort = addr.port;
        lifecycle = "listening";
        safeLog({
          level: "info",
          code: "server_listening",
          message: `control API server listening on ${boundHost}:${boundPort}`,
          host: boundHost,
          port: boundPort,
        });
        resolve(boundPort);
      });
    });
  }

  function address(): ControlServerAddress | null {
    if (lifecycle !== "listening" || boundHost === null || boundPort === null) {
      return null;
    }
    return { host: boundHost, port: boundPort };
  }

  function close(): Promise<void> {
    if (lifecycle === "pre-listen" || lifecycle === "bind-failed") {
      // Idempotent: nothing was listening.
      lifecycle = "closed";
      return Promise.resolve();
    }
    if (lifecycle === "closed") {
      return Promise.resolve();
    }
    if (lifecycle === "closing" && closingPromise) {
      return closingPromise;
    }
    lifecycle = "closing";
    closingPromise = new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        lifecycle = "closed";
        safeLog({
          level: "info",
          code: "server_closed",
          message: "control API server closed",
        });
        resolve();
      };
      // Node 18.2+ exposes closeAllConnections. In environments where
      // it is unavailable we fall back to letting close() drain
      // whatever it can within the grace window.
      const closeAllConnections =
        (server as Server & { closeAllConnections?: () => void })
          .closeAllConnections;
      const timer = setTimeout(() => {
        if (typeof closeAllConnections === "function") {
          try {
            closeAllConnections.call(server);
          } catch {
            // Defensive — closeAllConnections should not throw.
          }
        }
        finish();
      }, CLOSE_GRACE_MS);
      timer.unref();
      server.close(() => finish());
    });
    return closingPromise;
  }

  return {
    listen,
    address,
    close,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function describeError(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

// ─── Type guards (narrow opts surface for downstream Step 3 wiring) ──────
//
// Re-exported for tests + future Step 3 helpers; not part of the
// public ControlServer surface.
export type { ControlAgentHandle, ControlRouterTarget };
