// Batch C — direct-LLM provider self-heal: a token-truncated (or max_tokens
// 4xx) first call is retried ONCE at a higher cap so the turn isn't wasted.

import { afterEach, describe, expect, it } from "vitest";

import { clearAdapters, registerAdapter } from "../src/llm/adapter-registry";
import { AdapterError, type LLMAdapter } from "../src/llm/adapters/types";
import { createDirectLLMRuntimeProvider } from "../src/bridge/direct-llm-provider";
import type { BridgeRuntimeDecisionRequest } from "../src/bridge/provider";
import type { LLMConfig, LLMProfile } from "../src/profile/config-schema";

function config(profile: LLMProfile): LLMConfig {
  return { schemaVersion: 1, activeProfile: "main", profiles: { main: profile }, routing: { default: "main" } };
}

function req(): BridgeRuntimeDecisionRequest {
  return {
    game: "coup",
    matchId: "m1",
    legalActions: [{ type: "noop" }] as unknown as BridgeRuntimeDecisionRequest["legalActions"],
    publicState: { your_player_id: "p0" },
    timeoutMs: 0,
  };
}

/** Adapter whose behavior on each call is scripted; records the maxTokens seen. */
function scriptedAdapter(
  protocol: LLMProfile["protocol"],
  script: ReadonlyArray<{ truncated?: boolean; throwTokenLimit?: boolean }>,
): { adapter: LLMAdapter; maxTokensSeen: number[] } {
  const maxTokensSeen: number[] = [];
  const adapter: LLMAdapter = {
    protocol,
    validateProfile: () => ({ ok: true, errors: [], warnings: [] }),
    probe: async (p) => ({ success: true, latencyMs: 1, model: p.model, protocol, jsonValid: true }),
    generateDecision: async (input) => {
      const step = script[maxTokensSeen.length] ?? {};
      maxTokensSeen.push(input.maxTokens);
      if (step.throwTokenLimit) throw new AdapterError("invalid_request", protocol, "400 max_tokens", { tokenLimit: true });
      return { text: '{"action":"noop"}', latencyMs: 1, ...(step.truncated ? { truncated: true, stopReason: "max_tokens" as const } : {}) };
    },
    estimateUsage: (_o, p) => ({ protocol, providerLabel: protocol, model: p.model, latencyMs: 1, timestamp: "" }),
    redact: (r) => r,
  };
  return { adapter, maxTokensSeen };
}

function makeProvider(adapter: LLMAdapter, cfg: LLMConfig) {
  return createDirectLLMRuntimeProvider({
    agentSlug: "x",
    loadConfig: async () => cfg,
    registerAdapters: async () => { clearAdapters(); registerAdapter(adapter); },
  });
}

const OPUS: LLMProfile = { protocol: "anthropic_messages", apiKeyRef: { type: "env", name: "K" }, model: "claude-opus-4-7", request: { maxTokens: 32000 } };

afterEach(() => { clearAdapters(); delete process.env.K; });

describe("direct-llm self-heal (Batch C)", () => {
  it("retries a truncated first call at the model ceiling", async () => {
    process.env.K = "sk-test";
    const { adapter, maxTokensSeen } = scriptedAdapter("anthropic_messages", [{ truncated: true }, {}]);
    const out = (await makeProvider(adapter, config(OPUS)).decide(req())) as { selfHealed?: { from: number; to: number } };
    expect(maxTokensSeen).toEqual([32000, 128000]); // opus ceiling
    expect(out.selfHealed).toEqual({ from: 32000, to: 128000 });
  });

  it("retries once on a max_tokens 4xx, then succeeds", async () => {
    process.env.K = "sk-test";
    const { adapter, maxTokensSeen } = scriptedAdapter("anthropic_messages", [{ throwTokenLimit: true }, {}]);
    const out = (await makeProvider(adapter, config(OPUS)).decide(req())) as { selfHealed?: { from: number; to: number }; raw: string };
    expect(maxTokensSeen).toEqual([32000, 128000]);
    expect(out.selfHealed).toEqual({ from: 32000, to: 128000 });
    expect(JSON.parse(out.raw).action).toBe("noop");
  });

  it("does NOT retry a normal decision (single call, no selfHealed)", async () => {
    process.env.K = "sk-test";
    const { adapter, maxTokensSeen } = scriptedAdapter("anthropic_messages", [{}]);
    const out = (await makeProvider(adapter, config(OPUS)).decide(req())) as { selfHealed?: unknown };
    expect(maxTokensSeen).toEqual([32000]);
    expect(out.selfHealed).toBeUndefined();
  });

  it("keeps the first (truncated but usable) output when the retry fails — never a third call (F1)", async () => {
    process.env.K = "sk-test";
    // call#1 truncated-but-parseable; the retry then throws a max_tokens 4xx.
    // Old code re-entered the catch and fired a THIRD call; the guarded version
    // issues exactly one retry and keeps the first output instead of losing it.
    const { adapter, maxTokensSeen } = scriptedAdapter("anthropic_messages", [{ truncated: true }, { throwTokenLimit: true }]);
    const out = (await makeProvider(adapter, config(OPUS)).decide(req())) as { selfHealed?: unknown; truncated?: boolean; raw: string };
    expect(maxTokensSeen).toEqual([32000, 128000]); // one retry only — no third call
    expect(JSON.parse(out.raw).action).toBe("noop"); // first output preserved
    expect(out.truncated).toBe(true); // still surfaced as truncated (so the user is nudged)
    expect(out.selfHealed).toBeUndefined(); // the retry did not land
  });

  it("skips self-heal when too little turn budget remains (F2)", async () => {
    process.env.K = "sk-test";
    // timeoutMs below the self-heal budget floor → a second full model call
    // could blow the turn deadline, so we skip it and surface the truncation.
    const { adapter, maxTokensSeen } = scriptedAdapter("anthropic_messages", [{ truncated: true }, {}]);
    const out = (await makeProvider(adapter, config(OPUS)).decide({ ...req(), timeoutMs: 5000 })) as { selfHealed?: unknown; truncated?: boolean };
    expect(maxTokensSeen).toEqual([32000]); // no retry issued
    expect(out.selfHealed).toBeUndefined();
    expect(out.truncated).toBe(true);
  });

  it("still self-heals when ample turn budget remains (F2)", async () => {
    process.env.K = "sk-test";
    const { adapter, maxTokensSeen } = scriptedAdapter("anthropic_messages", [{ truncated: true }, {}]);
    const out = (await makeProvider(adapter, config(OPUS)).decide({ ...req(), timeoutMs: 120_000 })) as { selfHealed?: { from: number; to: number } };
    expect(maxTokensSeen).toEqual([32000, 128000]);
    expect(out.selfHealed).toEqual({ from: 32000, to: 128000 });
  });

  it("a non-token-limit error is NOT retried (propagates to fallback)", async () => {
    process.env.K = "sk-test";
    const adapter: LLMAdapter = {
      protocol: "anthropic_messages",
      validateProfile: () => ({ ok: true, errors: [], warnings: [] }),
      probe: async (p) => ({ success: true, latencyMs: 1, model: p.model, protocol: "anthropic_messages", jsonValid: true }),
      generateDecision: async () => { throw new AdapterError("server_error", "anthropic_messages", "500"); },
      estimateUsage: (_o, p) => ({ protocol: "anthropic_messages", providerLabel: "a", model: p.model, latencyMs: 1, timestamp: "" }),
      redact: (r) => r,
    };
    await expect(makeProvider(adapter, config(OPUS)).decide(req())).rejects.toThrow(/500/);
  });
});
