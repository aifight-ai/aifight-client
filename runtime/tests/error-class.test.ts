// Batch A — classifyDecisionError: fold a thrown decision error into a
// user-meaningful class + a retry verdict. See error-class.ts.

import { describe, expect, it } from "vitest";

import { classifyDecisionError, parseRetryAfterMs } from "../src/llm/adapters/error-class";
import { AdapterError } from "../src/llm/adapters/types";

/** A duck-typed AdapterError-shaped cause (the classifier only reads fields). */
function err(kind: string, message = "", extra: Record<string, unknown> = {}) {
  return { kind, message, ...extra };
}

describe("classifyDecisionError", () => {
  it("maps the non-retryable classes (retry can't help)", () => {
    expect(classifyDecisionError(err("auth_failed"))).toMatchObject({ class: "auth", retryable: false });
    expect(classifyDecisionError(err("invalid_request"))).toMatchObject({ class: "config", retryable: false });
    expect(classifyDecisionError(err("model_not_found"))).toMatchObject({ class: "config", retryable: false });
    expect(classifyDecisionError(err("unsupported"))).toMatchObject({ class: "config", retryable: false });
    expect(classifyDecisionError(err("budget_exceeded"))).toMatchObject({ class: "quota", retryable: false });
    expect(classifyDecisionError(err("content_filter"))).toMatchObject({ class: "content_filter", retryable: false });
    // We aborted it (turn deadline) — retrying just re-aborts.
    expect(classifyDecisionError(err("aborted"))).toMatchObject({ class: "unknown", retryable: false });
  });

  it("maps the retryable transient classes", () => {
    expect(classifyDecisionError(err("rate_limited"))).toMatchObject({ class: "rate_limit", retryable: true });
    expect(classifyDecisionError(err("server_error"))).toMatchObject({ class: "server", retryable: true });
    expect(classifyDecisionError(err("timeout"))).toMatchObject({ class: "timeout", retryable: true });
    expect(classifyDecisionError(err("network"))).toMatchObject({ class: "network", retryable: true });
    expect(classifyDecisionError(err("invalid_response"))).toMatchObject({ class: "unknown", retryable: true });
  });

  it("treats a token-limit error as terminal (the self-heal owns that retry)", () => {
    expect(classifyDecisionError(err("invalid_request", "max_tokens too big", { tokenLimit: true }))).toMatchObject({
      class: "token_limit",
      retryable: false,
    });
  });

  it("splits a truly-exhausted quota out of a transient 429", () => {
    expect(classifyDecisionError(err("rate_limited", "You exceeded your current quota, check plan and billing"))).toMatchObject({
      class: "quota",
      retryable: false,
    });
    expect(classifyDecisionError(err("rate_limited", "insufficient_quota"))).toMatchObject({ class: "quota", retryable: false });
    // A plain throttle stays a retryable rate limit.
    expect(classifyDecisionError(err("rate_limited", "Rate limit reached for requests"))).toMatchObject({
      class: "rate_limit",
      retryable: true,
    });
  });

  it("labels a billing/quota 400 as quota, not config (e.g. Anthropic credit balance)", () => {
    // Anthropic returns "credit balance is too low" as a 400 (invalid_request);
    // classify it quota ("top up") rather than config ("check your model id").
    expect(classifyDecisionError(err("invalid_request", "Your credit balance is too low to access the Anthropic API."))).toMatchObject({
      class: "quota",
      retryable: false,
    });
    // A normal bad-request 400 is still a config error.
    expect(classifyDecisionError(err("invalid_request", "model: unknown model 'gpt-9'"))).toMatchObject({ class: "config", retryable: false });
  });

  it("passes a Retry-After hint through on retryable classes", () => {
    const info = classifyDecisionError(err("rate_limited", "slow down", { retryAfterMs: 2000 }));
    expect(info).toMatchObject({ class: "rate_limit", retryable: true, retryAfterMs: 2000 });
    // A negative / NaN hint is ignored.
    expect(classifyDecisionError(err("server_error", "", { retryAfterMs: -1 })).retryAfterMs).toBeUndefined();
  });

  it("defaults a non-adapter cause to one conservative retry", () => {
    expect(classifyDecisionError(new Error("boom"))).toMatchObject({ class: "unknown", retryable: true });
    expect(classifyDecisionError("weird string")).toMatchObject({ class: "unknown", retryable: true });
    expect(classifyDecisionError(undefined)).toMatchObject({ class: "unknown", retryable: true });
    // …but an explicit retryable:false on an unknown-kind error is honored.
    expect(classifyDecisionError({ retryable: false })).toMatchObject({ class: "unknown", retryable: false });
  });

  it("works on a real AdapterError instance (duck-typing sanity)", () => {
    const real = new AdapterError("rate_limited", "openai_chat_completions", "HTTP 429 Too Many Requests");
    expect(classifyDecisionError(real)).toMatchObject({ class: "rate_limit", retryable: true });
    const authReal = new AdapterError("auth_failed", "anthropic_messages", "HTTP 401 invalid x-api-key");
    expect(classifyDecisionError(authReal)).toMatchObject({ class: "auth", retryable: false });
  });

  it("carries a real AdapterError's retryAfterMs through to the classification", () => {
    const throttled = new AdapterError("rate_limited", "openai_chat_completions", "429", { retryAfterMs: 3000 });
    expect(classifyDecisionError(throttled)).toMatchObject({ class: "rate_limit", retryable: true, retryAfterMs: 3000 });
  });
});

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds into ms", () => {
    expect(parseRetryAfterMs("120")).toBe(120_000);
    expect(parseRetryAfterMs("0")).toBe(0);
    expect(parseRetryAfterMs("  30  ")).toBe(30_000);
  });

  it("parses an HTTP-date (future → positive, past → 0)", () => {
    const future = parseRetryAfterMs("Fri, 01 Jan 2100 00:00:00 GMT");
    expect(typeof future).toBe("number");
    expect(future!).toBeGreaterThan(0);
    expect(parseRetryAfterMs("Thu, 01 Jan 1970 00:00:00 GMT")).toBe(0);
  });

  it("returns undefined for absent / unparseable values", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs("")).toBeUndefined();
    expect(parseRetryAfterMs("   ")).toBeUndefined();
    expect(parseRetryAfterMs("soon-ish")).toBeUndefined();
  });
});
