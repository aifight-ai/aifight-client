import { describe, expect, it } from "vitest";

import { resolveModelCapabilities } from "../src/llm/capabilities/validate-capabilities.js";

// resolveModelCapabilities is the single source of truth the wizard + probe use
// to decide which knobs to surface. These cases lock the per-family quirks the
// owner cares about (thinking on/off, temperature-when-thinking, effort sets).
describe("resolveModelCapabilities", () => {
  it("Claude Sonnet: thinking optional, effort set, temperature usable when off", () => {
    const c = resolveModelCapabilities("anthropic_messages", "claude-sonnet-4-6");
    expect(c.isKnownModel).toBe(true);
    expect(c.supportsThinking).toBe(true);
    expect(c.canDisableThinking).toBe(true); // Claude turns thinking off by omission
    expect(c.thinkingAlwaysOn).toBe(false);
    expect(c.efforts).toEqual(["low", "medium", "high", "max"]);
    expect(c.defaultEffort).toBe("high");
    expect(c.temperatureUsableWhenThinkingOff).toBe(true);
  });

  it("Claude Opus 4.7: model-level supportsTemperature=false removes the temperature knob", () => {
    const c = resolveModelCapabilities("anthropic_messages", "claude-opus-4-7");
    expect(c.supportsThinking).toBe(true);
    expect(c.temperatureUsableWhenThinkingOff).toBe(false); // 4.7+ reject temperature entirely
    expect(c.efforts).toContain("xhigh");
  });

  it("Claude Opus 4.1: extended thinking only, 32k ceiling — deprecated but still callable", () => {
    // Per the model overview (2026-07-26): adaptive thinking "No", extended thinking
    // "Yes", max output 32k, retires 2026-08-05. While it was unlisted, three things
    // broke at once on it: the adapter's unknown-model fallback picked adaptive
    // (type:"adaptive" + output_config → 400), the ceiling read as unknown so the
    // first call could ask for more than 32k, and the truncation self-heal raised
    // toward 65536 — turning one 400 into two.
    const c = resolveModelCapabilities("anthropic_messages", "claude-opus-4-1");
    expect(c.isKnownModel).toBe(true);
    expect(c.thinkingModesKnown).toBe(true);
    expect(c.thinkingModes).toEqual(["extended"]);
    expect(c.maxOutputTokens).toBe(32000);
    expect(c.temperatureUsableWhenThinkingOff).toBe(true); // temperature only 400s on 4.7+
    // The dated id and the alias must land on the same entry, and neither may be
    // swallowed by (or swallow) a neighbouring 4.x pattern.
    expect(resolveModelCapabilities("anthropic_messages", "claude-opus-4-1-20250805").maxOutputTokens).toBe(32000);
    expect(resolveModelCapabilities("anthropic_messages", "claude-opus-4-8").maxOutputTokens).toBe(128000);
  });

  it("DeepSeek V4 Pro: thinking optional, sampling ignored while thinking, effort high/max", () => {
    const c = resolveModelCapabilities("deepseek_chat_completions", "deepseek-v4-pro");
    expect(c.supportsThinking).toBe(true);
    expect(c.canDisableThinking).toBe(true);
    expect(c.samplingIgnoredWhenThinking).toBe(true);
    expect(c.efforts).toEqual(["high", "max"]);
    // protocol supportsTemperature = "ignored_when_thinking" (not false) → still
    // usable in the non-thinking branch.
    expect(c.temperatureUsableWhenThinkingOff).toBe(true);
    expect(c.maxOutputTokens).toBe(65536);
  });

  it("OpenAI Chat Completions: thinking is pass-through — available, but default OFF", () => {
    // 2026-07-26: this protocol used to be marked non-thinking, so a reasoning
    // model behind it (gpt-5.x via a proxy) had its configured effort silently
    // discarded. It now forwards reasoning_effort verbatim; because the endpoint's
    // model may not reason at all (gpt-4o), a fresh profile defaults thinking off.
    const c = resolveModelCapabilities("openai_chat_completions", "gpt-4o");
    expect(c.supportsThinking).toBe(true);
    expect(c.thinkingDefaultOn).toBe(false);
    expect(c.thinkingAlwaysOn).toBe(false);
    expect(c.efforts).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(c.temperatureUsableWhenThinkingOff).toBe(true);
  });

  it("protocols that think keep defaulting thinking ON", () => {
    for (const [proto, model] of [
      ["anthropic_messages", "claude-opus-5"],
      ["openai_responses", "gpt-5.6-sol"],
      ["gemini_generate_content", "gemini-3.6-flash"],
    ] as const) {
      expect(resolveModelCapabilities(proto, model).thinkingDefaultOn, proto).toBe(true);
    }
  });

  it("unknown protocol degrades to a safe plain-chat view", () => {
    const c = resolveModelCapabilities("some_future_protocol", "mystery-model");
    expect(c.isKnownProtocol).toBe(false);
    expect(c.supportsThinking).toBe(false);
    expect(c.temperatureUsableWhenThinkingOff).toBe(true);
  });

  it("unknown model on a known protocol keeps protocol-level effort defaults", () => {
    const c = resolveModelCapabilities("anthropic_messages", "claude-future-99");
    expect(c.isKnownProtocol).toBe(true);
    expect(c.isKnownModel).toBe(false);
    expect(c.supportsThinking).toBe(true);
    expect(c.canDisableThinking).toBe(true);
    expect(c.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]); // protocol effortValues
  });
});
