// Tests for runtime/src/games/coup/fallback.ts.
//
// M1-13 rev2/rev3 contract: Coup fallback trusts server enumeration
// for targets, roles, card_index, and return_indices. Every successful
// selection returns the original LegalAction reference.

import { describe, expect, it } from "vitest";

import { fallbackCoup } from "../src/games/coup/fallback";
import type { LegalAction } from "../src/decision/types";
import type { CoupState } from "../src/protocol/types";

function action(type: string, data?: Record<string, unknown>): LegalAction {
  return data === undefined ? { type } : { type, data };
}

function state(over: Partial<CoupState> = {}): CoupState {
  return {
    phase: "action",
    current_turn: "p0",
    your_cards: ["Duke", "Assassin"],
    your_revealed: [],
    coins: 3,
    ...over,
  };
}

function run(
  legalActions: readonly LegalAction[],
  publicState: CoupState = state(),
): LegalAction {
  return fallbackCoup({
    publicState,
    legalActions,
    yourPlayerId: "p0",
  });
}

describe("fallbackCoup", () => {
  it("action phase prefers income", () => {
    const legalActions = [
      action("coup", { target: "p1" }),
      action("income"),
      action("foreign_aid"),
    ];

    expect(run(legalActions)).toBe(legalActions[1]);
  });

  it("action phase falls from income to foreign_aid", () => {
    const legalActions = [
      action("coup", { target: "p1" }),
      action("foreign_aid"),
      action("tax"),
    ];

    expect(run(legalActions)).toBe(legalActions[1]);
  });

  it("action phase returns the first server-enumerated coup target", () => {
    const firstCoup = action("coup", { target: "p1" });
    const secondCoup = action("coup", { target: "p2" });
    const legalActions = [action("exchange"), firstCoup, secondCoup, action("tax")];

    const result = run(legalActions);

    expect(result).toBe(firstCoup);
    expect(result.data).toBe(firstCoup.data);
  });

  it("action phase uses first coup when server made coup mandatory", () => {
    const legalActions = [
      action("coup", { target: "p2" }),
      action("coup", { target: "p1" }),
    ];

    expect(run(legalActions, state({ coins: 10 }))).toBe(legalActions[0]);
  });

  it("challenge_action phase prefers pass over challenge", () => {
    const legalActions = [action("challenge"), action("pass")];

    expect(
      run(
        legalActions,
        state({ phase: "challenge_action", pending_action: "tax" }),
      ),
    ).toBe(legalActions[1]);
  });

  it("challenge_block phase prefers pass over challenge", () => {
    const legalActions = [action("challenge"), action("pass")];

    expect(
      run(
        legalActions,
        state({ phase: "challenge_block", pending_action: "steal" }),
      ),
    ).toBe(legalActions[1]);
  });

  it("block phase prefers pass", () => {
    const legalActions = [action("block", { role: "Duke" }), action("pass")];

    expect(
      run(
        legalActions,
        state({ phase: "block", pending_action: "foreign_aid" }),
      ),
    ).toBe(legalActions[1]);
  });

  it("block phase returns server-provided role when pass is unavailable", () => {
    const blockData = { role: "Duke" };
    const legalActions = [action("block", blockData)];

    const result = run(
      legalActions,
      state({ phase: "block", pending_action: "foreign_aid" }),
    );

    expect(result).toBe(legalActions[0]);
    expect(result.data).toBe(blockData);
  });

  it("lose_influence phase trusts server-provided card_index", () => {
    const loseCardData = { card_index: 1 };
    const legalActions = [action("lose_card", loseCardData)];

    const result = run(
      legalActions,
      state({ phase: "lose_influence", influence_loser: "p0" }),
    );

    expect(result).toBe(legalActions[0]);
    expect(result.data).toBe(loseCardData);
  });

  it("exchange_return phase trusts server-provided return_indices", () => {
    const returnData = {
      return_indices: [1, 2],
      cards: ["Duke", "Captain"],
    };
    const legalActions = [action("return_cards", returnData)];

    const result = run(
      legalActions,
      state({
        phase: "exchange_return",
        all_exchange_options: ["Duke", "Assassin", "Captain", "Contessa"],
      }),
    );

    expect(result).toBe(legalActions[0]);
    expect(result.data).toBe(returnData);
  });

  it("falls through to the first legal action when no priority type matches", () => {
    const legalActions = [action("server_extension", { opaque: true })];

    expect(run(legalActions)).toBe(legalActions[0]);
  });

  it("throws when phase is done", () => {
    expect(() =>
      run([action("income")], state({ phase: "done", winner: "p0" })),
    ).toThrow("phase is done");
  });

  it("throws when legalActions is empty", () => {
    expect(() => run([])).toThrow("requires at least one legal action");
  });
});
