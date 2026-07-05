// Tests for runtime/src/games/texas_holdem/state-formatter.ts.
//
// Uses hand-written fixtures (no real server data, no snapshot — TED
// 拍板点 #14 contains-string assertions). Covers stateBlock core
// fields, recentEventsBlock 7 event templates, and PlayerInfo.data
// shape guard (rev2/rev3 + Risks #16) via Opponents-row sub-asserts.

import { describe, expect, it } from "vitest";

import { formatTexasHoldemState } from "../src/games/texas_holdem/state-formatter";
import type {
  Event,
  PlayerInfo,
  TexasHoldemRules,
  TexasHoldemState,
} from "../src/protocol/types";

const RULES: TexasHoldemRules = {
  name: "No-Limit Texas Hold'em",
  summary: "Standard NLHE.",
  available_actions: {
    fold: "Fold",
    check: "Check",
    call: "Call current bet",
    raise: "Raise to amount",
    allin: "Push all chips",
  },
  key_rules: ["Best 5-card hand wins."],
};

function baseState(over: Partial<TexasHoldemState> = {}): TexasHoldemState {
  return {
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
    ...over,
  };
}

const PLAYERS: readonly PlayerInfo[] = [
  { id: "p0", name: "Player 1", status: "active", data: { chips: 10000, bet: 400 } },
  { id: "p1", name: "Player 2", status: "active", data: { chips: 9000, bet: 200 } },
];

describe("formatTexasHoldemState", () => {
  it("cash format shows running results (cumulative net + bb/100)", () => {
    const out = formatTexasHoldemState({
      publicState: baseState({
        format: "cash",
        hands_completed: 6,
        big_blind: 100,
        players: [
          { id: "p0", status: "active", net: 1500 },
          { id: "p1", status: "active", net: -1500 },
        ],
      }),
      rules: RULES,
      players: PLAYERS,
      recentEvents: [],
      yourPlayerId: "p1",
    });
    expect(out.stateBlock).toContain("Running results (through 6 of 10 hands)");
    expect(out.stateBlock).toContain("p0: net +1500");
    expect(out.stateBlock).toContain("+250 bb/100");
    expect(out.stateBlock).toContain("p1 (you): net -1500");
    expect(out.stateBlock).toContain("-250 bb/100");
  });

  it("stateBlock contains all core fields", () => {
    const out = formatTexasHoldemState({
      publicState: baseState(),
      rules: RULES,
      players: PLAYERS,
      recentEvents: [],
      yourPlayerId: "p1",
    });
    expect(out.stateBlock).toContain("Hand 3 of 10 | Phase: preflop");
    expect(out.stateBlock).toContain("Blinds: 200/400");
    expect(out.stateBlock).toContain("Your hand: Ah Kd");
    expect(out.stateBlock).toContain("Board: (no community cards yet)");
    expect(out.stateBlock).toContain("Your position: BB");
    expect(out.stateBlock).toContain("Your chips: 9000 | Your current bet: 200");
    expect(out.stateBlock).toContain("Pot: 600 | Current bet to match: 400");
    expect(out.stateBlock).toContain("Need to call: 200");
    expect(out.stateBlock).toContain("Action order:");
  });

  it("Board renders community cards when present", () => {
    const out = formatTexasHoldemState({
      publicState: baseState({ phase: "flop", community_cards: ["7c", "9d", "Kh"] }),
      rules: RULES,
      players: PLAYERS,
      recentEvents: [],
      yourPlayerId: "p1",
    });
    expect(out.stateBlock).toContain("Board: 7c 9d Kh");
    expect(out.stateBlock).not.toContain("(no community cards yet)");
  });

  it("Need to call appears only when current_bet > your_bet", () => {
    const out = formatTexasHoldemState({
      publicState: baseState({ current_bet: 200, your_bet: 200 }),
      rules: RULES,
      players: PLAYERS,
      recentEvents: [],
      yourPlayerId: "p1",
    });
    expect(out.stateBlock).not.toContain("Need to call:");
  });

  it("Opponents render with PlayerInfo.data shape guard", () => {
    const players: PlayerInfo[] = [
      { id: "p0", name: "Player 1", status: "active", data: { chips: 10000, bet: 400 } },
      { id: "p1", name: "Player 2", status: "active", data: { chips: 9000, bet: 200 } },
      { id: "p2", name: "Player 3", status: "folded" }, // (b) data missing
      { id: "p3", name: "Player 4", status: "active", data: { chips: "bad" } as unknown as Record<string, unknown> }, // (c) wrong type
      { id: "p4", name: "Player 5", status: "all_in", data: { chips: 50 } }, // (d) bet missing → only chips
    ];
    const out = formatTexasHoldemState({
      publicState: baseState(),
      rules: RULES,
      players,
      recentEvents: [],
      yourPlayerId: "p1",
    });
    // (a) full data shows both chips + bet
    expect(out.stateBlock).toContain("Player 1 (p0): status=active | chips=10000 | bet=400");
    // your own line excluded
    expect(out.stateBlock).not.toContain("Player 2 (p1): status=active");
    // (b) data missing — only status, no chips/bet, never throws
    expect(out.stateBlock).toContain("Player 3 (p2): status=folded");
    expect(out.stateBlock).not.toContain("Player 3 (p2): status=folded |");
    // (c) wrong-type chips — omitted
    expect(out.stateBlock).toContain("Player 4 (p3): status=active");
    expect(out.stateBlock).not.toContain("chips=bad");
    // (d) only chips present, bet omitted
    expect(out.stateBlock).toContain("Player 5 (p4): status=all_in | chips=50");
    expect(out.stateBlock).not.toContain("Player 5 (p4): status=all_in | chips=50 | bet=");
  });

  it("recentEventsBlock renders 7 event templates", () => {
    const events: Event[] = [
      {
        type: "new_hand",
        seq: 1,
        ts: "2026-04-26T00:00:00Z",
        data: { hand_num: 3, max_hands: 10, dealer: "p0", chips: { p0: 10000, p1: 9000 }, small_blind: 200, big_blind: 400 },
      },
      {
        type: "player_action",
        player: "p0",
        seq: 2,
        ts: "2026-04-26T00:00:01Z",
        data: { action: "raise", amount: 800, total_bet: 800 },
      },
      {
        type: "community_cards",
        seq: 3,
        ts: "2026-04-26T00:00:02Z",
        data: { phase: "flop", cards: ["7c", "9d", "Kh"] },
      },
      {
        type: "cards_dealt",
        player: "p1",
        seq: 4,
        ts: "2026-04-26T00:00:03Z",
        data: { cards: ["Ah", "Kd"] },
      },
      {
        type: "hand_result",
        seq: 5,
        ts: "2026-04-26T00:00:04Z",
        data: { winners: ["p1"], pot: 1600, reason: "showdown" },
      },
      {
        type: "match_result",
        seq: 6,
        ts: "2026-04-26T00:00:05Z",
        data: { winner: "p1", final_chips: { p0: 0, p1: 19000 } },
      },
      {
        type: "player_disconnected",
        player: "p0",
        seq: 7,
        ts: "2026-04-26T00:00:06Z",
        data: { reason: "ws_close" },
      },
    ];
    const out = formatTexasHoldemState({
      publicState: baseState(),
      rules: RULES,
      players: PLAYERS,
      recentEvents: events,
      yourPlayerId: "p1",
    });
    expect(out.recentEventsBlock).toContain("Hand 3 began | dealer: Player 1 (p0) | blinds: 200/400");
    expect(out.recentEventsBlock).toContain("Player 1 (p0) raise 800 (total bet 800)");
    expect(out.recentEventsBlock).toContain("Flop: 7c 9d Kh");
    expect(out.recentEventsBlock).toContain("You were dealt: Ah Kd");
    expect(out.recentEventsBlock).toContain("Hand winners: you (p1) | pot 1600 (showdown)");
    expect(out.recentEventsBlock).toContain("Match over. Winner: you (p1)");
    expect(out.recentEventsBlock).toContain("Player 1 (p0) disconnected — reason: ws_close");
  });

  it("cards_dealt for another player does not leak cards", () => {
    const out = formatTexasHoldemState({
      publicState: baseState(),
      rules: RULES,
      players: PLAYERS,
      recentEvents: [
        { type: "cards_dealt", player: "p0", seq: 1, data: { cards: ["X1", "X2"] } },
      ],
      yourPlayerId: "p1",
    });
    expect(out.recentEventsBlock).not.toContain("X1");
    expect(out.recentEventsBlock).not.toContain("X2");
    expect(out.recentEventsBlock).toContain("Player 1 (p0) was dealt cards");
  });

  it("hand_result with reason=all_others_folded omits showdown", () => {
    const out = formatTexasHoldemState({
      publicState: baseState(),
      rules: RULES,
      players: PLAYERS,
      recentEvents: [
        { type: "hand_result", seq: 1, data: { winners: ["p0"], pot: 800, reason: "all_others_folded" } },
      ],
      yourPlayerId: "p1",
    });
    expect(out.recentEventsBlock).toContain("Hand winners: Player 1 (p0) | pot 800 (all_others_folded)");
  });

  it("empty recentEvents → placeholder string", () => {
    const out = formatTexasHoldemState({
      publicState: baseState(),
      rules: RULES,
      players: PLAYERS,
      recentEvents: [],
      yourPlayerId: "p1",
    });
    expect(out.recentEventsBlock).toBe("(no events since your last turn)");
  });

  it("missing your_hand / your_chips fields do not throw", () => {
    const minimalState = baseState({
      your_hand: undefined,
      your_chips: undefined,
      your_bet: undefined,
      your_position: undefined,
    });
    expect(() =>
      formatTexasHoldemState({
        publicState: minimalState,
        rules: RULES,
        players: PLAYERS,
        recentEvents: [],
        yourPlayerId: "p1",
      }),
    ).not.toThrow();
    const out = formatTexasHoldemState({
      publicState: minimalState,
      rules: RULES,
      players: PLAYERS,
      recentEvents: [],
      yourPlayerId: "p1",
    });
    expect(out.stateBlock).toContain("Phase: preflop");
    expect(out.stateBlock).not.toContain("Your hand:");
    expect(out.stateBlock).not.toContain("Your chips:");
    expect(out.stateBlock).not.toContain("Your position:");
  });

  it("missing action_order does not throw and omits the line", () => {
    const out = formatTexasHoldemState({
      publicState: baseState({ phase: "showdown", action_order: undefined }),
      rules: RULES,
      players: PLAYERS,
      recentEvents: [],
      yourPlayerId: "p1",
    });
    expect(out.stateBlock).not.toContain("Action order:");
  });
});
