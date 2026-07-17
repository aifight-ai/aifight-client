import { afterEach, describe, expect, it, vi } from "vitest";

import { clearAdapters, registerBuiltinAdapters, requireAdapter } from "../src/llm/adapter-registry";
import type { CanonicalReasoningConfig, LLMProfile } from "../src/llm/adapters/types";
import { resolveLLMProfile } from "../src/llm/resolve-profile";
import type { LLMProfile as ConfigLLMProfile } from "../src/profile/config-schema";

// P2.5 — LLM reasoning-parameter compatibility. Verifies:
//  - config.json `thinking` is mapped into the canonical reasoning config
//  - the Anthropic adapter emits the CURRENT adaptive shape for new models
//    (Opus 4.6/4.7/4.8) and the LEGACY enabled+budget_tokens shape for older
//    models (4.5) — never sending type:"enabled" to a 4.7/4.8 (would 400).

function resolved(model: string): LLMProfile {
  return {
    profileId: "p",
    displayName: "p",
    protocol: "anthropic_messages",
    baseURL: "https://api.anthropic.com",
    model,
    apiKey: "sk",
    temperature: 0.7,
    maxTokens: 1024,
    timeouts: { requestMs: 1000 },
    retries: { maxAttempts: 1 },
  };
}

function stubAnthropic(): { body: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: unknown) => {
      captured = JSON.parse((init as { body: string }).body);
      const text = JSON.stringify({ content: [{ type: "text", text: "OK" }], usage: { input_tokens: 1, output_tokens: 1 } });
      return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) } as unknown as Response;
    }),
  );
  return { body: () => captured };
}

async function callAnthropic(model: string, reasoning: CanonicalReasoningConfig, temperature: number | null) {
  await registerBuiltinAdapters();
  const adapter = requireAdapter("anthropic_messages");
  const cap = stubAnthropic();
  await adapter.generateDecision(
    { systemPrompt: "s", userPrompt: "u", maxTokens: 1024, temperature, reasoning },
    resolved(model),
  );
  return cap.body();
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearAdapters();
});

describe("resolveLLMProfile: thinking -> reasoning mapping", () => {
  it("maps config thinking into canonical reasoning", () => {
    const def: ConfigLLMProfile = {
      protocol: "anthropic_messages",
      apiKeyRef: { type: "env", name: "X" },
      model: "claude-opus-4-8",
      thinking: { enabled: true, mode: "always", effort: "high", maxReasoningTokens: 5000 },
    };
    const r = resolveLLMProfile("p", def, "sk").reasoning;
    expect(r).toBeDefined();
    expect(r!.enabled).toBe(true);
    expect(r!.mode).toBe("enabled"); // config "always" -> canonical "enabled"
    expect(r!.effort).toBe("high");
    expect(r!.budgetTokens).toBe(5000);
  });

  it('maps mode "never" -> "disabled"', () => {
    const def: ConfigLLMProfile = {
      protocol: "anthropic_messages",
      apiKeyRef: { type: "env", name: "X" },
      model: "m",
      thinking: { enabled: false, mode: "never" },
    };
    expect(resolveLLMProfile("p", def, "sk").reasoning!.mode).toBe("disabled");
  });
});

describe("anthropic adapter: new/old thinking compatibility", () => {
  it("Opus 4.8 + effort high -> adaptive thinking + output_config, no temperature", async () => {
    const b = await callAnthropic("claude-opus-4-8", { enabled: true, effort: "high" }, 0.7);
    expect(b.thinking).toEqual({ type: "adaptive", display: "omitted" });
    expect(b.output_config).toEqual({ effort: "high" });
    expect(b.temperature).toBeUndefined();
  });

  it("Opus 4.8 + effort max -> output_config.effort max", async () => {
    const b = await callAnthropic("claude-opus-4-8", { enabled: true, effort: "max" }, null);
    expect(b.output_config).toEqual({ effort: "max" });
  });

  it("xhigh stays xhigh on Opus 4.8 (supported)", async () => {
    const b = await callAnthropic("claude-opus-4-8", { enabled: true, effort: "xhigh" }, null);
    expect(b.output_config).toEqual({ effort: "xhigh" });
  });

  it("xhigh clamps to high on Opus 4.6 (xhigh only valid on 4.7/4.8)", async () => {
    const b = await callAnthropic("claude-opus-4-6", { enabled: true, effort: "xhigh" }, null);
    expect(b.output_config).toEqual({ effort: "high" });
  });

  it("xhigh clamps to high on Sonnet 4.6", async () => {
    const b = await callAnthropic("claude-sonnet-4-6", { enabled: true, effort: "xhigh" }, null);
    expect(b.output_config).toEqual({ effort: "high" });
  });

  it("legacy Opus 4.5 + reasoning -> enabled + budget_tokens (never adaptive)", async () => {
    const b = await callAnthropic("claude-opus-4-5", { enabled: true, budgetTokens: 2000 }, 0.5);
    expect(b.thinking).toEqual({ type: "enabled", budget_tokens: 2000 });
    expect(b.output_config).toBeUndefined();
    expect(b.temperature).toBeUndefined();
  });

  it("legacy budget clamps to >= 1024", async () => {
    const b = await callAnthropic("claude-sonnet-4-5", { enabled: true, budgetTokens: 100 }, null);
    expect(b.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });

  it("reasoning disabled -> no thinking, temperature sent (valid on 4.8)", async () => {
    const b = await callAnthropic("claude-opus-4-8", { enabled: false }, 0.3);
    expect(b.thinking).toBeUndefined();
    expect(b.temperature).toBe(0.3);
  });
});

// ── Gemini per-model thinking (gemini-2.5* thinkingBudget / gemini-3* thinkingLevel) ──

function resolvedGemini(model: string): LLMProfile {
  return {
    profileId: "g",
    displayName: "g",
    protocol: "gemini_generate_content",
    baseURL: "https://generativelanguage.googleapis.com",
    model,
    apiKey: "k",
    temperature: 0.7,
    maxTokens: 1024,
    timeouts: { requestMs: 1000 },
    retries: { maxAttempts: 1 },
  };
}

function stubGemini(): { body: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: unknown) => {
      captured = JSON.parse((init as { body: string }).body);
      const text = JSON.stringify({
        candidates: [{ content: { parts: [{ text: "OK" }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      });
      return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) } as unknown as Response;
    }),
  );
  return { body: () => captured };
}

async function callGemini(model: string, reasoning: CanonicalReasoningConfig | undefined) {
  await registerBuiltinAdapters();
  const adapter = requireAdapter("gemini_generate_content");
  const cap = stubGemini();
  await adapter.generateDecision(
    { systemPrompt: "s", userPrompt: "u", maxTokens: 1024, temperature: 0.7, reasoning },
    resolvedGemini(model),
  );
  return cap.body();
}

function genConfig(body: Record<string, unknown>): Record<string, unknown> {
  return body.generationConfig as Record<string, unknown>;
}

describe("gemini adapter: per-model thinking", () => {
  it("gemini-2.5* + effort high -> thinkingConfig.thinkingBudget (token count)", async () => {
    const b = await callGemini("gemini-2.5-pro", { enabled: true, effort: "high" });
    expect(genConfig(b).thinkingConfig).toEqual({ thinkingBudget: 16384 });
  });

  it("gemini-2.5* honors an explicit thinkingBudget", async () => {
    const b = await callGemini("gemini-2.5-flash", { enabled: true, thinkingBudget: 5000 });
    expect(genConfig(b).thinkingConfig).toEqual({ thinkingBudget: 5000 });
  });

  it("gemini-3* + effort high -> thinkingConfig.thinkingLevel", async () => {
    const b = await callGemini("gemini-3-pro", { enabled: true, effort: "high" });
    expect(genConfig(b).thinkingConfig).toEqual({ thinkingLevel: "high" });
  });

  it("gemini-3* honors an explicit thinkingLevel", async () => {
    const b = await callGemini("gemini-3-pro", { enabled: true, thinkingLevel: "low" });
    expect(genConfig(b).thinkingConfig).toEqual({ thinkingLevel: "low" });
  });

  it("non-thinking Gemini (2.0) ignores reasoning -> no thinkingConfig", async () => {
    const b = await callGemini("gemini-2.0-flash", { enabled: true, effort: "high" });
    expect(genConfig(b).thinkingConfig).toBeUndefined();
  });

  it("reasoning disabled -> no thinkingConfig", async () => {
    const b = await callGemini("gemini-2.5-pro", { enabled: false });
    expect(genConfig(b).thinkingConfig).toBeUndefined();
  });

  it("validateProfile warns when thinking is requested on a non-thinking Gemini model", async () => {
    await registerBuiltinAdapters();
    const adapter = requireAdapter("gemini_generate_content");
    const profile = { ...resolvedGemini("gemini-2.0-flash"), reasoning: { enabled: true, effort: "high" } as CanonicalReasoningConfig };
    const result = adapter.validateProfile(profile);
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => /not a known thinking-capable/i.test(w))).toBe(true);
  });
});

// ── OpenAI Responses verbosity (GPT-5.x text.verbosity) ──

function resolvedResponses(model: string, verbosity?: "low" | "medium" | "high"): LLMProfile {
  return {
    profileId: "o",
    displayName: "o",
    protocol: "openai_responses",
    baseURL: "https://api.openai.com/v1",
    model,
    apiKey: "sk",
    temperature: null,
    maxTokens: 1024,
    ...(verbosity !== undefined ? { verbosity } : {}),
    timeouts: { requestMs: 1000 },
    retries: { maxAttempts: 1 },
  };
}

async function callResponses(profile: LLMProfile) {
  await registerBuiltinAdapters();
  const adapter = requireAdapter("openai_responses");
  let captured: Record<string, unknown> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: unknown) => {
      captured = JSON.parse((init as { body: string }).body);
      const text = JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }], usage: {} });
      return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) } as unknown as Response;
    }),
  );
  await adapter.generateDecision(
    { systemPrompt: "s", userPrompt: "u", maxTokens: 1024, temperature: null, reasoning: { enabled: true, effort: "medium" } },
    profile,
  );
  return captured;
}

describe("openai responses adapter: verbosity", () => {
  it("sends text.verbosity when set", async () => {
    const b = await callResponses(resolvedResponses("gpt-5.5", "low"));
    expect(b.text).toEqual({ verbosity: "low" });
  });

  it("omits text.verbosity when unset", async () => {
    const b = await callResponses(resolvedResponses("gpt-5.5"));
    expect(b.text).toBeUndefined();
  });
});
