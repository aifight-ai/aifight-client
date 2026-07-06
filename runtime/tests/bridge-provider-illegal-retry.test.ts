// §3 Phase A: an unparseable/illegal model output gets corrective feedback
// and a bounded retry before the deterministic fallback acts. Asserts the
// three branches (direct pass / retry success / retry exhausted → fallback),
// that a retry adds exactly one model call, the feedback payload contents,
// and the turn-budget guard.

import { describe, expect, it } from "vitest";

import {
  buildBridgeDecisionProvider,
  type BridgeDecisionTrace,
  type BridgeRuntimeDecisionRequest,
  type BridgeRuntimeProvider,
} from "../src/bridge/provider";
import type { AgentDecisionContext } from "../src/agents/agent";
import type { MsgActionRequest } from "../src/protocol/types";

const LEGAL_ACTIONS = [{ type: "fold" }, { type: "call" }] as const;

function makeCtx(timeoutMs = 60_000): AgentDecisionContext {
  const actionRequest = {
    type: "action_request",
    match_id: "m-1",
    data: {
      state: { your_player_id: "p0" },
      legal_actions: [...LEGAL_ACTIONS],
      timeout_ms: timeoutMs,
    },
  } as unknown as MsgActionRequest;
  return {
    actionRequest,
    matchId: "m-1",
    game: "texas_holdem",
    state: "in_match",
  } as unknown as AgentDecisionContext;
}

function scriptedProvider(outputs: ReadonlyArray<string | { type: string }>): {
  provider: BridgeRuntimeProvider;
  requests: BridgeRuntimeDecisionRequest[];
} {
  const requests: BridgeRuntimeDecisionRequest[] = [];
  const provider: BridgeRuntimeProvider = {
    name: "scripted",
    async decide(req) {
      requests.push(req);
      const next = outputs[requests.length - 1];
      if (next === undefined) throw new Error("scripted provider exhausted");
      return next as string | (typeof LEGAL_ACTIONS)[number];
    },
  };
  return { provider, requests };
}

function collectTraces(): { traces: BridgeDecisionTrace[]; onTrace: (t: BridgeDecisionTrace) => void } {
  const traces: BridgeDecisionTrace[] = [];
  return { traces, onTrace: (t) => traces.push(t) };
}

function finalTrace(traces: BridgeDecisionTrace[]) {
  const final = traces.find((t) => t.type === "final_action");
  if (!final || final.type !== "final_action") throw new Error("no final_action trace");
  return final;
}

describe("bridge provider illegal-output retry (§3 Phase A)", () => {
  it("legal first reply → decisionSource=model, exactly one call", async () => {
    const { provider, requests } = scriptedProvider(['{"action":"call"}']);
    const { traces, onTrace } = collectTraces();
    const dp = buildBridgeDecisionProvider(provider, { onTrace });

    const action = await dp.decide(makeCtx());

    expect(action).toEqual({
      action: { type: "call" },
      decision: { source: "model", illegal_retries: 0 },
    });
    expect(requests).toHaveLength(1);
    expect(finalTrace(traces).decisionSource).toBe("model");
    expect(traces.some((t) => t.type === "illegal_retry")).toBe(false);
  });

  it("garbage then legal → decisionSource=model_retry, feedback present on retry request", async () => {
    const { provider, requests } = scriptedProvider(["zzzz nonsense", '{"action":"call"}']);
    const { traces, onTrace } = collectTraces();
    const dp = buildBridgeDecisionProvider(provider, { onTrace });

    const action = await dp.decide(makeCtx());

    expect(action).toEqual({
      action: { type: "call" },
      decision: { source: "model_retry", illegal_retries: 1 },
    });
    expect(requests).toHaveLength(2); // retry adds exactly one call
    const retryReq = requests[1]!;
    expect(retryReq.illegalFeedback).toBeDefined();
    expect(retryReq.illegalFeedback!.attempt).toBe(1);
    expect(retryReq.illegalFeedback!.reason).toBe("unparseable_runtime_text");
    expect(retryReq.illegalFeedback!.priorRaw).toContain("zzzz nonsense");
    expect(retryReq.illegalFeedback!.message).toContain("fold, call");
    expect(finalTrace(traces).decisionSource).toBe("model_retry");
    expect(traces.filter((t) => t.type === "illegal_retry")).toHaveLength(1);
  });

  it("illegal action object → reason=illegal_runtime_action on feedback", async () => {
    const { provider, requests } = scriptedProvider([
      { type: "raise" } as { type: string },
      '{"action":"fold"}',
    ]);
    const { traces, onTrace } = collectTraces();
    const dp = buildBridgeDecisionProvider(provider, { onTrace });

    const action = await dp.decide(makeCtx());

    expect(action).toEqual({
      action: { type: "fold" },
      decision: { source: "model_retry", illegal_retries: 1 },
    });
    expect(requests[1]!.illegalFeedback!.reason).toBe("illegal_runtime_action");
    expect(finalTrace(traces).decisionSource).toBe("model_retry");
  });

  it("garbage twice → fallback after the single default retry", async () => {
    const { provider, requests } = scriptedProvider(["zzzz", "yyyy still nonsense"]);
    const { traces, onTrace } = collectTraces();
    const dp = buildBridgeDecisionProvider(provider, { onTrace });

    const action = await dp.decide(makeCtx());

    expect(requests).toHaveLength(2); // 1 original + 1 retry, then fallback
    const final = finalTrace(traces);
    expect(final.decisionSource).toBe("fallback");
    expect(final.source).toBe("fallback");
    const sent = (action as { action: { type: string } }).action;
    expect(LEGAL_ACTIONS.map((a) => a.type)).toContain(sent.type);
  });

  it("illegalRetryCount=0 → no retry, immediate fallback", async () => {
    const { provider, requests } = scriptedProvider(["zzzz"]);
    const { traces, onTrace } = collectTraces();
    const dp = buildBridgeDecisionProvider(provider, { onTrace, illegalRetryCount: 0 });

    await dp.decide(makeCtx());

    expect(requests).toHaveLength(1);
    expect(finalTrace(traces).decisionSource).toBe("fallback");
  });

  it("illegalRetryCount=2 → up to two corrective retries", async () => {
    const { provider, requests } = scriptedProvider(["zzzz", "yyyy", '{"action":"fold"}']);
    const { traces, onTrace } = collectTraces();
    const dp = buildBridgeDecisionProvider(provider, { onTrace, illegalRetryCount: 2 });

    const action = await dp.decide(makeCtx());

    expect(action).toEqual({
      action: { type: "fold" },
      decision: { source: "model_retry", illegal_retries: 2 },
    });
    expect(requests).toHaveLength(3);
    expect(requests[2]!.illegalFeedback!.attempt).toBe(2);
    expect(finalTrace(traces).decisionSource).toBe("model_retry");
  });

  it("tiny turn budget → retry skipped, fallback without a second call", async () => {
    const { provider, requests } = scriptedProvider(["zzzz", '{"action":"call"}']);
    const { traces, onTrace } = collectTraces();
    const dp = buildBridgeDecisionProvider(provider, { onTrace });

    // 1s budget < MIN_ILLEGAL_RETRY_BUDGET_MS (10s) → no corrective retry.
    await dp.decide(makeCtx(1_000));

    expect(requests).toHaveLength(1);
    expect(finalTrace(traces).decisionSource).toBe("fallback");
  });

  it("usage events flow through with the right decisionSource (§7A)", async () => {
    const usagePayload = {
      provider: "anthropic_messages",
      model: "claude-x",
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 1200,
    };
    let calls = 0;
    const provider: BridgeRuntimeProvider = {
      name: "usage-scripted",
      async decide() {
        calls++;
        // first reply is garbage (forces a §3 retry), second is legal —
        // both carry usage.
        return { raw: calls === 1 ? "zzzz" : '{"action":"call"}', usage: usagePayload };
      },
    };
    const events: Array<{ decisionSource: string; usage: { model: string } }> = [];
    const dp = buildBridgeDecisionProvider(provider, {
      onUsage: (e) => events.push(e),
    });

    const action = await dp.decide(makeCtx());

    // §7B-1: the wire usage aggregates BOTH calls of the decision
    // (initial + corrective retry) into one record.
    expect(action).toEqual({
      action: { type: "call" },
      usage: { model: "claude-x", input_tokens: 200, output_tokens: 100 },
      decision: { source: "model_retry", illegal_retries: 1 },
    });
    expect(events).toHaveLength(2);
    expect(events[0]!.decisionSource).toBe("model");
    expect(events[1]!.decisionSource).toBe("model_retry");
    expect(events[1]!.usage.model).toBe("claude-x");
  });

  it("retry transport error → fallback, no further retries", async () => {
    const requests: BridgeRuntimeDecisionRequest[] = [];
    const provider: BridgeRuntimeProvider = {
      name: "throw-on-retry",
      async decide(req) {
        requests.push(req);
        if (requests.length === 1) return "zzzz";
        throw new Error("boom");
      },
    };
    const { traces, onTrace } = collectTraces();
    const dp = buildBridgeDecisionProvider(provider, { onTrace, illegalRetryCount: 2 });

    await dp.decide(makeCtx());

    expect(requests).toHaveLength(2);
    expect(finalTrace(traces).decisionSource).toBe("fallback");
  });

  it("truncation signal flows onto the runtime_success trace (Batch B1)", async () => {
    const provider: BridgeRuntimeProvider = {
      name: "trunc",
      async decide() {
        return { raw: '{"action":"call"}', truncated: true, profileId: "claude" };
      },
    };
    const { traces, onTrace } = collectTraces();
    const dp = buildBridgeDecisionProvider(provider, { onTrace });

    await dp.decide(makeCtx());

    const ok = traces.find((t) => t.type === "runtime_success");
    expect(ok && ok.type === "runtime_success" && ok.truncated).toBe(true);
    expect(ok && ok.type === "runtime_success" && ok.profileId).toBe("claude");
  });

  it("a token-limit error flags the runtime_failure trace (Batch B1)", async () => {
    let call = 0;
    const provider: BridgeRuntimeProvider = {
      name: "tokenlimit",
      async decide() {
        call++;
        if (call === 1) throw Object.assign(new Error("HTTP 400 max_tokens"), { tokenLimit: true });
        return '{"action":"call"}';
      },
    };
    const { traces, onTrace } = collectTraces();
    const dp = buildBridgeDecisionProvider(provider, { onTrace });

    await dp.decide(makeCtx());

    const fail = traces.find((t) => t.type === "runtime_failure");
    expect(fail && fail.type === "runtime_failure" && fail.tokenLimit).toBe(true);
  });
});
