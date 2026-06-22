import { describe, expect, it } from "vitest";

import { faithfulProbe } from "../src/cli/commands/config-probe.js";
import type { DecisionInput, DecisionOutput, LLMProfile } from "../src/llm/adapters/types.js";

function profile(over: Partial<LLMProfile> = {}): LLMProfile {
  return {
    profileId: "p",
    displayName: "P",
    protocol: "anthropic_messages",
    baseURL: "https://example.test",
    model: "claude-sonnet-4-6",
    apiKey: "sk-test",
    temperature: null,
    maxTokens: 32000,
    responseFormat: "json",
    reasoning: { enabled: true, mode: "enabled", effort: "high" },
    timeouts: { requestMs: 30000, connectMs: 10000 },
    retries: { maxAttempts: 2, backoffMs: 500 },
    ...over,
  };
}

function fakeAdapter(gen: (input: DecisionInput, p: LLMProfile) => Promise<DecisionOutput>) {
  return { generateDecision: gen };
}

describe("faithfulProbe", () => {
  it("tests the REAL path: passes the profile's reasoning + max tokens", async () => {
    let captured: DecisionInput | undefined;
    const adapter = fakeAdapter(async (input) => {
      captured = input;
      return { text: '{"ok":true}', latencyMs: 12 };
    });
    const res = await faithfulProbe(adapter, profile());
    expect(res.success).toBe(true);
    expect(res.jsonValid).toBe(true);
    expect(res.latencyMs).toBe(12);
    // Faithful: thinking is NOT disabled and tokens are NOT capped to a tiny probe value.
    expect(captured?.maxTokens).toBe(32000);
    expect(captured?.reasoning).toEqual({ enabled: true, mode: "enabled", effort: "high" });
  });

  it("explains the reasoning-ate-the-budget failure when the model returns nothing", async () => {
    const adapter = fakeAdapter(async () => ({ text: "   ", latencyMs: 5 }));
    const res = await faithfulProbe(adapter, profile());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Raise max tokens|reasoning/i);
  });

  it("reports connectivity success but jsonValid=false for non-JSON text", async () => {
    const adapter = fakeAdapter(async () => ({ text: "hello, not json", latencyMs: 7 }));
    const res = await faithfulProbe(adapter, profile());
    expect(res.success).toBe(true);
    expect(res.jsonValid).toBe(false);
  });

  it("surfaces the adapter error message on failure", async () => {
    const adapter = fakeAdapter(async () => {
      throw new Error("DeepSeek API 401: invalid key");
    });
    const res = await faithfulProbe(adapter, profile({ protocol: "deepseek_chat_completions" }));
    expect(res.success).toBe(false);
    expect(res.error).toContain("401");
    expect(res.protocol).toBe("deepseek_chat_completions");
  });
});
