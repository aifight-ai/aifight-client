// Tests for runtime/src/games/liars_dice/state-formatter.ts.
//
// Hand-written fixtures, contains-string assertions, no snapshot.

import { describe, expect, it } from "vitest";

import { formatLiarsDiceState } from "../src/games/liars_dice/state-formatter";
import type {
  Event,
  LiarsDiceRules,
  LiarsDiceState,
  PlayerInfo,
} from "../src/protocol/types";

const RULES: LiarsDiceRules = {
  name: "Liar's Dice",
  summary: "Each round, players make escalating bids about the total face counts.",
  available_actions: {
    bid: "Bid quantity + face",
    challenge: "Challenge prior bid",
  },
  key_rules: [
    "If bid face = 1, ones are NOT wild for this bid.",
    "Bid quantity must not exceed total_dice in play.",
  ],
};

function baseState(over: Partial<LiarsDiceState> = {}): LiarsDiceState {
  return {
    phase: "bidding",
    round: 2,
    current_bid: { quantity: 4, face: 5, bidder: "p0" },
    current_turn: "p1",
    total_dice: 9,
    your_dice: [3, 4, 5, 5],
    your_dice_count: 4,
    ...over,
  };
}

const PLAYERS: readonly PlayerInfo[] = [
  { id: "p0", name: "Player 1", status: "active", data: { dice_count: 5 } },
  { id: "p1", name: "Player 2", status: "active", data: { dice_count: 4 } },
];

describe("formatLiarsDiceState", () => {
  it("stateBlock core fields", () => {
    const out = formatLiarsDiceState({
      publicState: baseState(),
      rules: RULES,
      players: PLAYERS,
      recentEvents: [],
      yourPlayerId: "p1",
    });
    expect(out.stateBlock).toContain("Round 2 | Phase: bidding");
    expect(out.stateBlock).toContain("Total dice in play: 9");
    expect(out.stateBlock).toContain("Your dice: [3 4 5 5] (count: 4)");
    expect(out.stateBlock).toContain("Current bid: quantity=4 face=5 by Player 1 (p0)");
    expect(out.stateBlock).toContain("Current turn: you (p1)");
  });

  it("Current bid: (none) when current_bid is missing", () => {
    const out = formatLiarsDiceState({
      publicState: baseState({ current_bid: undefined }),
      rules: RULES,
      players: PLAYERS,
      recentEvents: [],
      yourPlayerId: "p1",
    });
    expect(out.stateBlock).toContain("Current bid: (none — you may bid any opening bid)");
  });

  it("eliminated player → your_dice undefined falls back to count line", () => {
    const out = formatLiarsDiceState({
      publicState: baseState({ your_dice: undefined, your_dice_count: 0 }),
      rules: RULES,
      players: PLAYERS,
      recentEvents: [],
      yourPlayerId: "p1",
    });
    expect(out.stateBlock).toContain("Your dice: (eliminated or not visible) (count: 0)");
  });

  it("recentEventsBlock renders 6 event templates", () => {
    const events: Event[] = [
      { type: "bid", player: "p0", seq: 1, data: { quantity: 4, face: 5 } },
      {
        type: "challenge",
        player: "p1",
        seq: 2,
        data: {
          challenger: "p1",
          bidder: "p0",
          bid_quantity: 4,
          bid_face: 5,
          actual_count: 3,
          bid_met: false,
          all_dice: { p0: [3, 4, 5, 5], p1: [1, 2, 2, 3] },
          loser: "p0",
        },
      },
      { type: "player_eliminated", player: "p0", seq: 3, data: { player: "p0" } },
      { type: "round_start", seq: 4, data: { round: 3, dice_counts: { p0: 4, p1: 4 } } },
      { type: "game_over", seq: 5, data: { winner: "p1" } },
      { type: "player_disconnected", player: "p0", seq: 6, data: { player: "p0" } },
    ];
    const out = formatLiarsDiceState({
      publicState: baseState(),
      rules: RULES,
      players: PLAYERS,
      recentEvents: events,
      yourPlayerId: "p1",
    });
    expect(out.recentEventsBlock).toContain("Player 1 (p0) bid: quantity 4 face 5");
    expect(out.recentEventsBlock).toContain("you (p1) challenged Player 1 (p0)'s bid (4 5s)");
    expect(out.recentEventsBlock).toContain("Actual count: 3");
    expect(out.recentEventsBlock).toContain("bid_met=false");
    expect(out.recentEventsBlock).toContain("Player 1 (p0) loses 1 die");
    expect(out.recentEventsBlock).toContain("Revealed dice: p0=[3,4,5,5], p1=[1,2,2,3]");
    expect(out.recentEventsBlock).toContain("Player 1 (p0) eliminated");
    expect(out.recentEventsBlock).toContain("Round 3 began");
    expect(out.recentEventsBlock).toContain("Dice counts: p0=4, p1=4");
    expect(out.recentEventsBlock).toContain("Game over. Winner: you (p1)");
    expect(out.recentEventsBlock).toContain("Player 1 (p0) disconnected");
  });

  it("challenge event with bid_met=true renders correctly", () => {
    const out = formatLiarsDiceState({
      publicState: baseState(),
      rules: RULES,
      players: PLAYERS,
      recentEvents: [
        {
          type: "challenge",
          player: "p1",
          seq: 1,
          data: {
            challenger: "p1",
            bidder: "p0",
            bid_quantity: 3,
            bid_face: 5,
            actual_count: 4,
            bid_met: true,
            all_dice: { p0: [5, 5, 5], p1: [1, 5, 6] },
            loser: "p1",
          },
        },
      ],
      yourPlayerId: "p1",
    });
    expect(out.recentEventsBlock).toContain("bid_met=true");
    expect(out.recentEventsBlock).toContain("you (p1) loses 1 die");
  });

  it("rules.key_rules face=1 wild reminder is not formatter responsibility (sanity)", () => {
    // formatter does not embed rules text; that goes through prompt-builder
    // (Step 3) — sanity: stateBlock does not contain rules.key_rules text
    const out = formatLiarsDiceState({
      publicState: baseState(),
      rules: RULES,
      players: PLAYERS,
      recentEvents: [],
      yourPlayerId: "p1",
    });
    expect(out.stateBlock).not.toContain("ones are NOT wild");
  });

  it("Opponents render with PlayerInfo.data shape guard", () => {
    const players: PlayerInfo[] = [
      { id: "p0", name: "Player 1", status: "active", data: { dice_count: 5 } }, // (a) full
      { id: "p1", name: "Player 2", status: "active" }, // (we are this player; excluded)
      { id: "p2", name: "Player 3", status: "active" }, // (b) data missing
      { id: "p3", name: "Player 4", status: "eliminated", data: { dice_count: "bad" } as unknown as Record<string, unknown> }, // (c) wrong type
    ];
    const out = formatLiarsDiceState({
      publicState: baseState(),
      rules: RULES,
      players,
      recentEvents: [],
      yourPlayerId: "p1",
    });
    expect(out.stateBlock).toContain("Player 1 (p0): status=active | dice_count=5");
    expect(out.stateBlock).not.toContain("Player 2 (p1):"); // self excluded
    expect(out.stateBlock).toContain("Player 3 (p2): status=active");
    expect(out.stateBlock).not.toContain("Player 3 (p2): status=active |");
    expect(out.stateBlock).toContain("Player 4 (p3): status=eliminated");
    expect(out.stateBlock).not.toContain("dice_count=bad");
  });

  it("empty recentEvents → placeholder string", () => {
    const out = formatLiarsDiceState({
      publicState: baseState(),
      rules: RULES,
      players: PLAYERS,
      recentEvents: [],
      yourPlayerId: "p1",
    });
    expect(out.recentEventsBlock).toBe("(no events since your last turn)");
  });

  it("missing current_turn at phase=done does not throw and omits the line", () => {
    const out = formatLiarsDiceState({
      publicState: baseState({ phase: "done", current_turn: undefined, current_bid: undefined }),
      rules: RULES,
      players: PLAYERS,
      recentEvents: [],
      yourPlayerId: "p1",
    });
    expect(out.stateBlock).toContain("Phase: done");
    expect(out.stateBlock).not.toContain("Current turn:");
  });

  it("missing total_dice does not throw and omits the line", () => {
    const out = formatLiarsDiceState({
      publicState: baseState({ phase: "done", total_dice: undefined }),
      rules: RULES,
      players: PLAYERS,
      recentEvents: [],
      yourPlayerId: "p1",
    });
    expect(out.stateBlock).not.toContain("Total dice in play:");
  });
});
