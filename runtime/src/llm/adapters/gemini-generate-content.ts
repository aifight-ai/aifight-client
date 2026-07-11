// LLM adapter: Google Gemini native generateContent API.
//
// Protocol: gemini_generate_content
//   - baseURL default: https://generativelanguage.googleapis.com
//   - Auth: x-goog-api-key header
//   - Endpoint: ${baseURL}/v1beta/models/${model}:generateContent
//   - System prompt → systemInstruction; user prompt → contents[].parts[].text
//   - JSON mode → generationConfig.responseMimeType = "application/json"
//
// Note: a Google AI Studio key also works against the OpenAI-compatible
// endpoint via the openai_chat_compat adapter; config init uses that compat
// route by default. This native adapter is for profiles that explicitly
// select gemini_generate_content.

import type {
  LLMAdapter,
  LLMProfile,
  DecisionInput,
  DecisionOutput,
  ProbeResult,
  ValidationResult,
  UsageRecord,
  AdapterErrorKind,
  CanonicalReasoningConfig,
} from "./types.js";
import { AdapterError } from "./types.js";
import { looksLikeTokenLimit, computeTruncated } from "./token-limit.js";
import { parseRetryAfterMs, isContentFilterReason } from "./error-class.js";
import { boundedErrorBody } from "./redact.js";
import { fetchNoFollow } from "../../net/guarded-fetch.js";

const PROTOCOL = "gemini_generate_content" as const;
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";

export function createGeminiGenerateContentAdapter(): LLMAdapter {
  return { protocol: PROTOCOL, validateProfile, probe, generateDecision, estimateUsage, redact };
}

function validateProfile(profile: LLMProfile): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!profile.apiKey) errors.push("apiKey must be a non-empty string");
  if (!profile.model) errors.push("model must be a non-empty string");
  if (!Number.isFinite(profile.maxTokens) || profile.maxTokens <= 0) {
    errors.push("maxTokens must be a positive finite integer");
  }
  // Thinking is wired for gemini-2.5* (thinkingBudget) and gemini-3* (thinkingLevel);
  // other Gemini models silently lack a thinking API. Warn rather than drop quietly.
  if (wantsThinking(profile.reasoning) && geminiThinkingFamily(profile.model) === null) {
    warnings.push(
      `Model "${profile.model}" is not a known thinking-capable Gemini model ` +
        `(gemini-2.5* uses thinkingBudget, gemini-3* uses thinkingLevel); the reasoning config will be ignored.`,
    );
  }
  return { ok: errors.length === 0, errors, warnings };
}

async function probe(profile: LLMProfile): Promise<ProbeResult> {
  const start = performance.now();
  try {
    const output = await generateDecision(
      {
        systemPrompt: "You are a JSON test helper. Respond only with valid JSON.",
        userPrompt: 'Return {"ok":true}',
        maxTokens: 32,
        temperature: 0,
        responseFormat: "json",
      },
      profile,
    );
    const latencyMs = Math.max(0, performance.now() - start);
    let jsonValid = false;
    try {
      JSON.parse(output.text);
      jsonValid = true;
    } catch {
      // model ignored the JSON mime hint
    }
    return { success: true, latencyMs, model: profile.model, protocol: PROTOCOL, jsonValid };
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

async function generateDecision(
  input: DecisionInput,
  profile: LLMProfile,
  _continuationState?: unknown,
): Promise<DecisionOutput> {
  const baseURL = (profile.baseURL && profile.baseURL.length > 0 ? profile.baseURL : DEFAULT_BASE_URL).replace(/\/+$/, "");
  if (input.signal?.aborted) {
    throw new AdapterError("aborted", PROTOCOL, "request aborted before send");
  }
  const url = `${baseURL}/v1beta/models/${encodeURIComponent(profile.model)}:generateContent`;

  const generationConfig: Record<string, unknown> = { maxOutputTokens: input.maxTokens };
  const temperature = input.temperature ?? profile.temperature;
  if (temperature !== null && temperature !== undefined) generationConfig.temperature = temperature;
  if (input.responseFormat === "json" || input.responseFormat === "json_object") {
    generationConfig.responseMimeType = "application/json";
  }
  // Per-model thinking (the "special API usage" of the latest Gemini models).
  // Only emitted when reasoning is explicitly requested, so default behavior is
  // unchanged. gemini-2.5* takes a token budget; gemini-3* takes a level.
  const thinkingConfig = buildThinkingConfig(profile.model, input.reasoning ?? profile.reasoning);
  if (thinkingConfig !== null) generationConfig.thinkingConfig = thinkingConfig;

  const body = {
    systemInstruction: { parts: [{ text: input.systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: input.userPrompt }] }],
    generationConfig,
  };

  const headers: Record<string, string> = {
    "x-goog-api-key": profile.apiKey,
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
    if (isAbortError(cause)) throw new AdapterError("aborted", PROTOCOL, "request aborted", { cause });
    throw new AdapterError("network", PROTOCOL, `fetch failed: ${describeError(cause)}`, { cause });
  }

  const latencyMs = Math.max(0, performance.now() - start);

  if (!response.ok) {
    const rawBody = await safeReadText(response);
    const safeBody = boundedErrorBody(rawBody, profile.apiKey, 512);
    throw new AdapterError(
      httpStatusToKind(response.status),
      PROTOCOL,
      `Gemini returned HTTP ${response.status}`,
      { cause: safeBody, retryable: isRetryableStatus(response.status), tokenLimit: looksLikeTokenLimit(rawBody), status: response.status, retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")) },
    );
  }

  const rawText = await safeReadText(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (cause) {
    throw new AdapterError("invalid_response", PROTOCOL, "response body is not valid JSON", { cause });
  }

  const stopReason = extractGeminiFinish(parsed);
  const block = geminiBlockReason(parsed);
  if (block !== null) {
    throw new AdapterError("content_filter", PROTOCOL, `Gemini blocked the response (${block})`);
  }
  const text = extractText(parsed);
  if (text === null) {
    throw new AdapterError(
      "invalid_response",
      PROTOCOL,
      "response missing candidates[0].content.parts[].text",
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

/** Content-filter signal on a Gemini payload: a top-level
 *  promptFeedback.blockReason (any value = blocked prompt), or a safety-class
 *  candidates[0].finishReason. Returns the reason string, else null. */
function geminiBlockReason(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const pf = obj["promptFeedback"];
  if (typeof pf === "object" && pf !== null) {
    const br = (pf as Record<string, unknown>)["blockReason"];
    if (typeof br === "string" && br !== "") return br;
  }
  const candidates = obj["candidates"];
  if (Array.isArray(candidates) && candidates.length > 0) {
    const first = candidates[0];
    if (typeof first === "object" && first !== null) {
      const fr = (first as Record<string, unknown>)["finishReason"];
      if (isContentFilterReason(fr)) return typeof fr === "string" ? fr : "SAFETY";
    }
  }
  return null;
}

/** Gemini candidates[0].finishReason → normalized stopReason. */
function extractGeminiFinish(parsed: unknown): "stop" | "max_tokens" | "other" | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidates = (parsed as Record<string, unknown>)["candidates"];
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined;
  const first = candidates[0];
  if (typeof first !== "object" || first === null) return undefined;
  const fr = (first as Record<string, unknown>)["finishReason"];
  if (typeof fr !== "string" || fr === "") return undefined;
  if (fr === "MAX_TOKENS") return "max_tokens";
  if (fr === "STOP") return "stop";
  return "other";
}

function estimateUsage(output: DecisionOutput, profile: LLMProfile): UsageRecord {
  return {
    protocol: PROTOCOL,
    providerLabel: "google-gemini",
    model: profile.model,
    inputTokens: output.inputTokens,
    outputTokens: output.outputTokens,
    cachedTokens: output.cachedTokens,
    latencyMs: output.latencyMs,
    timestamp: new Date().toISOString(),
  };
}

function redact(raw: unknown): unknown {
  if (!isObject(raw)) return raw;
  return { modelVersion: raw["modelVersion"], usageMetadata: raw["usageMetadata"], _redacted: true };
}

// ─── thinking / reasoning (per-model special API usage) ──────────────
//
// Gemini's thinking API differs by model family (per the model-capabilities
// table): gemini-2.5* uses generationConfig.thinkingConfig.thinkingBudget (a
// token count; -1 = dynamic), while gemini-3* uses thinkingConfig.thinkingLevel
// (minimal/low/medium/high). We follow that table. ⚠️ The exact wire shapes —
// especially gemini-3 thinkingLevel — should be confirmed with a live `aifight
// config test` probe against the current Gemini API before relying on them in
// production; model APIs evolve.

function geminiThinkingFamily(model: string): "gemini-3" | "gemini-2.5" | null {
  if (/^gemini-3/i.test(model)) return "gemini-3";
  if (/^gemini-2\.5/i.test(model)) return "gemini-2.5";
  return null;
}

function wantsThinking(reasoning: CanonicalReasoningConfig | undefined): boolean {
  if (!reasoning) return false;
  if (reasoning.enabled === false || reasoning.mode === "disabled") return false;
  return (
    reasoning.enabled === true ||
    reasoning.enabled === "auto" ||
    reasoning.mode === "enabled" ||
    reasoning.mode === "adaptive" ||
    reasoning.mode === "auto" ||
    (reasoning.effort !== undefined && reasoning.effort !== "off")
  );
}

function effortToThinkingLevel(
  effort: CanonicalReasoningConfig["effort"],
): "minimal" | "low" | "medium" | "high" {
  switch (effort) {
    case "off":
    case "minimal":
      return "minimal";
    case "low":
      return "low";
    case "medium":
    case "auto":
      return "medium";
    case "high":
    case "xhigh":
    case "max":
      return "high";
    default:
      return "high";
  }
}

function effortToThinkingBudget(effort: CanonicalReasoningConfig["effort"]): number {
  switch (effort) {
    case "minimal":
      return 1024;
    case "low":
      return 4096;
    case "medium":
    case "auto":
      return 8192;
    case "high":
      return 16384;
    case "xhigh":
    case "max":
      return 24576;
    default:
      return -1; // dynamic: let Gemini choose
  }
}

/** Build generationConfig.thinkingConfig for thinking-capable Gemini models, or null. */
function buildThinkingConfig(
  model: string,
  reasoning: CanonicalReasoningConfig | undefined,
): Record<string, unknown> | null {
  if (!wantsThinking(reasoning)) return null;
  const family = geminiThinkingFamily(model);
  if (family === "gemini-3") {
    const level = reasoning?.thinkingLevel ?? effortToThinkingLevel(reasoning?.effort);
    return { thinkingLevel: level };
  }
  if (family === "gemini-2.5") {
    const budget = reasoning?.thinkingBudget ?? reasoning?.budgetTokens ?? effortToThinkingBudget(reasoning?.effort);
    return { thinkingBudget: budget };
  }
  return null; // unknown family: caller's validateProfile already warned
}

// ─── helpers ─────────────────────────────────────────────────────────

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

function httpStatusToKind(status: number): AdapterErrorKind {
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
  const candidates = parsed["candidates"];
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const first = candidates[0];
  if (!isObject(first)) return null;
  const content = first["content"];
  if (!isObject(content)) return null;
  const parts = content["parts"];
  if (!Array.isArray(parts)) return null;
  const texts = parts
    .map((p) => (isObject(p) && typeof p["text"] === "string" ? (p["text"] as string) : ""))
    .filter((t) => t.length > 0);
  return texts.length > 0 ? texts.join("") : null;
}

function extractUsage(parsed: unknown): { inputTokens?: number; outputTokens?: number; cachedTokens?: number } {
  if (!isObject(parsed)) return {};
  const usage = parsed["usageMetadata"];
  if (!isObject(usage)) return {};
  const prompt = usage["promptTokenCount"];
  const candidates = usage["candidatesTokenCount"];
  // C2: Gemini reports cached (implicit/explicit context cache) tokens under
  // usageMetadata.cachedContentTokenCount.
  const cached = usage["cachedContentTokenCount"];
  return {
    inputTokens: typeof prompt === "number" ? prompt : undefined,
    outputTokens: typeof candidates === "number" ? candidates : undefined,
    cachedTokens: typeof cached === "number" ? cached : undefined,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
