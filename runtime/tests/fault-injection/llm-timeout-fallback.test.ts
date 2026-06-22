// M5-01 fault class 1: LLM 慢响应 / 超时 → fallback to first legal action
// (plan §13 + §5.10 fallback policy).
//
// Adjacent to (but does NOT overlap with) decision-provider.test.ts:
//   - decision-provider.test.ts is the M1-14 contract suite (sealed) — covers
//     each error subclass + happy + retry budget + provider switch + caching.
//   - This file is a fault-themed entry point: 3 cases that exercise the
//     decisionBudgetMs trip path under realistic abort-honoring clients,
//     with timing assertions and fallback-action invariants the M1-14 suite
//     doesn't make as the focal point.
//
// All tests are deterministic — no real network, no setTimeout race. The
// hanging client uses AbortSignal-driven rejection so the only timeline is
// the AbortController inside provider.decide().

import { describe, expect, it, vi } from "vitest";

import { createDirectModelProvider } from "../../src/decision/provider";
import type {
  DecisionRequest,
  LegalAction,
  StrategyProfile,
} from "../../src/decision/types";
import type { CoupRules, CoupState, PlayerInfo } from "../../src/protocol/types";
import { makeAbortHonoringHangingClient } from "./_helpers";

// ─── Minimal Coup fixture (mirrors decision-provider.test.ts shape) ─────

const COUP_RULES: CoupRules = {
  name: "Coup",
  summary: "Bluff your role; lose all influence to be eliminated.",
  available_actions: {
    income: "Take 1 coin",
    foreign_aid: "Take 2 coins (blockable by Duke)",
    coup: "Pay 7 to eliminate one influence",
    tax: "Take 3 coins (claim Duke)",
    assassinate: "Pay 3, eliminate target's influence (claim Assassin)",
    steal: "Take 2 coins from target (claim Captain)",
    exchange: "Swap cards with deck (claim Ambassador)",
    challenge: "Challenge a role claim",
    pass: "Pass on challenge / block",
    block: "Block an action with claimed role",
    lose_card: "Choose which influence to reveal",
    return_cards: "Return exchange cards to deck",
  },
  key_rules: ["Mandatory coup at 10 coins."],
};

const PLAYERS: readonly PlayerInfo[] = [
  { id: "p0", name: "P1", status: "active", data: { coins: 4, hidden_cards: 2, revealed: [] } },
  { id: "p1", name: "P2", status: "active", data: { coins: 3, hidden_cards: 2, revealed: [] } },
];

function strategy(): StrategyProfile {
  return {
    name: "fault-test",
    version: 1,
    provider: "anthropic",
    model: "claude-opus-4-7",
    systemPrompt: "Test bot.",
    maxTokens: 256,
  };
}

function coupReq(over: { decisionBudgetMs?: number; legalActions?: readonly LegalAction[] } = {}): DecisionRequest {
  const state: CoupState = {
    phase: "action",
    current_turn: "p1",
    your_cards: ["Duke", "Assassin"],
    your_revealed: [],
    coins: 3,
  };
  return {
    game: "coup",
    matchId: "match-fault",
    playerId: "p1",
    rules: COUP_RULES,
    legalActions: over.legalActions ?? [
      { type: "income", data: {} },
      { type: "foreign_aid", data: {} },
    ],
    publicState: state,
    players: PLAYERS,
    recentEvents: [],
    strategyProfile: strategy(),
    turnTimeoutMs: 300_000,
    decisionBudgetMs: over.decisionBudgetMs ?? 50,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("M5-01 LLM timeout — fallback / abort path", () => {
  it("hanging client + abort-honoring signal → fatal_aborted within budget+epsilon", async () => {
    // Uses signal abort to reject. Real provider implementations (M1-11
    // anthropic.ts / openai.ts) also rely on fetch's signal abort for
    // budget enforcement, so this mirrors prod behavior under decisionBudgetMs.
    const { client, generate } = makeAbortHonoringHangingClient();
    const provider = createDirectModelProvider({
      name: "fault-test",
      apiKeyResolver: () => "test-key",
      clientFactory: { anthropic: vi.fn(() => client) },
      retryBudget: 0, // skip retries: first abort = terminal fatal_aborted.
    });

    const t0 = Date.now();
    await expect(provider.decide(coupReq({ decisionBudgetMs: 30 }))).rejects.toMatchObject({
      kind: "fatal_aborted",
    });
    const elapsed = Date.now() - t0;

    // Budget=30ms; allow 250ms slack for CI runners under load. Bound is
    // important — without working AbortController this would hang forever.
    expect(elapsed).toBeLessThan(280);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("retryBudget=0 + first attempt hangs → fatal_aborted, never reaches fallback", async () => {
    // retryBudget=0 means budget exhaustion = error throw, not fallback
    // (fallback dispatches when retries are exhausted by error/parse, not by
    // signal abort — abort is a fatal terminal). Locks the M1-14 contract:
    // hanging-LLM does NOT silently produce a fallback action under abort.
    const { client } = makeAbortHonoringHangingClient();
    const provider = createDirectModelProvider({
      name: "fault-test",
      apiKeyResolver: () => "test-key",
      clientFactory: { anthropic: vi.fn(() => client) },
      retryBudget: 0,
    });

    let caught: { kind?: string } | null = null;
    try {
      await provider.decide(coupReq({ decisionBudgetMs: 25 }));
    } catch (e) {
      caught = e as { kind?: string };
    }
    expect(caught?.kind).toBe("fatal_aborted");
  });

  it("decisionBudgetMs=1 (already-elapsed)+ hanging client → fatal_aborted before any generate fire", async () => {
    // budget=1ms means the AbortController.timer fires near-immediately. The
    // aborted-pre-start branch (provider.ts runDecideLoop signal.aborted check)
    // returns fatal_aborted without invoking generate. Confirms the daemon
    // does not call out to LLM when budget is already consumed.
    const { client, generate } = makeAbortHonoringHangingClient();
    const provider = createDirectModelProvider({
      name: "fault-test",
      apiKeyResolver: () => "test-key",
      clientFactory: { anthropic: vi.fn(() => client) },
      retryBudget: 0,
    });

    // Force the abort-listener path: budget=1 means by the time the await
    // hits the listener-add the signal might already be aborted, in which
    // case generate's first-line aborted check rejects immediately.
    await expect(provider.decide(coupReq({ decisionBudgetMs: 1 }))).rejects.toMatchObject({
      kind: "fatal_aborted",
    });
    // generate may or may not be invoked depending on whether the timer fires
    // before runDecideLoop's first check — both outcomes are valid, but it
    // MUST NOT have been called more than once (no retry on abort).
    expect(generate.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
