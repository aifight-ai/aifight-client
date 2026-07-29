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
function harness(
  answers: string[],
  opts?: { configured?: boolean; throwOn?: string; claim?: MenuDeps["claim"] },
): Harness {
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
      ...(opts?.claim !== undefined ? { claim: opts.claim } : {}),
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

  it("update dispatches the update command", async () => {
    const h = harness(["8", "q"]);
    await runInteractiveMenu(h.deps);
    expect(h.dispatched).toEqual([{ cmd: "update", positional: [] }]);
    expect(h.helpShown).toBe(false);
  });

  it("telegram is item 10 (not 0, which quits) and dispatches bare", async () => {
    const h = harness(["10", "q"]);
    await runInteractiveMenu(h.deps);
    expect(h.dispatched).toEqual([{ cmd: "telegram", positional: [] }]);
  });

  it("0 still quits rather than picking the telegram item", async () => {
    const h = harness(["0"]);
    const code = await runInteractiveMenu(h.deps);
    expect(code).toBe(0);
    expect(h.dispatched).toEqual([]);
  });

  it("full command list calls showHelp", async () => {
    const h = harness(["9", "q"]);
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

  // The LLM item used to dispatch bare `config`, which opens its OWN hub menu —
  // so picking "LLM" dropped the user into a second, different menu one level
  // down. That is the "why are there two menus" the owner ran into (2026-07-29).
  it("LLM goes straight to the LLM wizard, not into the config hub", async () => {
    const h = harness(["7", "q"]);
    await runInteractiveMenu(h.deps);
    expect(h.dispatched).toEqual([{ cmd: "config", positional: ["llm"] }]);
  });

  it("strategy dispatches `strategy path`", async () => {
    const h = harness(["12", "q"]);
    await runInteractiveMenu(h.deps);
    expect(h.dispatched).toEqual([{ cmd: "strategy", positional: ["path"] }]);
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

// An unclaimed agent cannot play at all, and the panel used to say nothing about
// it: the owner finished a whole VPS install, went round the menu, and never saw
// a claim reminder or a way to get the link back (2026-07-29).
describe("claim reminder", () => {
  const PENDING = {
    pending: true,
    url: "https://aifight.ai/claim/abc123",
    agentName: "PokerMind",
  } as const;

  it("warns at the top of the panel, with the name and the link", async () => {
    const h = harness(["q"], { claim: PENDING });
    await runInteractiveMenu(h.deps);
    const text = h.out();
    expect(text).toContain("NOT CLAIMED");
    expect(text).toContain("PokerMind");
    expect(text).toContain("https://aifight.ai/claim/abc123");
    expect(text).toContain("cannot play until you claim it");
  });

  it("repeats the warning every time round the loop, not just once", async () => {
    const h = harness(["1", "q"], { claim: PENDING });
    await runInteractiveMenu(h.deps);
    // Drawn before the first choice and again after the action returns —
    // a one-shot banner scrolls away behind the command's own output.
    expect(h.out().match(/NOT CLAIMED/g)?.length).toBe(2);
  });

  it("the claim item hands back the link", async () => {
    const h = harness(["11", "q"], { claim: PENDING });
    await runInteractiveMenu(h.deps);
    expect(h.dispatched).toEqual([]); // purely local — no command to run
    expect(h.out()).toContain("https://aifight.ai/claim/abc123");
  });

  it("says nothing when the agent is already claimed", async () => {
    const h = harness(["q"], { claim: { pending: false } });
    await runInteractiveMenu(h.deps);
    expect(h.out()).not.toContain("NOT CLAIMED");
  });

  it("a claimed agent picking the claim item is pointed at the Dashboard", async () => {
    const h = harness(["11", "q"], { claim: { pending: false } });
    await runInteractiveMenu(h.deps);
    expect(h.out()).toContain("already claimed");
    expect(h.out()).toContain("/dashboard");
  });

  it("no claim info at all (older config) draws the plain panel", async () => {
    const h = harness(["q"]);
    await runInteractiveMenu(h.deps);
    expect(h.out()).not.toContain("NOT CLAIMED");
    expect(h.out()).toContain("what would you like to do?");
  });
});
