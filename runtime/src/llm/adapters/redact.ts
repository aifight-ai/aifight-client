// Shared provider-error scrubbing for LLM adapters.
//
// Provider error bodies can echo request headers or otherwise contain the
// caller's API key, and can be arbitrarily large. Every adapter that surfaces a
// provider error body — in an AdapterError message OR its `cause` — MUST route
// it through boundedErrorBody so the key is stripped and the body is
// length-capped before it can reach logs, traces, decision records, or the
// user. Keeping this in one place stops the redaction from drifting per adapter.

/**
 * Replace every literal occurrence of the API key with "[REDACTED]".
 * A falsy key is a no-op (nothing to redact).
 */
export function redactApiKey(text: string, apiKey: string): string {
  if (!apiKey) return text;
  return text.replaceAll(apiKey, "[REDACTED]");
}

/**
 * Redact the API key from a provider-supplied error body and cap its length.
 * Use for any provider text that ends up in an AdapterError message or cause.
 */
export function boundedErrorBody(text: string, apiKey: string, max = 512): string {
  return redactApiKey(text, apiKey).slice(0, max);
}
