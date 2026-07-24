import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearAdapters,
  registerBuiltinAdapters,
  requireAdapter,
} from "../src/llm/adapter-registry";
import type { LLMProfile } from "../src/llm/adapters/types";
import { redactApiKey, boundedErrorBody } from "../src/llm/adapters/redact";

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
    timeouts: { requestMs: 1000 },
    retries: { maxAttempts: 1 },
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
      headers: { get: (_key: string): string | null => null },
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

// R13 F-09: a provider error body can echo the API key back and be arbitrarily
// large. Whichever field an adapter surfaces it in (AdapterError message OR
// cause), the raw key must never appear, "[REDACTED]" must replace it, and the
// body must be length-capped (512).
describe("provider error bodies are redacted + length-capped (R13 F-09)", () => {
  const LEAK_KEY = "sk-LEAK-abcdef0123456789";
  // Body literally contains the key, plus a long marker run to prove capping.
  const errorBody = { error: { message: `invalid api key ${LEAK_KEY} rejected` }, pad: "Z".repeat(2000) };

  const cases: Array<{ protocol: LLMProfile["protocol"]; baseURL: string }> = [
    { protocol: "anthropic_messages", baseURL: "https://api.anthropic.com" },
    { protocol: "openai_responses", baseURL: "https://api.openai.com/v1" },
    { protocol: "openai_chat_completions", baseURL: "https://api.openai.com/v1" },
    { protocol: "openai_chat_compat", baseURL: "https://example.test/v1" },
    { protocol: "deepseek_chat_completions", baseURL: "https://api.deepseek.com" },
    { protocol: "gemini_generate_content", baseURL: "https://generativelanguage.googleapis.com" },
  ];

  for (const c of cases) {
    it(`${c.protocol}: 400 error body never leaks the key and is capped`, async () => {
      await registerBuiltinAdapters();
      const adapter = requireAdapter(c.protocol);
      stubFetch(400, errorBody);

      let err: unknown;
      try {
        await adapter.generateDecision(
          { systemPrompt: "sys", userPrompt: "usr", maxTokens: 64, temperature: 0, responseFormat: "json" },
          resolved({ protocol: c.protocol, baseURL: c.baseURL, model: "test-model", apiKey: LEAK_KEY }),
        );
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(Error);
      const e = err as { message: string; cause?: unknown };
      const combined = `${e.message} ${typeof e.cause === "string" ? e.cause : ""}`;
      // The raw key must be gone, replaced by the redaction marker.
      expect(combined).not.toContain(LEAK_KEY);
      expect(combined).toContain("[REDACTED]");
      // Length cap: an uncapped body would carry all 2000 marker chars.
      const markerCount = (combined.match(/Z/g) ?? []).length;
      expect(markerCount).toBeLessThanOrEqual(512);
      expect(markerCount).toBeGreaterThan(0); // proves the body was actually surfaced
    });
  }
});

describe("redact helpers (R13 F-09)", () => {
  it("redactApiKey replaces every occurrence and is a no-op for an empty key", () => {
    expect(redactApiKey("a KEY b KEY c", "KEY")).toBe("a [REDACTED] b [REDACTED] c");
    expect(redactApiKey("nothing to do", "")).toBe("nothing to do");
  });

  it("boundedErrorBody redacts then caps to max length", () => {
    const out = boundedErrorBody(`prefix SECRET ${"x".repeat(1000)}`, "SECRET", 32);
    expect(out.length).toBe(32);
    expect(out).not.toContain("SECRET");
    expect(out.startsWith("prefix [REDACTED]")).toBe(true);
  });
});

// 2026-07-19: Gemini-protocol gateways/proxies can return thought-summary parts
// (thought: true) even though the runtime never requests includeThoughts. Those
// parts are chain-of-thought — joining them into the reply surfaced the model's
// reasoning as its answer. They must be skipped unconditionally.
describe("gemini_generate_content: unsolicited thought parts are never the answer", () => {
  const GEMINI_BASE = "https://generativelanguage.googleapis.com";
  const input = { systemPrompt: "sys", userPrompt: "usr", maxTokens: 64, temperature: 0, responseFormat: "json" } as const;

  it("skips thought parts and returns only the answer part", async () => {
    await registerBuiltinAdapters();
    const adapter = requireAdapter("gemini_generate_content");
    stubFetch(200, {
      candidates: [
        {
          content: {
            parts: [
              { text: "**My Reasoning Process** weighing the greeting", thought: true },
              { text: "HELLO" },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });
    const out = await adapter.generateDecision(
      input,
      resolved({ protocol: "gemini_generate_content", baseURL: GEMINI_BASE, model: "test-model" }),
    );
    expect(out.text).toBe("HELLO");
  });

  it("thought-only response is a missing-text error, not a thought reply", async () => {
    await registerBuiltinAdapters();
    const adapter = requireAdapter("gemini_generate_content");
    stubFetch(200, {
      candidates: [{ content: { parts: [{ text: "only private thoughts here", thought: true }] } }],
    });
    await expect(
      adapter.generateDecision(
        input,
        resolved({ protocol: "gemini_generate_content", baseURL: GEMINI_BASE, model: "test-model" }),
      ),
    ).rejects.toThrow(/missing/);
  });
});

// 2026-07-19: Gemini bills thinking tokens as output but reports them in a
// separate usageMetadata field (thoughtsTokenCount). Reading only
// candidatesTokenCount under-counted a reasoning model's output massively.
describe("gemini_generate_content: thoughtsTokenCount folds into outputTokens", () => {
  const GEMINI_BASE = "https://generativelanguage.googleapis.com";
  const input = { systemPrompt: "sys", userPrompt: "usr", maxTokens: 64, temperature: 0, responseFormat: "json" } as const;

  it("output usage = candidates + thoughts", async () => {
    await registerBuiltinAdapters();
    const adapter = requireAdapter("gemini_generate_content");
    stubFetch(200, {
      candidates: [{ content: { parts: [{ text: "HELLO" }] } }],
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, thoughtsTokenCount: 93, cachedContentTokenCount: 3 },
    });
    const out = await adapter.generateDecision(
      input,
      resolved({ protocol: "gemini_generate_content", baseURL: GEMINI_BASE, model: "test-model" }),
    );
    expect(out.inputTokens).toBe(11);
    expect(out.outputTokens).toBe(100);
    expect(out.cachedTokens).toBe(3);
  });

  it("no thoughtsTokenCount → unchanged candidates-only accounting", async () => {
    await registerBuiltinAdapters();
    const adapter = requireAdapter("gemini_generate_content");
    stubFetch(200, {
      candidates: [{ content: { parts: [{ text: "HELLO" }] } }],
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 },
    });
    const out = await adapter.generateDecision(
      input,
      resolved({ protocol: "gemini_generate_content", baseURL: GEMINI_BASE, model: "test-model" }),
    );
    expect(out.outputTokens).toBe(7);
  });
});
