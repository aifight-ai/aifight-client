// Batch A — effort→maxTokens recommendation (D3/D4).

import { describe, it, expect } from "vitest";

import { recommendMaxTokens } from "../src/llm/capabilities/validate-capabilities";
import { applyEffortTokenRecommendation } from "../src/cli/commands/config-edit";
import type { ProfileBuildSettings } from "../src/cli/commands/config-shared";

describe("recommendMaxTokens (D3)", () => {
  it("recommends the model ceiling for high/xhigh/max effort", () => {
    expect(recommendMaxTokens({ protocol: "anthropic_messages", model: "claude-opus-4-7", effort: "max", thinkingEnabled: true }))
      .toEqual({ recommended: 128000, ceilingKnown: true });
    expect(recommendMaxTokens({ protocol: "anthropic_messages", model: "claude-sonnet-4-6", effort: "high", thinkingEnabled: true }))
      .toEqual({ recommended: 64000, ceilingKnown: true });
    expect(recommendMaxTokens({ protocol: "openai_responses", model: "gpt-5.5", effort: "xhigh", thinkingEnabled: true }))
      .toEqual({ recommended: 128000, ceilingKnown: true });
  });

  it("returns undefined for low/medium/default effort or thinking off", () => {
    expect(recommendMaxTokens({ protocol: "anthropic_messages", model: "claude-opus-4-7", effort: "medium", thinkingEnabled: true })).toBeUndefined();
    expect(recommendMaxTokens({ protocol: "anthropic_messages", model: "claude-opus-4-7", thinkingEnabled: true })).toBeUndefined();
    expect(recommendMaxTokens({ protocol: "anthropic_messages", model: "claude-opus-4-7", effort: "max", thinkingEnabled: false })).toBeUndefined();
  });

  it("falls back to a generous value for an unknown model (ceilingKnown false)", () => {
    const r = recommendMaxTokens({ protocol: "openai_chat_compat", model: "some-new-model", effort: "max", thinkingEnabled: true });
    expect(r).toEqual({ recommended: 65536, ceilingKnown: false });
  });
});

function settings(over: Partial<ProfileBuildSettings>): ProfileBuildSettings {
  return { thinkingEnabled: true, maxTokens: 32000, stream: "auto", temperature: null, ...over };
}

describe("applyEffortTokenRecommendation (D4)", () => {
  it("auto-raises to the ceiling when no explicit --max-tokens and below recommendation", () => {
    const r = applyEffortTokenRecommendation(settings({ effort: "max", maxTokens: 32000 }), "anthropic_messages", "claude-opus-4-7", undefined);
    expect(r.settings.maxTokens).toBe(128000);
    expect(r.note).toMatch(/auto-raised to 128000/);
  });

  it("keeps an explicit small value but warns", () => {
    const r = applyEffortTokenRecommendation(settings({ effort: "max", maxTokens: 8000 }), "anthropic_messages", "claude-opus-4-7", 8000);
    expect(r.settings.maxTokens).toBe(8000);
    expect(r.note).toMatch(/warning: max tokens 8000 is below the recommended 128000/);
  });

  it("does nothing for medium effort (no recommendation)", () => {
    const r = applyEffortTokenRecommendation(settings({ effort: "medium", maxTokens: 32000 }), "anthropic_messages", "claude-sonnet-4-6", undefined);
    expect(r.settings.maxTokens).toBe(32000);
    expect(r.note).toBeUndefined();
  });

  it("does nothing when maxTokens already meets the recommendation", () => {
    const r = applyEffortTokenRecommendation(settings({ effort: "max", maxTokens: 128000 }), "anthropic_messages", "claude-opus-4-7", undefined);
    expect(r.settings.maxTokens).toBe(128000);
    expect(r.note).toBeUndefined();
  });
});
