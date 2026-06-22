import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearAdapters,
  registerBuiltinAdapters,
  requireAdapter,
} from "../src/llm/adapter-registry";
import type { LLMProfile } from "../src/llm/adapters/types";

// Adapter HTTP-shape tests (P2 hardening). Injects globalThis.fetch so no
// network is touched. Verifies each adapter: hits the right endpoint with the
// right auth header, extracts the model text, and maps HTTP 401 to a failed
// probe. Adapters had zero unit coverage before this.

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
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearAdapters();
});

const ALL_PROTOCOLS = [
  "anthropic_messages",
  "openai_responses",
  "openai_chat_completions",
  "openai_chat_compat",
  "deepseek_chat_completions",
  "gemini_generate_content",
] as const;

describe("adapter registry", () => {
  it("registers all six builtin protocols", async () => {
    await registerBuiltinAdapters();
    for (const p of ALL_PROTOCOLS) {
      expect(requireAdapter(p).protocol).toBe(p);
    }
  });
});

describe("adapter happy paths (injected fetch)", () => {
  const cases: Array<{
    protocol: LLMProfile["protocol"];
    baseURL: string;
    body: unknown;
    urlIncludes: string;
    authHeader: string;
  }> = [
    {
      protocol: "anthropic_messages",
      baseURL: "https://api.anthropic.com",
      body: { content: [{ type: "text", text: "HELLO" }], usage: { input_tokens: 1, output_tokens: 1 } },
      urlIncludes: "/v1/messages",
      authHeader: "x-api-key",
    },
    {
      protocol: "openai_chat_completions",
      baseURL: "https://api.openai.com/v1",
      body: { choices: [{ message: { content: "HELLO" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      urlIncludes: "/chat/completions",
      authHeader: "authorization",
    },
    {
      protocol: "deepseek_chat_completions",
      baseURL: "https://api.deepseek.com",
      body: { choices: [{ message: { content: "HELLO" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      urlIncludes: "/chat/completions",
      authHeader: "authorization",
    },
    {
      protocol: "openai_chat_compat",
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
      body: { choices: [{ message: { content: "HELLO" } }] },
      urlIncludes: "/chat/completions",
      authHeader: "authorization",
    },
    {
      protocol: "gemini_generate_content",
      baseURL: "https://generativelanguage.googleapis.com",
      body: { candidates: [{ content: { parts: [{ text: "HELLO" }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
      urlIncludes: ":generateContent",
      authHeader: "x-goog-api-key",
    },
  ];

  for (const c of cases) {
    it(`${c.protocol}: extracts text + hits ${c.urlIncludes} with ${c.authHeader}`, async () => {
      await registerBuiltinAdapters();
      const adapter = requireAdapter(c.protocol);
      const { calls } = stubFetch(200, c.body);
      const out = await adapter.generateDecision(
        { systemPrompt: "sys", userPrompt: "usr", maxTokens: 64, temperature: 0, responseFormat: "json" },
        resolved({ protocol: c.protocol, baseURL: c.baseURL, model: "test-model" }),
      );
      expect(out.text).toBe("HELLO");
      expect(calls.length).toBe(1);
      expect(calls[0]!.url).toContain(c.urlIncludes);
      const headers = (calls[0]!.init.headers ?? {}) as Record<string, string>;
      const headerKeys = Object.keys(headers).map((k) => k.toLowerCase());
      expect(headerKeys).toContain(c.authHeader);
    });
  }
});

describe("adapter error paths (HTTP 401 → failed probe)", () => {
  for (const protocol of ALL_PROTOCOLS) {
    it(`${protocol}: 401 yields probe success=false`, async () => {
      await registerBuiltinAdapters();
      const adapter = requireAdapter(protocol);
      stubFetch(401, { error: "unauthorized" });
      const baseURL =
        protocol === "openai_chat_compat"
          ? "https://example.test/v1"
          : protocol === "gemini_generate_content"
            ? "https://generativelanguage.googleapis.com"
            : "https://api.example.test/v1";
      const res = await adapter.probe(resolved({ protocol, baseURL, model: "test-model" }));
      expect(res.success).toBe(false);
      expect(res.protocol).toBe(protocol);
    });
  }
});
