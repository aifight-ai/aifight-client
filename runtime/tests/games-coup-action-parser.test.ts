// Tests for runtime/src/games/coup/action-parser.ts.
//
// M1-14 contract: Coup never reconstructs `data`. Every targeted /
// roled / indexed / combo variant is enumerated by the server, so the
// parser looks up the matching enumerated entry and returns its
// reference (reference equality holds for every successful parse).

import { describe, expect, it } from "vitest";

import { parseCoupAction } from "../src/games/coup/action-parser";
import type { LegalAction } from "../src/decision/types";

function action(type: string, data?: Record<string, unknown>): LegalAction {
  return data === undefined ? { type } : { type, data };
}

describe("parseCoupAction", () => {
  it("income happy path returns server-provided LegalAction reference", () => {
    const incomeAction = action("income");
    const legalActions = [incomeAction, action("foreign_aid")];
    const result = parseCoupAction(
      '{"action":"income","data":{}}',
      legalActions,
    );

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.action).toBe(incomeAction);
  });

  it("coup with valid target returns matching enumerated entry", () => {
    const coupP0 = action("coup", { target: "p0" });
    const coupP2 = action("coup", { target: "p2" });
    const legalActions = [coupP0, coupP2, action("income")];
    const result = parseCoupAction(
      '{"action":"coup","data":{"target":"p2"}}',
      legalActions,
    );

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.action).toBe(coupP2);
      expect(result.action.data).toBe(coupP2.data);
    }
  });

  it("coup with target not in any enumerated entry → data_validation invalid", () => {
    const result = parseCoupAction(
      '{"action":"coup","data":{"target":"p99"}}',
      [action("coup", { target: "p1" }), action("coup", { target: "p2" })],
    );

    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.reason).toBe("data_validation");
  });

  it("coup missing target field → data_validation invalid", () => {
    const result = parseCoupAction(
      '{"action":"coup","data":{}}',
      [action("coup", { target: "p1" })],
    );

    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.reason).toBe("data_validation");
  });

  it("block with valid role returns matching enumerated entry", () => {
    const blockDuke = action("block", { role: "Duke" });
    const blockContessa = action("block", { role: "Contessa" });
    const legalActions = [action("pass"), blockDuke, blockContessa];
    const result = parseCoupAction(
      '{"action":"block","data":{"role":"Contessa"}}',
      legalActions,
    );

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.action).toBe(blockContessa);
  });

  it("block with role not enumerated → data_validation invalid", () => {
    const result = parseCoupAction(
      '{"action":"block","data":{"role":"Mage"}}',
      [action("block", { role: "Duke" })],
    );

    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.reason).toBe("data_validation");
  });

  it("lose_card with enumerated card_index returns matching entry", () => {
    const lose0 = action("lose_card", { card_index: 0 });
    const lose1 = action("lose_card", { card_index: 1 });
    const result = parseCoupAction(
      '{"action":"lose_card","data":{"card_index":1}}',
      [lose0, lose1],
    );

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.action).toBe(lose1);
  });

  it("lose_card with index outside enumerated range → data_validation invalid", () => {
    const result = parseCoupAction(
      '{"action":"lose_card","data":{"card_index":99}}',
      [action("lose_card", { card_index: 0 })],
    );

    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.reason).toBe("data_validation");
  });

  it("return_cards with matching combo returns enumerated entry", () => {
    const combo01 = action("return_cards", { return_indices: [0, 1] });
    const combo02 = action("return_cards", { return_indices: [0, 2] });
    const result = parseCoupAction(
      '{"action":"return_cards","data":{"return_indices":[0,2]}}',
      [combo01, combo02],
    );

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.action).toBe(combo02);
  });

  it("return_cards with non-matching combo → data_validation invalid", () => {
    const result = parseCoupAction(
      '{"action":"return_cards","data":{"return_indices":[5,6]}}',
      [
        action("return_cards", { return_indices: [0, 1] }),
        action("return_cards", { return_indices: [0, 2] }),
      ],
    );

    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.reason).toBe("data_validation");
  });

  it("strips fenced JSON and surfaces summary string", () => {
    const incomeAction = action("income");
    const result = parseCoupAction(
      '```json\n{"action":"income","data":{},"summary":"safe choice"}\n```',
      [incomeAction],
    );

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.action).toBe(incomeAction);
      expect(result.summary).toBe("safe choice");
    }
  });

  it("unknown action type → unknown_action_type invalid; non-JSON → json_parse", () => {
    const unknown = parseCoupAction(
      '{"action":"raise","data":{}}',
      [action("income")],
    );
    expect(unknown.kind).toBe("invalid");
    if (unknown.kind === "invalid") expect(unknown.reason).toBe("unknown_action_type");

    const broken = parseCoupAction("just text", [action("income")]);
    expect(broken.kind).toBe("invalid");
    if (broken.kind === "invalid") expect(broken.reason).toBe("json_parse");
  });
});
