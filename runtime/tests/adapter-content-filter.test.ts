// Batch C — content_filter detection. A 200 response whose native finish/stop/
// safety reason means the model blocked its OWN output must surface as an
// AdapterError of kind "content_filter" (not a mystery invalid_response), so the
// transient loop classifies it non-retryable. Reuses the injected-fetch pattern.

import { afterEach, describe, expect, it, vi } from "vitest";

import { clearAdapters, registerBuiltinAdapters, requireAdapter } from "../src/llm/adapter-registry";
import { AdapterError, type LLMProfile } from "../src/llm/adapters/types";

function resolved(
  partial: Pick<LLMProfile, "protocol" | "baseURL" | "model"> & Partial<LLMProfile>,
): LLMProfile {
  return {
    profileId: "p",
    displayName: "p",
    apiKey: "sk-test",
    temperature: null,
    maxTokens: 64,
    timeouts: { requestMs: 1000, connectMs: 1000 },
    retries: { maxAttempts: 1, backoffMs: 0 },
    ...partial,
  };
}

function stubFetch(status: number, body: unknown): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      text: async () => text,
      json: async () => JSON.parse(text),
    }) as unknown as Response),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearAdapters();
});

const DECIDE = { systemPrompt: "sys", userPrompt: "usr", maxTokens: 64, temperature: 0, responseFormat: "json" } as const;

async function decideErr(protocol: string, baseURL: string, body: unknown) {
  await registerBuiltinAdapters();
  const adapter = requireAdapter(protocol);
  stubFetch(200, body);
  try {
    await adapter.generateDecision(DECIDE, resolved({ protocol: protocol as LLMProfile["protocol"], baseURL, model: "test-model" }));
    return null;
  } catch (e) {
    return e;
  }
}

// A 200 body carrying each provider's content-filter signal.
const CASES: Array<{ protocol: string; baseURL: string; body: unknown }> = [
  {
    protocol: "anthropic_messages",
    baseURL: "https://api.anthropic.com",
    body: { content: [{ type: "text", text: "I can't help with that." }], usage: { input_tokens: 1, output_tokens: 5 }, stop_reason: "refusal" },
  },
  {
    protocol: "openai_chat_completions",
    baseURL: "https://api.openai.com/v1",
    body: { choices: [{ message: { content: "" }, finish_reason: "content_filter" }], usage: {} },
  },
  {
    protocol: "openai_chat_compat",
    baseURL: "https://api.example.com/v1",
    body: { choices: [{ message: { content: "" }, finish_reason: "content_filter" }] },
  },
  {
    protocol: "deepseek_chat_completions",
    baseURL: "https://api.deepseek.com",
    body: { choices: [{ message: { content: "" }, finish_reason: "content_filter" }], usage: { prompt_tokens: 1, completion_tokens: 0 } },
  },
  {
    protocol: "gemini_generate_content",
    baseURL: "https://generativelanguage.googleapis.com",
    body: { candidates: [{ finishReason: "SAFETY", content: { parts: [{ text: "" }] } }] },
  },
  {
    protocol: "openai_responses",
    baseURL: "https://api.openai.com/v1",
    body: { status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [] },
  },
];

describe("adapter content_filter detection (Batch C)", () => {
  for (const c of CASES) {
    it(`${c.protocol}: a blocked-output response → AdapterError kind content_filter`, async () => {
      const err = await decideErr(c.protocol, c.baseURL, c.body);
      expect(err, c.protocol).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).kind, c.protocol).toBe("content_filter");
      // content_filter defaults to non-retryable (isRetryableKind false).
      expect((err as AdapterError).retryable, c.protocol).toBe(false);
    });
  }

  it("gemini: a top-level promptFeedback.blockReason also counts", async () => {
    const err = await decideErr("gemini_generate_content", "https://generativelanguage.googleapis.com", {
      promptFeedback: { blockReason: "SAFETY" },
      candidates: [],
    });
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).kind).toBe("content_filter");
  });

  it("gemini: a RECITATION (copyright) finishReason is a content_filter", async () => {
    const err = await decideErr("gemini_generate_content", "https://generativelanguage.googleapis.com", {
      candidates: [{ finishReason: "RECITATION", content: { parts: [{ text: "" }] } }],
    });
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).kind).toBe("content_filter");
  });
});
