// Tests for runtime/src/decision/prompt-builder.ts.
//
// Real formatters end-to-end (no vi.fn dispatch injection — TED rev3
// 拍板点 #14). Hand-written fixtures + contains-string assertions.

import { describe, expect, it } from "vitest";

import { buildPrompt } from "../src/decision/prompt-builder";
import type {
  DecisionRequest,
  GameType,
  LegalAction,
  StrategyProfile,
} from "../src/decision/types";
import type {
  CoupRules,
  CoupState,
  Event,
  LiarsDiceRules,
  LiarsDiceState,
  PlayerInfo,
  TexasHoldemRules,
  TexasHoldemState,
} from "../src/protocol/types";

// ─── Fixtures ───────────────────────────────────────────────────────

const TEXAS_RULES: TexasHoldemRules = {
  name: "No-Limit Texas Hold'em",
  summary: "Standard NLHE.",
  available_actions: {
    fold: "Fold",
    check: "Check",
    call: "Call current bet",
    raise: "Raise to amount",
    allin: "Push all chips",
  },
  key_rules: ["Best 5-card hand wins.", "Position matters."],
};

const LIARS_RULES: LiarsDiceRules = {
  name: "Liar's Dice",
  summary: "Bid escalating face counts; challenge if you think the bid is a lie.",
  available_actions: {
    bid: "Bid quantity + face",
    challenge: "Challenge prior bid",
  },
  key_rules: ["If bid face = 1, ones are NOT wild for this bid."],
};

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

function makeStrategy(over: Partial<StrategyProfile> = {}): StrategyProfile {
  return {
    name: "test-bot",
    version: 1,
    provider: "anthropic",
    model: "claude-opus-4-7",
    systemPrompt: "You are a thoughtful, balanced strategic player.",
    maxTokens: 1024,
    ...over,
  };
}

const PLAYERS: readonly PlayerInfo[] = [
  { id: "p0", name: "Player 1", status: "active", data: { chips: 10000, bet: 400 } },
  { id: "p1", name: "Player 2", status: "active", data: { chips: 9000, bet: 200 } },
];

function makeTexasReq(over: Partial<DecisionRequest> = {}): DecisionRequest {
  const state: TexasHoldemState = {
    phase: "preflop",
    community_cards: [],
    pot: 600,
    current_bet: 400,
    dealer: 0,
    dealer_id: "p0",
    hand_num: 3,
    max_hands: 10,
    small_blind: 200,
    big_blind: 400,
    current_player_id: "p1",
    action_order: ["p1", "p0"],
    your_hand: ["Ah", "Kd"],
    your_chips: 9000,
    your_bet: 200,
    your_seat: 1,
    your_position: "BB",
    your_player_id: "p1",
  };
  const legalActions: LegalAction[] = [
    { type: "fold", data: {} },
    { type: "call", data: { amount: 200 } },
    { type: "raise", data: { amount: 800, min: 800, max: 9000 } },
  ];
  return {
    game: "texas_holdem",
    matchId: "match-abc",
    playerId: "p1",
    rules: TEXAS_RULES,
    legalActions,
    publicState: state,
    players: PLAYERS,
    recentEvents: [],
    strategyProfile: makeStrategy(),
    turnTimeoutMs: 300_000,
    decisionBudgetMs: 60_000,
    ...over,
  };
}

function makeLiarsReq(over: Partial<DecisionRequest> = {}): DecisionRequest {
  const state: LiarsDiceState = {
    phase: "bidding",
    round: 2,
    current_bid: { quantity: 4, face: 5, bidder: "p0" },
    current_turn: "p1",
    total_dice: 9,
    your_dice: [3, 4, 5, 5],
    your_dice_count: 4,
  };
  const legalActions: LegalAction[] = [
    { type: "bid", data: { quantity: 5, face: 5 } },
    { type: "challenge", data: {} },
  ];
  return {
    game: "liars_dice",
    matchId: "match-ld-1",
    playerId: "p1",
    rules: LIARS_RULES,
    legalActions,
    publicState: state,
    players: [
      { id: "p0", name: "Player 1", status: "active", data: { dice_count: 5 } },
      { id: "p1", name: "Player 2", status: "active", data: { dice_count: 4 } },
    ],
    recentEvents: [],
    strategyProfile: makeStrategy(),
    turnTimeoutMs: 300_000,
    decisionBudgetMs: 60_000,
    ...over,
  };
}

function makeCoupReq(over: Partial<DecisionRequest> = {}): DecisionRequest {
  const state: CoupState = {
    phase: "action",
    current_turn: "p1",
    your_cards: ["Duke", "Assassin"],
    your_revealed: [],
    coins: 3,
  };
  const legalActions: LegalAction[] = [
    { type: "income", data: {} },
    { type: "foreign_aid", data: {} },
    { type: "tax", data: {} },
    { type: "steal", data: { target: "p0" } },
  ];
  return {
    game: "coup",
    matchId: "match-coup-1",
    playerId: "p1",
    rules: COUP_RULES,
    legalActions,
    publicState: state,
    players: [
      { id: "p0", name: "Player 1", status: "active", data: { coins: 4, hidden_cards: 2, revealed: [] } },
      { id: "p1", name: "Player 2", status: "active", data: { coins: 3, hidden_cards: 2, revealed: [] } },
    ],
    recentEvents: [],
    strategyProfile: makeStrategy(),
    turnTimeoutMs: 300_000,
    decisionBudgetMs: 60_000,
    ...over,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("buildPrompt — dispatch by game (real formatters, no mock)", () => {
  it("texas_holdem path produces Texas-specific anchors", () => {
    const out = buildPrompt(makeTexasReq());
    expect(out.userPrompt).toContain("Hand 3 of 10");
    expect(out.userPrompt).toContain("Your hand: Ah Kd");
    expect(out.userPrompt).toContain("Match: texas_holdem | match_id: match-abc | you are p1");
  });

  it("liars_dice path produces Liars-specific anchors", () => {
    const out = buildPrompt(makeLiarsReq());
    expect(out.userPrompt).toContain("Round 2");
    expect(out.userPrompt).toContain("Total dice in play: 9");
    expect(out.userPrompt).toContain("Your dice: [3 4 5 5] (count: 4)");
    expect(out.userPrompt).toContain("Match: liars_dice | match_id: match-ld-1");
  });

  it("coup path produces Coup-specific anchors", () => {
    const out = buildPrompt(makeCoupReq());
    expect(out.userPrompt).toContain("Phase: action");
    expect(out.userPrompt).toContain("Your unrevealed cards: [Duke, Assassin]");
    expect(out.userPrompt).toContain("Match: coup | match_id: match-coup-1");
  });
});

describe("buildPrompt — systemPrompt assembly order", () => {
  it("strategy.systemPrompt → Game Rules → Output format → Constraints", () => {
    const out = buildPrompt(makeTexasReq());
    const sp = out.systemPrompt;
    const idxStrategy = sp.indexOf("You are a thoughtful, balanced strategic player.");
    const idxRules = sp.indexOf("Game Rules — No-Limit Texas Hold'em:");
    const idxOutput = sp.indexOf("Output format:");
    const idxConstraints = sp.indexOf("Constraints:");
    expect(idxStrategy).toBeGreaterThanOrEqual(0);
    expect(idxRules).toBeGreaterThan(idxStrategy);
    expect(idxOutput).toBeGreaterThan(idxRules);
    expect(idxConstraints).toBeGreaterThan(idxOutput);
    expect(sp).toContain("Key rules:");
    expect(sp).toContain("- Best 5-card hand wins.");
    expect(sp).toContain("Available actions:");
    expect(sp).toContain("- raise: Raise to amount");
  });
});

describe("buildPrompt — userPrompt assembly order", () => {
  it("Match context → Recent events → Current state → Legal actions → Reminder", () => {
    const events: Event[] = [
      { type: "player_action", player: "p0", seq: 1, data: { action: "raise", amount: 400 } },
    ];
    const out = buildPrompt(makeTexasReq({ recentEvents: events }));
    const up = out.userPrompt;
    const idxMatch = up.indexOf("Match: texas_holdem");
    const idxEvents = up.indexOf("Recent events (incremental since your last turn):");
    const idxState = up.indexOf("Current state:");
    const idxLegal = up.indexOf("Legal actions:");
    const idxReminder = up.indexOf(
      "Reminder: respond with a single JSON object as specified in the system prompt.",
    );
    expect(idxMatch).toBe(0);
    expect(idxEvents).toBeGreaterThan(idxMatch);
    expect(idxState).toBeGreaterThan(idxEvents);
    expect(idxLegal).toBeGreaterThan(idxState);
    expect(idxReminder).toBeGreaterThan(idxLegal);
  });
});

describe("buildPrompt — gameSpecific.extraPrompt injection", () => {
  it("appears in systemPrompt between Game Rules and Output format when set", () => {
    const strat = makeStrategy({
      gameSpecific: {
        texas_holdem: { extraPrompt: "Bluff aggressively when in late position." },
      },
    });
    const out = buildPrompt(makeTexasReq({ strategyProfile: strat }));
    const sp = out.systemPrompt;
    expect(sp).toContain("Bluff aggressively when in late position.");
    const idxRules = sp.indexOf("Game Rules — No-Limit Texas Hold'em:");
    const idxExtra = sp.indexOf("Bluff aggressively");
    const idxOutput = sp.indexOf("Output format:");
    expect(idxExtra).toBeGreaterThan(idxRules);
    expect(idxOutput).toBeGreaterThan(idxExtra);
  });

  it("is absent when gameSpecific[game] is missing", () => {
    const out = buildPrompt(makeTexasReq());
    expect(out.systemPrompt).not.toContain("Bluff aggressively");
  });
});

describe("buildPrompt — legal_actions block", () => {
  it("renders 1-based numbered list with game-specific param hints", () => {
    const out = buildPrompt(makeTexasReq());
    const up = out.userPrompt;
    expect(up).toContain("Legal actions:");
    expect(up).toContain("1. fold — no parameters");
    expect(up).toContain("2. call — data: {amount=200}");
    expect(up).toContain("3. raise — data: {amount=800, min=800, max=9000}");
  });

  it("liars dice bid + challenge", () => {
    const out = buildPrompt(makeLiarsReq());
    expect(out.userPrompt).toContain("1. bid — data: {quantity=5, face=5}");
    expect(out.userPrompt).toContain("2. challenge — no parameters");
  });

  it("coup target + roleless variants", () => {
    const out = buildPrompt(makeCoupReq());
    expect(out.userPrompt).toContain("1. income — no parameters");
    expect(out.userPrompt).toContain("2. foreign_aid — no parameters");
    expect(out.userPrompt).toContain("3. tax — no parameters");
    expect(out.userPrompt).toContain("4. steal — data: {target=p0}");
  });
});

describe("buildPrompt — empty legal_actions", () => {
  it("renders placeholder line and does NOT throw", () => {
    expect(() => buildPrompt(makeTexasReq({ legalActions: [] }))).not.toThrow();
    const out = buildPrompt(makeTexasReq({ legalActions: [] }));
    expect(out.userPrompt).toContain("Legal actions:");
    expect(out.userPrompt).toContain("(none — no action required this turn)");
  });
});

describe("buildPrompt — userPromptCharCap hard cap (default 16384)", () => {
  it("trims events from head with marker, preserves minimum core, length <= cap", () => {
    // Construct 500 events to overflow default cap (16384)
    const events: Event[] = [];
    for (let i = 0; i < 500; i++) {
      events.push({
        type: "player_action",
        player: i % 2 === 0 ? "p0" : "p1",
        seq: i,
        data: { action: "raise", amount: 100 + i, total_bet: 100 + i },
      });
    }
    const out = buildPrompt(makeTexasReq({ recentEvents: events }));

    // Hard cap honored
    expect(out.userPrompt.length).toBeLessThanOrEqual(16384);

    // Minimum core preserved
    expect(out.userPrompt).toContain("Match: texas_holdem | match_id: match-abc | you are p1");
    expect(out.userPrompt).toContain("Legal actions:");
    expect(out.userPrompt).toContain(
      "Reminder: respond with a single JSON object as specified in the system prompt.",
    );

    // Truncation marker present
    expect(out.userPrompt).toContain("[... older events truncated to fit prompt budget ...]");
  });
});

describe("buildPrompt — userPromptCharCap extreme small value forces convergence", () => {
  it("cap=500 still preserves Match context + Legal actions + Reminder + state truncate marker", () => {
    const events: Event[] = [];
    for (let i = 0; i < 50; i++) {
      events.push({
        type: "player_action",
        player: "p0",
        seq: i,
        data: { action: "raise", amount: 100 + i, total_bet: 100 + i },
      });
    }
    const out = buildPrompt(makeTexasReq({ recentEvents: events }), {
      userPromptCharCap: 500,
    });

    // Hard cap honored at exact value
    expect(out.userPrompt.length).toBeLessThanOrEqual(500);

    // Minimum core preserved (Match context + Legal actions + Reminder)
    expect(out.userPrompt).toContain("Match: texas_holdem");
    expect(out.userPrompt).toContain("Legal actions:");
    expect(out.userPrompt).toContain(
      "Reminder: respond with a single JSON object as specified in the system prompt.",
    );

    // State truncate marker present (level (b)/(c) reached)
    expect(out.userPrompt).toContain("[... state truncated ...]");
  });
});

describe("buildPrompt — Step 3b: core-only fits but core + events marker does not", () => {
  it("drops events marker entirely when only true minimum core fits, length <= cap", () => {
    // For this Texas fixture, empirical lengths:
    //   - matchContext: "Match: texas_holdem | match_id: match-abc | you are p1" ≈ 54 chars
    //   - legalActionsSection: "Legal actions:\n1. fold — no parameters\n2. call ... " ≈ 117 chars
    //   - REMINDER_LINE ≈ 78 chars
    //   - true minimum core = matchContext + 2 + legalActionsSection + 2 + REMINDER_LINE ≈ 253 chars
    //   - events marker section ("\n\n" + EVENTS_HEADER + "\n" + EVENTS_TRUNC_MARKER) ≈ 107 chars
    // cap=280 fits true min core (253) but NOT min core + events marker (253+107=360).
    // Old algorithm would drop state then hard-slice the still-too-large
    // (min core + events marker) prompt to 280 chars, mangling Legal actions.
    // Step 3b fix: try assemble("", "") before hard-slicing.
    const cap = 280;
    const out = buildPrompt(makeTexasReq(), { userPromptCharCap: cap });

    // Hard cap honored
    expect(out.userPrompt.length).toBeLessThanOrEqual(cap);

    // True minimum core fully preserved (no slicing)
    expect(out.userPrompt).toContain("Match: texas_holdem | match_id: match-abc | you are p1");
    expect(out.userPrompt).toContain("Legal actions:");
    expect(out.userPrompt).toContain("1. fold — no parameters");
    expect(out.userPrompt).toContain("3. raise — data: {amount=800, min=800, max=9000}");
    expect(out.userPrompt).toContain(
      "Reminder: respond with a single JSON object as specified in the system prompt.",
    );

    // Events marker dropped (Step 3b's required assertion)
    expect(out.userPrompt).not.toContain("[... older events truncated to fit prompt budget ...]");
    expect(out.userPrompt).not.toContain("Recent events (incremental");

    // State dropped too (no room either)
    expect(out.userPrompt).not.toContain("Current state:");
    expect(out.userPrompt).not.toContain("[... state truncated ...]");
  });
});

describe("buildPrompt — empty strategyProfile.systemPrompt", () => {
  it("starts systemPrompt with Game Rules block when strategy text is empty", () => {
    const out = buildPrompt(
      makeTexasReq({ strategyProfile: makeStrategy({ systemPrompt: "" }) }),
    );
    expect(out.systemPrompt.startsWith("Game Rules — No-Limit Texas Hold'em:")).toBe(true);
    expect(out.systemPrompt).toContain("Output format:");
    expect(out.systemPrompt).toContain("Constraints:");
  });
});

describe("buildPrompt — opponent anonymization", () => {
  it("uses anonymized 'Player N' name from PlayerInfo and never leaks agent_name fields", () => {
    const playersWithLeak: PlayerInfo[] = [
      {
        id: "p0",
        name: "Player 1",
        status: "active",
        data: { chips: 10000, bet: 400 },
        // Defensive sanity: even if a caller smuggles agent_name onto PlayerInfo,
        // the formatter strictly reads id/name/status + helper-shape-guarded data
        // and must not include it.
        // @ts-expect-error — PlayerInfo schema has additionalProperties: false
        agent_name: "should-not-appear-claude-opus",
      },
      { id: "p1", name: "Player 2", status: "active", data: { chips: 9000, bet: 200 } },
    ];
    const out = buildPrompt(makeTexasReq({ players: playersWithLeak }));
    expect(out.userPrompt).toContain("Player 1 (p0):");
    expect(out.userPrompt).not.toContain("should-not-appear-claude-opus");
    expect(out.systemPrompt).not.toContain("should-not-appear-claude-opus");
  });
});

describe("buildPrompt — JSON output contract present in systemPrompt", () => {
  it("contains Output format section with required schema fragments", () => {
    const out = buildPrompt(makeTexasReq());
    expect(out.systemPrompt).toContain("Output format:");
    expect(out.systemPrompt).toContain('{"action"');
    expect(out.systemPrompt).toContain('"data"');
    expect(out.systemPrompt).toContain('"summary"');
    expect(out.systemPrompt).toContain("Do not wrap in markdown code blocks");
    expect(out.systemPrompt).toContain("Do not output any text outside the JSON object");
  });
});

describe("buildPrompt — unsupported game throws", () => {
  it("throws when req.game is not one of the 3 supported games", () => {
    const badReq = makeTexasReq({ game: "mahjong" as unknown as GameType });
    expect(() => buildPrompt(badReq)).toThrow(
      /buildPrompt: unsupported game: mahjong/,
    );
  });
});
