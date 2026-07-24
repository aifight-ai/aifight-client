// Texas narrated prompt path (owner 拍板 2026-07-22): the shipped direct-LLM
// bridge renders texas from the SAME narrated view the platform's house bots
// decide on, instead of dumping raw state JSON. Under test:
//  - state renders as sentences (hand X of Y, board, running results) and the
//    raw `"state":{...}` dump disappears; legal_actions stay verbatim JSON
//    (they are the response-shape contract).
//  - match history renders hand starts/results as sentences, and settlement
//    lines survive the event-count cap (per-street actions are dropped first).
//  - any shape surprise (non-object state) falls back to the legacy JSON
//    prompt byte-for-byte; non-texas games are untouched by construction.

import { afterEach, describe, expect, it } from "vitest";

import type { MatchEventRecord } from "../src/bridge/match-context-tracker";
import { clearAdapters, registerAdapter } from "../src/llm/adapter-registry";
import type { DecisionInput, LLMAdapter, LLMProfile } from "../src/llm/adapters/types";
import { createDirectLLMRuntimeProvider } from "../src/bridge/direct-llm-provider";
import type { BridgeRuntimeDecisionRequest } from "../src/bridge/provider";
import type { LLMConfig } from "../src/profile/config-schema";

function captureAdapter(): { adapter: LLMAdapter; seen: DecisionInput[] } {
  const seen: DecisionInput[] = [];
  const adapter: LLMAdapter = {
    protocol: "anthropic_messages",
    validateProfile: () => ({ ok: true, errors: [], warnings: [] }),
    probe: async (p: LLMProfile) => ({ success: true, latencyMs: 1, model: p.model, protocol: "anthropic_messages" }),
    generateDecision: async (input) => {
      seen.push(input);
      return { text: '{"action":"check"}', latencyMs: 1 };
    },
    estimateUsage: (_o, p) => ({
      protocol: "anthropic_messages",
      providerLabel: "anthropic_messages",
      model: p.model,
      latencyMs: 1,
      timestamp: "",
    }),
    redact: (raw) => raw,
  };
  return { adapter, seen };
}

const CONFIG: LLMConfig = {
  schemaVersion: 1,
  activeProfile: "main",
  profiles: { main: { protocol: "anthropic_messages", apiKeyRef: { type: "env", name: "K" }, model: "m" } },
  routing: { default: "main" },
};

const TEXAS_LEGAL = [
  { type: "check" },
  { type: "raise", data: { min: 100, max: 9100, amount: 100 } },
] as unknown as BridgeRuntimeDecisionRequest["legalActions"];

const TEXAS_STATE = {
  phase: "turn",
  format: "cash",
  hand_num: 7,
  max_hands: 10,
  hands_completed: 6,
  small_blind: 50,
  big_blind: 100,
  pot: 2100,
  current_bet: 0,
  your_hand: ["As", "Kd"],
  your_chips: 9100,
  your_bet: 0,
  your_player_id: "p0",
  your_position: "BTN",
  community_cards: ["Kc", "9h", "2s", "7d"],
  action_order: ["p1", "p0"],
  players: [
    { id: "p0", status: "active", chips: 9100, bet: 0, position: "BTN", net: 1500 },
    { id: "p1", status: "active", chips: 9100, bet: 0, position: "SB", net: -1500 },
  ],
};

function texasRequest(extra: Partial<BridgeRuntimeDecisionRequest>): BridgeRuntimeDecisionRequest {
  return {
    game: "texas_holdem",
    matchId: "s1",
    playerId: "p0",
    legalActions: TEXAS_LEGAL,
    publicState: TEXAS_STATE,
    timeoutMs: 30_000,
    ...extra,
  };
}

async function promptFor(extra: Partial<BridgeRuntimeDecisionRequest>): Promise<DecisionInput> {
  const { adapter, seen } = captureAdapter();
  process.env.K = "sk-test";
  try {
    const provider = createDirectLLMRuntimeProvider({
      agentSlug: "x",
      loadConfig: async () => CONFIG,
      registerAdapters: async () => {
        clearAdapters();
        registerAdapter(adapter);
      },
    });
    await provider.decide(texasRequest(extra));
    return seen[0]!;
  } finally {
    delete process.env.K;
  }
}

describe("buildDirectPrompt: texas narrated view", () => {
  afterEach(() => clearAdapters());

  it("renders the state as sentences and keeps legal_actions as verbatim JSON", async () => {
    const input = await promptFor({});
    expect(input.userPrompt).toContain("CURRENT TURN — Texas Hold'em, narrated view of the live state:");
    expect(input.userPrompt).toContain("Hand 7 of 10 | Phase: turn");
    expect(input.userPrompt).toContain("Blinds: 50/100");
    expect(input.userPrompt).toContain("Your hand: As Kd");
    expect(input.userPrompt).toContain("Board: Kc 9h 2s 7d");
    expect(input.userPrompt).toContain("Running results (through 6 of 10 hands)");
    expect(input.userPrompt).toContain("p0 (you): net +1500");
    expect(input.userPrompt).toContain("p1: net -1500");
    // Opponent seat data survives the narration via the synthesized PlayerInfo.
    expect(input.userPrompt).toContain("chips=9100");
    // The response contract stays machine-readable and verbatim.
    expect(input.userPrompt).toContain(JSON.stringify(TEXAS_LEGAL));
    // And the raw state dump is gone.
    expect(input.userPrompt).not.toContain('"state":');
    expect(input.userPrompt).not.toContain('"hand_num":7');
  });

  it("narrates history events and keeps settlement lines under event pressure", async () => {
    const events: MatchEventRecord[] = [];
    let seq = 1;
    events.push({
      seq: seq++,
      type: "new_hand",
      data: { hand_num: 1, dealer: "p1", small_blind: 50, big_blind: 100 },
    });
    events.push({
      seq: seq++,
      type: "hand_result",
      data: { winners: ["p0"], pot: 300, reason: "all_folded", hand: 1 },
    });
    // Flood with per-street actions well past the 80-event window.
    for (let i = 0; i < 120; i++) {
      events.push({ seq: seq++, type: "player_action", data: { action: "check" }, playerId: "p1" });
    }
    const input = await promptFor({ matchContext: { events } });
    // Narrated, not raw JSON lines.
    expect(input.userPrompt).toContain("Hand 1 began | dealer: Player p1 (p1) | blinds: 50/100");
    expect(input.userPrompt).toContain("Hand winners: you (p0) | pot 300 (all_folded)");
    expect(input.userPrompt).not.toContain('#2 hand_result {"winners"');
    // The flood dropped old actions (omission reported) but never the ledger.
    expect(input.userPrompt).toContain("earlier events omitted");
    expect(input.userPrompt).toContain("Player p1 (p1) check");
  });

  it("falls back to the legacy JSON prompt when the state is not an object", async () => {
    const input = await promptFor({ publicState: 42 });
    expect(input.userPrompt).toContain('"game":"texas_holdem"');
    expect(input.userPrompt).toContain('"state":42');
    expect(input.userPrompt).not.toContain("narrated view");
  });
});
