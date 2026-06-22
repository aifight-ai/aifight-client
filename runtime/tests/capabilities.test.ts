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

  it("OpenAI Chat Completions: no thinking at all, no effort knobs", () => {
    const c = resolveModelCapabilities("openai_chat_completions", "gpt-4o");
    expect(c.supportsThinking).toBe(false);
    expect(c.canDisableThinking).toBe(false);
    expect(c.thinkingAlwaysOn).toBe(false);
    expect(c.efforts).toEqual([]);
    expect(c.temperatureUsableWhenThinkingOff).toBe(true);
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
