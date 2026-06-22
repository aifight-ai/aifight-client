// M1-11 direct-model: OpenAI Chat Completions API client.
//
// POST ${baseURL}/chat/completions with Authorization Bearer header.
// systemPrompt / userPrompt map to messages[0] / messages[1] (system
// + user roles). Body uses `max_completion_tokens` (rev 2 拍板点 #18)
// — explicitly NOT `max_tokens`, which is deprecated for newer model
// families (GPT-5 / o-series). On 200 OK we return parsed text +
// token usage; otherwise typed DirectModelError per the rev 2 contract.
//
// Internal-only — no root re-export. M1-14 decision/provider.ts will
// dispatch to this factory by strategyProfile.provider.

import {
  DirectModelAbortedError,
  DirectModelHttpError,
  DirectModelInvalidResponseError,
  DirectModelNetworkError,
  DirectModelUnsupportedError,
  redactSecrets,
  sanitizeSnippet,
} from "./errors";
import type {
  DirectModelClient,
  DirectModelGenerateRequest,
  DirectModelGenerateResponse,
  DirectModelProviderName,
} from "./types";

const PROVIDER: DirectModelProviderName = "openai";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface OpenAIClientOptions {
  readonly apiKey: string;
  readonly model: string;
  /** Default "https://api.openai.com/v1". Trailing slashes stripped. */
  readonly baseURL?: string;
  /** Optional OpenAI-Organization header. */
  readonly organization?: string;
  /** Test injection point. Defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
}

export function createOpenAIClient(opts: OpenAIClientOptions): DirectModelClient {
  if (!opts.apiKey) {
    throw new DirectModelUnsupportedError(PROVIDER, "apiKey", "apiKey must be a non-empty string");
  }
  if (!opts.model) {
    throw new DirectModelUnsupportedError(PROVIDER, "model", "model must be a non-empty string");
  }

  const apiKey = opts.apiKey;
  const model = opts.model;
  const baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const organization = opts.organization;
  const fetchImpl: typeof fetch | undefined = opts.fetchImpl ?? globalThis.fetch;

  if (typeof fetchImpl !== "function") {
    throw new DirectModelUnsupportedError(
      PROVIDER,
      "fetchImpl",
      "fetch is unavailable; pass fetchImpl explicitly",
    );
  }

  const url = `${baseURL}/chat/completions`;
  const secrets = [apiKey];

  const generate = async (
    req: DirectModelGenerateRequest,
  ): Promise<DirectModelGenerateResponse> => {
    if (!Number.isFinite(req.maxTokens) || req.maxTokens <= 0) {
      throw new DirectModelUnsupportedError(
        PROVIDER,
        "maxTokens",
        "maxTokens must be a positive integer",
      );
    }

    const signal = req.signal;
    if (signal?.aborted) {
      throw new DirectModelAbortedError(
        PROVIDER,
        "request aborted before send",
        signal.reason,
      );
    }

    // rev 2 拍板点 #18: OpenAI body uses `max_completion_tokens`
    // (NOT `max_tokens`). Deliberate single-field choice — no
    // model-family branch so strategyProfile upgrades stay simple.
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: req.systemPrompt },
        { role: "user", content: req.userPrompt },
      ],
      max_completion_tokens: req.maxTokens,
    };
    if (req.temperature !== undefined) {
      body.temperature = req.temperature;
    }

    const headers: Record<string, string> = {
      "Authorization": `Bearer ${apiKey}`,
      "content-type": "application/json",
    };
    if (organization) {
      headers["OpenAI-Organization"] = organization;
    }

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
        throw new DirectModelAbortedError(PROVIDER, "request aborted", cause);
      }
      // Defensive redact: lower-layer fetch errors don't normally include
      // apiKey, but if a custom fetchImpl echoes headers we still honor
      // the redaction contract (rev 2 #17). cause stays raw (rev 2 #19).
      const safeDesc = redactSecrets(describeError(cause), secrets);
      throw new DirectModelNetworkError(PROVIDER, `fetch failed: ${safeDesc}`, cause);
    }

    const latencyMs = Math.max(0, performance.now() - start);

    if (!response.ok) {
      const rawBody = await safeReadText(response);
      const bodySnippet = sanitizeSnippet(rawBody, secrets);
      throw new DirectModelHttpError(
        PROVIDER,
        response.status,
        `OpenAI returned HTTP ${response.status}`,
        bodySnippet,
        response,
      );
    }

    const rawText = await safeReadText(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (cause) {
      throw new DirectModelInvalidResponseError(
        PROVIDER,
        "response body is not valid JSON",
        sanitizeSnippet(rawText, secrets),
        cause,
      );
    }

    const text = extractText(parsed);
    if (text === null) {
      throw new DirectModelInvalidResponseError(
        PROVIDER,
        "response missing choices[0].message.content (or content is not a string)",
        sanitizeSnippet(rawText, secrets),
      );
    }

    const { inputTokens, outputTokens } = extractTokens(parsed);

    return {
      text,
      inputTokens,
      outputTokens,
      latencyMs,
      raw: parsed,
    };
  };

  return {
    provider: PROVIDER,
    model,
    generate,
  };
}

// ─── helpers ────────────────────────────────────────────────────────

// Duck-type AbortError detection: across Node / undici / DOMException
// versions the abort surface uses name="AbortError" and/or
// code="ABORT_ERR" (legacy DOMException code 20). Avoid
// `instanceof DOMException` so we don't bind to a specific runtime.
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

function extractText(parsed: unknown): string | null {
  if (!isObject(parsed)) return null;
  const choices = parsed.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!isObject(first)) return null;
  const message = first.message;
  if (!isObject(message)) return null;
  const content = message.content;
  if (typeof content !== "string") return null;
  return content;
}

function extractTokens(parsed: unknown): {
  inputTokens?: number;
  outputTokens?: number;
} {
  if (!isObject(parsed)) return {};
  const usage = parsed.usage;
  if (!isObject(usage)) return {};
  const promptTokens = usage.prompt_tokens;
  const completionTokens = usage.completion_tokens;
  return {
    inputTokens: typeof promptTokens === "number" ? promptTokens : undefined,
    outputTokens: typeof completionTokens === "number" ? completionTokens : undefined,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
