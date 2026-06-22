// Tests for runtime/src/games/texas_holdem/action-parser.ts.
//
// M1-14 contract: simple actions (check / call / fold / allin) return
// the original server-provided LegalAction reference; raise returns a
// fresh `{type:"raise", data:{amount}}` object because the LLM picks
// the concrete amount within the [min, max] window.

import { describe, expect, it } from "vitest";

import { parseTexasHoldemAction } from "../src/games/texas_holdem/action-parser";
import type { LegalAction } from "../src/decision/types";

function action(type: string, data?: Record<string, unknown>): LegalAction {
  return data === undefined ? { type } : { type, data };
}

describe("parseTexasHoldemAction", () => {
  it("happy path check returns server-provided LegalAction reference", () => {
    const checkAction = action("check");
    const legalActions = [checkAction, action("fold")];
    const result = parseTexasHoldemAction(
      '{"action":"check","data":{},"summary":"safe"}',
      legalActions,
    );

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.action).toBe(checkAction);
      expect(result.summary).toBe("safe");
    }
  });

  it("happy path raise returns reconstructed action with LLM amount", () => {
    const raiseAction = action("raise", { amount: 500, min: 500, max: 9000 });
    const legalActions = [action("fold"), raiseAction];
    const result = parseTexasHoldemAction(
      '{"action":"raise","data":{"amount":1000}}',
      legalActions,
    );

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.action.type).toBe("raise");
      expect(result.action.data).toEqual({ amount: 1000 });
      expect(result.action).not.toBe(raiseAction);
      expect(result.action.data).not.toBe(raiseAction.data);
    }
  });

  it("raise amount above max → data_validation invalid", () => {
    const raiseAction = action("raise", { amount: 500, min: 500, max: 9000 });
    const result = parseTexasHoldemAction(
      '{"action":"raise","data":{"amount":10000}}',
      [raiseAction],
    );

    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.reason).toBe("data_validation");
  });

  it("raise amount below min → data_validation invalid", () => {
    const raiseAction = action("raise", { amount: 500, min: 500, max: 9000 });
    const result = parseTexasHoldemAction(
      '{"action":"raise","data":{"amount":100}}',
      [raiseAction],
    );

    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.reason).toBe("data_validation");
  });

  it("strips ```json fenced blocks before parsing", () => {
    const checkAction = action("check");
    const result = parseTexasHoldemAction(
      '```json\n{"action":"check","data":{}}\n```',
      [checkAction],
    );

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.action).toBe(checkAction);
  });

  it("non-JSON output → json_parse invalid with rawSnippet", () => {
    const result = parseTexasHoldemAction(
      "Sorry, I cannot answer this.",
      [action("check")],
    );

    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.reason).toBe("json_parse");
      expect(result.rawSnippet).toBe("Sorry, I cannot answer this.");
    }
  });

  it("envelope without action field → missing_fields invalid", () => {
    const result = parseTexasHoldemAction(
      '{"data":{}}',
      [action("check")],
    );

    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.reason).toBe("missing_fields");
  });

  it("unknown action type (not in Texas enum) → unknown_action_type invalid", () => {
    const result = parseTexasHoldemAction(
      '{"action":"foo","data":{}}',
      [action("check")],
    );

    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.reason).toBe("unknown_action_type");
  });

  it("action in Texas enum but not in legalActions → action_not_legal invalid", () => {
    const result = parseTexasHoldemAction(
      '{"action":"raise","data":{"amount":500}}',
      [action("check"), action("fold")],
    );

    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.reason).toBe("action_not_legal");
  });

  it("rawSnippet truncates to provided cap when raw output is large", () => {
    const huge = "X".repeat(2000);
    const result = parseTexasHoldemAction(huge, [action("check")], 100);

    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.reason).toBe("json_parse");
      expect(result.rawSnippet?.length).toBe(100);
    }
  });
});
