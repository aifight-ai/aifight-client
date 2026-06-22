// Tests for runtime/src/games/liars_dice/fallback.ts.
//
// M1-13 rev2/rev3 contract: bid is the sole fallback that constructs a
// new action, because server LegalAction.data carries bid hints. All
// non-bid fallback choices return the original LegalAction reference.

import { describe, expect, it } from "vitest";

import { fallbackLiarsDice } from "../src/games/liars_dice/fallback";
import type { LegalAction } from "../src/decision/types";
import type { LiarsDiceState } from "../src/protocol/types";

function action(type: string, data?: Record<string, unknown>): LegalAction {
  return data === undefined ? { type } : { type, data };
}

function state(over: Partial<LiarsDiceState> = {}): LiarsDiceState {
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

function run(
  legalActions: readonly LegalAction[],
  publicState: LiarsDiceState = state(),
): LegalAction {
  return fallbackLiarsDice({
    publicState,
    legalActions,
    yourPlayerId: "p1",
  });
}

describe("fallbackLiarsDice", () => {
  it("builds an opening bid from server hints", () => {
    const result = run([
      action("bid", {
        min_quantity: 1,
        max_quantity: 5,
        min_face: 1,
        max_face: 6,
      }),
    ]);

    expect(result).toEqual({ type: "bid", data: { quantity: 1, face: 1 } });
  });

  it("builds a face-increment bid from server hints", () => {
    const result = run([
      action("bid", {
        current_quantity: 4,
        current_face: 5,
        min_quantity: 4,
        min_face: 6,
        max_quantity: 9,
      }),
    ]);

    expect(result).toEqual({ type: "bid", data: { quantity: 4, face: 6 } });
  });

  it("builds a quantity-wrap bid from server hints", () => {
    const result = run([
      action("bid", {
        current_quantity: 4,
        current_face: 6,
        min_quantity: 5,
        min_face: 1,
        max_quantity: 9,
      }),
    ]);

    expect(result).toEqual({ type: "bid", data: { quantity: 5, face: 1 } });
  });

  it("chooses challenge when server hints exceed max_quantity", () => {
    const legalActions = [
      action("bid", { min_quantity: 10, min_face: 1, max_quantity: 9 }),
      action("challenge"),
    ];

    expect(run(legalActions)).toBe(legalActions[1]);
  });

  it("falls back to publicState calculation when bid hints are missing", () => {
    const result = run([action("bid", {})]);

    expect(result).toEqual({ type: "bid", data: { quantity: 4, face: 6 } });
  });

  it("wraps publicState backup bid from face 6 to next quantity", () => {
    const result = run(
      [action("bid", {})],
      state({ current_bid: { quantity: 4, face: 6, bidder: "p0" } }),
    );

    expect(result).toEqual({ type: "bid", data: { quantity: 5, face: 1 } });
  });

  it("uses opening publicState backup only when total_dice is known", () => {
    const result = run([action("bid", {})], state({ current_bid: undefined }));

    expect(result).toEqual({ type: "bid", data: { quantity: 1, face: 1 } });
  });

  it("chooses challenge when backup bid would exceed total_dice", () => {
    const legalActions = [action("bid", {}), action("challenge")];

    expect(
      run(
        legalActions,
        state({
          current_bid: { quantity: 9, face: 6, bidder: "p0" },
          total_dice: 9,
        }),
      ),
    ).toBe(legalActions[1]);
  });

  it("returns challenge reference when bid is not legal", () => {
    const legalActions = [action("challenge")];

    expect(run(legalActions)).toBe(legalActions[0]);
  });

  it("prioritizes bid over challenge when both are legal", () => {
    const challenge = action("challenge");
    const result = run([
      challenge,
      action("bid", { min_quantity: 4, min_face: 6, max_quantity: 9 }),
    ]);

    expect(result).toEqual({ type: "bid", data: { quantity: 4, face: 6 } });
    expect(result).not.toBe(challenge);
  });

  it("falls through to the first action when bid cannot be constructed", () => {
    const legalActions = [action("bid", {})];

    expect(
      run(
        legalActions,
        state({
          current_bid: undefined,
          total_dice: undefined,
        }),
      ),
    ).toBe(legalActions[0]);
  });

  it("falls through to the first unknown action", () => {
    const legalActions = [action("server_extension", { opaque: true })];

    expect(run(legalActions)).toBe(legalActions[0]);
  });

  it("throws when legalActions is empty", () => {
    expect(() => run([])).toThrow("requires at least one legal action");
  });
});
