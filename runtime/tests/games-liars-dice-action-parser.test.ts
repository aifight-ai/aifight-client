// Tests for runtime/src/games/liars_dice/action-parser.ts.
//
// M1-14 contract: challenge returns the original server-provided
// LegalAction reference; bid returns a fresh `{type:"bid", data:
// {quantity, face}}` object because the LLM picks the concrete pair
// within the server hint window. Validation enforces:
//   - quantity / face are finite integers, face in [1, 6].
//   - quantity >= min_quantity, quantity <= max_quantity (when hints present).
//   - When quantity === min_quantity, face >= min_face.
//   - Hints fully missing → weak validation only (numbers + face range).

import { describe, expect, it } from "vitest";

import { parseLiarsDiceAction } from "../src/games/liars_dice/action-parser";
import type { LegalAction } from "../src/decision/types";

function action(type: string, data?: Record<string, unknown>): LegalAction {
  return data === undefined ? { type } : { type, data };
}

describe("parseLiarsDiceAction", () => {
  it("bid happy path with hints returns reconstructed bid", () => {
    const bidAction = action("bid", {
      min_quantity: 3,
      min_face: 4,
      max_quantity: 8,
    });
    const result = parseLiarsDiceAction(
      '{"action":"bid","data":{"quantity":3,"face":4}}',
      [bidAction, action("challenge")],
    );

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.action.type).toBe("bid");
      expect(result.action.data).toEqual({ quantity: 3, face: 4 });
      expect(result.action).not.toBe(bidAction);
    }
  });

  it("bid quantity below min_quantity → data_validation invalid", () => {
    const bidAction = action("bid", {
      min_quantity: 3,
      min_face: 4,
      max_quantity: 8,
    });
    const result = parseLiarsDiceAction(
      '{"action":"bid","data":{"quantity":2,"face":4}}',
      [bidAction],
    );

    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.reason).toBe("data_validation");
  });

  it("bid quantity above max_quantity → data_validation invalid", () => {
    const bidAction = action("bid", {
      min_quantity: 3,
      min_face: 4,
      max_quantity: 8,
    });
    const result = parseLiarsDiceAction(
      '{"action":"bid","data":{"quantity":10,"face":4}}',
      [bidAction],
    );

    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.reason).toBe("data_validation");
  });

  it("bid same quantity but face below min_face → data_validation invalid", () => {
    const bidAction = action("bid", {
      min_quantity: 3,
      min_face: 4,
      max_quantity: 8,
    });
    const result = parseLiarsDiceAction(
      '{"action":"bid","data":{"quantity":3,"face":3}}',
      [bidAction],
    );

    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.reason).toBe("data_validation");
  });

  it("bid higher quantity → any face 1..6 accepted", () => {
    const bidAction = action("bid", {
      min_quantity: 3,
      min_face: 4,
      max_quantity: 8,
    });
    const result = parseLiarsDiceAction(
      '{"action":"bid","data":{"quantity":4,"face":1}}',
      [bidAction],
    );

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.action.data).toEqual({ quantity: 4, face: 1 });
    }
  });

  it("bid face out of 1..6 → data_validation invalid", () => {
    const bidAction = action("bid", {
      min_quantity: 1,
      min_face: 1,
      max_quantity: 8,
    });

    const tooLow = parseLiarsDiceAction(
      '{"action":"bid","data":{"quantity":3,"face":0}}',
      [bidAction],
    );
    expect(tooLow.kind).toBe("invalid");
    if (tooLow.kind === "invalid") expect(tooLow.reason).toBe("data_validation");

    const tooHigh = parseLiarsDiceAction(
      '{"action":"bid","data":{"quantity":3,"face":7}}',
      [bidAction],
    );
    expect(tooHigh.kind).toBe("invalid");
    if (tooHigh.kind === "invalid") expect(tooHigh.reason).toBe("data_validation");
  });

  it("bid hints fully missing → weak validation accepts numeric pair", () => {
    const bidAction = action("bid", {});
    const result = parseLiarsDiceAction(
      '{"action":"bid","data":{"quantity":3,"face":4}}',
      [bidAction],
    );

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.action.data).toEqual({ quantity: 3, face: 4 });
    }
  });

  it("challenge happy path returns server-provided LegalAction reference", () => {
    const challengeAction = action("challenge");
    const result = parseLiarsDiceAction(
      '{"action":"challenge","data":{}}',
      [challengeAction],
    );

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.action).toBe(challengeAction);
  });

  it("LLM outputs challenge but legalActions only has bid → action_not_legal", () => {
    const result = parseLiarsDiceAction(
      '{"action":"challenge","data":{}}',
      [action("bid", { min_quantity: 1, min_face: 1, max_quantity: 5 })],
    );

    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.reason).toBe("action_not_legal");
  });

  it("strips fenced JSON and rejects non-JSON / missing fields", () => {
    const fenced = parseLiarsDiceAction(
      '```json\n{"action":"challenge","data":{}}\n```',
      [action("challenge")],
    );
    expect(fenced.kind).toBe("ok");

    const garbage = parseLiarsDiceAction("nope", [action("challenge")]);
    expect(garbage.kind).toBe("invalid");
    if (garbage.kind === "invalid") expect(garbage.reason).toBe("json_parse");

    const missing = parseLiarsDiceAction('{"data":{}}', [action("challenge")]);
    expect(missing.kind).toBe("invalid");
    if (missing.kind === "invalid") expect(missing.reason).toBe("missing_fields");
  });
});
