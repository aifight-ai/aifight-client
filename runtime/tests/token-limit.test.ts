// Batch 0 — pure unit tests for the shared truncation helpers
// (llm/adapters/token-limit.ts).

import { describe, it, expect } from "vitest";

import {
  looksLikeTokenLimit,
  normalizeOpenAIFinish,
  computeTruncated,
} from "../src/llm/adapters/token-limit";

describe("looksLikeTokenLimit (D2 400 heuristic)", () => {
  it("matches real provider max-token error bodies", () => {
    expect(looksLikeTokenLimit("max_tokens: 200000 > 128000, which is the maximum")).toBe(true);
    expect(looksLikeTokenLimit("This model's maximum context length is 128000 tokens")).toBe(true);
    expect(looksLikeTokenLimit('{"error":{"code":"context_length_exceeded"}}')).toBe(true);
    expect(looksLikeTokenLimit("thinking.budget_tokens must be less than max_tokens")).toBe(true);
    expect(looksLikeTokenLimit("max output tokens exceeded")).toBe(true);
  });

  it("does NOT match unrelated 400s (conservative)", () => {
    expect(looksLikeTokenLimit("invalid api key")).toBe(false);
    expect(looksLikeTokenLimit("unsupported temperature value")).toBe(false);
    expect(looksLikeTokenLimit("model not found")).toBe(false);
    expect(looksLikeTokenLimit("")).toBe(false);
    expect(looksLikeTokenLimit(undefined)).toBe(false);
    expect(looksLikeTokenLimit(123)).toBe(false);
  });

  it("does NOT flag max_tokens errors that a bigger cap can't fix (F6)", () => {
    // Wrong parameter name (reasoning models want max_completion_tokens),
    // unsupported param, malformed value — raising the cap would not help, and
    // must not trigger self-heal or the "raise max tokens" advice.
    expect(
      looksLikeTokenLimit("Unsupported parameter: max_tokens is not supported with this model. Use max_completion_tokens instead."),
    ).toBe(false);
    expect(looksLikeTokenLimit("Invalid max_tokens: value must be a positive integer")).toBe(false);
    // A genuine over-cap error is still classified as a token-limit problem.
    expect(looksLikeTokenLimit("max_tokens: 200000 > 128000, which is the maximum")).toBe(true);
  });
});

describe("normalizeOpenAIFinish", () => {
  it("maps finish_reason values", () => {
    expect(normalizeOpenAIFinish("length")).toBe("max_tokens");
    expect(normalizeOpenAIFinish("stop")).toBe("stop");
    expect(normalizeOpenAIFinish("content_filter")).toBe("other");
    expect(normalizeOpenAIFinish("tool_calls")).toBe("other");
  });
  it("returns undefined when absent/empty/non-string", () => {
    expect(normalizeOpenAIFinish(undefined)).toBeUndefined();
    expect(normalizeOpenAIFinish("")).toBeUndefined();
    expect(normalizeOpenAIFinish(null)).toBeUndefined();
    expect(normalizeOpenAIFinish(42)).toBeUndefined();
  });
});

describe("computeTruncated", () => {
  it("true when stopReason is max_tokens", () => {
    expect(computeTruncated("max_tokens", "partial answer", undefined)).toBe(true);
  });
  it("true when text empty AND reasoning tokens spent (thinking ate budget)", () => {
    expect(computeTruncated(undefined, "", 5000)).toBe(true);
    expect(computeTruncated("stop", "   ", 5000)).toBe(true);
  });
  it("false for a normal completion", () => {
    expect(computeTruncated("stop", "the answer", 100)).toBe(false);
    expect(computeTruncated(undefined, "the answer", undefined)).toBe(false);
  });
  it("false when empty text but no reasoning tokens (not a thinking-truncation)", () => {
    expect(computeTruncated(undefined, "", 0)).toBe(false);
    expect(computeTruncated(undefined, "", undefined)).toBe(false);
  });
});
