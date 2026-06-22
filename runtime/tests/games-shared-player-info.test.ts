// Helper unit tests for runtime/src/games/_shared/player-info.ts.
//
// Locks shape-guard behavior so the 3 game state-formatters share a
// single source of truth (M1-12 TED rev3 PlayerInfo 字段读取合同 +
// Risks #16). Per-game formatter tests still cover the integration
// shape, but these isolate the helper contract.

import { describe, expect, it } from "vitest";

import {
  readNumberField,
  readStringArrayField,
} from "../src/games/_shared/player-info";

describe("readNumberField", () => {
  it("returns the value for valid numbers (positive / zero / negative)", () => {
    expect(readNumberField({ chips: 100 }, "chips")).toBe(100);
    expect(readNumberField({ chips: 0 }, "chips")).toBe(0);
    expect(readNumberField({ chips: -5 }, "chips")).toBe(-5);
    expect(readNumberField({ chips: 3.14 }, "chips")).toBe(3.14);
  });

  it("returns undefined when data is missing / null / non-object", () => {
    expect(readNumberField(undefined, "chips")).toBeUndefined();
    expect(readNumberField(null, "chips")).toBeUndefined();
    expect(readNumberField("not an object", "chips")).toBeUndefined();
    expect(readNumberField(123, "chips")).toBeUndefined();
    expect(readNumberField(true, "chips")).toBeUndefined();
    expect(readNumberField({}, "chips")).toBeUndefined();
    expect(readNumberField({ other_key: 100 }, "chips")).toBeUndefined();
  });

  it("returns undefined for wrong-type / non-finite numbers", () => {
    expect(readNumberField({ chips: "100" }, "chips")).toBeUndefined();
    expect(readNumberField({ chips: null }, "chips")).toBeUndefined();
    expect(readNumberField({ chips: NaN }, "chips")).toBeUndefined();
    expect(readNumberField({ chips: Infinity }, "chips")).toBeUndefined();
    expect(readNumberField({ chips: -Infinity }, "chips")).toBeUndefined();
    expect(readNumberField({ chips: true }, "chips")).toBeUndefined();
    expect(readNumberField({ chips: [100] }, "chips")).toBeUndefined();
    expect(readNumberField({ chips: { value: 100 } }, "chips")).toBeUndefined();
  });
});

describe("readStringArrayField", () => {
  it("returns the array for valid string[] (incl. empty array)", () => {
    expect(readStringArrayField({ revealed: ["Duke", "Captain"] }, "revealed")).toEqual([
      "Duke",
      "Captain",
    ]);
    expect(readStringArrayField({ revealed: [] }, "revealed")).toEqual([]);
    // Read-only by convention — returns array reference (no copy)
    const src = { revealed: ["A"] };
    expect(readStringArrayField(src, "revealed")).toBe(src.revealed);
  });

  it("returns undefined for non-array / missing / mixed-type / non-string elements", () => {
    expect(readStringArrayField({ revealed: "Duke" }, "revealed")).toBeUndefined();
    expect(readStringArrayField({ revealed: null }, "revealed")).toBeUndefined();
    expect(readStringArrayField({ revealed: [1, 2] }, "revealed")).toBeUndefined();
    expect(readStringArrayField({ revealed: ["Duke", 5] }, "revealed")).toBeUndefined();
    expect(readStringArrayField({ revealed: ["A", null] }, "revealed")).toBeUndefined();
    expect(readStringArrayField({}, "revealed")).toBeUndefined();
    expect(readStringArrayField(undefined, "revealed")).toBeUndefined();
    expect(readStringArrayField(null, "revealed")).toBeUndefined();
    expect(readStringArrayField(42, "revealed")).toBeUndefined();
  });
});
