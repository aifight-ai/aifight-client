// Anthropic Messages API adapter.
//
// Protocol: anthropic_messages
// Endpoint: POST ${baseURL}/v1/messages
// Auth: x-api-key + anthropic-version: 2023-06-01
//
// Model-specific reasoning behavior is NOT hardcoded here — it is looked up in
// capabilities/model-capabilities.json (see thinkingShapeFor / clampEffortForModel):
//   adaptive models → thinking: { type: "adaptive", display } + output_config: { effort }
//   4.5-generation  → thinking: { type: "enabled", budget_tokens }
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
import { resolveModelCapabilities } from "../capabilities/validate-capabilities.js";
import { looksLikeTokenLimit, computeTruncated } from "./token-limit.js";
import { parseRetryAfterMs, isContentFilterReason } from "./error-class.js";
import { boundedErrorBody } from "./redact.js";
import { fetchNoFollow } from "../../net/guarded-fetch.js";
import { readTextCapped, readErrorBodyCapped } from "./response-limit.js";

const PROTOCOL = "anthropic_messages" as const;
const ANTHROPIC_VERSION = "2023-06-01";

// ─── Model classification ────────────────────────────────────────────
// Which thinking shape a model wants, and which effort tiers it accepts, are
// facts ABOUT THE MODEL: they live in capabilities/model-capabilities.json and
// are read from there rather than re-encoded as regexes here. Two independent
// hand-maintained copies of this knowledge (this file and Go's
// internal/llmcompat/compat.go) had both silently missed the entire Claude 5
// family — a duplicated fact drifts, a looked-up one cannot.
//
//   adaptive → thinking:{type:"adaptive"} + output_config:{effort}
//   extended → thinking:{type:"enabled", budget_tokens:N}   (Opus 4.1, 4.5 generation)
//
// Claude 4.7 and later REJECT type:"enabled" with HTTP 400, so for a model the
// registry has never heard of, ADAPTIVE is the right guess: an unrecognized id is
// far more likely to be newer than the registry than older than the 4.5
// generation, and guessing wrong surfaces as a loud 400 on the user's very first
// Test — whereas the old "unknown ⇒ no thinking support" default sent a plain
// request and threw the configured effort away in silence.
function thinkingShapeFor(model: string): "adaptive" | "extended" | "none" {
  const caps = resolveModelCapabilities(PROTOCOL, model);
  if (!caps.thinkingModesKnown) return "adaptive";
  if (caps.thinkingModes.includes("adaptive")) return "adaptive";
  if (caps.thinkingModes.includes("extended")) return "extended";
  return "none";
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
  /** `low | medium | high | xhigh | max` today. Typed as a plain string, not a
   *  union, because the tier vocabulary is Anthropic's to extend and it is the
   *  capability registry — not this file — that decides which tiers a given model
   *  accepts (see clampEffortForModel). */
  effort: string;
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
  // cacheable length silently won't cache — and that minimum is NOT monotonic by
  // generation (per the prompt-caching docs, verified 2026-07-26: Opus 5 and
  // Fable 5 = 512, Opus 4.8 = 1024, Opus 4.7 = 2048, Opus 4.6 and Haiku 4.5 =
  // 4096), so it cannot be inferred from the model id. Expected for most users'
  // short system prompts (cache spec §10.1-B2);
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

  const shape = thinkingShapeFor(profile.model);
  switch (shape) {
    case "adaptive": {
      // Adaptive thinking + effort. display "omitted" is fine and faster — we only
      // need the final action text, not a thinking summary.
      body.thinking = { type: "adaptive", display: reasoning?.display ?? "omitted" };
      // No tier picked / "auto" → omit output_config so Anthropic's own default
      // applies (documented as identical to effort:"high" today, and free to
      // evolve with the API). An explicit tier is clamped per the registry.
      const mapped = mapEffort(effort);
      if (mapped !== undefined) {
        body.output_config = { effort: clampEffortForModel(mapped, profile.model) };
      }
      // Thinking active → leave temperature unset (Anthropic requirement).
      break;
    }
    case "extended": {
      // 4.5 generation and older: manual extended thinking via enabled + budget_tokens.
      const budget = Math.max(1024, reasoning?.budgetTokens ?? 4096);
      body.thinking = { type: "enabled", budget_tokens: budget };
      // Manual thinking also requires temperature unset.
      break;
    }
    case "none":
      // Registry says this model cannot think at all: plain request.
      if (input.temperature !== null) body.temperature = input.temperature;
      break;
    default: {
      // If Anthropic ever ships a third thinking wire shape, thinkingShapeFor
      // gains a member and this stops compiling. Falling through to the plain
      // request instead would drop the user's whole reasoning config in silence —
      // the failure mode this adapter already survived once.
      const _exhaustive: never = shape;
      void _exhaustive;
      if (input.temperature !== null) body.temperature = input.temperature;
    }
  }

  return body;
}

/**
 * Canonical effort → Anthropic `output_config.effort`.
 *
 * Known aliases normalize (`minimal` → `low`), and the sentinels below mean "no
 * explicit tier" so the caller's `?? "high"` applies. `adaptive` is on that list on
 * purpose: it is a THINKING MODE, not an effort level, and the effort docs call out
 * passing it here as a mistake.
 *
 * Anything else passes through UNCHANGED. This used to be a closed enum that mapped
 * every unrecognized value to `high`, which made a newer tier indistinguishable from
 * asking for high — the same silent-downgrade failure the model classification had.
 * A tier this build has never heard of should reach the API and be answered by it;
 * for a model the registry DOES list, clampEffortForModel still absorbs it (so a
 * typo on a known model lands on `high` rather than a 400).
 */
function mapEffort(effort: string | undefined): string | undefined {
  switch (effort) {
    case undefined:
    case "":
    case "off":
    case "none":
    case "auto":
    case "default":
    case "adaptive":
      return undefined;
    case "minimal":
      return "low";
    default:
      return effort;
  }
}

/** Effort tiers are per-model (e.g. `xhigh` exists on Opus 4.7/4.8, Opus 5,
 *  Sonnet 5 and Fable 5, but NOT on Opus 4.6 or Sonnet 4.6, where sending it
 *  400s). A tier the model does not list clamps DOWN to `high`, never up, so a
 *  house bot and an app-configured agent on the same model and the same nominal
 *  effort actually reason at the same level — Go's NormalizeClaudeEffort does the
 *  identical clamp against the identical registry.
 *
 *  For a model the registry doesn't know, the configured value is sent AS-IS: only
 *  the registry can authoritatively reject a tier, and only for a model it lists.
 *  New models keep arriving with new vocabularies; let the API be the judge rather
 *  than silently downgrading the user's choice. (Same rule as CLI `config add`.) */
function clampEffortForModel(effort: string, model: string): string {
  const caps = resolveModelCapabilities(PROTOCOL, model);
  if (!caps.isKnownModel || caps.efforts.length === 0) return effort;
  return caps.efforts.includes(effort) ? effort : "high";
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
    const text = (await readErrorBodyCapped(response)) || "(unreadable body)";
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

  // Capped read then parse — response.json() would buffer the whole body first.
  const rawText = await readTextCapped(response, PROTOCOL);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
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
  let fullThinking = "";

  // A 200 body from a non-conforming proxy may be {}/null/scalar with no
  // `content` array. Guard before iterating so the missing-text path throws a
  // classified AdapterError('invalid_response') below, not a raw TypeError —
  // mirrors redact()'s `response.content ?? []` guard in this file.
  const blocks = Array.isArray(raw?.content) ? raw.content : [];

  for (const block of blocks) {
    if (block.type === "text") {
      text += (block as AnthropicTextBlock).text;
    } else if (block.type === "thinking") {
      const tb = block as AnthropicThinkingBlock;
      if (tb.summary) {
        reasoningSummary = tb.summary;
      } else if (tb.thinking) {
        // Legacy extended thinking (budget_tokens models) carries the full
        // chain of thought instead of a summary — collect it so reasoning
        // capture works there too (the caller truncates before storing).
        fullThinking += (fullThinking ? "\n\n" : "") + tb.thinking;
      }
    }
  }
  if (reasoningSummary === undefined && fullThinking !== "") {
    reasoningSummary = fullThinking;
  }

  const stopReason = normalizeAnthropicStop(raw?.stop_reason ?? null);

  if (isContentFilterReason(raw?.stop_reason)) {
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
      // B8 (windows-loop, 2026-07-26): no built-in price table, per the owner
      // decision that this codebase ships no hardcoded prices. The table that
      // used to live here was also wrong by construction — its newest entry was
      // "claude-opus-4" at 2025-Q3 rates, so every Claude 4.5+/5 model matched
      // NOTHING and the fallback computed a cost of exactly $0.00.
      //
      // Nothing consumed the number (checked: no reader anywhere in the repo).
      // The cost users actually see comes from their own `aifight prices` table
      // via usage/stats.ts, over the separate persisted UsageRecord, which has no
      // cost field at all — so this was a wrong answer nobody was even reading.
      // Token counts below are real and unaffected; this now matches every other
      // adapter (OpenAI Responses, DeepSeek): report usage, leave pricing alone.
      return {
        protocol: PROTOCOL,
        providerLabel: "Anthropic",
        model: profile.model,
        inputTokens: output.inputTokens ?? 0,
        outputTokens: output.outputTokens ?? 0,
        reasoningTokens: output.reasoningTokens,
        cachedTokens: output.cachedTokens ?? 0,
        cacheWriteTokens: output.cacheWriteTokens ?? 0,
        estimatedCostUSD: undefined,
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
