import { describe, expect, it } from "vitest";

import { runInteractiveMenu, type MenuDeps } from "../src/cli/commands/menu";
import type { HandlerEnv } from "../src/cli/shared";

// The interactive menu is fully injectable (prompt / dispatch / showHelp /
// configured), so its control flow is testable without a real TTY. main.ts gates
// the TTY/!json conditions; these tests cover the panel logic itself.

interface Harness {
  readonly deps: MenuDeps;
  readonly out: () => string;
  readonly dispatched: Array<{ cmd: string; positional: string[] }>;
  helpShown: boolean;
}

/** Build a menu harness whose prompt() returns the given answers in order
 *  (then "" forever as a safety stop — paired with a "q" near the end). */
function harness(answers: string[], opts?: { configured?: boolean; throwOn?: string }): Harness {
  const chunks: string[] = [];
  const dispatched: Array<{ cmd: string; positional: string[] }> = [];
  const env = {
    stdout: (s: string) => chunks.push(s),
    stderr: (s: string) => chunks.push(s),
  } as unknown as HandlerEnv;
  let i = 0;
  const h: Harness = {
    out: () => chunks.join(""),
    dispatched,
    helpShown: false,
    deps: {
      env,
      prompt: () => Promise.resolve(answers[i++] ?? ""),
      dispatch: (cmd, positional) => {
        dispatched.push({ cmd, positional });
        if (opts?.throwOn === cmd) throw new Error(`boom in ${cmd}`);
        return Promise.resolve(0);
      },
      showHelp: () => {
        h.helpShown = true;
      },
      configured: opts?.configured ?? true,
    },
  };
  return h;
}

describe("interactive menu", () => {
  it("first run (unconfigured) + yes → dispatches setup", async () => {
    const h = harness(["y"], { configured: false });
    const code = await runInteractiveMenu(h.deps);
    expect(code).toBe(0);
    expect(h.dispatched).toEqual([{ cmd: "setup", positional: [] }]);
  });

  it("first run (unconfigured) + no → no dispatch, points to setup", async () => {
    const h = harness(["n"], { configured: false });
    const code = await runInteractiveMenu(h.deps);
    expect(code).toBe(0);
    expect(h.dispatched).toEqual([]);
    expect(h.out()).toContain("aifight setup");
  });

  it("picks status then quits", async () => {
    const h = harness(["1", "q"]);
    const code = await runInteractiveMenu(h.deps);
    expect(code).toBe(0);
    expect(h.dispatched).toEqual([{ cmd: "status", positional: [] }]);
  });

  it("rename prompts for a name and dispatches it joined", async () => {
    const h = harness(["4", "Dark Knight", "q"]);
    await runInteractiveMenu(h.deps);
    expect(h.dispatched).toEqual([{ cmd: "rename", positional: ["Dark Knight"] }]);
  });

  it("play asks game + count → start [game] [N]", async () => {
    const h = harness(["3", "texas_holdem", "2", "q"]);
    await runInteractiveMenu(h.deps);
    expect(h.dispatched).toEqual([{ cmd: "start", positional: ["texas_holdem", "2"] }]);
  });

  it("play with blank game → start [N] (auto game)", async () => {
    const h = harness(["3", "", "", "q"]); // blank game, blank count → default 1
    await runInteractiveMenu(h.deps);
    expect(h.dispatched).toEqual([{ cmd: "start", positional: ["1"] }]);
  });

  it("daily cap dispatches set daily <N>", async () => {
    const h = harness(["5", "3", "q"]);
    await runInteractiveMenu(h.deps);
    expect(h.dispatched).toEqual([{ cmd: "set", positional: ["daily", "3"] }]);
  });

  it("rejects a non-numeric daily cap without dispatching", async () => {
    const h = harness(["5", "lots", "q"]);
    await runInteractiveMenu(h.deps);
    expect(h.dispatched).toEqual([]);
    expect(h.out()).toContain("non-negative");
  });

  it("full command list calls showHelp", async () => {
    const h = harness(["8", "q"]);
    await runInteractiveMenu(h.deps);
    expect(h.helpShown).toBe(true);
    expect(h.dispatched).toEqual([]);
  });

  it("unknown choice re-prompts, does not dispatch", async () => {
    const h = harness(["zzz", "q"]);
    await runInteractiveMenu(h.deps);
    expect(h.dispatched).toEqual([]);
    expect(h.out()).toContain("Unknown choice");
  });

  it("a failing action is caught and the panel continues", async () => {
    const h = harness(["1", "2", "q"], { throwOn: "status" });
    const code = await runInteractiveMenu(h.deps);
    expect(code).toBe(0);
    // status threw but was caught; record still ran afterwards.
    expect(h.dispatched).toEqual([
      { cmd: "status", positional: [] },
      { cmd: "record", positional: [] },
    ]);
    expect(h.out()).toContain("aifight: boom in status");
  });
});
