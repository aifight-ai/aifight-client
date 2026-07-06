// Shared max_tokens / reasoning-budget truncation detection, used by every
// adapter so the signal is normalized identically. See
// docs/agent-bridge/TOKEN_BUDGET_SAFETY_SPEC.md §7 (D1/D2).

/**
 * Conservative heuristic: does a provider's error-response body look like a
 * max_tokens / reasoning-budget / context-window problem? Only a positive match
 * flags AdapterError.tokenLimit — a generic 400 stays a generic invalid_request.
 * Prefer false negatives over false positives.
 *
 * Covers the real wording seen across providers:
 *   Anthropic 400: "max_tokens: N > M, which is the maximum ..." / "thinking.budget_tokens"
 *   OpenAI/compat: "context_length_exceeded", "maximum context length is N tokens"
 *   Generic:       "max output tokens", "output limit"
 */
const TOKEN_LIMIT_RE =
  /max[_\s-]?(output[_\s-]?)?tokens?|output[_\s-]?limit|budget[_\s-]?tokens?|thinking[_\s-]?budget|context[_\s-]?length|maximum\s+context/i;

/**
 * Errors that mention "max_tokens" but that raising the cap will NOT fix — so
 * they must NOT trigger self-heal or the "raise max tokens" advice:
 *   • wrong parameter name — reasoning models want `max_completion_tokens`;
 *   • an unsupported parameter for this model;
 *   • a malformed value ("must be a positive integer", "invalid max_tokens").
 */
const NOT_A_BUDGET_PROBLEM_RE =
  /max_completion_tokens|not\s+supported|unsupported\s+(parameter|value)|must\s+be\s+a?\s*positive|invalid\s+max[_\s-]?tokens?/i;

/** True when an error body string looks like a genuine max_tokens / reasoning-
 *  budget / context-window problem (one that a bigger cap could fix). */
export function looksLikeTokenLimit(bodyText: unknown): boolean {
  if (typeof bodyText !== "string" || bodyText === "") return false;
  if (NOT_A_BUDGET_PROBLEM_RE.test(bodyText)) return false;
  return TOKEN_LIMIT_RE.test(bodyText);
}

/**
 * OpenAI-family `finish_reason` → normalized stopReason (shared by
 * openai-chat-completions, openai-chat-compat, deepseek). `length` = hit the
 * max_tokens cap. Absent/empty → undefined (never guessed).
 */
export function normalizeOpenAIFinish(fr: unknown): "stop" | "max_tokens" | "other" | undefined {
  if (typeof fr !== "string" || fr === "") return undefined;
  if (fr === "length") return "max_tokens";
  if (fr === "stop") return "stop";
  return "other";
}

/**
 * truncated = the model hit the output cap (stopReason "max_tokens"), OR it
 * produced no text while spending reasoning tokens (extended thinking consumed
 * the entire budget, leaving nothing for the answer). The second case never
 * surfaces as an error — the adapter returns empty text — so it must be detected
 * here at DecisionOutput construction, not on the error path.
 */
export function computeTruncated(
  stopReason: "stop" | "max_tokens" | "other" | undefined,
  text: string,
  reasoningTokens: number | undefined,
): boolean {
  if (stopReason === "max_tokens") return true;
  if (text.trim() === "" && (reasoningTokens ?? 0) > 0) return true;
  return false;
}
