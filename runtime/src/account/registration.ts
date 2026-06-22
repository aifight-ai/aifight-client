// runtime/src/account/registration.ts
//
// M1-03 surface: call POST /api/agents/register, validate the 201
// body against register_response.schema.json, and return the one-time
// `api_key` + `claim_token` to the caller. NO persistence here.
// Persistence (SQLite / keychain / libsodium) is explicitly M1-04 /
// M1-05 territory — this file must not import anything under
// src/store/ or src/credentials/ (neither exists yet) nor touch
// ~/.aifight/ at all.
//
// Error contract:
//   - fetch throws / AbortError / timeout → RegisterNetworkError
//   - HTTP status !== 201                  → RegisterHttpError(status, body)
//   - 201 + non-JSON body                  → RegisterSchemaError (empty ajv errors)
//   - 201 + schema-invalid body            → RegisterSchemaError (ajv errors)
//   - 201 + schema-valid body              → RegisterAgentResult
//
// Security note: api_key and claim_token only ever appear in the 201
// success path. Error messages deliberately never embed the body
// contents when status === 201 (ajv errors carry instancePaths, not
// values). Callers MUST NOT log the returned result object without
// redacting those two fields.

import Ajv from "ajv";
import type { ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import { loadAllSchemas, loadRestSchema } from "../protocol/schemas";
import type { RegisterRequest, RegisterResponse } from "../protocol/types";
import {
  type AjvLikeError,
  RegisterHttpError,
  RegisterNetworkError,
  RegisterSchemaError,
} from "./errors";

const DEFAULT_TIMEOUT_MS = 30_000;
const REGISTER_PATH = "/api/agents/register";

export interface RegisterAgentOptions {
  /** Base URL, no trailing slash. e.g. "https://beta.aifight.ai". */
  baseUrl: string;
  /** Request body; `name` is the legacy alias for suggested_name. */
  request: RegisterRequest;
  /** Test injection point. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Per-device id; sent as X-Device-Id so the server binds the new agent to
   *  this device (anti-theft). Omitted from the request when absent. */
  deviceId?: string;
  /** Default 30_000 ms, composed with `signal` via AbortSignal.any. */
  timeoutMs?: number;
  /** Optional caller-supplied abort; composed with timeoutMs. */
  signal?: AbortSignal;
}

export interface RegisterAgentResult {
  /** Full validated response, strongly typed. */
  response: RegisterResponse;
  /** Convenience — identical to response.agent.api_key. SHOWN ONCE. */
  apiKey: string;
  /** Convenience — identical to response.claim_token. SHOWN ONCE. */
  claimToken: string;
  /** Convenience — identical to response.agent.id. */
  agentId: string;
  /** Convenience — identical to response.claim_url. */
  claimUrl: string;
}

const REGISTER_RESPONSE_ID =
  "https://aifight.ai/protocol/v1/rest/register_response.schema.json";

let cachedValidator: ValidateFunction | null = null;

function getResponseValidator(): ValidateFunction {
  if (cachedValidator) return cachedValidator;
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  // Preload every committed schema so cross-file $refs (if any are
  // added later to register_response) resolve without network. Because
  // loadAllSchemas() already includes register_response by $id, we
  // MUST retrieve the validator via ajv.getSchema(id) — calling
  // ajv.compile() on the same object again throws
  // "schema with key or id … already exists".
  const all = loadAllSchemas();
  for (const [id, schema] of all) {
    if (!ajv.getSchema(id)) ajv.addSchema(schema as object, id);
  }
  const got = ajv.getSchema(REGISTER_RESPONSE_ID);
  if (got) {
    cachedValidator = got as ValidateFunction;
    return cachedValidator;
  }
  // Defensive fallback: register_response wasn't in the bundle for
  // some reason (packaging bug). Compile it standalone so we still
  // validate; surfacing a clear error beats silent skip.
  const responseSchema = loadRestSchema("register_response") as object;
  cachedValidator = ajv.compile(responseSchema);
  return cachedValidator;
}

export async function registerAgent(
  opts: RegisterAgentOptions,
): Promise<RegisterAgentResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = opts.baseUrl.replace(/\/+$/, "") + REGISTER_PATH;

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal: AbortSignal = opts.signal
    ? AbortSignal.any([timeoutSignal, opts.signal])
    : timeoutSignal;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(opts.deviceId ? { "X-Device-Id": opts.deviceId } : {}),
      },
      body: JSON.stringify(opts.request),
      signal,
    });
  } catch (e) {
    if (timeoutSignal.aborted) {
      throw new RegisterNetworkError(
        `POST ${REGISTER_PATH} timed out after ${timeoutMs}ms`,
        e,
      );
    }
    if (opts.signal?.aborted) {
      throw new RegisterNetworkError(
        `POST ${REGISTER_PATH} aborted by caller`,
        e,
      );
    }
    const msg = e instanceof Error ? e.message : String(e);
    throw new RegisterNetworkError(
      `POST ${REGISTER_PATH} failed: ${msg}`,
      e,
    );
  }

  // Read body exactly once — fetch's Response body stream is
  // single-consumption. Parse as JSON but fall back to raw text so
  // error branches below can still surface something useful.
  const bodyText = await response.text();
  let bodyJson: unknown = undefined;
  let parseError: Error | null = null;
  if (bodyText.length > 0) {
    try {
      bodyJson = JSON.parse(bodyText);
    } catch (e) {
      parseError = e instanceof Error ? e : new Error(String(e));
    }
  }

  if (response.status !== 201) {
    const body =
      bodyJson &&
      typeof bodyJson === "object" &&
      bodyJson !== null &&
      "error" in (bodyJson as Record<string, unknown>)
        ? (bodyJson as { error?: string })
        : bodyText;
    throw new RegisterHttpError(
      response.status,
      body,
      `POST ${REGISTER_PATH} returned HTTP ${response.status}`,
    );
  }

  // 201 path — must be valid JSON matching register_response.
  if (parseError !== null) {
    throw new RegisterSchemaError(
      [],
      `POST ${REGISTER_PATH} returned 201 with non-JSON body: ${parseError.message}`,
    );
  }
  if (typeof bodyJson !== "object" || bodyJson === null) {
    throw new RegisterSchemaError(
      [],
      `POST ${REGISTER_PATH} returned 201 with non-object body`,
    );
  }

  const validator = getResponseValidator();
  const valid = validator(bodyJson);
  if (!valid) {
    const ajvErrors: AjvLikeError[] = (validator.errors ?? []).map((e) => ({
      instancePath: e.instancePath,
      message: e.message ?? undefined,
    }));
    throw new RegisterSchemaError(
      ajvErrors,
      "register_response schema validation failed",
    );
  }

  const typed = bodyJson as RegisterResponse;
  return {
    response: typed,
    apiKey: typed.agent.api_key,
    claimToken: typed.claim_token,
    agentId: typed.agent.id,
    claimUrl: typed.claim_url,
  };
}
