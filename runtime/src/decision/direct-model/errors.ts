// M1-11 direct-model: typed error hierarchy + redaction helpers.
//
// Mirrors src/wsclient/errors.ts:
// abstract base + concrete subclasses with a `kind` discriminator.
// Programmatic branching uses `kind` or `instanceof`; message text
// is free-form English and MUST NOT be parsed.
//
// Redaction contract (TED rev 2 拍板点 #17 / #19):
//   - error.message MUST NOT contain apiKey value, Authorization
//     header value, or x-api-key header value.
//   - bodySnippet / responseSnippet MUST be redacted and capped at
//     SNIPPET_MAX bytes with a tail truncation marker.
//   - cause is a raw unknown reference (fetch error, Response, any
//     underlying object). It is intentionally NOT redacted; callers
//     who log / persist cause must sanitize themselves.
//
// Construction is allocation-only — nothing here touches the
// network, disk, logger, or process state.

import type { DirectModelProviderName } from "./types";

// ─── Discriminator + base ───────────────────────────────────────────

export type DirectModelErrorKind =
  // fetch threw before any HTTP response (DNS / TLS / refused).
  | "direct_model_network"
  // HTTP response status was not 2xx.
  | "direct_model_http"
  // caller-supplied AbortSignal fired (or aborted before send).
  | "direct_model_aborted"
  // 2xx response but body parse / shape was wrong.
  | "direct_model_invalid_response"
  // caller-supplied opts failed validation (empty key, etc).
  | "direct_model_unsupported";

export abstract class DirectModelError extends Error {
  abstract readonly kind: DirectModelErrorKind;
  readonly provider: DirectModelProviderName;
  // raw underlying object; intentionally NOT redacted (rev 2 contract).
  readonly cause: unknown;

  protected constructor(
    provider: DirectModelProviderName,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.provider = provider;
    this.cause = cause;
  }
}

// ─── Concrete subclasses ────────────────────────────────────────────

/** fetch() threw before producing a Response. Wraps the underlying
 *  Node net / TLS / DNS error (or whatever fetch surfaced). */
export class DirectModelNetworkError extends DirectModelError {
  override readonly name = "DirectModelNetworkError";
  override readonly kind = "direct_model_network" as const;

  constructor(provider: DirectModelProviderName, message: string, cause?: unknown) {
    super(provider, message, cause);
  }
}

/** HTTP response with non-2xx status. `bodySnippet` is the response
 *  payload after redaction + truncation (≤ SNIPPET_MAX); callers
 *  SHOULD NOT JSON.parse it without checking Content-Type. */
export class DirectModelHttpError extends DirectModelError {
  override readonly name = "DirectModelHttpError";
  override readonly kind = "direct_model_http" as const;
  readonly status: number;
  readonly bodySnippet?: string;

  constructor(
    provider: DirectModelProviderName,
    status: number,
    message: string,
    bodySnippet?: string,
    cause?: unknown,
  ) {
    super(provider, message, cause);
    this.status = status;
    this.bodySnippet = bodySnippet;
  }
}

/** Caller-supplied AbortSignal fired (either pre-aborted or
 *  mid-flight). Distinguished from DirectModelNetworkError so the
 *  caller can suppress retry on intentional cancel. */
export class DirectModelAbortedError extends DirectModelError {
  override readonly name = "DirectModelAbortedError";
  override readonly kind = "direct_model_aborted" as const;

  constructor(provider: DirectModelProviderName, message: string, cause?: unknown) {
    super(provider, message, cause);
  }
}

/** 2xx response but the body could not be parsed as JSON, or the
 *  parsed shape did not match the expected provider envelope (e.g.
 *  Anthropic missing `content[0].text`, OpenAI missing
 *  `choices[0].message.content`). `responseSnippet` is redacted +
 *  truncated. */
export class DirectModelInvalidResponseError extends DirectModelError {
  override readonly name = "DirectModelInvalidResponseError";
  override readonly kind = "direct_model_invalid_response" as const;
  readonly responseSnippet?: string;

  constructor(
    provider: DirectModelProviderName,
    message: string,
    responseSnippet?: string,
    cause?: unknown,
  ) {
    super(provider, message, cause);
    this.responseSnippet = responseSnippet;
  }
}

/** Caller passed an option that fails synchronous validation
 *  (empty apiKey, empty model, maxTokens <= 0, etc). Thrown before
 *  any network call. `field` names the offending option for
 *  programmatic handling (don't parse message text). */
export class DirectModelUnsupportedError extends DirectModelError {
  override readonly name = "DirectModelUnsupportedError";
  override readonly kind = "direct_model_unsupported" as const;
  readonly field: string;

  constructor(
    provider: DirectModelProviderName,
    field: string,
    message: string,
  ) {
    super(provider, message);
    this.field = field;
  }
}

// ─── Redaction helpers (internal) ───────────────────────────────────
//
// Exported so anthropic.ts (Step 2) and openai.ts (Step 3) can reuse
// without duplicating logic. NOT part of the package public API
// (M1-11 stays internal until M1-14 decides surface). Tests in
// Step 2/3 will exercise these directly.
//
// Contract:
//   - redactSecrets(s, secrets): replace every non-empty secret in
//     `s` with REDACTED_PLACEHOLDER. Empty / undefined secrets are
//     skipped (caller bug: don't redact "").
//   - truncateSnippet(s, max): cap the *total* result length
//     (prefix + marker) at `max`. The truncation marker
//     "...[truncated N chars]" is included in the budget — see
//     fixed-point loop in the body. `max` is a soft cap based on
//     String.length (≈ UTF-8 byte cap; close enough for snippet
//     bounds). Tiny `max` (smaller than a single marker) returns
//     the marker truncated to `max` so the output still carries the
//     leading "..." hint.
//   - sanitizeSnippet(raw, secrets): convenience pipeline =
//     redactSecrets → truncateSnippet(SNIPPET_MAX). Returns
//     undefined when `raw` is undefined / empty.

export const SNIPPET_MAX = 2048;
export const REDACTED_PLACEHOLDER = "[REDACTED]";

export function redactSecrets(s: string, secrets: readonly string[]): string {
  let out = s;
  for (const secret of secrets) {
    if (!secret) continue;
    let idx = out.indexOf(secret);
    while (idx >= 0) {
      out = out.slice(0, idx) + REDACTED_PLACEHOLDER + out.slice(idx + secret.length);
      idx = out.indexOf(secret, idx + REDACTED_PLACEHOLDER.length);
    }
  }
  return out;
}

export function truncateSnippet(s: string, max: number = SNIPPET_MAX): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;

  // Marker length depends on the `dropped` digit-width, which in
  // turn depends on prefixLen, which depends on marker length.
  // Iterate to a fixed point — `dropped` only grows monotonically
  // as prefixLen shrinks, so this converges in <= 4 passes for any
  // realistic input. The 8-iteration cap is paranoia, not a real
  // bound.
  let prefixLen = max;
  let marker = "";
  for (let i = 0; i < 8; i++) {
    const dropped = s.length - prefixLen;
    const nextMarker = `...[truncated ${dropped} chars]`;
    const nextPrefixLen = Math.max(0, max - nextMarker.length);
    if (nextMarker === marker && nextPrefixLen === prefixLen) break;
    marker = nextMarker;
    prefixLen = nextPrefixLen;
  }

  // When `max` cannot fit the full marker, return the marker
  // truncated to `max` so the leading "..." still hints at
  // truncation while honoring the size cap.
  if (max < marker.length) {
    return marker.slice(0, max);
  }
  return s.slice(0, prefixLen) + marker;
}

export function sanitizeSnippet(
  raw: string | undefined,
  secrets: readonly string[],
): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  const redacted = redactSecrets(raw, secrets);
  return truncateSnippet(redacted, SNIPPET_MAX);
}
