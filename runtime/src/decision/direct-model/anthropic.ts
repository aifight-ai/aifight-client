// M1-11 direct-model: Anthropic Messages API client.
//
// POST ${baseURL}/v1/messages with x-api-key + anthropic-version
// headers. The system prompt maps to the top-level `system` field;
// the user prompt becomes a single "user" message. On 200 OK we
// return parsed text + token usage; otherwise we throw a typed
// DirectModelError per the rev2 contract.
//
// Internal-only — no root re-export. M1-14 decision/provider.ts
// will dispatch to this factory by strategyProfile.provider.

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

const PROVIDER: DirectModelProviderName = "anthropic";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_VERSION = "2023-06-01";

export interface AnthropicClientOptions {
  readonly apiKey: string;
  readonly model: string;
  /** Default "https://api.anthropic.com". Trailing slashes are stripped. */
  readonly baseURL?: string;
  /** Default "2023-06-01" (current Messages API). */
  readonly anthropicVersion?: string;
  /** Test injection point. Defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
}

export function createAnthropicClient(opts: AnthropicClientOptions): DirectModelClient {
  if (!opts.apiKey) {
    throw new DirectModelUnsupportedError(PROVIDER, "apiKey", "apiKey must be a non-empty string");
  }
  if (!opts.model) {
    throw new DirectModelUnsupportedError(PROVIDER, "model", "model must be a non-empty string");
  }

  const apiKey = opts.apiKey;
  const model = opts.model;
  const baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const anthropicVersion = opts.anthropicVersion ?? DEFAULT_VERSION;
  const fetchImpl: typeof fetch | undefined = opts.fetchImpl ?? globalThis.fetch;

  if (typeof fetchImpl !== "function") {
    throw new DirectModelUnsupportedError(
      PROVIDER,
      "fetchImpl",
      "fetch is unavailable; pass fetchImpl explicitly",
    );
  }

  const url = `${baseURL}/v1/messages`;
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

    const body: Record<string, unknown> = {
      model,
      system: req.systemPrompt,
      messages: [{ role: "user", content: req.userPrompt }],
      max_tokens: req.maxTokens,
    };
    if (req.temperature !== undefined) {
      body.temperature = req.temperature;
    }

    const headers: Record<string, string> = {
      "x-api-key": apiKey,
      "anthropic-version": anthropicVersion,
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
        throw new DirectModelAbortedError(PROVIDER, "request aborted", cause);
      }
      // Defensive redact: lower-layer fetch errors don't normally include
      // apiKey, but if a custom fetchImpl echoes headers we still honor
      // the redaction contract (rev2 #17). cause stays raw (rev2 #19).
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
        `Anthropic returned HTTP ${response.status}`,
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
        "response missing content[0].text or content[0].type !== 'text'",
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
// versions the abort surface uses name="AbortError" and/or code="ABORT_ERR"
// (legacy DOMException code 20). Avoid `instanceof DOMException` so we
// don't bind to a specific runtime.
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
  const content = parsed.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const first = content[0];
  if (!isObject(first)) return null;
  if (first.type !== "text") return null;
  const text = first.text;
  if (typeof text !== "string") return null;
  return text;
}

function extractTokens(parsed: unknown): {
  inputTokens?: number;
  outputTokens?: number;
} {
  if (!isObject(parsed)) return {};
  const usage = parsed.usage;
  if (!isObject(usage)) return {};
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  return {
    inputTokens: typeof inputTokens === "number" ? inputTokens : undefined,
    outputTokens: typeof outputTokens === "number" ? outputTokens : undefined,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
