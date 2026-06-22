// Typed error hierarchy for the WebSocket client (M1-06).
//
// Mirrors src/account/errors.ts and src/store/errors.ts in shape:
// one abstract base + concrete subclasses with a `kind`
// discriminator, plus optional `cause?: unknown` on classes that
// genuinely wrap a lower-layer error. Programmatic branching uses
// `kind` or `instanceof`; message text is free-form English and
// MUST NOT be parsed.
//
// These are pure data carriers — nothing in this file touches the
// network, the disk, or a logger. Construction is cheap and
// allocation-only; subclasses set `this.name` so V8 stack frames
// and structured logs identify them correctly.
//
// Note on inbound vs outbound schema errors (rev 2 P2 #4): we keep
// WSSchemaError (inbound — server bug / protocol drift) and
// WSOutboundSchemaError (outbound — local code bug, sync throw at
// send()) as separate classes. Same shape, different semantics:
// callers handle them differently (inbound goes to onError handler;
// outbound propagates synchronously to the calling code).

// ─── Local Ajv error shape ──────────────────────────────────────────
//
// Re-declared locally instead of imported from ../account/errors to
// avoid creating a wsclient → account directional dependency
// (wsclient is not an "account" concern). Same structural shape as
// account/errors.ts#AjvLikeError; future refactor can promote this to
// runtime/src/protocol/ if a third consumer appears.

export interface AjvLikeError {
  readonly instancePath: string;
  readonly message?: string;
}

// ─── Discriminator + base ───────────────────────────────────────────

export type WSClientErrorKind =
  // TCP / TLS / DNS layer failure when opening the WebSocket.
  | "connect"
  // HTTP upgrade refused by the server (4xx / 5xx response).
  | "handshake"
  // WS opened but the welcome frame did not arrive in time.
  | "welcome-timeout"
  // First server frame was not a valid welcome (wrong type, bad
  // shape per ajv, missing required fields).
  | "welcome-invalid"
  // server_protocol_version major component does not match the
  // runtime's compiled-in version (per plan §5.8 + ADR-016).
  | "protocol-version"
  // Operation attempted on a connection in a non-"connected" state
  // (e.g. send() while closing, close() after close).
  | "closed"
  // Inbound payload failed ajv schema validation. Server bug or
  // protocol drift; surfaced via onError, connection stays open.
  | "schema"
  // Outbound payload (passed to send()) failed ajv schema validation
  // BEFORE serialization. Local code bug; thrown synchronously to
  // the caller, message never reaches the wire.
  | "outbound-schema"
  // Inbound message has a `type` field not in the protocol message
  // dispatch table. Server bug or version skew; surfaced via
  // onError, message dropped.
  | "unknown-message"
  // The caller-controlled AbortSignal fired during connect or
  // mid-operation.
  | "aborted";

export abstract class WSClientError extends Error {
  abstract readonly kind: WSClientErrorKind;
}

// ─── Connect / handshake (network layer) ────────────────────────────

/** TCP / TLS / DNS layer failure: the WebSocket couldn't even
 *  reach the HTTP upgrade step. Wraps the underlying Node net /
 *  tls / dns error (or whatever the `ws` library surfaced). */
export class WSConnectError extends WSClientError {
  readonly kind = "connect" as const;
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "WSConnectError";
    this.cause = cause;
  }
}

/** HTTP upgrade was attempted and the server replied with an error
 *  status (typically 401 invalid api key, 404 wrong path, 5xx
 *  server fault). `responseBody` is the raw response payload as a
 *  string; callers SHOULD NOT JSON.parse it without checking
 *  Content-Type, since some 5xx pages are HTML. */
export class WSHandshakeError extends WSClientError {
  readonly kind = "handshake" as const;
  readonly statusCode: number;
  readonly responseBody: string;
  readonly cause?: unknown;
  constructor(
    statusCode: number,
    responseBody: string,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "WSHandshakeError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
    this.cause = cause;
  }
}

/** Specialization of WSHandshakeError for the 403 the server returns when the
 *  agent's credential is presented from a device other than the one it is bound
 *  to (single-device binding / anti-theft). statusCode is always 403, so the
 *  reconnect layer treats it as terminal (no retry); callers branch on
 *  `instanceof WSDeviceMismatchError` to show the "re-pair from the Dashboard"
 *  recovery rather than retrying forever. */
export class WSDeviceMismatchError extends WSHandshakeError {
  constructor(responseBody: string, message: string, cause?: unknown) {
    super(403, responseBody, message, cause);
    this.name = "WSDeviceMismatchError";
  }
}

// ─── Welcome / protocol negotiation ─────────────────────────────────

/** WS open succeeded but no frame arrived within
 *  `welcomeTimeoutMs` (default 10s). Distinguished from
 *  WSConnectError so callers can differentiate "couldn't reach
 *  server" from "reached server but it's not speaking". */
export class WSWelcomeTimeoutError extends WSClientError {
  readonly kind = "welcome-timeout" as const;
  constructor(message: string) {
    super(message);
    this.name = "WSWelcomeTimeoutError";
  }
}

/** First server frame arrived but is not a valid welcome — wrong
 *  type, malformed JSON, or fails ajv against
 *  server_welcome.schema.json. `ajvErrors` is the raw ajv error
 *  array (or empty for non-ajv failures like "wrong type"). */
export class WSWelcomeInvalidError extends WSClientError {
  readonly kind = "welcome-invalid" as const;
  readonly ajvErrors: readonly AjvLikeError[];
  constructor(ajvErrors: readonly AjvLikeError[], message: string) {
    super(message);
    this.name = "WSWelcomeInvalidError";
    this.ajvErrors = ajvErrors;
  }
}

/** server_protocol_version's major component does not match the
 *  runtime's compiled-in expectedProtocolVersion. Per plan §5.8 +
 *  server_welcome.schema.json the runtime MUST refuse such
 *  connections (major bumps are breaking). Minor / patch
 *  mismatches do NOT throw this — they are silently accepted. */
export class WSProtocolVersionError extends WSClientError {
  readonly kind = "protocol-version" as const;
  readonly clientVersion: string;
  readonly serverVersion: string;
  constructor(
    clientVersion: string,
    serverVersion: string,
    message: string,
  ) {
    super(message);
    this.name = "WSProtocolVersionError";
    this.clientVersion = clientVersion;
    this.serverVersion = serverVersion;
  }
}

// ─── Lifecycle / state ──────────────────────────────────────────────

/** Operation attempted on a WSClient whose state is not
 *  "connected": send() during closing, send() after close,
 *  close() called twice (this is no-op, not an error — but
 *  internal use may distinguish). */
export class WSClosedError extends WSClientError {
  readonly kind = "closed" as const;
  constructor(message: string) {
    super(message);
    this.name = "WSClosedError";
  }
}

// ─── Frame validation (inbound + outbound) ──────────────────────────

/** Inbound frame failed ajv validation against its
 *  per-message schema. Indicates server bug or protocol drift —
 *  surfaced to onError handler; the connection stays open and
 *  the offending message is dropped. `messageType` is the
 *  envelope's `type` field if parseable, else "<unknown>". */
export class WSSchemaError extends WSClientError {
  readonly kind = "schema" as const;
  readonly messageType: string;
  readonly ajvErrors: readonly AjvLikeError[];
  constructor(
    messageType: string,
    ajvErrors: readonly AjvLikeError[],
    message: string,
  ) {
    super(message);
    this.name = "WSSchemaError";
    this.messageType = messageType;
    this.ajvErrors = ajvErrors;
  }
}

/** Outbound message passed to send() failed ajv validation
 *  against the matching client_*.schema.json. Indicates LOCAL
 *  code bug (we tried to send something the server would
 *  reject) — thrown synchronously to the calling code, message
 *  never reaches the wire. Kept distinct from WSSchemaError
 *  because callers MUST treat it as a programming error, not a
 *  runtime drift signal. */
export class WSOutboundSchemaError extends WSClientError {
  readonly kind = "outbound-schema" as const;
  readonly messageType: string;
  readonly ajvErrors: readonly AjvLikeError[];
  constructor(
    messageType: string,
    ajvErrors: readonly AjvLikeError[],
    message: string,
  ) {
    super(message);
    this.name = "WSOutboundSchemaError";
    this.messageType = messageType;
    this.ajvErrors = ajvErrors;
  }
}

/** Inbound frame's `type` field is not in the dispatch table
 *  (see protocol/schemas.ts MESSAGE_TYPE_TO_FILE). Server bug
 *  or version skew — surfaced to onError, message dropped,
 *  connection stays open. */
export class WSUnknownMessageError extends WSClientError {
  readonly kind = "unknown-message" as const;
  readonly messageType: string;
  constructor(messageType: string, message: string) {
    super(message);
    this.name = "WSUnknownMessageError";
    this.messageType = messageType;
  }
}

// ─── Caller cancellation ────────────────────────────────────────────

/** The caller-controlled AbortSignal fired during connect() or a
 *  mid-flight operation. `cause` carries the abort reason
 *  (AbortSignal.reason) so callers can distinguish their own
 *  abort categories without parsing message text. */
export class WSAbortedError extends WSClientError {
  readonly kind = "aborted" as const;
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "WSAbortedError";
    this.cause = cause;
  }
}
