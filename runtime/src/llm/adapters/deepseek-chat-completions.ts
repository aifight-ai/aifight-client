// DeepSeek Chat Completions adapter.
//
// Protocol: deepseek_chat_completions
// Endpoint: POST ${baseURL}/chat/completions
// Auth:     Authorization: Bearer ${apiKey}
// Models:   deepseek-v4-pro, deepseek-v4-flash
//
// Thinking mode behaviour:
//   - Enabled by default when reasoning.enabled !== false
//   - In thinking mode: temperature, top_p, presence_penalty, frequency_penalty
//     have NO effect — they are omitted from the request body
//   - reasoning_effort only supports "high" and "max"
//   - Effort mapping: off/minimal/low/medium -> "high", xhigh/max -> "max", auto -> "max"
//     Effort values that require remapping emit a console warning.

import type {
  LLMAdapter,
  LLMProfile,
  DecisionInput,
  DecisionOutput,
  ProbeResult,
  ValidationResult,
  UsageRecord,
  ReasoningEffort,
} from "./types.js";
import { AdapterError } from "./types.js";
import { looksLikeTokenLimit, normalizeOpenAIFinish, computeTruncated } from "./token-limit.js";
import { parseRetryAfterMs, isContentFilterReason } from "./error-class.js";

const PROTOCOL = "deepseek_chat_completions" as const;

// DeepSeek's web UI streams and its FAQ injects keep-alive empty lines into
// non-streaming responses to dodge TCP timeouts; long / reasoning generations
// over a non-streaming connection are fragile in practice. So above this
// max_tokens threshold we switch to SSE streaming (collecting the full text),
// which is the robust path for big outputs. Small requests stay non-streaming.
const STREAM_MAX_TOKENS_THRESHOLD = 4096;

// ─── Effort mapping ──────────────────────────────────────────────────

type DeepSeekReasoningEffort = "high" | "max";

/**
 * Map the canonical ReasoningEffort to the two values DeepSeek supports.
 * Returns the mapped value and a warning string if remapping was lossy.
 */
function mapEffort(effort: ReasoningEffort): {
  value: DeepSeekReasoningEffort;
  warning?: string;
} {
  switch (effort) {
    case "max":
    case "xhigh":
      return { value: "max" };
    case "auto":
      return { value: "max", warning: `effort "auto" mapped to "max" for DeepSeek` };
    case "high":
      return { value: "high" };
    case "medium":
      return {
        value: "high",
        warning: `effort "medium" mapped to "high" for DeepSeek (nearest supported value)`,
      };
    case "low":
      return {
        value: "high",
        warning: `effort "low" mapped to "high" for DeepSeek (minimum supported value)`,
      };
    case "minimal":
      return {
        value: "high",
        warning: `effort "minimal" mapped to "high" for DeepSeek (minimum supported value)`,
      };
    case "off":
      // Caller should have disabled thinking; map to high as fallback.
      return {
        value: "high",
        warning: `effort "off" mapped to "high" for DeepSeek; use reasoning.enabled=false to disable thinking instead`,
      };
    default: {
      const _exhaustive: never = effort;
      void _exhaustive;
      return { value: "high", warning: `unknown effort "${String(effort)}" mapped to "high"` };
    }
  }
}

// ─── Wire types ──────────────────────────────────────────────────────

interface DeepSeekMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface DeepSeekRequestBody {
  model: string;
  messages: DeepSeekMessage[];
  max_tokens: number;
  thinking?: { type: "enabled" | "disabled" };
  reasoning_effort?: DeepSeekReasoningEffort;
  temperature?: number;
  response_format?: { type: "json_object" | "text" };
  stream?: boolean;
  /** Ask DeepSeek to emit a final usage chunk while streaming. */
  stream_options?: { include_usage: boolean };
}

interface DeepSeekResponseMessage {
  role: string;
  content: string;
  reasoning_content?: string;
}

interface DeepSeekChoice {
  message: DeepSeekResponseMessage;
  finish_reason?: string;
}

interface DeepSeekUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
  /** DeepSeek context-caching hit count (C2). Absent on cache miss / older API. */
  prompt_cache_hit_tokens?: number;
}

interface DeepSeekResponse {
  choices: DeepSeekChoice[];
  usage?: DeepSeekUsage;
}

// ─── HTTP helper ─────────────────────────────────────────────────────

/** Fetch + status-error mapping. Returns the raw Response for the caller to consume (json or SSE). */
async function sendRequest(
  baseURL: string,
  apiKey: string,
  body: DeepSeekRequestBody,
  signal?: AbortSignal,
): Promise<Response> {
  const url = `${baseURL.replace(/\/+$/, "")}/chat/completions`;

  let resp: Response;
  try {
    resp = await globalThis.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new AdapterError("aborted", PROTOCOL, "Request aborted", { cause: err });
    }
    throw new AdapterError("network", PROTOCOL, `Network error: ${String(err)}`, {
      cause: err,
      retryable: true,
    });
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const kind =
      resp.status === 401 || resp.status === 403
        ? "auth_failed"
        : resp.status === 429
          ? "rate_limited"
          : resp.status === 404
            ? "model_not_found"
            : resp.status >= 400 && resp.status < 500
              ? "invalid_request"
              : "server_error";
    throw new AdapterError(
      kind,
      PROTOCOL,
      `DeepSeek API ${resp.status}: ${text.slice(0, 300)}`,
      { retryable: kind === "rate_limited" || kind === "server_error", tokenLimit: looksLikeTokenLimit(text), status: resp.status, retryAfterMs: parseRetryAfterMs(resp.headers.get("retry-after")) },
    );
  }

  return resp;
}

/** Non-streaming: parse the single JSON body. */
async function postChatCompletions(
  baseURL: string,
  apiKey: string,
  body: DeepSeekRequestBody,
  signal?: AbortSignal,
): Promise<DeepSeekResponse> {
  const resp = await sendRequest(baseURL, apiKey, body, signal);
  let data: unknown;
  try {
    data = await resp.json();
  } catch (err) {
    throw new AdapterError("invalid_response", PROTOCOL, "Response body is not valid JSON", {
      cause: err,
    });
  }
  return data as DeepSeekResponse;
}

interface DeepSeekStreamChunk {
  choices?: Array<{
    delta?: { content?: string; reasoning_content?: string };
    finish_reason?: string | null;
  }>;
  usage?: DeepSeekUsage;
}

/**
 * Streaming: consume the SSE body and accumulate content + reasoning_content
 * into a single DeepSeekResponse, so the rest of the adapter is unchanged. Used
 * for large max_tokens where a non-streaming connection would be fragile.
 */
async function streamChatCompletions(
  baseURL: string,
  apiKey: string,
  body: DeepSeekRequestBody,
  signal?: AbortSignal,
): Promise<DeepSeekResponse> {
  const resp = await sendRequest(baseURL, apiKey, body, signal);
  const stream = resp.body;
  if (!stream) {
    throw new AdapterError("invalid_response", PROTOCOL, "streaming response had no body");
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let usage: DeepSeekUsage | undefined;
  let finishReason: string | undefined;
  let done = false;

  const handleLine = (rawLine: string): void => {
    const line = rawLine.trim();
    if (line === "" || line.startsWith(":")) return; // keep-alive / comment
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") {
      done = true;
      return;
    }
    let chunk: DeepSeekStreamChunk;
    try {
      chunk = JSON.parse(payload) as DeepSeekStreamChunk;
    } catch {
      return; // ignore unparseable chunk
    }
    const choice = chunk.choices?.[0];
    if (choice?.delta) {
      if (typeof choice.delta.content === "string") content += choice.delta.content;
      if (typeof choice.delta.reasoning_content === "string") reasoning += choice.delta.reasoning_content;
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) usage = chunk.usage;
  };

  try {
    while (!done) {
      const { done: readerDone, value } = await reader.read();
      if (readerDone) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        if (done) break;
      }
    }
    if (!done && buffer.length > 0) handleLine(buffer); // trailing partial line
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new AdapterError("aborted", PROTOCOL, "Request aborted", { cause: err });
    }
    throw new AdapterError("network", PROTOCOL, `stream read failed: ${String(err)}`, {
      cause: err,
      retryable: true,
    });
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  return {
    choices: [
      {
        message: { role: "assistant", content, ...(reasoning ? { reasoning_content: reasoning } : {}) },
        ...(finishReason ? { finish_reason: finishReason } : {}),
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

// ─── Request builder ─────────────────────────────────────────────────

function buildRequestBody(input: DecisionInput, profile: LLMProfile): DeepSeekRequestBody {
  const reasoning = input.reasoning ?? profile.reasoning;
  const thinkingEnabled =
    reasoning?.enabled !== false && reasoning?.mode !== "disabled";

  const body: DeepSeekRequestBody = {
    model: profile.model,
    messages: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userPrompt },
    ],
    max_tokens: input.maxTokens,
  };

  if (thinkingEnabled) {
    body.thinking = { type: "enabled" };

    const effort = reasoning?.effort;
    if (effort && effort !== "off") {
      const { value, warning } = mapEffort(effort);
      if (warning) {
        console.warn(`[deepseek-chat-completions] ${warning}`);
      }
      body.reasoning_effort = value;
    } else {
      // Default to max when thinking is enabled but no effort specified.
      body.reasoning_effort = "max";
    }

    // In thinking mode the following params have NO effect — omit them.
    // (temperature, top_p, presence_penalty, frequency_penalty)
    if (input.temperature !== null) {
      console.warn(
        "[deepseek-chat-completions] temperature is ignored in thinking mode",
      );
    }
  } else {
    body.thinking = { type: "disabled" };
    if (input.temperature !== null) {
      body.temperature = input.temperature;
    }
  }

  // DeepSeek strict json_object mode is OPT-IN (off by default). DeepSeek 400s on
  // `response_format: json_object` unless the prompt contains the word "json", and
  // it can return empty content — so we only enable it via the per-model feature
  // flag. The decision prompt usually already asks for JSON; if not, inject a hint
  // so the request is always accepted. Without the flag we rely on the prompt
  // (the model still returns JSON because the prompt instructs it).
  if (profile.features?.jsonObjectMode === true) {
    body.response_format = { type: "json_object" };
    if (!body.messages.some((m) => /json/i.test(m.content))) {
      body.messages[0] = {
        ...body.messages[0],
        content: `${body.messages[0].content}\n\nRespond ONLY with a valid JSON object.`,
      };
    }
  }

  // Streaming mode (user-configurable; chunks are reassembled so callers see no
  // difference). "auto" (default) streams large/reasoning generations that would
  // be fragile over a non-streaming connection; "always"/"never" force it.
  const streamMode = profile.stream ?? "auto";
  const shouldStream =
    streamMode === "always" ||
    (streamMode !== "never" && input.maxTokens > STREAM_MAX_TOKENS_THRESHOLD);
  if (shouldStream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }

  return body;
}

// ─── Adapter ─────────────────────────────────────────────────────────

export function createDeepSeekChatCompletionsAdapter(): LLMAdapter {
  return {
    protocol: PROTOCOL,

    // ── validateProfile ────────────────────────────────────────────

    validateProfile(profile: LLMProfile): ValidationResult {
      const errors: string[] = [];
      const warnings: string[] = [];

      if (profile.protocol !== PROTOCOL) {
        errors.push(`protocol must be "${PROTOCOL}", got "${profile.protocol}"`);
      }
      if (!profile.baseURL) {
        errors.push("baseURL is required");
      }
      if (!profile.apiKey) {
        errors.push("apiKey is required");
      }
      if (!profile.model) {
        errors.push("model is required");
      }

      const knownModels = ["deepseek-v4-pro", "deepseek-v4-flash"];
      if (profile.model && !knownModels.includes(profile.model)) {
        warnings.push(
          `model "${profile.model}" is not in the known list [${knownModels.join(", ")}]; proceeding anyway`,
        );
      }

      const effort = profile.reasoning?.effort;
      if (effort && effort !== "high" && effort !== "max") {
        const { warning } = mapEffort(effort);
        if (warning) warnings.push(warning);
      }

      if (profile.reasoning?.enabled !== false && profile.temperature !== null) {
        warnings.push(
          "temperature is set but will be ignored when thinking mode is enabled",
        );
      }

      return { ok: errors.length === 0, errors, warnings };
    },

    // ── probe ──────────────────────────────────────────────────────

    async probe(profile: LLMProfile): Promise<ProbeResult> {
      const t0 = Date.now();
      // No response_format here: DeepSeek's json_object mode is opt-in (and 400s
      // without "json" in the prompt). The probe just checks connectivity + that
      // the model returns parseable JSON, which the prompt asks for directly.
      const body: DeepSeekRequestBody = {
        model: profile.model,
        messages: [
          {
            role: "user",
            content: 'Reply ONLY with this JSON object and nothing else: {"ok":true}',
          },
        ],
        max_tokens: 64,
        thinking: { type: "disabled" },
      };

      try {
        const data = await postChatCompletions(
          profile.baseURL,
          profile.apiKey,
          body,
        );

        const text = data.choices?.[0]?.message?.content ?? "";
        let jsonValid = false;
        try {
          const parsed = JSON.parse(text) as unknown;
          jsonValid =
            typeof parsed === "object" && parsed !== null && "ok" in parsed;
        } catch {
          jsonValid = false;
        }

        return {
          success: true,
          latencyMs: Date.now() - t0,
          model: profile.model,
          protocol: PROTOCOL,
          jsonValid,
        };
      } catch (err) {
        return {
          success: false,
          latencyMs: Date.now() - t0,
          model: profile.model,
          protocol: PROTOCOL,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    // ── generateDecision ───────────────────────────────────────────

    async generateDecision(
      input: DecisionInput,
      profile: LLMProfile,
    ): Promise<DecisionOutput> {
      const t0 = Date.now();
      const body = buildRequestBody(input, profile);

      const data = body.stream
        ? await streamChatCompletions(profile.baseURL, profile.apiKey, body, input.signal)
        : await postChatCompletions(profile.baseURL, profile.apiKey, body, input.signal);

      const choice = data.choices?.[0];
      if (!choice) {
        throw new AdapterError(
          "invalid_response",
          PROTOCOL,
          "Response contained no choices",
        );
      }

      const text = choice.message?.content ?? "";
      const reasoningSummary = choice.message?.reasoning_content ?? undefined;

      const usage = data.usage;
      const inputTokens = usage?.prompt_tokens;
      const outputTokens = usage?.completion_tokens;
      const reasoningTokens =
        usage?.completion_tokens_details?.reasoning_tokens;
      const cachedTokens = usage?.prompt_cache_hit_tokens; // C2: DeepSeek cache hits

      if (isContentFilterReason(choice.finish_reason)) {
        throw new AdapterError("content_filter", PROTOCOL, "DeepSeek blocked the response (finish_reason: content_filter)");
      }
      const stopReason = normalizeOpenAIFinish(choice.finish_reason);
      const truncated = computeTruncated(stopReason, text, reasoningTokens);

      return {
        text,
        ...(stopReason ? { stopReason } : {}),
        ...(truncated ? { truncated: true } : {}),
        inputTokens,
        outputTokens,
        reasoningTokens,
        cachedTokens,
        latencyMs: Date.now() - t0,
        reasoningSummary,
        raw: data,
      };
    },

    // ── estimateUsage ──────────────────────────────────────────────

    estimateUsage(output: DecisionOutput, profile: LLMProfile): UsageRecord {
      // DeepSeek does not publish per-token pricing in the same way — return
      // undefined cost so the daemon can apply its own pricing table.
      return {
        protocol: PROTOCOL,
        providerLabel: "deepseek",
        model: profile.model,
        inputTokens: output.inputTokens,
        outputTokens: output.outputTokens,
        reasoningTokens: output.reasoningTokens,
        cachedTokens: output.cachedTokens,
        estimatedCostUSD: undefined,
        latencyMs: output.latencyMs,
        timestamp: new Date().toISOString(),
      };
    },

    // ── redact ─────────────────────────────────────────────────────

    redact(raw: unknown): unknown {
      if (typeof raw !== "object" || raw === null) return raw;

      const r = raw as Record<string, unknown>;
      const redacted: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(r)) {
        if (key === "choices" && Array.isArray(value)) {
          // Strip reasoning_content from choices (may contain long CoT).
          redacted[key] = value.map((choice: unknown) => {
            if (typeof choice !== "object" || choice === null) return choice;
            const c = choice as Record<string, unknown>;
            if (typeof c["message"] === "object" && c["message"] !== null) {
              const msg = { ...(c["message"] as Record<string, unknown>) };
              delete msg["reasoning_content"];
              return { ...c, message: msg };
            }
            return c;
          });
        } else {
          redacted[key] = value;
        }
      }

      return redacted;
    },
  };
}
