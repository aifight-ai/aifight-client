// Anthropic Messages API adapter.
//
// Protocol: anthropic_messages
// Endpoint: POST ${baseURL}/v1/messages
// Auth: x-api-key + anthropic-version: 2023-06-01
//
// Model-specific reasoning behavior:
//   Opus 4.7  → thinking: { type: "adaptive", display: "omitted" }  + output_config: { effort: "xhigh" }
//   Opus 4.6  → thinking: { type: "adaptive", display: "summarized" } + output_config: { effort: "high" }
//   Sonnet    → same shape as 4.6
// For xhigh / max effort: omit temperature, top_p, top_k entirely.

import type {
  LLMAdapter,
  LLMProfile,
  DecisionInput,
  DecisionOutput,
  ProbeResult,
  ValidationResult,
  UsageRecord,
  CanonicalReasoningConfig,
} from "./types.js";
import { AdapterError } from "./types.js";
import { looksLikeTokenLimit, computeTruncated } from "./token-limit.js";
import { parseRetryAfterMs, isContentFilterReason } from "./error-class.js";
import { boundedErrorBody } from "./redact.js";
import { fetchNoFollow } from "../../net/guarded-fetch.js";

const PROTOCOL = "anthropic_messages" as const;
const ANTHROPIC_VERSION = "2023-06-01";

// ─── Model classification ────────────────────────────────────────────
// Adaptive thinking (thinking:{type:"adaptive"} + output_config.effort) is
// supported on Opus 4.6/4.7/4.8, Sonnet 4.6, and Mythos. Opus 4.7/4.8 and
// Mythos accept ONLY adaptive — manual type:"enabled"+budget_tokens returns
// HTTP 400. Older Claude (Opus/Sonnet 4.5, 3.7) require manual extended
// thinking (enabled + budget_tokens) and do NOT support adaptive.

function supportsAdaptiveThinking(model: string): boolean {
  return (
    /claude-opus-4[-.](6|7|8)/i.test(model) ||
    /claude-sonnet-4[-.]6/i.test(model) ||
    /mythos/i.test(model)
  );
}

function legacyThinkingCapable(model: string): boolean {
  return /claude-(opus|sonnet)-4[-.]5/i.test(model) || /claude-3[-.]7/i.test(model);
}

function isXHighEffort(effort: string | undefined): boolean {
  return effort === "xhigh" || effort === "max";
}

// ─── Request body types (Anthropic wire format) ──────────────────────

interface AnthropicThinkingConfig {
  type: "adaptive" | "enabled" | "disabled";
  display?: "omitted" | "summarized";
  budget_tokens?: number;
}

interface AnthropicOutputConfig {
  effort: "low" | "medium" | "high" | "xhigh" | "max";
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

/** A `system` text block carrying an optional prompt-cache breakpoint (C1). */
interface AnthropicSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  /** String (legacy) or a block array, so a `cache_control` breakpoint can sit
   *  at the end of the system prefix (C1). */
  system?: string | AnthropicSystemBlock[];
  messages: AnthropicMessage[];
  thinking?: AnthropicThinkingConfig;
  output_config?: AnthropicOutputConfig;
  temperature?: number;
  top_p?: number;
}

// ─── Response types ──────────────────────────────────────────────────

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  summary?: string;
}

interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: Array<AnthropicTextBlock | AnthropicThinkingBlock | { type: string }>;
  usage: AnthropicUsage;
  stop_reason: string | null;
}

// ─── Request builder ─────────────────────────────────────────────────

function buildRequestBody(
  input: DecisionInput,
  profile: LLMProfile,
): AnthropicRequestBody {
  const reasoning = input.reasoning ?? profile.reasoning;
  const effort = reasoning?.effort;

  const body: AnthropicRequestBody = {
    model: profile.model,
    max_tokens: input.maxTokens,
    messages: [{ role: "user", content: input.userPrompt }],
  };

  // C1 (prompt-cache): carry the system prompt as a single text block with a
  // cache_control breakpoint at its end, so the (tools→)system prefix is
  // cacheable on api.anthropic.com. A prefix below the model's minimum
  // cacheable length (Opus 4.8 = 4096, Fable 5 = 2048 tokens) silently won't
  // cache — expected for most users' short system prompts (cache spec §10.1-B2);
  // long-strategy users benefit immediately. Empty system → omit the field.
  if (input.systemPrompt) {
    body.system = [
      { type: "text", text: input.systemPrompt, cache_control: { type: "ephemeral" } },
    ];
  }

  const explicitlyDisabled =
    reasoning?.enabled === false || reasoning?.mode === "disabled";
  const wantThinking =
    !explicitlyDisabled &&
    (reasoning?.enabled === true ||
      reasoning?.enabled === "auto" ||
      reasoning?.mode === "enabled" ||
      reasoning?.mode === "adaptive" ||
      (effort !== undefined && effort !== "off"));

  if (!wantThinking) {
    // Thinking off (or unset). Valid on every model — on Opus 4.7/4.8,
    // omitting `thinking` is how you turn it off (type:"enabled" would 400).
    if (input.temperature !== null) body.temperature = input.temperature;
    return body;
  }

  if (supportsAdaptiveThinking(profile.model)) {
    // New models: adaptive thinking + effort. display "omitted" is fine and
    // faster — we only need the final action text, not a thinking summary.
    body.thinking = { type: "adaptive", display: reasoning?.display ?? "omitted" };
    body.output_config = { effort: clampEffortForModel(mapEffort(effort) ?? "high", profile.model) };
    // Thinking active → leave temperature unset (Anthropic requirement).
  } else if (legacyThinkingCapable(profile.model)) {
    // Older models: manual extended thinking via enabled + budget_tokens.
    const budget = Math.max(1024, reasoning?.budgetTokens ?? 4096);
    body.thinking = { type: "enabled", budget_tokens: budget };
    // Manual thinking also requires temperature unset.
  } else {
    // Model has no thinking support (e.g. Haiku 3): plain request.
    if (input.temperature !== null) body.temperature = input.temperature;
  }

  return body;
}

function mapEffort(effort: string | undefined): AnthropicOutputConfig["effort"] | undefined {
  switch (effort) {
    case "low":
    case "minimal":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    case "max":
      return "max";
    default:
      return undefined;
  }
}

/** Per the Effort docs, `xhigh` is only valid on Opus 4.7 / 4.8. On other adaptive
 *  models (Opus 4.6, Sonnet 4.6, Mythos) sending it 400s — clamp it down to `high`.
 *  `max` is accepted on all adaptive models, so it needs no clamp. */
function supportsXhigh(model: string): boolean {
  return /claude-opus-4[-.](7|8)/i.test(model);
}

function clampEffortForModel(
  effort: AnthropicOutputConfig["effort"],
  model: string,
): AnthropicOutputConfig["effort"] {
  if (effort === "xhigh" && !supportsXhigh(model)) return "high";
  return effort;
}

// ─── HTTP helper ─────────────────────────────────────────────────────

async function callAPI(
  url: string,
  apiKey: string,
  body: AnthropicRequestBody,
  signal?: AbortSignal,
): Promise<AnthropicResponse> {
  let response: Response;
  try {
    response = await fetchNoFollow(url, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new AdapterError("aborted", PROTOCOL, "Request aborted", { cause: err });
    }
    throw new AdapterError("network", PROTOCOL, `Network error: ${String(err)}`, {
      retryable: true,
      cause: err,
    });
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "(unreadable body)");
    const safeBody = boundedErrorBody(text, apiKey, 512);
    const kind = httpStatusToKind(response.status);
    const retryable = kind === "rate_limited" || kind === "server_error";
    throw new AdapterError(
      kind,
      PROTOCOL,
      `Anthropic API error ${response.status}: ${safeBody}`,
      { retryable, tokenLimit: looksLikeTokenLimit(text), status: response.status, retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")) },
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (err) {
    throw new AdapterError("invalid_response", PROTOCOL, "Response is not valid JSON", {
      cause: err,
    });
  }

  return parsed as AnthropicResponse;
}

function httpStatusToKind(status: number): import("./types.js").AdapterErrorKind {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 404) return "model_not_found";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 422) return "invalid_request";
  if (status >= 500) return "server_error";
  return "unknown";
}

// ─── Response parser ─────────────────────────────────────────────────

/** Anthropic stop_reason → normalized stopReason. null/absent → undefined. */
function normalizeAnthropicStop(reason: string | null): "stop" | "max_tokens" | "other" | undefined {
  if (reason === null || reason === undefined) return undefined;
  if (reason === "max_tokens") return "max_tokens";
  if (reason === "end_turn" || reason === "stop_sequence") return "stop";
  return "other";
}

function parseResponse(raw: AnthropicResponse): {
  text: string;
  reasoningSummary?: string;
  reasoningTokens?: number;
  stopReason?: "stop" | "max_tokens" | "other";
} {
  let text = "";
  let reasoningSummary: string | undefined;

  for (const block of raw.content) {
    if (block.type === "text") {
      text += (block as AnthropicTextBlock).text;
    } else if (block.type === "thinking") {
      const tb = block as AnthropicThinkingBlock;
      if (tb.summary) {
        reasoningSummary = tb.summary;
      }
    }
  }

  const stopReason = normalizeAnthropicStop(raw.stop_reason);

  if (isContentFilterReason(raw.stop_reason)) {
    throw new AdapterError("content_filter", PROTOCOL, "Anthropic declined the request (stop_reason: refusal)");
  }

  if (!text) {
    // Empty text almost always means extended thinking consumed the whole
    // budget (stop_reason "max_tokens"). Carry that as tokenLimit so the runtime
    // classifies it as a truncation, not a mystery invalid_response.
    throw new AdapterError(
      "invalid_response",
      PROTOCOL,
      "No text block found in Anthropic response",
      { tokenLimit: stopReason === "max_tokens" },
    );
  }

  return { text: text.trim(), reasoningSummary, ...(stopReason ? { stopReason } : {}) };
}

// ─── Approximate pricing (USD per 1M tokens, as of 2025-Q3) ─────────

const PRICING: Record<string, { input: number; output: number; cached?: number }> = {
  "claude-opus-4": { input: 15, output: 75, cached: 1.5 },
  "claude-sonnet-4": { input: 3, output: 15, cached: 0.3 },
  "claude-haiku-3": { input: 0.25, output: 1.25, cached: 0.03 },
};

function findPricing(model: string) {
  for (const [key, price] of Object.entries(PRICING)) {
    if (model.includes(key)) return price;
  }
  // Unknown model — return zero so we don't crash
  return { input: 0, output: 0, cached: 0 };
}

// ─── Adapter implementation ──────────────────────────────────────────

export function createAnthropicMessagesAdapter(): LLMAdapter {
  return {
    protocol: PROTOCOL,

    validateProfile(profile: LLMProfile): ValidationResult {
      const errors: string[] = [];
      const warnings: string[] = [];

      if (profile.protocol !== PROTOCOL) {
        errors.push(`Protocol mismatch: expected ${PROTOCOL}, got ${profile.protocol}`);
      }
      if (!profile.apiKey) {
        errors.push("apiKey is required");
      }
      if (!profile.model) {
        errors.push("model is required");
      }
      if (!profile.baseURL) {
        errors.push("baseURL is required");
      }
      if (profile.maxTokens <= 0) {
        errors.push("maxTokens must be > 0");
      }

      // Warn if manual budgetTokens provided (deprecated for 4.6+)
      if (profile.reasoning?.budgetTokens) {
        warnings.push(
          "reasoning.budgetTokens is deprecated for claude-4.x models; use effort-level config instead",
        );
      }

      // Warn if temperature set alongside xhigh/max effort
      const effort = profile.reasoning?.effort;
      if (isXHighEffort(effort) && profile.temperature !== null) {
        warnings.push(
          `temperature will be omitted for effort=${effort} (Anthropic requirement)`,
        );
      }

      return { ok: errors.length === 0, errors, warnings };
    },

    async probe(profile: LLMProfile): Promise<ProbeResult> {
      const start = Date.now();
      const url = `${profile.baseURL}/v1/messages`;

      // Minimal structured JSON probe — does not use reasoning to keep latency low
      const body: AnthropicRequestBody = {
        model: profile.model,
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content:
              'Reply with exactly this JSON and nothing else: {"status":"ok","probe":true}',
          },
        ],
        temperature: 0,
      };

      try {
        const raw = await callAPI(url, profile.apiKey, body);
        const latencyMs = Date.now() - start;
        const { text } = parseResponse(raw);

        let jsonValid = false;
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          jsonValid = parsed["status"] === "ok";
        } catch {
          // not valid JSON
        }

        return {
          success: true,
          latencyMs,
          model: raw.model ?? profile.model,
          protocol: PROTOCOL,
          jsonValid,
        };
      } catch (err) {
        return {
          success: false,
          latencyMs: Date.now() - start,
          model: profile.model,
          protocol: PROTOCOL,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async generateDecision(
      input: DecisionInput,
      profile: LLMProfile,
      _continuationState?: unknown,
    ): Promise<DecisionOutput> {
      const start = Date.now();
      const url = `${profile.baseURL}/v1/messages`;
      const body = buildRequestBody(input, profile);

      const raw = await callAPI(url, profile.apiKey, body, input.signal);
      const latencyMs = Date.now() - start;

      const { text, reasoningSummary, stopReason } = parseResponse(raw);

      const usage = raw.usage ?? {};
      const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
      const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
      const inputTokens =
        typeof usage.input_tokens === "number"
          ? usage.input_tokens + cacheReadTokens + cacheWriteTokens
          : undefined;
      const outputTokens = usage.output_tokens;
      const cachedTokens = cacheReadTokens || undefined;
      const cacheCreationTokens = cacheWriteTokens || undefined;
      const truncated = computeTruncated(stopReason, text, undefined);

      return {
        text,
        ...(stopReason ? { stopReason } : {}),
        ...(truncated ? { truncated: true } : {}),
        inputTokens,
        outputTokens,
        cachedTokens,
        cacheWriteTokens: cacheCreationTokens,
        latencyMs,
        reasoningSummary,
        raw,
      };
    },

    estimateUsage(output: DecisionOutput, profile: LLMProfile): UsageRecord {
      const pricing = findPricing(profile.model);
      const inputTokens = output.inputTokens ?? 0;
      const outputTokens = output.outputTokens ?? 0;
      const cachedTokens = output.cachedTokens ?? 0;
      const cacheWriteTokens = output.cacheWriteTokens ?? 0;

      const billableInput = inputTokens - cachedTokens - cacheWriteTokens;
      const estimatedCostUSD =
        (Math.max(0, billableInput) * pricing.input +
          (cachedTokens * (pricing.cached ?? pricing.input)) +
          cacheWriteTokens * pricing.input +
          outputTokens * pricing.output) /
        1_000_000;

      return {
        protocol: PROTOCOL,
        providerLabel: "Anthropic",
        model: profile.model,
        inputTokens,
        outputTokens,
        reasoningTokens: output.reasoningTokens,
        cachedTokens,
        cacheWriteTokens,
        estimatedCostUSD,
        latencyMs: output.latencyMs,
        timestamp: new Date().toISOString(),
      };
    },

    redact(raw: unknown): unknown {
      if (!raw || typeof raw !== "object") return raw;
      const response = raw as AnthropicResponse;

      // Strip thinking block internals; keep summary if present
      const redactedContent = (response.content ?? []).map((block) => {
        if (block.type === "thinking") {
          const tb = block as AnthropicThinkingBlock;
          return tb.summary
            ? { type: "thinking", summary: tb.summary }
            : { type: "thinking" };
        }
        return block;
      });

      return {
        id: response.id,
        type: response.type,
        model: response.model,
        stop_reason: response.stop_reason,
        usage: response.usage,
        content: redactedContent,
      };
    },
  };
}
