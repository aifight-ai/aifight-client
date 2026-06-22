// Tests for runtime/src/games/texas_holdem/fallback.ts.
//
// M1-13 rev3 contract: fallback is a dumb selector. Except for games
// that need to construct a new action (not Texas), tests use reference
// equality to prove the server-provided LegalAction object is returned
// unchanged.

import { describe, expect, it } from "vitest";

import { fallbackTexasHoldem } from "../src/games/texas_holdem/fallback";
import type { LegalAction } from "../src/decision/types";
import type { TexasHoldemState } from "../src/protocol/types";

function action(type: string, data?: Record<string, unknown>): LegalAction {
  return data === undefined ? { type } : { type, data };
}

function state(): TexasHoldemState {
  return {
    phase: "preflop",
    community_cards: [],
    pot: 600,
    current_bet: 400,
    dealer: 0,
    dealer_id: "p0",
    hand_num: 1,
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
}

function run(legalActions: readonly LegalAction[]): LegalAction {
  return fallbackTexasHoldem({
    publicState: state(),
    legalActions,
    yourPlayerId: "p1",
  });
}

describe("fallbackTexasHoldem", () => {
  it("prefers check over every other action", () => {
    const legalActions = [
      action("raise", { amount: 800, min: 800, max: 9000 }),
      action("fold"),
      action("check"),
      action("allin"),
      action("call", { amount: 200 }),
    ];

    expect(run(legalActions)).toBe(legalActions[2]);
  });

  it("prefers call when check is unavailable", () => {
    const legalActions = [
      action("raise", { amount: 800, min: 800, max: 9000 }),
      action("fold"),
      action("call", { amount: 200 }),
      action("allin"),
    ];

    expect(run(legalActions)).toBe(legalActions[2]);
  });

  it("prefers fold when check and call are unavailable", () => {
    const legalActions = [
      action("raise", { amount: 800, min: 800, max: 9000 }),
      action("allin"),
      action("fold"),
    ];

    expect(run(legalActions)).toBe(legalActions[2]);
  });

  it("prefers raise when only aggressive choices remain", () => {
    const legalActions = [
      action("allin"),
      action("raise", { amount: 800, min: 800, max: 9000 }),
    ];

    const result = run(legalActions);

    expect(result).toBe(legalActions[1]);
    expect(result.data).toBe(legalActions[1].data);
  });

  it("returns allin when it is the only priority action", () => {
    const legalActions = [action("allin", { amount: 9000 })];

    expect(run(legalActions)).toBe(legalActions[0]);
  });

  it("falls back to the first server-provided action for unknown types", () => {
    const legalActions = [
      action("wait_for_server_extension", { opaque: true }),
      action("another_extension"),
    ];

    expect(run(legalActions)).toBe(legalActions[0]);
  });

  it("does not reconstruct raise data", () => {
    const raiseData = { amount: 5000, min: 5000, max: 5000 };
    const legalActions = [action("raise", raiseData)];

    const result = run(legalActions);

    expect(result).toBe(legalActions[0]);
    expect(result.data).toBe(raiseData);
    expect(result).toEqual({ type: "raise", data: raiseData });
  });

  it("does not inspect publicState or yourPlayerId when selecting", () => {
    const legalActions = [action("call", { amount: 200 })];

    const result = fallbackTexasHoldem({
      publicState: { phase: "showdown" } as TexasHoldemState,
      legalActions,
      yourPlayerId: "missing-player",
    });

    expect(result).toBe(legalActions[0]);
  });

  it("throws when legalActions is empty", () => {
    expect(() => run([])).toThrow("requires at least one legal action");
  });
});
