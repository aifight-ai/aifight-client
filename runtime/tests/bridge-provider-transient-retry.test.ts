// Batch A — type-aware, budget-bounded transient retry in the decision loop.
// A retryable API failure (rate_limit / server / timeout / network) earns a
// backed-off retry; a non-retryable one (auth / config / quota / content_filter
// / token_limit) falls straight through to the deterministic fallback with no
// wasted call. The failure trace carries the classification.

import { describe, expect, it } from "vitest";

import {
  buildBridgeDecisionProvider,
  type BridgeDecisionTrace,
  type BridgeRuntimeDecisionRequest,
  type BridgeRuntimeProvider,
} from "../src/bridge/provider";
import { AdapterError, type AdapterErrorKind } from "../src/llm/adapters/types";
import type { AgentDecisionContext } from "../src/agents/agent";
import type { MsgActionRequest } from "../src/protocol/types";

const LEGAL_ACTIONS = [{ type: "fold" }, { type: "call" }] as const;

function makeCtx(timeoutMs = 60_000): AgentDecisionContext {
  const actionRequest = {
    type: "action_request",
    match_id: "m-1",
    data: { state: { your_player_id: "p0" }, legal_actions: [...LEGAL_ACTIONS], timeout_ms: timeoutMs },
  } as unknown as MsgActionRequest;
  return { actionRequest, matchId: "m-1", game: "texas_holdem", state: "in_match" } as unknown as AgentDecisionContext;
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

function failTrace(traces: BridgeDecisionTrace[]) {
  const f = traces.find((t) => t.type === "runtime_failure");
  if (!f || f.type !== "runtime_failure") throw new Error("no runtime_failure trace");
  return f;
}

/** A provider that throws `errs[i]` on call i, then returns valid JSON. */
function throwingProvider(errs: readonly unknown[]) {
  const requests: BridgeRuntimeDecisionRequest[] = [];
  const provider: BridgeRuntimeProvider = {
    name: "throwy",
    async decide(req) {
      requests.push(req);
      const i = requests.length - 1;
      if (i < errs.length) throw errs[i];
      return '{"action":"call"}';
    },
  };
  return { provider, requests };
}

const ae = (kind: AdapterErrorKind, message = "") => new AdapterError(kind, "anthropic_messages", message);

describe("bridge provider transient retry (Batch A)", () => {
  it("does NOT retry an auth failure → one call, straight to fallback, classified", async () => {
    const { provider, requests } = throwingProvider([ae("auth_failed", "HTTP 401 invalid key")]);
    const { traces, onTrace } = collectTraces();
    await buildBridgeDecisionProvider(provider, { onTrace }).decide(makeCtx());
    expect(requests).toHaveLength(1); // no wasted retry on a key that can't work
    expect(finalTrace(traces).decisionSource).toBe("fallback");
    expect(failTrace(traces).errorClass).toBe("auth");
  });

  it("does NOT retry a config (bad request) failure", async () => {
    const { provider, requests } = throwingProvider([ae("invalid_request", "HTTP 400 unknown model")]);
    const { traces, onTrace } = collectTraces();
    await buildBridgeDecisionProvider(provider, { onTrace }).decide(makeCtx());
    expect(requests).toHaveLength(1);
    expect(failTrace(traces).errorClass).toBe("config");
  });

  it("does NOT retry an exhausted-quota 429 (classified quota, not rate_limit)", async () => {
    const { provider, requests } = throwingProvider([ae("rate_limited", "You exceeded your current quota / billing")]);
    const { traces, onTrace } = collectTraces();
    await buildBridgeDecisionProvider(provider, { onTrace }).decide(makeCtx());
    expect(requests).toHaveLength(1);
    expect(failTrace(traces).errorClass).toBe("quota");
  });

  it("retries a server error and succeeds on the next attempt", async () => {
    const { provider, requests } = throwingProvider([ae("server_error", "HTTP 503")]);
    const { traces, onTrace } = collectTraces();
    const action = await buildBridgeDecisionProvider(provider, { onTrace }).decide(makeCtx());
    expect(requests).toHaveLength(2); // one backed-off retry, then success
    expect(action).toMatchObject({ action: { type: "call" }, decision: { source: "model" } });
    expect(failTrace(traces).errorClass).toBe("server");
  });

  it("honors the default of 2 transient retries (3 attempts) before falling back", async () => {
    const { provider, requests } = throwingProvider([ae("server_error"), ae("server_error"), ae("server_error"), ae("server_error")]);
    const { traces, onTrace } = collectTraces();
    await buildBridgeDecisionProvider(provider, { onTrace }).decide(makeCtx());
    expect(requests).toHaveLength(3); // 1 + 2 retries, then fallback
    expect(finalTrace(traces).decisionSource).toBe("fallback");
  });

  it("transientRetryCount=0 → no transient retry at all", async () => {
    const { provider, requests } = throwingProvider([ae("network", "ECONNRESET")]);
    const { traces, onTrace } = collectTraces();
    await buildBridgeDecisionProvider(provider, { onTrace, transientRetryCount: 0 }).decide(makeCtx());
    expect(requests).toHaveLength(1);
    expect(failTrace(traces).errorClass).toBe("network");
  });

  it("skips the retry when too little turn budget remains", async () => {
    const { provider, requests } = throwingProvider([ae("server_error", "HTTP 500")]);
    const { traces, onTrace } = collectTraces();
    // 1s budget < backoff + MIN_TRANSIENT_RETRY_BUDGET_MS → no second call.
    await buildBridgeDecisionProvider(provider, { onTrace }).decide(makeCtx(1_000));
    expect(requests).toHaveLength(1);
    expect(finalTrace(traces).decisionSource).toBe("fallback");
  });

  it("a token-limit error is not retried here (owned by the self-heal)", async () => {
    const tokenErr = new AdapterError("invalid_request", "anthropic_messages", "max_tokens exceeded", { tokenLimit: true });
    const { provider, requests } = throwingProvider([tokenErr]);
    const { traces, onTrace } = collectTraces();
    await buildBridgeDecisionProvider(provider, { onTrace }).decide(makeCtx());
    expect(requests).toHaveLength(1);
    const fail = failTrace(traces);
    expect(fail.errorClass).toBe("token_limit");
    expect(fail.tokenLimit).toBe(true);
  });

  // R13-F06: the loop takes its transient-retry budget from the profile (surfaced
  // by the provider) instead of the always-2 default. A declared 0 → a single
  // attempt even on a retryable error — distinct from the default's 3 attempts.
  it("F-06: honors a provider-declared transientRetryCount of 0 (no retry on a retryable error)", async () => {
    let calls = 0;
    const provider: BridgeRuntimeProvider = {
      name: "declared-zero",
      transientRetryCount: () => 0,
      async decide() {
        calls++;
        throw new AdapterError("server_error", "anthropic_messages", "HTTP 500");
      },
    };
    const { traces, onTrace } = collectTraces();
    await buildBridgeDecisionProvider(provider, { onTrace }).decide(makeCtx());
    expect(calls).toBe(1);
    expect(finalTrace(traces).source).toBe("fallback");
  });

  it("F-06: awaits an async provider-declared transientRetryCount", async () => {
    let calls = 0;
    const provider: BridgeRuntimeProvider = {
      name: "declared-async-zero",
      transientRetryCount: async () => 0,
      async decide() {
        calls++;
        throw new AdapterError("network", "anthropic_messages", "ECONNRESET");
      },
    };
    const { onTrace } = collectTraces();
    await buildBridgeDecisionProvider(provider, { onTrace }).decide(makeCtx());
    expect(calls).toBe(1);
  });

  // R13-F02: the supersede AbortSignal on the decision context reaches the
  // runtime request, so the direct-LLM provider can bind it to the adapter fetch.
  it("F-02: forwards the ctx supersede signal into the runtime request", async () => {
    const controller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const provider: BridgeRuntimeProvider = {
      name: "signal-capture",
      async decide(req) {
        seen.push(req.signal);
        return '{"action":"call"}';
      },
    };
    const ctx = makeCtx();
    (ctx as { signal?: AbortSignal }).signal = controller.signal;
    await buildBridgeDecisionProvider(provider, {}).decide(ctx);
    expect(seen[0]).toBe(controller.signal);
  });
});
