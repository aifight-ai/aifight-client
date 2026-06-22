// OpenAI Responses API adapter.
//
// Protocol: openai_responses
// Endpoint: POST ${baseURL}/responses
// Auth: Authorization: Bearer ${apiKey}
//
// Request body uses `input` (array of messages), `reasoning` object, and
// `max_output_tokens`. Response has `output` array with items of type
// "message" containing a `content` array of output_text blocks.
//
// Reasoning effort mapping:
//   canonical "off" / "minimal"  → openai "none"
//   canonical "low"              → openai "low"
//   canonical "medium" / "auto"  → openai "medium"
//   canonical "high"             → openai "high"
//   canonical "xhigh" / "max"   → openai "xhigh"
//
// GPT-5.5 default effort: "medium". GPT-5.4 default effort: "none"
// (dangerous for strategy games — always set effort explicitly in profile).

import type {
  CanonicalReasoningConfig,
  DecisionInput,
  DecisionOutput,
  LLMAdapter,
  LLMProfile,
  ProbeResult,
  UsageRecord,
  ValidationResult,
} from "./types.js";
import { AdapterError } from "./types.js";

const PROTOCOL = "openai_responses" as const;
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MAX_OUTPUT_TOKENS = 25000;

// ─── Reasoning effort mapping ────────────────────────────────────────

type OpenAIEffort = "none" | "low" | "medium" | "high" | "xhigh";

function mapEffort(canonical: CanonicalReasoningConfig["effort"]): OpenAIEffort {
  switch (canonical) {
    case "off":
    case "minimal":
      return "none";
    case "low":
      return "low";
    case "medium":
    case "auto":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
    case "max":
      return "xhigh";
    default:
      return "medium";
  }
}

function buildReasoningObject(
  reasoning?: CanonicalReasoningConfig,
): Record<string, unknown> | undefined {
  if (!reasoning) return undefined;

  // If reasoning is explicitly disabled, omit the object entirely.
  if (reasoning.mode === "disabled" || reasoning.enabled === false) return undefined;

  const effort = mapEffort(reasoning.effort);
  const obj: Record<string, unknown> = { effort };

  // Map canonical summary field.
  if (reasoning.summary != null) {
    obj.summary = reasoning.summary === "off" ? undefined : reasoning.summary;
  } else {
    // Default to "auto" for summarized context.
    obj.summary = "auto";
  }

  return obj;
}

// ─── Factory ─────────────────────────────────────────────────────────

export function createOpenAIResponsesAdapter(): LLMAdapter {
  return {
    protocol: PROTOCOL,
    validateProfile,
    probe,
    generateDecision,
    estimateUsage,
    redact,
  };
}

// ─── validateProfile ─────────────────────────────────────────────────

function validateProfile(profile: LLMProfile): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!profile.apiKey) {
    errors.push("apiKey is required");
  }
  if (!profile.model) {
    errors.push("model is required");
  }
  if (profile.protocol !== PROTOCOL) {
    errors.push(`protocol must be "openai_responses", got "${profile.protocol}"`);
  }
  if (profile.maxTokens <= 0 || !Number.isFinite(profile.maxTokens)) {
    errors.push("maxTokens must be a positive finite number");
  }

  // Warn about GPT-5.4 default effort being "none" (dangerous for strategy games).
  if (profile.model.startsWith("gpt-5.4")) {
    const effort = profile.reasoning?.effort;
    if (!effort || effort === "off") {
      warnings.push(
        'GPT-5.4 default effort is "none" — dangerous for strategy games. ' +
          'Set reasoning.effort explicitly (e.g. "medium" or "high") in the profile.',
      );
    }
  }

  // Warn if includeEncryptedReasoning is requested but summary is off.
  if (
    profile.reasoning?.includeEncryptedReasoning === true &&
    profile.reasoning?.summary === "off"
  ) {
    warnings.push(
      'includeEncryptedReasoning=true with summary="off" — encrypted reasoning will be ' +
        "included but no summary will be returned.",
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ─── probe ───────────────────────────────────────────────────────────

async function probe(profile: LLMProfile): Promise<ProbeResult> {
  const start = performance.now();
  let output: DecisionOutput;
  try {
    output = await generateDecision(
      {
        systemPrompt: 'You are a connectivity probe. Reply with exactly: {"ok":true}',
        userPrompt: 'Reply with exactly: {"ok":true} and nothing else.',
        maxTokens: 64,
        temperature: null,
      },
      profile,
    );
  } catch (err) {
    const latencyMs = Math.max(0, performance.now() - start);
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      latencyMs,
      error: message,
      model: profile.model,
      protocol: PROTOCOL,
    };
  }

  const latencyMs = output.latencyMs;
  let jsonValid = false;
  try {
    const parsed = JSON.parse(output.text.trim());
    jsonValid = typeof parsed === "object" && parsed !== null && (parsed as Record<string, unknown>).ok === true;
  } catch {
    // Not valid JSON — jsonValid stays false.
  }

  return {
    success: true,
    latencyMs,
    model: profile.model,
    protocol: PROTOCOL,
    jsonValid,
  };
}

// ─── generateDecision ────────────────────────────────────────────────

async function generateDecision(
  input: DecisionInput,
  profile: LLMProfile,
  _continuationState?: unknown,
): Promise<DecisionOutput> {
  const { signal } = input;

  if (signal?.aborted) {
    throw new AdapterError("aborted", PROTOCOL, "request aborted before send", {
      cause: signal.reason,
    });
  }

  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new AdapterError(
      "network",
      PROTOCOL,
      "fetch is unavailable in this runtime",
    );
  }

  const baseURL = (profile.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = `${baseURL}/responses`;

  const effectiveMaxTokens =
    input.maxTokens > 0 ? input.maxTokens : DEFAULT_MAX_OUTPUT_TOKENS;

  // Resolve reasoning config: DecisionInput overrides profile.
  const reasoningCfg = input.reasoning ?? profile.reasoning;
  const reasoningObj = buildReasoningObject(reasoningCfg);

  const body: Record<string, unknown> = {
    model: profile.model,
    input: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userPrompt },
    ],
    max_output_tokens: effectiveMaxTokens,
  };

  if (reasoningObj !== undefined) {
    body.reasoning = reasoningObj;
  }

  // Include encrypted reasoning content when requested.
  if (reasoningCfg?.includeEncryptedReasoning === true) {
    body.include = ["reasoning.encrypted_content"];
  }

  // GPT-5.x verbosity control (Responses API → text.verbosity). low is often a
  // better default for the terse JSON actions this arena needs.
  if (profile.verbosity !== undefined) {
    body.text = { verbosity: profile.verbosity };
  }

  // Temperature only applies when reasoning is off/none.
  if (input.temperature !== null && input.temperature !== undefined) {
    body.temperature = input.temperature;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${profile.apiKey}`,
    "content-type": "application/json",
  };

  const start = performance.now();
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    if (isAbortError(cause)) {
      throw new AdapterError("aborted", PROTOCOL, "request aborted during fetch", {
        cause,
        retryable: false,
      });
    }
    const safeDesc = redactApiKey(describeError(cause), profile.apiKey);
    throw new AdapterError("network", PROTOCOL, `fetch failed: ${safeDesc}`, {
      cause,
      retryable: true,
    });
  }

  const latencyMs = Math.max(0, performance.now() - start);

  if (!response.ok) {
    const rawBody = await safeReadText(response);
    const bodySnippet = redactApiKey(rawBody, profile.apiKey).slice(0, 512);
    const kind = httpStatusToKind(response.status);
    throw new AdapterError(
      kind,
      PROTOCOL,
      `OpenAI Responses API returned HTTP ${response.status}: ${bodySnippet}`,
      { retryable: kind === "rate_limited" || kind === "server_error" },
    );
  }

  const rawText = await safeReadText(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (cause) {
    throw new AdapterError(
      "invalid_response",
      PROTOCOL,
      "response body is not valid JSON",
      { cause, retryable: false },
    );
  }

  const text = extractText(parsed);
  if (text === null) {
    throw new AdapterError(
      "invalid_response",
      PROTOCOL,
      'response missing output[].content[].text (type "output_text")',
      { retryable: false },
    );
  }

  const { inputTokens, outputTokens, reasoningTokens } = extractTokens(parsed);
  const reasoningSummary = extractReasoningSummary(parsed);

  return {
    text,
    inputTokens,
    outputTokens,
    reasoningTokens,
    latencyMs,
    reasoningSummary,
    raw: parsed,
  };
}

// ─── estimateUsage ───────────────────────────────────────────────────

function estimateUsage(output: DecisionOutput, profile: LLMProfile): UsageRecord {
  return {
    protocol: PROTOCOL,
    providerLabel: "OpenAI",
    model: profile.model,
    inputTokens: output.inputTokens,
    outputTokens: output.outputTokens,
    reasoningTokens: output.reasoningTokens,
    cachedTokens: output.cachedTokens,
    // Cost estimation omitted — OpenAI Responses API pricing is model-specific
    // and changes frequently. Callers that need cost tracking should integrate
    // the OpenAI usage API or maintain a separate price table.
    estimatedCostUSD: undefined,
    latencyMs: output.latencyMs,
    timestamp: new Date().toISOString(),
  };
}

// ─── redact ──────────────────────────────────────────────────────────

function redact(raw: unknown): unknown {
  if (!isObject(raw)) return raw;

  const copy: Record<string, unknown> = { ...raw };

  // Remove encrypted reasoning tokens — they are large and sensitive.
  if (Array.isArray(copy.output)) {
    copy.output = (copy.output as unknown[]).map((item) => {
      if (!isObject(item)) return item;
      const itemCopy: Record<string, unknown> = { ...item };
      if (itemCopy.type === "reasoning") {
        itemCopy.encrypted_content = "[redacted]";
      }
      return itemCopy;
    });
  }

  return copy;
}

// ─── helpers ─────────────────────────────────────────────────────────

function extractText(parsed: unknown): string | null {
  if (!isObject(parsed)) return null;
  const output = parsed.output;
  if (!Array.isArray(output)) return null;

  for (const item of output) {
    if (!isObject(item)) continue;
    if (item.type !== "message") continue;
    const content = item.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block.type !== "output_text") continue;
      if (typeof block.text === "string") return block.text;
    }
  }

  return null;
}

function extractTokens(parsed: unknown): {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
} {
  if (!isObject(parsed)) return {};
  const usage = parsed.usage;
  if (!isObject(usage)) return {};
  return {
    inputTokens: numOrUndef(usage.input_tokens),
    outputTokens: numOrUndef(usage.output_tokens),
    reasoningTokens: numOrUndef(usage.reasoning_tokens),
  };
}

function extractReasoningSummary(parsed: unknown): string | undefined {
  if (!isObject(parsed)) return undefined;
  const output = parsed.output;
  if (!Array.isArray(output)) return undefined;

  for (const item of output) {
    if (!isObject(item)) continue;
    if (item.type !== "reasoning") continue;
    const summary = item.summary;
    if (typeof summary === "string" && summary.length > 0) return summary;
    // summary may be an array of summary blocks.
    if (Array.isArray(summary)) {
      const texts = summary
        .filter(isObject)
        .map((b) => b.text)
        .filter((t): t is string => typeof t === "string");
      if (texts.length > 0) return texts.join(" ");
    }
  }

  return undefined;
}

function httpStatusToKind(
  status: number,
): "auth_failed" | "rate_limited" | "model_not_found" | "invalid_request" | "server_error" | "unknown" {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 429) return "rate_limited";
  if (status === 404) return "model_not_found";
  if (status === 400 || status === 422) return "invalid_request";
  if (status >= 500) return "server_error";
  return "unknown";
}

// Duck-type AbortError detection across Node / undici / DOMException.
function isAbortError(cause: unknown): boolean {
  if (cause === null || typeof cause !== "object") return false;
  const obj = cause as { name?: unknown; code?: unknown };
  if (obj.name === "AbortError") return true;
  if (obj.code === "ABORT_ERR" || obj.code === 20) return true;
  return false;
}

function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  try {
    return String(cause);
  } catch {
    return "unknown";
  }
}

function redactApiKey(text: string, apiKey: string): string {
  if (!apiKey) return text;
  return text.replaceAll(apiKey, "[REDACTED]");
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
