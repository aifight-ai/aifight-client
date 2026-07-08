import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearAdapters,
  registerBuiltinAdapters,
  requireAdapter,
} from "../src/llm/adapter-registry";
import type { DecisionInput, LLMProfile } from "../src/llm/adapters/types";

// C batch (prompt-cache) adapter tests. Injects globalThis.fetch so no network
// is touched.
//  C1 — the Anthropic request body carries the system prompt as a single text
//       block with a cache_control:{type:"ephemeral"} breakpoint at its end; an
//       empty system prompt omits the field (no empty cache block).
//  C2 — every adapter parses its provider's cached-token usage field (the names
//       fixed in PROMPT_LAYERING_AND_CACHE_SPEC §10.1) into
//       DecisionOutput.cachedTokens, and estimateUsage forwards it to
//       UsageRecord.cachedTokens (what the CLI/desktop usage views display).

function resolved(
  partial: Pick<LLMProfile, "protocol" | "baseURL" | "model"> & Partial<LLMProfile>,
): LLMProfile {
  return {
    profileId: "p",
    displayName: "p",
    apiKey: "sk-test",
    temperature: null,
    maxTokens: 256,
    timeouts: { requestMs: 1000, connectMs: 1000 },
    retries: { maxAttempts: 1, backoffMs: 0 },
    ...partial,
  };
}

function stubFetch(status: number, body: unknown): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const text = JSON.stringify(body);
  const fn = vi.fn(async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      json: async () => JSON.parse(text),
      headers: { get: () => null },
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return { calls };
}

const DECIDE: DecisionInput = {
  systemPrompt: "SYS-PROMPT",
  userPrompt: "usr",
  maxTokens: 64,
  temperature: 0,
  responseFormat: "json",
};

function bodyOf(calls: Array<{ init: RequestInit }>): Record<string, unknown> {
  return JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearAdapters();
});

// ─── C1: Anthropic system cache breakpoint ────────────────────────────

describe("C1 — Anthropic system cache_control breakpoint", () => {
  it("wraps a non-empty system prompt in a single text block with a trailing ephemeral breakpoint", async () => {
    await registerBuiltinAdapters();
    const adapter = requireAdapter("anthropic_messages");
    const { calls } = stubFetch(200, {
      content: [{ type: "text", text: "HELLO" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await adapter.generateDecision(
      DECIDE,
      resolved({ protocol: "anthropic_messages", baseURL: "https://api.anthropic.com", model: "claude-opus-4-8" }),
    );
    const body = bodyOf(calls);
    expect(Array.isArray(body.system)).toBe(true);
    const sys = body.system as Array<Record<string, unknown>>;
    expect(sys.length).toBe(1); // exactly one system block → exactly one breakpoint
    expect(sys[0]).toEqual({
      type: "text",
      text: "SYS-PROMPT",
      cache_control: { type: "ephemeral" },
    });
  });

  it("omits system entirely when the system prompt is empty (no empty cache block)", async () => {
    await registerBuiltinAdapters();
    const adapter = requireAdapter("anthropic_messages");
    const { calls } = stubFetch(200, {
      content: [{ type: "text", text: "HELLO" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await adapter.generateDecision(
      { ...DECIDE, systemPrompt: "" },
      resolved({ protocol: "anthropic_messages", baseURL: "https://api.anthropic.com", model: "claude-opus-4-8" }),
    );
    const body = bodyOf(calls);
    expect("system" in body).toBe(false);
  });
});

// ─── C2: per-provider cached-token parsing ────────────────────────────

interface CacheCase {
  protocol: LLMProfile["protocol"];
  baseURL: string;
  model: string;
  /** Provider response WITH a cache hit — expect cachedTokens === expected. */
  bodyWithCache: unknown;
  /** Provider response with NO cache field — expect cachedTokens undefined. */
  bodyNoCache: unknown;
  expected: number;
  profileExtra?: Partial<LLMProfile>;
}

const CASES: CacheCase[] = [
  {
    // Anthropic: cache_read_input_tokens + cache_creation_input_tokens
    protocol: "anthropic_messages",
    baseURL: "https://api.anthropic.com",
    model: "claude-opus-4-8",
    bodyWithCache: {
      content: [{ type: "text", text: "HELLO" }],
      usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 10 },
    },
    bodyNoCache: { content: [{ type: "text", text: "HELLO" }], usage: { input_tokens: 100, output_tokens: 10 } },
    expected: 100,
  },
  {
    // DeepSeek: prompt_cache_hit_tokens
    protocol: "deepseek_chat_completions",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-chat",
    bodyWithCache: {
      choices: [{ message: { content: "HELLO" } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 64 },
    },
    bodyNoCache: { choices: [{ message: { content: "HELLO" } }], usage: { prompt_tokens: 100, completion_tokens: 10 } },
    expected: 64,
    profileExtra: { stream: "never" },
  },
  {
    // OpenAI Responses: input_tokens_details.cached_tokens (NOT prompt_tokens_details)
    protocol: "openai_responses",
    baseURL: "https://api.openai.com/v1",
    model: "gpt-5",
    bodyWithCache: {
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "HELLO" }] }],
      usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 48 } },
    },
    bodyNoCache: {
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "HELLO" }] }],
      usage: { input_tokens: 100, output_tokens: 10 },
    },
    expected: 48,
  },
  {
    // OpenAI Chat Completions: prompt_tokens_details.cached_tokens
    protocol: "openai_chat_completions",
    baseURL: "https://api.openai.com/v1",
    model: "gpt-4o",
    bodyWithCache: {
      choices: [{ message: { content: "HELLO" } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 32 } },
    },
    bodyNoCache: { choices: [{ message: { content: "HELLO" } }], usage: { prompt_tokens: 100, completion_tokens: 10 } },
    expected: 32,
  },
  {
    // OpenAI-compatible (Grok/Kimi/GLM/MiniMax/Qwen/Gemini-compat): prompt_tokens_details.cached_tokens
    protocol: "openai_chat_compat",
    baseURL: "https://example.test/v1",
    model: "grok-4",
    bodyWithCache: {
      choices: [{ message: { content: "HELLO" } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 16 } },
    },
    bodyNoCache: { choices: [{ message: { content: "HELLO" } }], usage: { prompt_tokens: 100, completion_tokens: 10 } },
    expected: 16,
  },
  {
    // Gemini: usageMetadata.cachedContentTokenCount
    protocol: "gemini_generate_content",
    baseURL: "https://generativelanguage.googleapis.com",
    model: "gemini-2.5-pro",
    bodyWithCache: {
      candidates: [{ content: { parts: [{ text: "HELLO" }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, cachedContentTokenCount: 80 },
    },
    bodyNoCache: {
      candidates: [{ content: { parts: [{ text: "HELLO" }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 },
    },
    expected: 80,
  },
];

describe("C2 — adapters parse provider cached-token fields (§10.1)", () => {
  for (const c of CASES) {
    const profile = () => resolved({ protocol: c.protocol, baseURL: c.baseURL, model: c.model, ...c.profileExtra });

    it(`${c.protocol}: parses cached tokens → ${c.expected} and forwards to the usage record`, async () => {
      await registerBuiltinAdapters();
      const adapter = requireAdapter(c.protocol);
      const p = profile();
      stubFetch(200, c.bodyWithCache);
      const out = await adapter.generateDecision(DECIDE, p);
      expect(out.cachedTokens).toBe(c.expected);
      // estimateUsage must forward it — this is what the CLI/desktop stats show.
      expect(adapter.estimateUsage(out, p).cachedTokens).toBe(c.expected);
    });

    it(`${c.protocol}: cachedTokens is undefined when the provider omits the field`, async () => {
      await registerBuiltinAdapters();
      const adapter = requireAdapter(c.protocol);
      stubFetch(200, c.bodyNoCache);
      const out = await adapter.generateDecision(DECIDE, profile());
      expect(out.cachedTokens).toBeUndefined();
    });
  }
});
