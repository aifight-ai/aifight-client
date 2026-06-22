// LLM adapter: OpenAI Chat Completions API.
//
// Targets the canonical OpenAI /chat/completions endpoint for
// non-reasoning models (GPT-4o family, etc.). Uses
// `max_completion_tokens` — NOT the deprecated `max_tokens` — per
// OpenAI's current API contract. No thinking/reasoning support.
//
// Protocol: openai_chat_completions
// Default base URL: https://api.openai.com/v1

import type {
  LLMAdapter,
  LLMProfile,
  DecisionInput,
  DecisionOutput,
  ProbeResult,
  ValidationResult,
  UsageRecord,
} from "./types.js";
import { AdapterError } from "./types.js";

const PROTOCOL = "openai_chat_completions" as const;
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

// ─── Public factory ────────────────────────────────────────────────────────────

export function createOpenAIChatCompletionsAdapter(): LLMAdapter {
  return {
    protocol: PROTOCOL,
    validateProfile,
    probe,
    generateDecision,
    estimateUsage,
    redact,
  };
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
  if (!Number.isFinite(profile.maxTokens) || profile.maxTokens <= 0) {
    errors.push("maxTokens must be a positive finite integer");
  }
  if (profile.reasoning?.enabled) {
    warnings.push(
      `Protocol "${PROTOCOL}" does not support thinking/reasoning. ` +
        `The reasoning config will be ignored.`,
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
      // not valid JSON
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
  const baseURL = (profile.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, "");
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
    max_completion_tokens: input.maxTokens,
  };

  // Temperature: only send when explicitly set (not null)
  const temperature = input.temperature ?? profile.temperature;
  if (temperature !== null && temperature !== undefined) {
    body.temperature = temperature;
  }

  // JSON mode
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
    response = await globalThis.fetch(url, {
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
    const rawBody = await safeReadText(response);
    const kind = httpStatusToKind(response.status);
    throw new AdapterError(
      kind,
      PROTOCOL,
      `OpenAI returned HTTP ${response.status}`,
      { cause: rawBody, retryable: isRetryableStatus(response.status) },
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
      { cause },
    );
  }

  const text = extractText(parsed);
  if (text === null) {
    throw new AdapterError(
      "invalid_response",
      PROTOCOL,
      "response missing choices[0].message.content (or content is not a string)",
    );
  }

  const usage = extractUsage(parsed);

  return {
    text,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    latencyMs,
    raw: parsed,
  };
}

// ─── estimateUsage ─────────────────────────────────────────────────────────────

function estimateUsage(output: DecisionOutput, profile: LLMProfile): UsageRecord {
  return {
    protocol: PROTOCOL,
    providerLabel: "openai",
    model: profile.model,
    inputTokens: output.inputTokens,
    outputTokens: output.outputTokens,
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

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
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

function extractUsage(parsed: unknown): {
  inputTokens?: number;
  outputTokens?: number;
} {
  if (!isObject(parsed)) return {};
  const usage = parsed["usage"];
  if (!isObject(usage)) return {};
  const promptTokens = usage["prompt_tokens"];
  const completionTokens = usage["completion_tokens"];
  return {
    inputTokens: typeof promptTokens === "number" ? promptTokens : undefined,
    outputTokens:
      typeof completionTokens === "number" ? completionTokens : undefined,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
