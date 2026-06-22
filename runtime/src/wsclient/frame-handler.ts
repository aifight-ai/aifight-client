// runtime/src/wsclient/frame-handler.ts
//
// M1-06 Step 3 — pure-function framing layer for the WebSocket client.
// No socket, no timer, no I/O beyond JSON.parse / stringify and ajv.
// All errors are constructed but never logged here — callers decide.
//
// Two public surfaces:
//
//   serializeClientMessage(msg) → string
//     - Validates the envelope against client_<type>.schema.json
//       BEFORE serialization (rev 2 P2 #4).
//     - Rejects unknown types and rejects server-only types
//       (welcome / event / etc.) — both surface as
//       WSOutboundSchemaError so callers handle one error class
//       for outbound bugs.
//
//   parseServerFrame(raw) → ServerMessageEnvelope
//     - Accepts string OR Buffer (the `ws` library hands us either).
//     - JSON-parse, dispatch on `type`, validate against the matching
//       server_<type>.schema.json.
//     - Three failure modes:
//         * malformed JSON / non-object / missing type → WSSchemaError
//         * type unknown OR client-only (e.g. join_queue inbound) →
//           WSUnknownMessageError (not in inbound dispatch table)
//         * type known but payload fails ajv → WSSchemaError
//
// AJV pattern mirrors M1-03 (account/registration.ts):
//   - Single Ajv instance (lazy singleton).
//   - Preload every committed schema via loadAllSchemas() so
//     cross-file $refs resolve without network or recompile.
//   - Always look up validators with ajv.getSchema(id); never
//     ajv.compile() the same schema twice (Ajv throws "schema with
//     key or id … already exists").

import Ajv from "ajv";
import type { ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import { loadAllSchemas } from "../protocol/schemas";
import {
  type AjvLikeError,
  WSOutboundSchemaError,
  WSSchemaError,
  WSUnknownMessageError,
} from "./errors";

// ─── Constants: dispatch tables ─────────────────────────────────────
//
// These are the protocol message types the runtime is allowed to
// SEND (client_*) and to RECEIVE (server_*). Hard-coded here rather
// than imported from ../protocol/schemas.ts so the source of truth
// is the JSON Schema $id pattern (`<role>_<type>.schema.json`),
// and the runtime can refuse a server message arriving on the
// outbound surface (or vice versa) without scanning files.

const CLIENT_MESSAGE_TYPES = new Set<string>([
  "join_queue",
  "leave_queue",
  "match_confirm",
  "action",
  "runtime_status",
]);

const SERVER_MESSAGE_TYPES = new Set<string>([
  "welcome",
  "queue_joined",
  "queue_left",
  "match_confirm_request",
  "match_cancelled",
  "game_start",
  "readiness_check",
  "action_request",
  "action_stale",
  "event",
  "game_state",
  "game_over",
  "error",
]);

const SCHEMA_ID_PREFIX = "https://aifight.ai/protocol/v1/messages/";

function clientSchemaId(type: string): string {
  return `${SCHEMA_ID_PREFIX}client_${type}.schema.json`;
}

function serverSchemaId(type: string): string {
  return `${SCHEMA_ID_PREFIX}server_${type}.schema.json`;
}

// ─── Public envelope shapes ─────────────────────────────────────────
//
// These mirror the union types declared in M1-06 TED §API surface;
// keep loose here (data: unknown) — per-message strict typing is
// M1-22 codegen territory. The TS layer's purpose at this surface
// is to make sure the envelope (`type` / `match_id`) is shaped so
// ajv can do the rest.

export interface ClientMessageEnvelope {
  type: string;
  data?: unknown;
  /** REQUIRED for type=action (per client_action.schema.json), optional otherwise. */
  match_id?: string;
  /** Only meaningful for type=action (protocol v1.1): optional model usage
   *  metadata — token counts only. ajv enforces the inner shape. */
  usage?: unknown;
}

export interface ServerMessageEnvelope {
  type: string;
  data: unknown;
  match_id?: string;
}

// ─── Lazy ajv singleton ─────────────────────────────────────────────

let cachedAjv: Ajv | null = null;

function getAjv(): Ajv {
  if (cachedAjv) return cachedAjv;
  // strict:false because cross-file $refs and "format" keywords would
  // otherwise emit warnings; allErrors:true so callers see every
  // violation (better DX for outbound bugs especially).
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const [id, schema] of loadAllSchemas()) {
    if (!ajv.getSchema(id)) ajv.addSchema(schema as object, id);
  }
  cachedAjv = ajv;
  return ajv;
}

/** Warm the ajv cache up-front. Optional — getAjv() is lazy and
 *  serializeClientMessage / parseServerFrame call it on first use. */
export function initFrameHandler(): void {
  getAjv();
}

/** Test-only: drop the ajv singleton so the next getAjv() call
 *  rewalks loadAllSchemas(). Pairs with __resetSchemasRootCache()
 *  in protocol/schemas.ts. NOT exported from src/index.ts. */
export function __resetFrameHandlerCache(): void {
  cachedAjv = null;
}

// ─── Helpers ────────────────────────────────────────────────────────

function mapAjvErrors(v: ValidateFunction): readonly AjvLikeError[] {
  const errs = v.errors ?? [];
  return errs.map((e) => ({
    instancePath: e.instancePath,
    message: e.message ?? undefined,
  }));
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// ─── Outbound: serializeClientMessage ───────────────────────────────

export function serializeClientMessage(msg: ClientMessageEnvelope): string {
  // Defensive: caller may have constructed a malformed envelope at
  // runtime (e.g. via untyped JSON). Fail with the same outbound
  // error class so callers handle one path.
  if (!isPlainObject(msg)) {
    throw new WSOutboundSchemaError(
      "<unknown>",
      [],
      "serializeClientMessage: envelope must be a plain object",
    );
  }
  const type = (msg as { type?: unknown }).type;
  if (typeof type !== "string" || type.length === 0) {
    throw new WSOutboundSchemaError(
      "<unknown>",
      [],
      "serializeClientMessage: envelope is missing a string `type` field",
    );
  }
  // Reject server-only types (welcome / event / etc.) — these would
  // be silently rejected by the server but more importantly indicate
  // a local bug (using a server type as outbound). One outbound error
  // class covers both unknown and wrong-direction (rev 2 P2 #4).
  if (SERVER_MESSAGE_TYPES.has(type)) {
    throw new WSOutboundSchemaError(
      type,
      [],
      `serializeClientMessage: '${type}' is a server-only message type and cannot be sent by the client`,
    );
  }
  if (!CLIENT_MESSAGE_TYPES.has(type)) {
    throw new WSOutboundSchemaError(
      type,
      [],
      `serializeClientMessage: unknown client message type '${type}' (known: ${[...CLIENT_MESSAGE_TYPES].join(", ")})`,
    );
  }

  const ajv = getAjv();
  const id = clientSchemaId(type);
  const validate = ajv.getSchema(id);
  if (!validate) {
    // Should not happen — loadAllSchemas should have registered every
    // committed schema. If it does, treat as outbound failure (we can't
    // safely send a message we can't validate) and surface a clear
    // diagnostic for the packaging bug.
    throw new WSOutboundSchemaError(
      type,
      [],
      `serializeClientMessage: schema not registered for $id ${id} (packaging bug — loadAllSchemas did not include this file)`,
    );
  }
  const ok = validate(msg);
  if (!ok) {
    throw new WSOutboundSchemaError(
      type,
      mapAjvErrors(validate),
      `serializeClientMessage: '${type}' envelope failed schema validation`,
    );
  }
  return JSON.stringify(msg);
}

// ─── Inbound: parseServerFrame ──────────────────────────────────────

export function parseServerFrame(raw: string | Buffer): ServerMessageEnvelope {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    throw new WSSchemaError(
      "<unknown>",
      [],
      `parseServerFrame: malformed JSON: ${m}`,
    );
  }

  if (!isPlainObject(parsed)) {
    throw new WSSchemaError(
      "<unknown>",
      [],
      "parseServerFrame: frame must be a JSON object",
    );
  }

  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== "string" || type.length === 0) {
    throw new WSSchemaError(
      "<unknown>",
      [],
      "parseServerFrame: frame is missing a string `type` field",
    );
  }

  // Reject unknown types AND client-only types (e.g. join_queue
  // arriving from the server): both are "not in our inbound dispatch
  // table". WSUnknownMessageError carries the type so callers can
  // log + drop.
  if (!SERVER_MESSAGE_TYPES.has(type)) {
    if (CLIENT_MESSAGE_TYPES.has(type)) {
      throw new WSUnknownMessageError(
        type,
        `parseServerFrame: '${type}' is a client-only message type and was not expected on the inbound channel`,
      );
    }
    throw new WSUnknownMessageError(
      type,
      `parseServerFrame: unknown server message type '${type}' (known: ${[...SERVER_MESSAGE_TYPES].join(", ")})`,
    );
  }

  const ajv = getAjv();
  const id = serverSchemaId(type);
  const validate = ajv.getSchema(id);
  if (!validate) {
    // Same packaging-bug branch as outbound; surface with WSSchemaError
    // because it's an inbound integrity failure (we can't trust
    // anything we can't validate).
    throw new WSSchemaError(
      type,
      [],
      `parseServerFrame: schema not registered for $id ${id} (packaging bug)`,
    );
  }
  const ok = validate(parsed);
  if (!ok) {
    throw new WSSchemaError(
      type,
      mapAjvErrors(validate),
      `parseServerFrame: '${type}' frame failed schema validation`,
    );
  }

  // Cast through `unknown`: ajv has confirmed the shape, but the
  // local `Record<string, unknown>` narrowing from isPlainObject
  // doesn't satisfy TS's structural check against ServerMessageEnvelope.
  // Same pattern as registration.ts's `bodyJson as RegisterResponse`,
  // adjusted because we narrowed earlier.
  return parsed as unknown as ServerMessageEnvelope;
}
