import { afterEach, describe, expect, it, vi } from "vitest";

import { clearAdapters, registerBuiltinAdapters, requireAdapter } from "../src/llm/adapter-registry";
import type { CanonicalReasoningConfig, LLMProfile } from "../src/llm/adapters/types";
import { loadCapabilityRegistry } from "../src/llm/capabilities/validate-capabilities";
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

// B5. Which thinking parameter a Gemini model takes is declared once, as
// `thinkingParam` in model-capabilities.json. The adapter used to decide it again
// with its own id regexes — a second hand-maintained discriminator, which is the
// shape of drift that misclassified the whole Claude 5 family. The regexes are now
// only the unlisted-model fallback, and this walks the registry to prove the
// declared parameter is the one that actually reaches the wire: a future entry the
// adapter does not honour fails here instead of shipping.
describe("gemini adapter: the registry decides the thinking parameter", () => {
  // Turn a registry pattern into an id that matches it (same trick as Go's
  // repModelID in compat_contract_test.go).
  function representativeId(pattern: string): string {
    return pattern
      .replace(/^\^/, "")
      .replace(/\\\./g, ".")
      .replace(/\.\*/g, "-x-")
      .replace(/\(([^)|]+)(\|[^)]*)?\)/g, "$1");
  }

  it("every listed gemini model emits the parameter its entry declares", async () => {
    const models = loadCapabilityRegistry().protocols["gemini_generate_content"]?.models ?? [];
    expect(models.length).toBeGreaterThan(0);
    for (const entry of models) {
      if (entry.thinkingParam === undefined) continue;
      const id = representativeId(entry.pattern);
      const body = await callGemini(id, { enabled: true, effort: "high" });
      const thinking = genConfig(body).thinkingConfig as Record<string, unknown>;
      expect(Object.keys(thinking), `${id} (pattern ${entry.pattern})`).toEqual([entry.thinkingParam]);
    }
  });
});

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

  it("gemini-3 Pro clamps minimal to low (Pro rejects minimal; matches Go NormalizeGeminiThinkingLevel)", async () => {
    const b = await callGemini("gemini-3.1-pro", { enabled: true, thinkingLevel: "minimal" });
    expect(genConfig(b).thinkingConfig).toEqual({ thinkingLevel: "low" });
  });

  it("gemini-3 flash keeps minimal (flash/lite accept it)", async () => {
    const b = await callGemini("gemini-3-flash", { enabled: true, effort: "minimal" });
    expect(genConfig(b).thinkingConfig).toEqual({ thinkingLevel: "minimal" });
  });

  it("non-thinking Gemini (2.0) ignores reasoning -> no thinkingConfig", async () => {
    // 2.0/1.x are a CLOSED backward set that really has no thinking API.
    const b = await callGemini("gemini-2.0-flash", { enabled: true, effort: "high" });
    expect(genConfig(b).thinkingConfig).toBeUndefined();
  });

  it("an unrecognized Gemini gets the newest shape instead of silent drop", async () => {
    // Same policy as unknown Claude → adaptive: unknown ⇒ newest wire shape.
    // The old fallback ignored reasoning entirely, which is how a whole model
    // generation can lose its configured effort without anyone noticing.
    const b = await callGemini("gemini-4-pro", { enabled: true, effort: "high" });
    expect(genConfig(b).thinkingConfig).toEqual({ thinkingLevel: "high" });
  });

  it("auto (or no tier) on a thinkingLevel Gemini omits thinkingConfig", async () => {
    const b = await callGemini("gemini-3.6-flash", { enabled: true, effort: "auto" });
    expect(genConfig(b).thinkingConfig).toBeUndefined();
    const b2 = await callGemini("gemini-3.6-flash", { enabled: true });
    expect(genConfig(b2).thinkingConfig).toBeUndefined();
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

// The 2026-07-26 regression. supportsAdaptiveThinking() was a hand-written regex
// over Opus 4.6/4.7/4.8 + Sonnet 4.6 + Mythos, so every Claude 5 model matched
// NEITHER it nor the legacy 4.5 predicate and fell into the "this model can't
// think" branch: no `thinking`, no `output_config`, temperature sent, and the
// effort the user picked in the app thrown away in silence. It looked like it
// worked, because the API's own default is high effort.
describe("Claude 5 family reasoning shape", () => {
  for (const model of ["claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-mythos-5"]) {
    it(`${model} sends adaptive thinking, never a manual budget`, async () => {
      const body = await callAnthropic(model, { enabled: true, effort: "max" }, 0.7);
      expect(body.thinking).toMatchObject({ type: "adaptive" });
      expect(body.output_config).toEqual({ effort: "max" });
      expect(body).not.toHaveProperty("temperature");
    });
  }

  // xhigh reaches Opus 5 / Sonnet 5 / Fable 5 unchanged, but clamps to high on the
  // adaptive models that never got the tier — sending it there is a 400.
  it("routes xhigh by per-model support, not by generation", async () => {
    for (const model of ["claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-opus-4-8", "claude-opus-4-7"]) {
      const body = await callAnthropic(model, { enabled: true, effort: "xhigh" }, null);
      expect(body.output_config, `${model} must keep xhigh`).toEqual({ effort: "xhigh" });
    }
    for (const model of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-mythos-preview"]) {
      const body = await callAnthropic(model, { enabled: true, effort: "xhigh" }, null);
      expect(body.output_config, `${model} must clamp xhigh down`).toEqual({ effort: "high" });
    }
  });

  // Both directions of the 400: 4.7+ reject type:"enabled", the manual-only set
  // rejects type:"adaptive". The registry's thinkingModes is what keeps them apart.
  // Opus 4.1 is in this list because it is the oldest still-callable Claude
  // (retires 2026-08-05) and was the last one missing from the registry.
  it("keeps the manual-thinking-only set on budget_tokens", async () => {
    for (const model of ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1"]) {
      const body = await callAnthropic(model, { enabled: true, budgetTokens: 8000 }, 0.7);
      expect(body.thinking, model).toEqual({ type: "enabled", budget_tokens: 8000 });
      expect(body, model).not.toHaveProperty("output_config");
    }
  });

  // A model newer than this build must default to adaptive. The old fallback was
  // "no thinking at all", which is the failure that hid for a whole generation:
  // silent, and indistinguishable from working.
  it("defaults an unlisted Claude to adaptive and passes the effort through", async () => {
    const body = await callAnthropic("claude-opus-9-imaginary", { enabled: true, effort: "max" }, 0.7);
    expect(body.thinking).toMatchObject({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "max" });
  });

  // Unknown model + a tier this build has never heard of: send it as configured
  // rather than second-guessing. The cast is the point — config.json's schema
  // (STORABLE_REASONING_EFFORTS) is what stops "ultra" ever reaching here from a
  // real profile, so this pins the ADAPTER's defensive behaviour: if the union is
  // widened for a newly shipped tier, no adapter change is needed. mapEffort used to
  // be a closed switch that rewrote anything unrecognized to "high", making a new
  // tier indistinguishable from asking for high.
  it("does not clamp an unrecognized effort on an unlisted model", async () => {
    const effort = "ultra" as CanonicalReasoningConfig["effort"];
    const body = await callAnthropic("claude-opus-9-imaginary", { enabled: true, effort }, null);
    expect(body.output_config).toEqual({ effort: "ultra" });
  });

  // The alias still normalizes, and is not treated as "unrecognized".
  it("normalizes minimal to low rather than falling back to high", async () => {
    const body = await callAnthropic("claude-opus-9-imaginary", { enabled: true, effort: "minimal" }, null);
    expect(body.output_config).toEqual({ effort: "low" });
  });

  it("still omits thinking entirely when reasoning is off", async () => {
    const body = await callAnthropic("claude-opus-5", { enabled: false }, 0.7);
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("output_config");
    expect(body.temperature).toBe(0.7);
  });
});

// ── 2026-07-26 batch: chat pass-through, responses max, auto tier ──

function stubJSONCapture(responseText: string): { body: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: unknown) => {
      captured = JSON.parse((init as { body: string }).body);
      return { ok: true, status: 200, text: async () => responseText, json: async () => JSON.parse(responseText) } as unknown as Response;
    }),
  );
  return { body: () => captured };
}

function chatResponse(): string {
  return JSON.stringify({
    choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
}

async function callChat(protocol: "openai_chat_completions" | "openai_chat_compat", model: string, reasoning?: CanonicalReasoningConfig) {
  await registerBuiltinAdapters();
  const adapter = requireAdapter(protocol);
  const cap = stubJSONCapture(chatResponse());
  await adapter.generateDecision(
    { systemPrompt: "s", userPrompt: "u", maxTokens: 1024, temperature: 0.7, reasoning },
    {
      profileId: "p", displayName: "p", protocol, model, apiKey: "sk",
      baseURL: "https://proxy.example.com/v1",
      temperature: 0.7, maxTokens: 1024,
      timeouts: { requestMs: 1000 }, retries: { maxAttempts: 1 },
    },
  );
  return cap.body();
}

// The user-visible regression this batch fixes: both chat protocols REFUSED
// reasoning outright ("Protocol does not support thinking"), so a reasoning model
// behind a compat proxy silently ran at the endpoint's default effort. Verbatim
// pass-through can 400 on an endpoint that doesn't know the field — loud and
// diagnosable, unlike the silence it replaces.
describe("chat protocols: reasoning_effort pass-through", () => {
  for (const protocol of ["openai_chat_completions", "openai_chat_compat"] as const) {
    it(`${protocol} forwards a configured effort verbatim`, async () => {
      const body = await callChat(protocol, "gpt-5.6-sol", { enabled: true, effort: "max" });
      expect(body.reasoning_effort).toBe("max");
    });

    it(`${protocol} sends nothing for auto / unset / disabled`, async () => {
      expect((await callChat(protocol, "gpt-5.6-sol", { enabled: true, effort: "auto" })).reasoning_effort).toBeUndefined();
      expect((await callChat(protocol, "gpt-5.6-sol", { enabled: true })).reasoning_effort).toBeUndefined();
      expect((await callChat(protocol, "gpt-5.6-sol", { enabled: false, effort: "high" })).reasoning_effort).toBeUndefined();
      expect((await callChat(protocol, "gpt-4o")).reasoning_effort).toBeUndefined();
    });
  }
});

function responsesEffortResponse(): string {
  return JSON.stringify({
    output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }],
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

async function callResponsesEffort(model: string, reasoning?: CanonicalReasoningConfig) {
  await registerBuiltinAdapters();
  const adapter = requireAdapter("openai_responses");
  const cap = stubJSONCapture(responsesEffortResponse());
  await adapter.generateDecision(
    { systemPrompt: "s", userPrompt: "u", maxTokens: 1024, temperature: null, reasoning },
    {
      profileId: "p", displayName: "p", protocol: "openai_responses", model, apiKey: "sk",
      baseURL: "https://api.openai.com/v1",
      temperature: null, maxTokens: 1024,
      timeouts: { requestMs: 1000 }, retries: { maxAttempts: 1 },
    },
  );
  return cap.body();
}

describe("openai responses: max tier routing (GPT-5.6)", () => {
  it("gpt-5.6 keeps max — the first OpenAI ladder that has it", async () => {
    const body = await callResponsesEffort("gpt-5.6-sol", { enabled: true, effort: "max" });
    expect((body.reasoning as Record<string, unknown>).effort).toBe("max");
  });

  it("gpt-5.5 clamps max down to its highest listed tier (xhigh)", async () => {
    const body = await callResponsesEffort("gpt-5.5", { enabled: true, effort: "max" });
    expect((body.reasoning as Record<string, unknown>).effort).toBe("xhigh");
  });

  it("auto / unset omit the effort key so the provider default applies", async () => {
    // GPT-5.4's API default is none — the validateProfile warning covers that;
    // "auto" means the provider decides, so the adapter must not editorialize.
    const b1 = await callResponsesEffort("gpt-5.5", { enabled: true, effort: "auto" });
    expect((b1.reasoning as Record<string, unknown>).effort).toBeUndefined();
    const b2 = await callResponsesEffort("gpt-5.5", { enabled: true });
    expect((b2.reasoning as Record<string, unknown>).effort).toBeUndefined();
  });

  it("an unlisted model passes the tier through untouched", async () => {
    const body = await callResponsesEffort("gpt-6-imaginary", { enabled: true, effort: "max" });
    expect((body.reasoning as Record<string, unknown>).effort).toBe("max");
  });
});

describe("anthropic: the auto tier", () => {
  it("auto / unset omit output_config so Anthropic's default applies", async () => {
    const b1 = await callAnthropic("claude-opus-5", { enabled: true, effort: "auto" }, null);
    expect(b1.thinking).toMatchObject({ type: "adaptive" });
    expect(b1).not.toHaveProperty("output_config");
    const b2 = await callAnthropic("claude-opus-5", { enabled: true }, null);
    expect(b2).not.toHaveProperty("output_config");
  });
});
