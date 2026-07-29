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
import { resolveModelCapabilities } from "../capabilities/validate-capabilities.js";
import { looksLikeTokenLimit, computeTruncated } from "./token-limit.js";
import { parseRetryAfterMs, isContentFilterReason } from "./error-class.js";
import { boundedErrorBody } from "./redact.js";
import { fetchNoFollow } from "../../net/guarded-fetch.js";
import { readTextCapped, readErrorBodyCapped } from "./response-limit.js";

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
  // gemini-2.5* uses thinkingBudget, gemini-3* uses thinkingLevel. Two distinct
  // off-path cases: a LEGACY generation (2.0/1.x) really has no thinking API, so
  // the config is ignored with a warning; an UNRECOGNIZED id gets the newest
  // shape (thinkingLevel) rather than having its reasoning silently dropped.
  if (wantsThinking(profile.reasoning)) {
    if (isLegacyNonThinkingGemini(profile.model)) {
      warnings.push(
        `Model "${profile.model}" is not a known thinking-capable Gemini model ` +
          `(2.0/1.x have no thinking API); the reasoning config will be ignored.`,
      );
    } else if (!/^gemini-(3|2\.5)/i.test(profile.model)) {
      warnings.push(
        `Model "${profile.model}" is not a Gemini generation this build recognizes; ` +
          `thinking will be sent in the newest shape (thinkingConfig.thinkingLevel).`,
      );
    }
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
  // The /v1beta version path is appended below, so a stored baseURL that
  // already ends in /v1beta (older onboarding wizards wrote the official URL
  // with it baked in) is stripped first — otherwise the request URL doubles
  // into /v1beta/v1beta/… and 404s.
  const baseURL = (profile.baseURL && profile.baseURL.length > 0 ? profile.baseURL : DEFAULT_BASE_URL)
    .replace(/\/+$/, "")
    .replace(/\/v1beta$/, "");
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
    const rawBody = await readErrorBodyCapped(response);
    const safeBody = boundedErrorBody(rawBody, profile.apiKey, 512);
    throw new AdapterError(
      httpStatusToKind(response.status),
      PROTOCOL,
      `Gemini returned HTTP ${response.status}`,
      { cause: safeBody, retryable: isRetryableStatus(response.status), tokenLimit: looksLikeTokenLimit(rawBody), status: response.status, retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")) },
    );
  }

  const rawText = await readTextCapped(response, PROTOCOL);
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

/**
 * Which thinking parameter this model takes on the wire.
 *
 * Named after the wire shape rather than the generation on purpose: the shape is
 * the thing the request builder needs, and "gemini-3" was only ever a proxy for it.
 *
 * The registry's `thinkingParam` is the source of truth; the id regexes below are
 * ONLY the fallback for a model it has never heard of. They used to be the primary
 * test, which made this a second hand-maintained discriminator sitting alongside
 * model-capabilities.json — the same duplicated-fact setup that let the whole
 * Claude 5 family be misclassified (see anthropic-messages.ts).
 */
function geminiThinkingShape(model: string): "thinkingLevel" | "thinkingBudget" | "none" {
  switch (resolveModelCapabilities(PROTOCOL, model).thinkingParam) {
    case "thinkingLevel":
      return "thinkingLevel";
    case "thinkingBudget":
      return "thinkingBudget";
  }
  // Unlisted model — fall back to the id's shape.
  if (/^gemini-3/i.test(model)) return "thinkingLevel";
  if (/^gemini-2\.5/i.test(model)) return "thinkingBudget";
  // Closed BACKWARD set: generations that really have no thinking API. Nothing
  // released after 2.5 will ever join this list.
  if (isLegacyNonThinkingGemini(model)) return "none";
  // Unknown id → the NEWEST wire shape (thinkingLevel), the same policy as the
  // Anthropic adapter's unknown→adaptive: an unrecognized model is far more likely
  // to be newer than this build than older than 2.5, and a wrong guess is a loud
  // 400 — the old "unknown ⇒ ignore reasoning" default dropped the configured
  // effort in silence (exactly how the Claude 5 misclassification stayed hidden).
  return "thinkingLevel";
}

function isLegacyNonThinkingGemini(model: string): boolean {
  return /^gemini-(2\.0|1)/i.test(model);
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
    case undefined:
      return "high";
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
    default: {
      // A new canonical tier must be mapped deliberately, not absorbed here: this
      // switch is a real translation into Gemini's own enum, so silently landing a
      // new tier on "high" would make it indistinguishable from asking for high.
      // The runtime fallback stays for a value that reaches here despite the types
      // (a hand-edited config.json).
      const _exhaustive: never = effort;
      void _exhaustive;
      return "high";
    }
  }
}

/** Clamp a thinkingLevel into the registry's per-model set (model-capabilities.json).
 *  Gemini 3 Pro does not accept "minimal" — only the flash/lite variants do — so on a
 *  Pro model minimal clamps DOWN to low, matching Go NormalizeGeminiThinkingLevel so a
 *  bot and an app-configured agent on the same model reason at the same level. For a
 *  model the registry doesn't list, the value is sent AS-IS (let the API judge). */
function clampThinkingLevelForModel(
  level: "minimal" | "low" | "medium" | "high",
  model: string,
): "minimal" | "low" | "medium" | "high" {
  const caps = resolveModelCapabilities(PROTOCOL, model);
  if (!caps.isKnownModel || caps.efforts.length === 0) return level;
  if (caps.efforts.includes(level)) return level;
  return level === "minimal" ? "low" : "high";
}

function effortToThinkingBudget(effort: CanonicalReasoningConfig["effort"]): number {
  switch (effort) {
    case undefined:
    case "off":
      return -1; // dynamic: let Gemini choose
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
    default: {
      // Same reasoning as effortToThinkingLevel: a new tier needs its own budget
      // decided, not the dynamic default silently standing in for it.
      const _exhaustive: never = effort;
      void _exhaustive;
      return -1;
    }
  }
}

/** Build generationConfig.thinkingConfig for thinking-capable Gemini models, or null. */
function buildThinkingConfig(
  model: string,
  reasoning: CanonicalReasoningConfig | undefined,
): Record<string, unknown> | null {
  if (!wantsThinking(reasoning)) return null;
  // Unknown Gemini model → the NEWEST wire shape (thinkingLevel), same policy as
  // the Anthropic adapter's unknown→adaptive: an unrecognized id is far more
  // likely to be newer than this build than older than 2.5, and a wrong guess is
  // a loud 400 — the old "unknown ⇒ ignore reasoning" default dropped the user's
  // effort in silence (exactly how the Claude 5 misclassification hid).
  const shape = geminiThinkingShape(model);
  if (shape === "none") return null; // legacy generation: no thinking API at all
  if (shape === "thinkingLevel") {
    // "auto" (or no tier picked) = send no explicit level; Gemini's own default
    // thinking applies. An explicit tier maps onto the thinkingLevel enum.
    if (reasoning?.thinkingLevel === undefined &&
        (reasoning?.effort === undefined || reasoning?.effort === "auto")) {
      return null;
    }
    const level = reasoning?.thinkingLevel ?? effortToThinkingLevel(reasoning?.effort);
    return { thinkingLevel: clampThinkingLevelForModel(level, model) };
  }
  if (shape === "thinkingBudget") {
    const budget = reasoning?.thinkingBudget ?? reasoning?.budgetTokens ?? effortToThinkingBudget(reasoning?.effort);
    return { thinkingBudget: budget };
  }
  const _exhaustive: never = shape;
  void _exhaustive;
  return null;
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
    // Thought-summary parts (thought === true) are chain-of-thought, never the
    // answer. Gemini-protocol gateways/proxies can return them even though
    // includeThoughts was never requested, and joining them here would surface
    // the model's reasoning as its reply (2026-07-19). Filter unconditionally.
    .filter((p) => !(isObject(p) && p["thought"] === true))
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
  // Gemini reports thinking tokens SEPARATELY (thoughtsTokenCount) from the
  // visible answer (candidatesTokenCount) and bills both as output — fold them
  // together, or a reasoning model's output usage is massively under-counted
  // (2026-07-19). Both fields optional: absent on non-thinking models.
  const thoughts = usage["thoughtsTokenCount"];
  const candidatesN = typeof candidates === "number" ? candidates : undefined;
  const thoughtsN = typeof thoughts === "number" ? thoughts : undefined;
  const outputTotal =
    candidatesN === undefined && thoughtsN === undefined ? undefined : (candidatesN ?? 0) + (thoughtsN ?? 0);
  // C2: Gemini reports cached (implicit/explicit context cache) tokens under
  // usageMetadata.cachedContentTokenCount.
  const cached = usage["cachedContentTokenCount"];
  return {
    inputTokens: typeof prompt === "number" ? prompt : undefined,
    outputTokens: outputTotal,
    cachedTokens: typeof cached === "number" ? cached : undefined,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
