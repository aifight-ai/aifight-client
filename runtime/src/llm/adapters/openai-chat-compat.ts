// LLM adapter: Generic OpenAI-compatible Chat API.
//
// For third-party providers that expose an OpenAI-like /chat/completions
// endpoint but may not support every OpenAI parameter. Key differences
// from the canonical openai_chat_completions adapter:
//
//   - baseURL is REQUIRED (no default — every compat provider has its own)
//   - Uses `max_tokens` instead of `max_completion_tokens` (broader support)
//   - Model validation is lenient: unknown models emit a warning, not an error
//   - Temperature is always sent when non-null (compat providers expect it)
//   - No thinking/reasoning support assumed
//
// Protocol: openai_chat_compat

import type {
  CanonicalReasoningConfig,
  LLMAdapter,
  LLMProfile,
  DecisionInput,
  DecisionOutput,
  ProbeResult,
  ValidationResult,
  UsageRecord,
} from "./types.js";
import { AdapterError } from "./types.js";
import { looksLikeTokenLimit, normalizeOpenAIFinish, computeTruncated } from "./token-limit.js";
import { parseRetryAfterMs, isContentFilterReason } from "./error-class.js";
import { boundedErrorBody } from "./redact.js";
import { fetchNoFollow } from "../../net/guarded-fetch.js";
import { readTextCapped, readErrorBodyCapped } from "./response-limit.js";

const PROTOCOL = "openai_chat_compat" as const;

// ─── Public factory ────────────────────────────────────────────────────────────

export function createOpenAIChatCompatAdapter(): LLMAdapter {
  return {
    protocol: PROTOCOL,
    validateProfile,
    probe,
    generateDecision,
    estimateUsage,
    redact,
  };
}


/**
 * Canonical effort → Chat Completions `reasoning_effort`, passed through VERBATIM.
 * `undefined` = omit the field (thinking off, or "auto" = provider default). This
 * endpoint family used to refuse reasoning outright — a profile that configured an
 * effort had it silently discarded, so a reasoning model behind a proxy quietly ran
 * at whatever the endpoint's default was. Pass-through can 400 on an endpoint that
 * doesn't know the field; that is the endpoint saying no, which is diagnosable —
 * silence is not. (An endpoint that objects: leave the effort blank.)
 */
function passthroughReasoningEffort(reasoning?: CanonicalReasoningConfig): string | undefined {
  if (!reasoning) return undefined;
  if (reasoning.mode === "disabled" || reasoning.enabled === false) return undefined;
  const effort = reasoning.effort;
  if (effort === undefined || effort === "auto" || effort === "off") return undefined;
  return effort;
}

// ─── validateProfile ───────────────────────────────────────────────────────────

function validateProfile(profile: LLMProfile): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!profile.apiKey) {
    errors.push("apiKey must be a non-empty string");
  }
  if (!profile.model) {
    errors.push("model must be a non-empty string");
  }
  if (!profile.baseURL) {
    errors.push(
      `Protocol "${PROTOCOL}" requires an explicit baseURL — ` +
        `there is no shared default endpoint for OpenAI-compatible providers.`,
    );
  }
  if (!Number.isFinite(profile.maxTokens) || profile.maxTokens <= 0) {
    errors.push("maxTokens must be a positive finite integer");
  }
  if (profile.reasoning?.enabled && profile.reasoning.effort) {
    warnings.push(
      `Protocol "${PROTOCOL}" passes reasoning_effort through verbatim; ` +
        `compat endpoints differ — if the endpoint rejects it, leave effort blank.`,
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ─── probe ─────────────────────────────────────────────────────────────────────

async function probe(profile: LLMProfile): Promise<ProbeResult> {
  const start = performance.now();
  try {
    const output = await generateDecision(
      {
        systemPrompt: 'You are a JSON test helper. Respond only with valid JSON.',
        userPrompt: 'Return {"ok":true}',
        maxTokens: 32,
        temperature: 0,
        responseFormat: "json_object",
      },
      profile,
    );

    const latencyMs = Math.max(0, performance.now() - start);
    let jsonValid = false;
    try {
      JSON.parse(output.text);
      jsonValid = true;
    } catch {
      // not valid JSON — some compat providers ignore response_format
    }

    return {
      success: true,
      latencyMs,
      model: profile.model,
      protocol: PROTOCOL,
      jsonValid,
    };
  } catch (err) {
    return {
      success: false,
      latencyMs: Math.max(0, performance.now() - start),
      model: profile.model,
      protocol: PROTOCOL,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── generateDecision ──────────────────────────────────────────────────────────

async function generateDecision(
  input: DecisionInput,
  profile: LLMProfile,
  _continuationState?: unknown,
): Promise<DecisionOutput> {
  const baseURL = (profile.baseURL ?? "").replace(/\/+$/, "");
  if (!baseURL) {
    throw new AdapterError(
      "invalid_request",
      PROTOCOL,
      `Protocol "${PROTOCOL}" requires an explicit baseURL in the profile.`,
    );
  }
  const url = `${baseURL}/chat/completions`;

  if (input.signal?.aborted) {
    throw new AdapterError("aborted", PROTOCOL, "request aborted before send");
  }

  const body: Record<string, unknown> = {
    model: profile.model,
    messages: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userPrompt },
    ],
    // max_tokens for wider compat-provider support (not max_completion_tokens)
    max_tokens: input.maxTokens,
  };

  const reasoningEffort = passthroughReasoningEffort(input.reasoning ?? profile.reasoning);
  if (reasoningEffort !== undefined) body.reasoning_effort = reasoningEffort;

  // Temperature: compat providers expect it when the caller provides one.
  // Always send when non-null (unlike the canonical adapter which may omit it).
  const temperature = input.temperature ?? profile.temperature;
  if (temperature !== null && temperature !== undefined) {
    body.temperature = temperature;
  }

  // JSON mode — send if requested, but accept that some compat providers
  // silently ignore this parameter.
  if (
    input.responseFormat === "json_object" ||
    input.responseFormat === "json"
  ) {
    body.response_format = { type: "json_object" };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${profile.apiKey}`,
    "Content-Type": "application/json",
  };

  const start = performance.now();
  let response: Response;
  try {
    response = await fetchNoFollow(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: input.signal,
    });
  } catch (cause) {
    if (isAbortError(cause)) {
      throw new AdapterError("aborted", PROTOCOL, "request aborted", {
        cause,
      });
    }
    throw new AdapterError(
      "network",
      PROTOCOL,
      `fetch failed: ${describeError(cause)}`,
      { cause },
    );
  }

  const latencyMs = Math.max(0, performance.now() - start);

  if (!response.ok) {
    const rawBody = await readErrorBodyCapped(response);
    const safeBody = boundedErrorBody(rawBody, profile.apiKey, 512);
    const kind = httpStatusToKind(response.status);
    throw new AdapterError(
      kind,
      PROTOCOL,
      `OpenAI-compat provider returned HTTP ${response.status}`,
      { cause: safeBody, retryable: isRetryableStatus(response.status), tokenLimit: looksLikeTokenLimit(rawBody), status: response.status, retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")) },
    );
  }

  const rawText = await readTextCapped(response, PROTOCOL);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (cause) {
    throw new AdapterError(
      "invalid_response",
      PROTOCOL,
      "response body is not valid JSON",
      { cause },
    );
  }

  const finishReason = extractFinishReason(parsed);
  if (isContentFilterReason(finishReason)) {
    throw new AdapterError("content_filter", PROTOCOL, "the response was blocked by a content filter (finish_reason: content_filter)");
  }
  const stopReason = normalizeOpenAIFinish(finishReason);
  const text = extractText(parsed);
  if (text === null) {
    throw new AdapterError(
      "invalid_response",
      PROTOCOL,
      "response missing choices[0].message.content (or content is not a string)",
      { tokenLimit: stopReason === "max_tokens" },
    );
  }

  const usage = extractUsage(parsed);
  const truncated = computeTruncated(stopReason, text, undefined);

  return {
    text,
    ...(stopReason ? { stopReason } : {}),
    ...(truncated ? { truncated: true } : {}),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedTokens: usage.cachedTokens,
    latencyMs,
    raw: parsed,
  };
}

// ─── estimateUsage ─────────────────────────────────────────────────────────────

function estimateUsage(output: DecisionOutput, profile: LLMProfile): UsageRecord {
  return {
    protocol: PROTOCOL,
    providerLabel: "openai-compat",
    model: profile.model,
    inputTokens: output.inputTokens,
    outputTokens: output.outputTokens,
    cachedTokens: output.cachedTokens,
    latencyMs: output.latencyMs,
    timestamp: new Date().toISOString(),
  };
}

// ─── redact ────────────────────────────────────────────────────────────────────

function redact(raw: unknown): unknown {
  if (!isObject(raw)) return raw;
  // Return a shallow copy with usage stats preserved but message content
  // stripped to avoid leaking strategy prompts into storage.
  return {
    id: raw["id"],
    object: raw["object"],
    model: raw["model"],
    usage: raw["usage"],
    _redacted: true,
  };
}

// ─── helpers ───────────────────────────────────────────────────────────────────

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


function httpStatusToKind(
  status: number,
): import("./types.js").AdapterErrorKind {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 404) return "model_not_found";
  if (status === 429) return "rate_limited";
  if (status === 400) return "invalid_request";
  if (status >= 500) return "server_error";
  return "unknown";
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function extractText(parsed: unknown): string | null {
  if (!isObject(parsed)) return null;
  const choices = parsed["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!isObject(first)) return null;
  const message = first["message"];
  if (!isObject(message)) return null;
  const content = message["content"];
  if (typeof content !== "string") return null;
  return content;
}

/** Read choices[0].finish_reason (unknown → normalizeOpenAIFinish handles it). */
function extractFinishReason(parsed: unknown): unknown {
  if (!isObject(parsed)) return undefined;
  const choices = parsed["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0];
  if (!isObject(first)) return undefined;
  return first["finish_reason"];
}

function extractUsage(parsed: unknown): {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
} {
  if (!isObject(parsed)) return {};
  const usage = parsed["usage"];
  if (!isObject(usage)) return {};
  const promptTokens = usage["prompt_tokens"];
  const completionTokens = usage["completion_tokens"];
  // C2: OpenAI-compatible endpoints (Grok/Kimi/GLM/MiniMax/Qwen/Gemini-compat)
  // report cache hits under prompt_tokens_details.cached_tokens, same as OpenAI.
  const promptDetails = usage["prompt_tokens_details"];
  const cachedTokens =
    isObject(promptDetails) && typeof promptDetails["cached_tokens"] === "number"
      ? (promptDetails["cached_tokens"] as number)
      : undefined;
  return {
    inputTokens: typeof promptTokens === "number" ? promptTokens : undefined,
    outputTokens:
      typeof completionTokens === "number" ? completionTokens : undefined,
    cachedTokens,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
