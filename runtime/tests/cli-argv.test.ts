// M1-17 Step 1 — argv parser test matrix (Group 1, 14 cases).
//
// Maps directly to docs/plans/m1/M1-17.md Test Matrix Group 1 (case 1-14).
// Pure logic — no fs / no network. Runs entirely in-memory.

import { describe, it, expect } from "vitest";

import { parseArgs, type FlagSpec } from "../src/cli/argv";

describe("argv parser (M1-17 Group 1)", () => {
  it("case 1: empty argv + empty spec → empty positional + flags + no errors", () => {
    const r = parseArgs([], []);
    expect(r.positional).toEqual([]);
    expect(r.flags).toEqual({});
    expect(r.errors).toEqual([]);
  });

  it("case 2: --flag value (space-separated)", () => {
    const spec: FlagSpec[] = [{ name: "agent", type: "string" }];
    const r = parseArgs(["--agent", "alpha"], spec);
    expect(r.flags.agent).toBe("alpha");
    expect(r.positional).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it("case 3: --flag=value (= separator)", () => {
    const spec: FlagSpec[] = [{ name: "agent", type: "string" }];
    const r = parseArgs(["--agent=alpha"], spec);
    expect(r.flags.agent).toBe("alpha");
    expect(r.positional).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it("case 4: boolean flag without value → true", () => {
    const spec: FlagSpec[] = [{ name: "json", type: "boolean" }];
    const r = parseArgs(["--json"], spec);
    expect(r.flags.json).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("case 5: positional separation around flag value", () => {
    const spec: FlagSpec[] = [{ name: "flag", type: "string" }];
    const r = parseArgs(["a", "b", "--flag", "v", "c"], spec);
    expect(r.positional).toEqual(["a", "b", "c"]);
    expect(r.flags.flag).toBe("v");
    expect(r.errors).toEqual([]);
  });

  it("case 6: floating --json — three argv permutations all equivalent", () => {
    const spec: FlagSpec[] = [{ name: "json", type: "boolean" }];
    const permutations: ReadonlyArray<readonly string[]> = [
      ["agent", "list", "--json"],
      ["--json", "agent", "list"],
      ["agent", "--json", "list"],
    ];
    for (const argv of permutations) {
      const r = parseArgs(argv, spec);
      expect(r.positional).toEqual(["agent", "list"]);
      expect(r.flags.json).toBe(true);
      expect(r.errors).toEqual([]);
    }
  });

  it("case 7: floating --agent value — three argv permutations all equivalent", () => {
    const spec: FlagSpec[] = [{ name: "agent", type: "string" }];
    const permutations: ReadonlyArray<readonly string[]> = [
      ["join", "texas_holdem", "--agent", "alpha"],
      ["--agent", "alpha", "join", "texas_holdem"],
      ["join", "--agent", "alpha", "texas_holdem"],
    ];
    for (const argv of permutations) {
      const r = parseArgs(argv, spec);
      expect(r.positional).toEqual(["join", "texas_holdem"]);
      expect(r.flags.agent).toBe("alpha");
      expect(r.errors).toEqual([]);
    }
  });

  it("case 8: -- separator stops flag parsing", () => {
    const spec: FlagSpec[] = [{ name: "flag", type: "boolean" }];
    const r = parseArgs(["a", "--", "--flag"], spec);
    expect(r.positional).toEqual(["a", "--flag"]);
    expect(r.flags.flag).toBeUndefined();
    expect(r.errors).toEqual([]);
  });

  it("case 9: unknown flag pushes error but does not abort", () => {
    const spec: FlagSpec[] = [{ name: "json", type: "boolean" }];
    const r = parseArgs(["--unknown", "--json"], spec);
    expect(r.errors.some((e) => /unknown flag/i.test(e))).toBe(true);
    expect(r.flags.json).toBe(true);
  });

  it("case 10: type:number with non-numeric value → error", () => {
    const spec: FlagSpec[] = [{ name: "limit", type: "number" }];
    const r = parseArgs(["--limit", "abc"], spec);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.some((e) => /requires a number/i.test(e))).toBe(true);
    expect(r.flags.limit).toBeUndefined();
  });

  it("case 11: required flag missing → error", () => {
    const spec: FlagSpec[] = [{ name: "agent", type: "string", required: true }];
    const r = parseArgs([], spec);
    expect(r.errors.some((e) => /missing required flag/i.test(e) && /agent/.test(e))).toBe(true);
  });

  it("case 12: default applied when flag absent", () => {
    const spec: FlagSpec[] = [
      { name: "agent", type: "string", default: "default-agent" },
    ];
    const r = parseArgs([], spec);
    expect(r.flags.agent).toBe("default-agent");
    expect(r.errors).toEqual([]);
  });

  it("case 13: repeated same flag — last wins", () => {
    const spec: FlagSpec[] = [{ name: "agent", type: "string" }];
    const r = parseArgs(["--agent", "alpha", "--agent", "beta"], spec);
    expect(r.flags.agent).toBe("beta");
    expect(r.errors).toEqual([]);
  });

  it("case 14: -v / -h short aliases for --version / --help", () => {
    const spec: FlagSpec[] = [
      { name: "version", type: "boolean" },
      { name: "help", type: "boolean" },
    ];
    const rv = parseArgs(["-v"], spec);
    expect(rv.flags.version).toBe(true);
    expect(rv.errors).toEqual([]);
    const rh = parseArgs(["-h"], spec);
    expect(rh.flags.help).toBe(true);
    expect(rh.errors).toEqual([]);
  });

  // -- Step 1b regression cases (Codex P2 fix) --

  it("case 14a: Step 1b — value flag does not swallow next known flag", () => {
    // From M1-17 rev7 historical review focus: `aifight join --agent --json
    // texas_holdem`. --agent is value-taking, but its value-pull MUST detect
    // --json as a flag token, emit missing-value error, and let --json parse
    // normally on the next loop iteration. Otherwise --json silently becomes
    // the agent string and the boolean flag is never set.
    const spec: FlagSpec[] = [
      { name: "agent", type: "string" },
      { name: "json", type: "boolean" },
    ];
    const r = parseArgs(["join", "--agent", "--json", "texas_holdem"], spec);
    expect(r.errors.some((e) => /flag --agent requires a value/i.test(e))).toBe(true);
    expect(r.flags.json).toBe(true);
    expect(r.flags.agent).toBeUndefined();
    expect(r.positional).toEqual(["join", "texas_holdem"]);
  });

  it("case 14b: Step 1b — value flag does not swallow short alias (-v / -h)", () => {
    const spec: FlagSpec[] = [
      { name: "agent", type: "string" },
      { name: "version", type: "boolean" },
    ];
    const r = parseArgs(["--agent", "-v"], spec);
    expect(r.errors.some((e) => /flag --agent requires a value/i.test(e))).toBe(true);
    expect(r.flags.version).toBe(true);
    expect(r.flags.agent).toBeUndefined();
  });

  it("case 14c: Step 1b — negative number value is preserved (--limit -1)", () => {
    // Defensive guard: -1 is not a flag token (does not start with --, not in
    // SHORT_ALIASES), so the value-pull MUST consume it and parse as number.
    const spec: FlagSpec[] = [{ name: "limit", type: "number" }];
    const r = parseArgs(["--limit", "-1"], spec);
    expect(r.errors).toEqual([]);
    expect(r.flags.limit).toBe(-1);
  });
});
