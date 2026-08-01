// The Challenge submenu (menu item 5): gathers arguments, dispatches to the
// EXISTING challenge/accept commands, adds no behavior of its own. Driven
// through the chooser-less line fallback: every pickKey and every argument
// prompt consumes one queued answer in order.

import { describe, expect, it } from "vitest";

import { runChallengeMenu, type ChallengeMenuDeps } from "../src/cli/commands/challenge-menu";
import type { HandlerEnv } from "../src/cli/shared";

function harness(answers: string[]): {
  deps: ChallengeMenuDeps;
  out: () => string;
  dispatched: Array<{ cmd: string; positional: string[] }>;
} {
  const chunks: string[] = [];
  const dispatched: Array<{ cmd: string; positional: string[] }> = [];
  const env = { stdout: (s: string) => chunks.push(s), stderr: (s: string) => chunks.push(s) } as HandlerEnv;
  const deps: ChallengeMenuDeps = {
    env,
    locale: () => "en",
    prompt: async () => answers.shift() ?? "q",
    dispatch: async (cmd, positional) => {
      dispatched.push({ cmd, positional });
      return 0;
    },
  };
  return { deps, out: () => chunks.join(""), dispatched };
}

describe("challenge submenu", () => {
  it("create: game + explicit table size dispatch to `challenge <game> <n>`", async () => {
    const h = harness(["1", "3", "4"]); // Create → Coup (row 3) → 4 players
    await runChallengeMenu(h.deps);
    expect(h.dispatched).toEqual([{ cmd: "challenge", positional: ["coup", "4"] }]);
  });

  it("create: a blank table size lets the server seat the smallest legal table", async () => {
    const h = harness(["1", "1", ""]); // Create → Texas → blank
    await runChallengeMenu(h.deps);
    expect(h.dispatched).toEqual([{ cmd: "challenge", positional: ["texas_holdem"] }]);
  });

  it("create: an out-of-range size for the picked game dispatches nothing", async () => {
    const h = harness(["1", "3", "2"]); // Coup minimum is 3 (platform pacing ruling)
    await runChallengeMenu(h.deps);
    expect(h.dispatched).toEqual([]);
    expect(h.out()).toContain("between 3 and 4");
    expect(h.out()).toContain("nothing created");
  });

  it("list dispatches `challenge list`", async () => {
    const h = harness(["2"]);
    await runChallengeMenu(h.deps);
    expect(h.dispatched).toEqual([{ cmd: "challenge", positional: ["list"] }]);
  });

  it("accept forwards the pasted URL to `accept`, and an empty paste cancels", async () => {
    const url = "https://aifight.ai/challenge/dl_0123456789abcdef0123456789abcdef";
    const h = harness(["3", url]);
    await runChallengeMenu(h.deps);
    expect(h.dispatched).toEqual([{ cmd: "accept", positional: [url] }]);

    const cancelled = harness(["3", ""]);
    await runChallengeMenu(cancelled.deps);
    expect(cancelled.dispatched).toEqual([]);
  });

  it("q backs out without dispatching", async () => {
    const h = harness(["q"]);
    await runChallengeMenu(h.deps);
    expect(h.dispatched).toEqual([]);
  });
});
