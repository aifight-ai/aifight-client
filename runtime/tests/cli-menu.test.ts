import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeBridgeConfig } from "../src/bridge/config";
import { runInteractiveMenu, type MenuDeps } from "../src/cli/commands/menu";
import type { HandlerEnv } from "../src/cli/shared";

// The panel reads (and, on the way out, may offer to restart) the local bridge.
// Without an isolated home these tests run against the developer's REAL
// ~/.aifight/runtime — which is how a worker started dying mid-run once the
// settings items moved in here (2026-07-29). Every test gets its own empty home.
let prevHome: string | undefined;
let tmpDir: string | null = null;

beforeEach(() => {
  prevHome = process.env.AIFIGHT_RUNTIME_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-cli-menu-"));
  process.env.AIFIGHT_RUNTIME_HOME = tmpDir;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
  else process.env.AIFIGHT_RUNTIME_HOME = prevHome;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  prevHome = undefined;
  tmpDir = null;
});

// The interactive menu is fully injectable (prompt / dispatch / showHelp /
// configured), so its control flow is testable without a real TTY. main.ts gates
// the TTY/!json conditions; these tests cover the panel logic itself.

/** A minimal bridge.json so the settings items have a current value to show. */
function seedBridge(overrides: Record<string, unknown> = {}): void {
  writeBridgeConfig({
    version: 1,
    baseUrl: "https://aifight.ai",
    wsUrl: "wss://aifight.ai/api/ws",
    agentId: "00000000-0000-4000-8000-000000000001",
    agentName: "PokerMind",
    apiKey: "sk-existing-secret",
    runtimeType: "direct",
    runtimeLocalUrl: "direct://local",
    runtimeModel: "direct",
    directAgentSlug: "default",
    autoGames: ["coup"],
    updatedAt: "2026-07-27T00:00:00.000Z",
    ...overrides,
  } as never);
}

interface Harness {
  readonly deps: MenuDeps;
  readonly out: () => string;
  readonly dispatched: Array<{ cmd: string; positional: string[] }>;
  helpShown: boolean;
}

/** Build a menu harness whose prompt() returns the given answers in order, then
 *  "q" forever.
 *
 *  The fallback used to be "" — but the panel treats a blank line as "you just
 *  pressed Enter", reprints the menu and loops. Once a script ran out, that was
 *  an infinite loop that grew until the vitest worker was killed (found
 *  2026-07-29, when an item stopped consuming an answer on an empty home).
 *  "q" is the honest stop: out of script means done. */
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
      prompt: () => Promise.resolve(answers[i++] ?? "q"),
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

  it("daily cap without an agent on this machine says so instead of prompting", async () => {
    const h = harness(["5", "q"]);
    await runInteractiveMenu(h.deps);
    expect(h.out()).toContain("No agent on this machine yet");
    expect(h.dispatched).toEqual([]);
  });

  it("rejects a non-numeric daily cap without writing anything", async () => {
    seedBridge();
    const h = harness(["5", "lots", "q"]);
    await runInteractiveMenu(h.deps);
    expect(h.out()).toContain("Enter a whole number");
    expect(h.dispatched).toEqual([]);
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

// There is exactly ONE menu in this CLI, and this is it.
//
// The owner walked a fresh VPS install and found two (2026-07-29): bare
// `aifight` had the full panel, `aifight config` had a shorter different one,
// and picking "LLM" in the first dropped them into the second. The first pass
// split them by purpose; the follow-up instruction was to make them the same,
// with bare `aifight` as the reference. These pin that so a second menu cannot
// quietly grow back.
describe("one menu, two doors", () => {
  it("carries every item both menus used to have between them", async () => {
    seedBridge();
    const h = harness(["q"]);
    await runInteractiveMenu(h.deps);
    const text = h.out();
    for (const item of [
      // was only in bare `aifight`
      "Status —", "Record —", "Play —", "Rename —", "Update —", "Full command list",
      // was only in `aifight config`
      "LLM —", "Daily cap —", "Games —", "Telegram —", "Claim —", "Strategy —",
      "Show current config —",
    ]) {
      expect(text, item).toContain(item);
    }
  });

  it("never sends the user to another menu", async () => {
    seedBridge();
    const h = harness(["q"]);
    await runInteractiveMenu(h.deps);
    // The old panel had to explain where the OTHER menu was. Nothing should.
    expect(h.out()).not.toMatch(/live in the main panel|run `aifight` with no arguments|aifight config` for/);
  });

  it("the LLM item opens the LLM step directly, not bare `config`", async () => {
    seedBridge();
    const h = harness(["7", "q"]);
    await runInteractiveMenu(h.deps);
    // `config` with no subcommand would re-open this very panel — one level
    // deeper, forever. It must be `config llm`.
    expect(h.dispatched).toEqual([{ cmd: "config", positional: ["llm"] }]);
  });

  it("offers the bridge restart once on the way out, not per edit", async () => {
    seedBridge({ autoGames: ["coup"] });
    const dir = process.env.AIFIGHT_RUNTIME_HOME!;
    fs.writeFileSync(path.join(dir, "port"), "45995", { mode: 0o644 });
    const old = new Date("2020-01-01T00:00:00Z");
    fs.utimesSync(path.join(dir, "port"), old, old);

    const h = harness(["6", "texas_holdem", "6", "coup,liars_dice", "q"]);
    await runInteractiveMenu(h.deps);

    const offers = h.out().match(/service restart|next time it starts/g) ?? [];
    expect(offers.length, "the owner's complaint was being told three times in a row").toBe(1);
  });
});
