// runtime/src/wsclient/client.ts
//
// M1-06 Step 4 — WebSocket client welcome handshake.
// Scope (locked by Roy):
//   IN:   createWSClient() factory + WSClient class skeleton + HTTP
//         upgrade with X-API-Key header + wait first frame welcome +
//         welcome ajv validation + protocol-version major check +
//         welcome timeout + handshake/connect error mapping +
//         minimal close() for test cleanup.
//   OUT:  heartbeat / ping timer (Step 5), AbortSignal (Step 5),
//         reconnect (M1-07), message handler dispatch (Step 5/6),
//         full close lifecycle / onClose (Step 5), send() (Step 5/6).
//
// Type-leak guard (rev 2 P1 #3): the underlying `ws.WebSocket`
// instance lives in an ECMAScript `#private` field which TypeScript
// does NOT emit into the generated `.d.ts`. Additionally the
// WSClient constructor types its socket parameter as `unknown`
// rather than `WebSocket` so the constructor signature in the
// public declaration file carries no reference to `ws` either.
// Consumers of @aifight/aifight have no `ws` / `@types/ws` in
// their node_modules; both layers MUST stay clean.

import { WebSocket } from "ws";

import {
  WSAbortedError,
  type WSClientError,
  WSClosedError,
  WSConnectError,
  WSHandshakeError,
  WSDeviceMismatchError,
  WSProtocolVersionError,
  WSSchemaError,
  WSUnknownMessageError,
  WSWelcomeInvalidError,
  WSWelcomeTimeoutError,
  type AjvLikeError,
} from "./errors";
import {
  parseServerFrame,
  serializeClientMessage,
  type ServerMessageEnvelope,
} from "./frame-handler";

// ─── Public option + envelope shapes ────────────────────────────────

export interface WSWelcome {
  readonly type: "welcome";
  readonly data: {
    readonly server_protocol_version: string;
    readonly agent_id: string;
    readonly agent_name: string;
    readonly server_time: string;
    readonly games: readonly string[];
  };
  readonly match_id?: string;
}

/**
 * Discriminated union of valid outbound messages the client may
 * `send()` to the server. Mirrors the four `client_*.schema.json`
 * files at the TypeScript layer (rev 3 P2 #4 — TS first line of
 * defence; ajv via `serializeClientMessage` is the authoritative
 * runtime check).
 *
 * Required-vs-optional contracts here track schema `required` arrays:
 *   - join_queue:    `data` required (game name lives here)
 *   - leave_queue:   `data` optional (no fields needed)
 *   - match_confirm: `data` required (carries confirm_id)
 *   - action:        `match_id` required (server uses it for the
 *                    per-player session_id) AND `data` required
 *                    (the chosen action object)
 *
 * `match_id` on the three non-`action` types is envelope-level
 * scaffolding — the schemas accept it but no current message uses it.
 * Keep optional so callers don't have to thread an empty string.
 *
 * The `unknown` typing on `data` is deliberate: per-message strict
 * payload typing is M1-22 codegen territory. ajv enforces the inner
 * shape at runtime; surfacing it through TS now would duplicate
 * conformance work.
 */
export type WSClientMessage =
  | { type: "join_queue"; data: unknown; match_id?: string }
  | { type: "leave_queue"; data?: unknown; match_id?: string }
  | { type: "match_confirm"; data: unknown; match_id?: string }
  | {
      type: "action";
      match_id: string;
      data: unknown;
      /** REQUIRED echo of action_request.data.request_id (protocol v1.2,
       *  F07/R3-01; enforced 2026-07-16). Pins the submission to the decision
       *  it answers; the server refuses an id-less action unjudged
       *  (error + action_stale, no penalty). */
      request_id: string;
      /** Optional model usage metadata (protocol v1.1) — token counts
       *  only, never content. See client_action.schema.json `usage`. */
      usage?: {
        model: string;
        input_tokens?: number;
        output_tokens?: number;
        reasoning_tokens?: number;
        cached_tokens?: number;
      };
      /** Optional decision provenance (protocol v1.2, F09/AIF-03): model /
       *  model_retry / fallback. See client_action.schema.json `decision`. */
      decision?: {
        source: "model" | "model_retry" | "fallback";
        illegal_retries?: number;
        fallback_reason?: string;
      };
    }
  | { type: "runtime_status"; data: unknown; match_id?: string };

export interface WSClientOptions {
  /** WebSocket URL — e.g. "wss://aifight.ai/api/ws" or
   *  "ws://127.0.0.1:<port>/api/ws" in tests. */
  url: string;
  /** In-memory plaintext API key. Caller resolves from credentials.ts
   *  (M1-05) before this call; transport never touches keychain. */
  apiKey: string;
  /** Per-device id (sha256 of the device secret), sent as the X-Device-Id
   *  header so the server can enforce single-device binding (anti-theft).
   *  Optional: when absent the header is omitted (a lenient server treats a
   *  missing header as a legacy client). */
  deviceId?: string;
  /** Runtime's compiled-in protocol version, SemVer (e.g. "1.0.0"
   *  or "v1.0.0"). The optional "v" prefix is stripped before
   *  comparison. Major component must match server's
   *  server_protocol_version per plan §5.8 / ADR-016. */
  expectedProtocolVersion: string;
  /** Time after WS open() to receive the welcome frame. Default
   *  10_000 ms. Tests can lower for fast-fail coverage. */
  welcomeTimeoutMs?: number;
  /** Client-initiated WS ping frame (opcode 0x9) interval in ms.
   *  Default 25_000 (per plan §5.8 / ADR-015 — keeps server's
   *  60s ReadDeadline safely fed). Set to 0 to DISABLE the
   *  client-initiated ping entirely (the server's own ping +
   *  the `ws` library's automatic pong reply still keep the
   *  link alive in that case, but the structural Batch D fix
   *  — independent client ping timer — is not active). */
  pingIntervalMs?: number;
  /** Optional caller-controlled AbortSignal. If pre-aborted
   *  (signal.aborted=true at the moment createWSClient is called),
   *  rejects synchronously with WSAbortedError. If aborted
   *  mid-handshake, terminates the socket and rejects with
   *  WSAbortedError. If aborted AFTER createWSClient resolves,
   *  the WSClient transitions to "closed" (timers cleared,
   *  socket terminated) — equivalent to calling close(); no
   *  error is thrown since the signal owner is the actor. */
  signal?: AbortSignal;
  /** Maximum inbound WS frame size in bytes (R13-F03). `ws` closes the
   *  connection with code 1009 ("message too big") when the server sends a
   *  larger frame, which surfaces here as a normal close → reconnect. Defaults
   *  to DEFAULT_MAX_PAYLOAD_BYTES; the `ws` library default is 100 MiB, far
   *  above any legitimate AIFight frame, so an unbounded default would let a
   *  buggy/hostile server pin ~100 MiB of client memory per frame. */
  maxPayloadBytes?: number;
}

const DEFAULT_WELCOME_TIMEOUT_MS = 10_000;
const DEFAULT_PING_INTERVAL_MS = 25_000;
// R13-F03: 2 MiB is comfortably above the largest legitimate AIFight frame — a
// full-history reconnect action_request (event_history capped at 65536 events by
// server_action_request.schema.json, each event a small JSON object) is orders of
// magnitude smaller — while capping how much memory one inbound frame can pin.
const DEFAULT_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
// R13-F03: cap the buffered body of a rejected HTTP upgrade (non-101) response.
// The body is only used for an error message; 64 KiB is plenty for a JSON error,
// and prevents a hostile/misbehaving server from streaming an unbounded body into
// memory during the handshake.
const UPGRADE_REJECT_BODY_MAX_BYTES = 64 * 1024;

// ─── Public handler types (Step 5b1) ────────────────────────────────
//
// All three handler types may return a Promise; the WSClient's
// dispatcher fires-and-forgets it (rev 2 P2 #5: "handler Promise
// is explicitly discarded, not awaited"). The Batch D structural
// fix requires this — async handler work MUST NOT block the ping
// timer or any other inbound frame's dispatch.

export type WSMessageHandler = (
  msg: ServerMessageEnvelope,
) => void | Promise<void>;

/** Frame-level errors surfaced AFTER createWSClient resolves —
 *  malformed inbound JSON, schema violations, unknown server
 *  message types. Connect / handshake / welcome errors are
 *  rejected by createWSClient itself and never reach onError. */
export type WSErrorHandler = (
  err: WSClientError,
) => void | Promise<void>;

/** Information passed to onClose handlers. The connection is
 *  fully torn down by the time this fires; no further onMessage
 *  / onError handlers will run. */
export interface WSCloseInfo {
  /** WS close code from the close frame, or 0 for synthetic
   *  closes (abort, transport error before close frame). */
  readonly code: number;
  /** Human-readable reason. For client-initiated close, the
   *  string passed to close(); for server-initiated, what the
   *  server sent; for abort, the constant "aborted". */
  readonly reason: string;
  /** Who initiated the close: client (close() call), server
   *  (server-side close), or abort (AbortSignal fired
   *  post-connect). */
  readonly initiator: "client" | "server" | "abort";
}

export type WSCloseHandler = (info: WSCloseInfo) => void | Promise<void>;

/** Convert AbortSignal.reason (which is `unknown`) to a stable
 *  string for error messages. Mirrors the Web spec: when abort()
 *  is called without a reason, the spec defaults to a DOMException;
 *  when called with a reason, it can be anything. */
function stringifyAbortReason(reason: unknown): string {
  if (reason === undefined) return "(no reason)";
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  try {
    return String(reason);
  } catch {
    return "(unstringifiable reason)";
  }
}

// ─── WSClient class ─────────────────────────────────────────────────
//
// Step 4b: the implementation class is module-private. The PUBLIC
// surface of @aifight/aifight exports WSClient as a TYPE ALIAS only
// (see `export type WSClient = WSClientImpl` below). Consumers cannot
// `new WSClient(...)` to fabricate an "authenticated" client — the
// only way to get a WSClient is through the createWSClient() factory,
// which performs the handshake. This enforces the contract: holding a
// WSClient means a server-confirmed welcome happened.
//
// Why a class at all (rather than an interface + factory closure)?
// (a) #private fields work with classes, not interfaces — they are
//     the type-leak guard for the ws.WebSocket reference (rev 2
//     P1 #3).
// (b) Steps 5/6 will add stateful methods (heartbeat timers, handler
//     registries) where mutating private state inside method bodies
//     reads more naturally on a class than on a closure-bound object
//     literal.
// The class-as-implementation + type-alias-as-export pattern gives us
// both: full class ergonomics internally, no constructor exposed
// externally.

/** @internal — passed from createWSClient to WSClientImpl constructor. */
interface WSClientInternalOpts {
  pingIntervalMs?: number;
  signal?: AbortSignal;
}

class WSClientImpl {
  // ECMAScript #private: NOT emitted to .d.ts. The ws.WebSocket
  // instance never escapes this module via the public surface.
  #socket: WebSocket;
  #state: "connected" | "closing" | "closed" = "connected";
  // Step 5a fields — also #private, also absent from .d.ts.
  #pingTimer: NodeJS.Timeout | null = null;
  #abortSignal: AbortSignal | null = null;
  // Stored so close() can detach the listener. AbortSignal exposes
  // no isAborted-after-removal observable, so we track the handler.
  #abortHandler: (() => void) | null = null;
  // Step 5b1 fields — handler registries + close coordination.
  #messageHandlers: Set<WSMessageHandler> = new Set();
  #errorHandlers: Set<WSErrorHandler> = new Set();
  #closeHandlers: Set<WSCloseHandler> = new Set();
  #closeDispatched = false;
  // Set when close() / abort initiate; constructor's "close" listener
  // reads this to determine the WSCloseInfo.initiator. null = server
  // initiated (or pre-connect orphan close, but that branch is
  // unreachable post-resolve).
  #closeInitiator: "client" | "abort" | null = null;
  // Resolved by the constructor's "close" listener so close() can
  // await the actual socket close. Re-used if close() is called
  // multiple times (idempotent semantics).
  #closingPromise: Promise<void> | null = null;
  #resolveClosingPromise: (() => void) | null = null;

  /** The authenticated welcome frame received from the server. */
  readonly welcome: WSWelcome;

  /**
   * Constructor is REACHABLE only from this module's createWSClient
   * factory. Because WSClientImpl is not exported, consumers of
   * @aifight/aifight cannot `new` it (they only see the
   * `export type WSClient = WSClientImpl` alias, which carries
   * no constructor signature). The `socket` parameter is typed as
   * `unknown` belt-and-suspenders so that even if an internal
   * caller someday passes the wrong shape it fails as a cast
   * mistake rather than a structural type leak.
   *
   * Step 5a additions:
   *   - Starts a client-initiated ping timer (default 25s; pass
   *     pingIntervalMs=0 to disable).
   *   - Wires opts.signal so a post-connect abort triggers a forced
   *     close-equivalent transition (state→closed, timer cleared,
   *     socket terminated) without throwing — the signal owner is
   *     the actor and already knows.
   *
   * Step 5b1 additions:
   *   - Re-attaches "message", "error", "close" listeners on the
   *     socket (createWSClient's cleanup() removed all listeners
   *     during the handshake settle; this is the post-handshake
   *     re-attachment Roy flagged in the Step 5b1 brief).
   *   - "message" routes through parseServerFrame and dispatches
   *     to onMessage / onError handlers.
   *   - "close" emits onClose (idempotent via #closeDispatched).
   *   - "error" goes to a silent sink; transport errors usually
   *     pair with "close" which carries the user-facing signal.
   *     Frame-level errors (parse / schema / unknown) come through
   *     the message path, not the error event.
   */
  constructor(
    socket: unknown,
    welcome: WSWelcome,
    opts: WSClientInternalOpts,
  ) {
    this.#socket = socket as WebSocket;
    this.welcome = welcome;

    // ─── Re-register socket listeners (Step 5b1) ────────────────────
    //
    // createWSClient's settle/cleanup path called
    // socket.removeAllListeners() before handing the socket here,
    // so we own a bare socket and must wire everything we need.

    this.#socket.on("message", (data: Buffer | string | ArrayBuffer) => {
      this.#handleInboundFrame(data);
    });

    this.#socket.on("error", () => {
      // Transport-level error. ws will follow with "close" which
      // carries the user-facing signal via onClose. Swallow here;
      // EventEmitter would otherwise throw "Unhandled 'error'".
    });

    this.#socket.once("close", (code: number, reasonBuf: Buffer) => {
      // Single source of truth for state→closed + onClose dispatch.
      // Idempotent via #closeDispatched (abort path may have already
      // emitted before terminate() triggered this event).
      const reason = reasonBuf?.toString("utf8") ?? "";
      const initiator = this.#closeInitiator ?? "server";
      this.#emitCloseOnce({ code, reason, initiator });
      this.#state = "closed";
      this.#shutdownTimers();
      // Resolve any in-flight close() promise.
      if (this.#resolveClosingPromise) {
        this.#resolveClosingPromise();
        this.#resolveClosingPromise = null;
      }
    });

    // ─── Heartbeat (Step 5a, plan §5.8 Batch D structural fix) ──────
    const pingInterval = opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    if (pingInterval > 0) {
      this.#pingTimer = setInterval(() => {
        try {
          this.#socket.ping();
        } catch {
          if (this.#pingTimer) {
            clearInterval(this.#pingTimer);
            this.#pingTimer = null;
          }
        }
      }, pingInterval);
    }

    // ─── Post-connect abort wiring (Step 5a) ────────────────────────
    if (opts.signal) {
      this.#abortSignal = opts.signal;
      this.#abortHandler = (): void => {
        // Step 5b1: abort dispatches onClose synchronously with
        // initiator="abort", code=0, reason="aborted". The
        // subsequent terminate() will fire the socket "close" event,
        // but #emitCloseOnce makes that a no-op.
        if (this.#state === "closed") return;
        this.#closeInitiator = "abort";
        this.#emitCloseOnce({
          code: 0,
          reason: "aborted",
          initiator: "abort",
        });
        this.#state = "closed";
        this.#shutdownTimers();
        try {
          this.#socket.terminate();
        } catch {
          /* ignore — socket already in non-terminable state */
        }
      };
      opts.signal.addEventListener("abort", this.#abortHandler, {
        once: true,
      });
    }
  }

  /** Current lifecycle state. Step 5b1 expanded to three values:
   *  "connected" after createWSClient resolves, "closing" while
   *  close() is awaiting the socket close handshake (briefly),
   *  "closed" after close completes (or abort / server close
   *  fires). M1-07 may add "reconnecting". */
  get state(): "connected" | "closing" | "closed" {
    return this.#state;
  }

  // ─── Handler registration (Step 5b1) ─────────────────────────────
  //
  // All three return an unsubscribe function that removes the
  // handler. Idempotent: calling unsubscribe twice is a no-op
  // (Set.delete returns false but doesn't throw).
  //
  // Handlers registered AFTER a frame / error has been dispatched
  // do NOT receive the past event (no replay). Handlers registered
  // DURING dispatch are not invoked for the in-flight event
  // (dispatch iterates a snapshot of the registry).

  onMessage(handler: WSMessageHandler): () => void {
    this.#messageHandlers.add(handler);
    return () => {
      this.#messageHandlers.delete(handler);
    };
  }

  onError(handler: WSErrorHandler): () => void {
    this.#errorHandlers.add(handler);
    return () => {
      this.#errorHandlers.delete(handler);
    };
  }

  onClose(handler: WSCloseHandler): () => void {
    this.#closeHandlers.add(handler);
    return () => {
      this.#closeHandlers.delete(handler);
    };
  }

  // ─── Inbound dispatch (Step 5b1) ─────────────────────────────────
  //
  // Called from the socket "message" handler. parseServerFrame is
  // pure and throws WSSchemaError / WSUnknownMessageError — both
  // are mapped to onError invocations. The connection STAYS OPEN on
  // any frame-level error (Roy's choice in the Step 5b1 brief: just
  // report and keep going).

  #handleInboundFrame(data: Buffer | string | ArrayBuffer): void {
    if (this.#state !== "connected") return; // already closing/closed
    const frame: string | Buffer =
      typeof data === "string" || Buffer.isBuffer(data)
        ? data
        : Buffer.from(data as ArrayBuffer);

    let parsed: ServerMessageEnvelope;
    try {
      parsed = parseServerFrame(frame);
    } catch (e) {
      if (e instanceof WSSchemaError || e instanceof WSUnknownMessageError) {
        this.#dispatchError(e);
      } else {
        // Wrap unexpected throw to keep onError signature consistent.
        const msg = e instanceof Error ? e.message : String(e);
        this.#dispatchError(
          new WSSchemaError("<unknown>", [], `unexpected frame parse error: ${msg}`),
        );
      }
      return;
    }
    this.#dispatchMessage(parsed);
  }

  // ─── Handler dispatch primitives (Step 5b1) ──────────────────────
  //
  // rev 2 P2 #5: handler return values are explicitly discarded.
  // If a handler returns a Promise, we attach a no-op .catch() to
  // suppress unhandled rejections — but we do NOT await. The ping
  // timer and any subsequent inbound frames keep flowing. This is
  // the second half of the Batch D structural fix (the first half,
  // independent ping timer, landed in Step 5a).
  //
  // Sync throws inside handlers are swallowed: a handler bug must
  // not affect the transport. (Recursively dispatching such throws
  // through onError could loop forever if onError itself throws.)
  //
  // Iteration uses a snapshot to avoid skip/double-fire issues if
  // a handler unsubscribes or registers another during dispatch.

  #dispatchMessage(msg: ServerMessageEnvelope): void {
    const snapshot = [...this.#messageHandlers];
    for (const h of snapshot) {
      this.#fireAndForget(() => h(msg));
    }
  }

  #dispatchError(err: WSClientError): void {
    const snapshot = [...this.#errorHandlers];
    for (const h of snapshot) {
      this.#fireAndForget(() => h(err));
    }
  }

  #emitCloseOnce(info: WSCloseInfo): void {
    if (this.#closeDispatched) return;
    this.#closeDispatched = true;
    const snapshot = [...this.#closeHandlers];
    for (const h of snapshot) {
      this.#fireAndForget(() => h(info));
    }
  }

  #fireAndForget(invoke: () => void | Promise<void>): void {
    try {
      const r = invoke();
      // If handler returned a Promise, suppress unhandled rejection
      // without awaiting. void operator alone doesn't attach a
      // catch — the .then(undefined, swallow) does.
      if (r && typeof (r as { then?: unknown }).then === "function") {
        (r as Promise<unknown>).then(undefined, () => {
          /* swallow */
        });
      }
    } catch {
      /* swallow handler sync throw */
    }
  }

  // ─── Outbound (Step 5b2) ─────────────────────────────────────────
  //
  // Synchronous send. Two failure modes, both thrown on the calling
  // stack — neither routes through onError because both indicate a
  // caller-side issue that the application code must handle, not a
  // server-side runtime drift signal:
  //
  //   1. State !== "connected" → WSClosedError. The connection has
  //      been closed (by us, the server, or an abort), and there is
  //      no point queuing the bytes; the caller must obtain a fresh
  //      WSClient via createWSClient().
  //   2. Envelope fails ajv against client_<type>.schema.json →
  //      WSOutboundSchemaError (raised by serializeClientMessage).
  //      Local programming error per rev 2 P2 #4 — propagate AS-IS
  //      so the caller sees the offending type + ajv errors.
  //
  // The TS-level WSClientMessage union is the FIRST line of defence
  // (catches missing `match_id` on `action`, unknown types). ajv via
  // `serializeClientMessage` is the AUTHORITATIVE runtime check —
  // any path that bypasses TS (untyped JSON, dynamic dispatch) still
  // gets caught before bytes reach the wire.

  /**
   * Send an outbound message to the server. Synchronous.
   *
   * @throws {WSClosedError} when the client is not in the "connected"
   *         state (i.e. close()/abort/server-close has fired).
   * @throws {WSOutboundSchemaError} when `msg` fails ajv validation
   *         against client_<type>.schema.json. The error carries the
   *         offending message type and the raw ajv error array.
   */
  send(msg: WSClientMessage): void {
    if (this.#state !== "connected") {
      throw new WSClosedError(
        `cannot send: client state is "${this.#state}" (expected "connected")`,
      );
    }
    // serializeClientMessage validates and returns the JSON string,
    // or throws WSOutboundSchemaError. We let it propagate — the
    // caller distinguishes outbound-schema failures from closed
    // failures via `instanceof` / `kind`.
    const serialized = serializeClientMessage(msg);
    this.#socket.send(serialized);
  }

  // ─── Lifecycle control (Step 5a + 5b1) ───────────────────────────

  /**
   * Synchronous portion of timer/listener cleanup. Used by close(),
   * abort handler, and the socket "close" listener. Does NOT
   * mutate state — callers handle that separately because the
   * state transition timing differs:
   *   - close(): connected → closing (then closed via socket event)
   *   - abort:    connected → closed (sync, no closing intermediate)
   *   - server:   connected → closed (sync via socket event)
   *
   * Idempotent: safe to call multiple times.
   */
  #shutdownTimers(): void {
    if (this.#pingTimer) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
    if (this.#abortSignal && this.#abortHandler) {
      this.#abortSignal.removeEventListener("abort", this.#abortHandler);
      this.#abortSignal = null;
      this.#abortHandler = null;
    }
  }

  /**
   * Initiate a clean WS close. State transitions
   * connected → closing → closed; onClose fires exactly once when
   * the socket's "close" event arrives.
   *
   * Idempotent semantics:
   *   - Calling on a "closing" instance returns the in-flight
   *     close promise (so two awaiters share the same await).
   *   - Calling on a "closed" instance returns immediately.
   *   - Subsequent call after either resolves does nothing.
   */
  async close(code: number = 1000, reason: string = ""): Promise<void> {
    if (this.#state === "closed") return;
    if (this.#state === "closing") {
      // Already in close handshake — share the in-flight promise.
      if (this.#closingPromise) await this.#closingPromise;
      return;
    }

    this.#closeInitiator = "client";
    this.#state = "closing";
    this.#shutdownTimers();

    this.#closingPromise = new Promise<void>((resolve) => {
      this.#resolveClosingPromise = resolve;
    });

    try {
      this.#socket.close(code, reason);
    } catch {
      // Socket in a non-closable state — synthesize the close
      // dispatch ourselves so onClose handlers still fire.
      this.#emitCloseOnce({ code, reason, initiator: "client" });
      this.#state = "closed";
      if (this.#resolveClosingPromise) {
        this.#resolveClosingPromise();
        this.#resolveClosingPromise = null;
      }
    }
    await this.#closingPromise;
  }
}

/** The public WSClient type. This is a type alias over the internal
 *  WSClientImpl class — consumers can use `WSClient` as a TypeScript
 *  type (parameter / return / variable annotation) but cannot
 *  construct one directly because no class value with this name is
 *  exported. The only way to obtain a WSClient is via the
 *  createWSClient() factory. */
export type WSClient = WSClientImpl;

// ─── createWSClient: handshake state machine ────────────────────────

/**
 * Open a WebSocket to `opts.url`, send `X-API-Key` in the upgrade
 * request, wait for the server's welcome frame, validate it
 * (ajv + protocol-version major), and return a WSClient bound to
 * the open socket.
 *
 * Resolves on welcome accepted. Rejects with one of:
 *   - WSConnectError         — TCP/TLS/DNS failure (no HTTP response)
 *   - WSHandshakeError       — HTTP upgrade returned non-101 (4xx/5xx)
 *   - WSWelcomeTimeoutError  — open succeeded but no frame within
 *                              welcomeTimeoutMs (default 10s)
 *   - WSWelcomeInvalidError  — first frame is not a valid welcome:
 *                              malformed JSON, unknown type,
 *                              wrong type, or schema-invalid welcome
 *                              (ajv errors carried)
 *   - WSProtocolVersionError — welcome valid but
 *                              server_protocol_version major
 *                              differs from expectedProtocolVersion
 *
 * Step 4 caveats:
 *   - No AbortSignal (Step 5).
 *   - No reconnect (M1-07).
 *   - No retry on any error class — caller decides.
 */
export async function createWSClient(
  opts: WSClientOptions,
): Promise<WSClient> {
  const welcomeTimeoutMs =
    opts.welcomeTimeoutMs ?? DEFAULT_WELCOME_TIMEOUT_MS;

  // ─── Pre-aborted check (Step 5a) ───────────────────────────────────
  // If the caller's signal is already aborted at the moment
  // createWSClient is invoked, never even open the socket. Reject
  // synchronously with WSAbortedError so the caller sees a clear
  // signal rather than a connect/handshake error masking the abort.
  if (opts.signal?.aborted) {
    return Promise.reject(
      new WSAbortedError(
        `createWSClient aborted before start: ${stringifyAbortReason(opts.signal.reason)}`,
        opts.signal.reason,
      ),
    );
  }

  return new Promise<WSClient>((resolve, reject) => {
    let socket: WebSocket;
    try {
      const headers: Record<string, string> = { "X-API-Key": opts.apiKey };
      if (opts.deviceId) headers["X-Device-Id"] = opts.deviceId;
      // Declare the protocol version our bundled schemas speak (F07,
      // protocol v1.2). Since the 2026-07-16 enforcement the server REFUSES
      // handshakes below v1.2.0 (readable error frame + close): every
      // action_request carries request_id unconditionally, action submissions
      // must echo it, and a pre-v1.2 bundle would reject those frames
      // (additionalProperties: false) and silently lose every turn.
      headers["X-AIFight-Protocol-Version"] = opts.expectedProtocolVersion;
      // R13-F03: bound the inbound frame size. An oversize frame makes `ws`
      // close with 1009 ("message too big"), which flows through the normal
      // close → reconnect path rather than pinning ~100 MiB (the ws default).
      socket = new WebSocket(opts.url, {
        headers,
        maxPayload: opts.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
      });
    } catch (e) {
      // Synchronous construction failure (e.g. invalid URL parse).
      const msg = e instanceof Error ? e.message : String(e);
      reject(
        new WSConnectError(
          `failed to construct WebSocket for ${opts.url}: ${msg}`,
          e,
        ),
      );
      return;
    }

    let settled = false;
    let welcomeTimer: NodeJS.Timeout | null = null;
    // Step 5a: capture mid-handshake abort handler so cleanup can
    // detach it. AbortSignal exposes no isAborted-after-removal
    // observable, hence the explicit reference.
    let abortHandler: (() => void) | null = null;

    const cleanup = (): void => {
      if (welcomeTimer) {
        clearTimeout(welcomeTimer);
        welcomeTimer = null;
      }
      if (opts.signal && abortHandler) {
        opts.signal.removeEventListener("abort", abortHandler);
        abortHandler = null;
      }
      socket.removeAllListeners();
      // Defense-in-depth: install a silent "error" sink. After cleanup
      // strips the original handlers, the socket may still emit a
      // final async "error" (e.g. abortHandshake racing the server's
      // Connection: close, or terminate() in CONNECTING state). The
      // createWSClient promise is already settled — EventEmitter
      // would otherwise throw "Unhandled 'error' event" and crash
      // the process. Swallowing is correct here.
      socket.on("error", () => {
        /* swallow stray post-settle errors */
      });
    };

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    // ─── Mid-handshake abort wiring (Step 5a) ──────────────────────
    // If the signal aborts after socket construction but before the
    // welcome handshake completes, terminate the socket and reject
    // with WSAbortedError. cleanup() detaches this listener on any
    // settle path, including normal resolve.
    if (opts.signal) {
      abortHandler = (): void => {
        settle(() => {
          try {
            socket.terminate();
          } catch {
            /* ignore */
          }
          reject(
            new WSAbortedError(
              `createWSClient aborted during handshake: ${stringifyAbortReason(opts.signal!.reason)}`,
              opts.signal!.reason,
            ),
          );
        });
      };
      opts.signal.addEventListener("abort", abortHandler, { once: true });
    }

    // TCP/TLS/DNS layer — `ws` library emits "error" before "open"
    // on connect failures. Note: "error" and "unexpected-response"
    // are mutually exclusive in `ws`'s handler model.
    socket.once("error", (err: Error) => {
      settle(() => {
        // socket is already destroyed by ws on "error"; no terminate
        // needed. Some platforms still leave the handle around — best
        // effort.
        try {
          socket.terminate();
        } catch {
          /* ignore */
        }
        reject(
          new WSConnectError(
            `WebSocket connect failed for ${opts.url}: ${err.message}`,
            err,
          ),
        );
      });
    });

    // HTTP upgrade rejection (server returned non-101 status).
    // Body is buffered as utf-8 string so callers can surface it
    // (e.g. "{\"error\":\"invalid api key\"}").
    socket.once("unexpected-response", (req, res) => {
      let body = "";
      // R13-F03: cap the buffered reject body. Once past the cap we stop
      // appending and destroy the response so a hostile/misbehaving server
      // can't stream an unbounded body into memory during the handshake; the
      // bytes already collected are enough for the error message.
      let bodyBytes = 0;
      let bodyTruncated = false;
      res.setEncoding("utf8");
      const rejectUpgrade = (): void => {
        const status = res.statusCode ?? 0;
        const statusText = res.statusMessage ?? "";
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
        // Note: do NOT call socket.terminate() here. The server sent
        // Connection: close, so ws will tear down the underlying
        // socket when the response stream ends. Calling terminate()
        // while the socket is in CONNECTING state triggers
        // abortHandshake which emits an async "error" event on the
        // next tick — that races our cleanup and would crash the
        // process via EventEmitter's unhandled-error throw. The
        // silent-error sink installed in cleanup() catches any
        // straggler regardless, but skipping the redundant
        // terminate is the cleaner fix.
        settle(() =>
          reject(
            status === 403 && body.includes("device_mismatch")
              ? new WSDeviceMismatchError(
                  body,
                  "device mismatch: this agent is bound to another machine",
                )
              : new WSHandshakeError(
                  status,
                  body,
                  `HTTP upgrade rejected: ${status} ${statusText}${bodyTruncated ? " (response body truncated)" : ""}`.trim(),
                ),
          ),
        );
      };
      res.on("data", (chunk: string) => {
        if (bodyTruncated) return;
        bodyBytes += Buffer.byteLength(chunk, "utf8");
        if (bodyBytes > UPGRADE_REJECT_BODY_MAX_BYTES) {
          bodyTruncated = true;
          try {
            res.destroy();
          } catch {
            /* ignore */
          }
          rejectUpgrade();
          return;
        }
        body += chunk;
      });
      res.on("end", () => {
        if (bodyTruncated) return; // already rejected on the cap path
        rejectUpgrade();
      });
      res.on("error", (e: Error) => {
        const status = res.statusCode ?? 0;
        // Same reasoning as res.on("end"): don't terminate during
        // CONNECTING. The silent error sink in cleanup() catches
        // any subsequent stray emission.
        settle(() =>
          reject(
            new WSHandshakeError(
              status,
              body,
              `HTTP upgrade response read failed: ${e.message}`,
              e,
            ),
          ),
        );
      });
    });

    // Welcome timeout — clock starts at WS "open" so connect+upgrade
    // time doesn't eat into the welcome budget. If "open" never fires
    // (because connect/handshake fails first), this timer is never
    // armed and is never cleared either, but `cleanup()` defends.
    socket.once("open", () => {
      welcomeTimer = setTimeout(() => {
        settle(() => {
          try {
            socket.terminate();
          } catch {
            /* ignore */
          }
          reject(
            new WSWelcomeTimeoutError(
              `welcome did not arrive within ${welcomeTimeoutMs}ms after WebSocket open`,
            ),
          );
        });
      }, welcomeTimeoutMs);
    });

    // First inbound message — must be welcome, schema-valid, with a
    // matching protocol-version major.
    socket.once("message", (data: Buffer | string | ArrayBuffer) => {
      // `ws` may hand us Buffer, string, or ArrayBuffer depending on
      // opts; parseServerFrame accepts string|Buffer. Coerce
      // ArrayBuffer if it arrives (rare with default opts).
      const frame: string | Buffer =
        typeof data === "string" || Buffer.isBuffer(data)
          ? data
          : Buffer.from(data as ArrayBuffer);

      let parsed: ServerMessageEnvelope;
      try {
        parsed = parseServerFrame(frame);
      } catch (e) {
        // Translate frame-handler errors to WSWelcomeInvalidError so
        // the caller's mental model is "welcome handshake failed",
        // not "message dispatch failed mid-stream". Both inbound
        // failure classes (schema / unknown-message) collapse to
        // welcome-invalid here because we have no "connected" state
        // yet to surface them via onError.
        let ajvErrors: readonly AjvLikeError[] = [];
        let msg = "first frame failed to parse";
        if (e instanceof WSSchemaError) {
          ajvErrors = e.ajvErrors;
          msg =
            e.messageType === "welcome"
              ? `welcome failed schema validation: ${e.message}`
              : `first frame parse failure (${e.messageType}): ${e.message}`;
        } else if (e instanceof WSUnknownMessageError) {
          msg = `first frame had unknown server message type '${e.messageType}': ${e.message}`;
        } else if (e instanceof Error) {
          msg = `first frame parse error: ${e.message}`;
        }
        settle(() => {
          try {
            socket.terminate();
          } catch {
            /* ignore */
          }
          reject(new WSWelcomeInvalidError(ajvErrors, msg));
        });
        return;
      }

      if (parsed.type !== "welcome") {
        settle(() => {
          try {
            socket.terminate();
          } catch {
            /* ignore */
          }
          reject(
            new WSWelcomeInvalidError(
              [],
              `expected first frame to be 'welcome', got '${parsed.type}'`,
            ),
          );
        });
        return;
      }

      // ajv has confirmed the welcome shape via parseServerFrame +
      // server_welcome.schema.json. Cast through unknown for the same
      // reason as parseServerFrame's return cast — local narrowing
      // doesn't satisfy structural check.
      const welcome = parsed as unknown as WSWelcome;
      const serverVersion = welcome.data.server_protocol_version;

      const stripV = (v: string): string =>
        v.startsWith("v") ? v.slice(1) : v;
      const clientMajor = stripV(opts.expectedProtocolVersion).split(".")[0];
      const serverMajor = stripV(serverVersion).split(".")[0];

      if (clientMajor !== serverMajor) {
        settle(() => {
          try {
            socket.terminate();
          } catch {
            /* ignore */
          }
          reject(
            new WSProtocolVersionError(
              opts.expectedProtocolVersion,
              serverVersion,
              `protocol major version mismatch: client expected '${opts.expectedProtocolVersion}', server is '${serverVersion}'`,
            ),
          );
        });
        return;
      }

      // Welcome accepted — transfer ownership to WSClient. cleanup()
      // removes our handshake listeners; WSClient.close() will
      // register its own one-shot "close" listener when called.
      // Construct via the internal WSClientImpl since the public
      // export is type-only (Step 4b — no constructor in .d.ts).
      // Step 5a: forward pingIntervalMs + signal so the post-connect
      // heartbeat starts and the abort listener moves from "mid-
      // handshake" wiring (above, attached to abortHandler) to
      // "post-connect" wiring (inside WSClientImpl, attached to
      // its own #abortHandler). cleanup() detaches the mid-handshake
      // listener BEFORE WSClientImpl attaches its own — the signal
      // can fire only one set of listeners at a time, so a near-
      // simultaneous abort + welcome arrives at WSClientImpl's
      // listener (since that's the one alive after settle).
      settle(() => {
        const client = new WSClientImpl(socket, welcome, {
          pingIntervalMs: opts.pingIntervalMs,
          signal: opts.signal,
        });
        resolve(client);
      });
    });
  });
}
