// SECURITY (codex-security 2026-07-29 C13): a ceiling on how many bytes of a
// provider response we are willing to hold in memory.
//
// Every adapter used to swallow the body whole — `response.text()`,
// `response.json()`, or (DeepSeek streaming) a `content += delta` loop with no
// end. The size of that allocation was entirely the far end's choice: a
// misbehaving or hijacked endpoint, a proxy that never closes, or a model that
// simply runs away answers with as much as it likes and the bridge grows until
// the process dies. An OOM kill takes down the WHOLE bridge — every agent, every
// live match — and leaves nothing in the log to say why.
//
// A bounded read turns that into an ordinary, attributable AdapterError: this
// one call fails, the turn retries or forfeits, and the process stays up.
//
// Two ceilings, because the two paths want different things:
//   - readTextCapped()      success path. Throws when the body exceeds the cap;
//                           the caller's parse never sees a truncated document.
//   - readErrorBodyCapped() error path. Never throws — the body is only there to
//                           quote in a message — so it stops reading and returns
//                           what it has.

import { AdapterError } from "./types.js";

/**
 * 32 MiB. Far above any legitimate completion (a 200k-token answer is well under
 * 1 MB of text; even encrypted reasoning payloads run to single-digit MB) and far
 * below what it takes to OOM a small VPS.
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/** Error bodies exist to be quoted (adapters excerpt ~512 bytes) — 256 KiB is generous. */
export const MAX_ERROR_BODY_BYTES = 256 * 1024;

const ENV_VAR = "AIFIGHT_LLM_MAX_RESPONSE_BYTES";

/**
 * The active cap. Overridable via AIFIGHT_LLM_MAX_RESPONSE_BYTES for the rare
 * provider/model that legitimately needs more; junk values fall back to the
 * default rather than disabling the ceiling.
 */
export function maxResponseBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ENV_VAR];
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_MAX_RESPONSE_BYTES;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_MAX_RESPONSE_BYTES;
  }
  return parsed;
}

function tooLarge(protocol: string, seen: number, limit: number, atLeast: boolean): AdapterError {
  const size = atLeast ? `over ${seen}` : `${seen}`;
  return new AdapterError(
    "invalid_response",
    protocol,
    `Response body too large: ${size} bytes exceeds the ${limit}-byte ceiling. ` +
      `Set ${ENV_VAR} higher if this model legitimately returns more.`,
    { retryable: false },
  );
}

interface BodyReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<unknown>;
  releaseLock(): void;
}

/** The response body as a byte reader, or null when there is nothing to meter. */
function byteReader(response: Response): BodyReader | null {
  const stream = response.body as unknown as { getReader?: () => BodyReader } | null | undefined;
  if (!stream || typeof stream.getReader !== "function") return null;
  try {
    return stream.getReader();
  } catch {
    return null;
  }
}

function declaredLength(response: Response): number | null {
  const raw = response.headers?.get?.("content-length");
  if (typeof raw !== "string") return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Read a success-path body as text, refusing to allocate past `limit`.
 *
 * Throws AdapterError("invalid_response") the moment the running total crosses
 * the ceiling — the excess is never allocated and the connection is cancelled.
 */
export async function readTextCapped(
  response: Response,
  protocol: string,
  limit: number = maxResponseBytes(),
): Promise<string> {
  const declared = declaredLength(response);
  if (declared !== null && declared > limit) {
    // The far end told us up front — refuse before reading a single byte.
    throw tooLarge(protocol, declared, limit, false);
  }

  const reader = byteReader(response);
  if (!reader) {
    // Nothing to meter (a body-less mock, or a Response shape without a stream).
    // Post-hoc is weaker than refusing mid-read, but it still fails loudly.
    const text = await response.text();
    const size = Buffer.byteLength(text, "utf8");
    if (size > limit) throw tooLarge(protocol, size, limit, false);
    return text;
  }

  const decoder = new TextDecoder();
  const parts: string[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge(protocol, total, limit, true);
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released by cancel()
    }
  }
}

/**
 * Read an error-path body for quoting. Never throws and never allocates past
 * MAX_ERROR_BODY_BYTES — a failed HTTP status already decided the outcome, so a
 * huge or broken body must not turn into a second, worse failure.
 */
export async function readErrorBodyCapped(
  response: Response,
  limit: number = MAX_ERROR_BODY_BYTES,
): Promise<string> {
  const reader = byteReader(response);
  if (!reader) {
    try {
      const text = await response.text();
      return Buffer.byteLength(text, "utf8") > limit ? text.slice(0, limit) : text;
    } catch {
      return "";
    }
  }

  const decoder = new TextDecoder();
  const parts: string[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      parts.push(decoder.decode(value, { stream: true }));
      if (total >= limit) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    parts.push(decoder.decode());
    return parts.join("");
  } catch {
    return parts.join("");
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released by cancel()
    }
  }
}
