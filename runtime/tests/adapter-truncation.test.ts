// Batch 0 — per-adapter truncation signal wiring. Each adapter must surface
// stopReason / truncated on DecisionOutput, and tokenLimit on a max_tokens 400.
// Reuses the injected-fetch pattern from llm-adapters.test.ts (no network).

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

async function decide(protocol: string, baseURL: string, status: number, body: unknown) {
  await registerBuiltinAdapters();
  const adapter = requireAdapter(protocol);
  stubFetch(status, body);
  return adapter.generateDecision(DECIDE, resolved({ protocol: protocol as LLMProfile["protocol"], baseURL, model: "test-model" }));
}

// (protocol, baseURL, truncated-body, normal-body)
const CASES: Array<{ protocol: string; baseURL: string; truncatedBody: unknown; normalBody: unknown }> = [
  {
    protocol: "anthropic_messages",
    baseURL: "https://api.anthropic.com",
    truncatedBody: { content: [{ type: "text", text: "partial" }], usage: { input_tokens: 1, output_tokens: 64 }, stop_reason: "max_tokens" },
    normalBody: { content: [{ type: "text", text: "done" }], usage: { input_tokens: 1, output_tokens: 2 }, stop_reason: "end_turn" },
  },
  {
    protocol: "openai_chat_completions",
    baseURL: "https://api.openai.com/v1",
    truncatedBody: { choices: [{ message: { content: "partial" }, finish_reason: "length" }], usage: {} },
    normalBody: { choices: [{ message: { content: "done" }, finish_reason: "stop" }], usage: {} },
  },
  {
    protocol: "openai_chat_compat",
    baseURL: "https://api.example.com/v1",
    truncatedBody: { choices: [{ message: { content: "partial" }, finish_reason: "length" }] },
    normalBody: { choices: [{ message: { content: "done" }, finish_reason: "stop" }] },
  },
  {
    protocol: "deepseek_chat_completions",
    baseURL: "https://api.deepseek.com",
    truncatedBody: { choices: [{ message: { content: "partial" }, finish_reason: "length" }], usage: { prompt_tokens: 1, completion_tokens: 64 } },
    normalBody: { choices: [{ message: { content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2 } },
  },
  {
    protocol: "openai_responses",
    baseURL: "https://api.openai.com/v1",
    truncatedBody: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "message", content: [{ type: "output_text", text: "partial" }] }], usage: {} },
    normalBody: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }], usage: {} },
  },
  {
    protocol: "gemini_generate_content",
    baseURL: "https://generativelanguage.googleapis.com",
    truncatedBody: { candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "MAX_TOKENS" }], usageMetadata: {} },
    normalBody: { candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }], usageMetadata: {} },
  },
];

describe("adapter truncation signal (Batch 0)", () => {
  for (const c of CASES) {
    it(`${c.protocol}: max_tokens stop → stopReason max_tokens + truncated`, async () => {
      const out = await decide(c.protocol, c.baseURL, 200, c.truncatedBody);
      expect(out.stopReason, c.protocol).toBe("max_tokens");
      expect(out.truncated, c.protocol).toBe(true);
    });

    it(`${c.protocol}: normal stop → stopReason stop, not truncated`, async () => {
      const out = await decide(c.protocol, c.baseURL, 200, c.normalBody);
      expect(out.stopReason, c.protocol).toBe("stop");
      expect(out.truncated, c.protocol).toBeFalsy();
    });

    it(`${c.protocol}: a token-limit 400 sets AdapterError.tokenLimit`, async () => {
      await expect(
        decide(c.protocol, c.baseURL, 400, { error: { message: "max_tokens: 200000 > 128000, the maximum" } }),
      ).rejects.toMatchObject({ tokenLimit: true });
    });

    it(`${c.protocol}: an unrelated 400 does NOT set tokenLimit`, async () => {
      const err = await decide(c.protocol, c.baseURL, 400, { error: { message: "invalid api key" } }).catch((e) => e);
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).tokenLimit, c.protocol).toBe(false);
    });
  }

  it("deepseek: empty text + reasoning tokens (thinking ate budget) → truncated", async () => {
    const out = await decide("deepseek_chat_completions", "https://api.deepseek.com", 200, {
      choices: [{ message: { content: "" }, finish_reason: "length" }],
      usage: { prompt_tokens: 1, completion_tokens: 64, completion_tokens_details: { reasoning_tokens: 64 } },
    });
    expect(out.truncated).toBe(true);
  });

  it("anthropic: empty text throws with tokenLimit when stop_reason max_tokens", async () => {
    const err = await decide("anthropic_messages", "https://api.anthropic.com", 200, {
      content: [], usage: { input_tokens: 1, output_tokens: 64 }, stop_reason: "max_tokens",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).tokenLimit).toBe(true);
  });

  it("stopReason is absent when the provider omits finish_reason", async () => {
    const out = await decide("openai_chat_completions", "https://api.openai.com/v1", 200, {
      choices: [{ message: { content: "done" } }], usage: {},
    });
    expect(out.stopReason).toBeUndefined();
    expect(out.truncated).toBeFalsy();
  });
});
