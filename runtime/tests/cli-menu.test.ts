import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readBridgeConfig, writeBridgeConfig } from "../src/bridge/config";
import { createAnsi } from "../src/cli/ansi";
import { runInteractiveMenu, type MenuDeps } from "../src/cli/commands/menu";
import { renderMenuFrame, type MenuFrame } from "../src/cli/commands/menu-frame";
import { CommandError } from "../src/cli/shared";
import type { HandlerEnv } from "../src/cli/shared";

// The panel reads (and, on the way out, may offer to restart) the local bridge.
// Without an isolated home these tests run against the developer's REAL runtime
// directory — which is how a worker started dying mid-run once the settings
// items moved in here (2026-07-29). Every test gets its own empty home.
// (Naming that directory literally here would trip build.sh's step 1.6 guard,
// which greps tests/ for it — the guard is exactly why this block exists.)
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
  /** Every frame the injected chooser was offered (one per loop iteration). */
  readonly frames: MenuFrame[];
  /** The optional second argument each chooser call received (locale + refresh hook). */
  readonly chooseOpts: Array<{ locale?: "en" | "zh"; refreshWhen?: Promise<unknown>; getFrame?: () => MenuFrame } | undefined>;
  helpShown: boolean;
}

/** Build a menu harness whose chooser/prompt consume the given answers in
 *  order (menu picks AND item-argument answers interleave in one script),
 *  then "q" forever.
 *
 *  The fallback used to be "" — but the panel treats a blank line as "you just
 *  pressed Enter", reprints the menu and loops. Once a script ran out, that was
 *  an infinite loop that grew until the vitest worker was killed (found
 *  2026-07-29, when an item stopped consuming an answer on an empty home).
 *  "q" is the honest stop: out of script means done.
 *
 *  The injected chooser mirrors the production wiring: it renders the frame
 *  through the SAME renderer the arrow-key chooser uses (plain — no ANSI in
 *  tests), so the text assertions below see exactly what a terminal would
 *  show. `linePrompt: true` drops the chooser to exercise the numbered
 *  line-prompt fallback instead. */
function harness(
  answers: string[],
  opts?: {
    configured?: boolean;
    throwOn?: string;
    throwError?: Error;
    claim?: MenuDeps["claim"];
    locale?: () => "en" | "zh";
    matchingPaused?: () => boolean;
    dailyCap?: () => number | undefined;
    autoGames?: () => readonly string[];
    serviceInstalled?: boolean;
    onDispatch?: (cmd: string) => void;
    linePrompt?: boolean;
    statusBox?: MenuDeps["statusBox"];
  },
): Harness {
  const chunks: string[] = [];
  const dispatched: Array<{ cmd: string; positional: string[] }> = [];
  const frames: MenuFrame[] = [];
  const chooseOpts: Harness["chooseOpts"] = [];
  const env = {
    stdout: (s: string) => chunks.push(s),
    stderr: (s: string) => chunks.push(s),
  } as unknown as HandlerEnv;
  const plain = createAnsi({ enabled: false });
  let i = 0;
  const h: Harness = {
    out: () => chunks.join(""),
    dispatched,
    frames,
    chooseOpts,
    helpShown: false,
    deps: {
      env,
      // The real promptLine writes the question to stdout before reading —
      // mirror that so prompt text is part of the captured output.
      prompt: (question: string) => {
        chunks.push(question);
        return Promise.resolve(answers[i++] ?? "q");
      },
      ...(opts?.linePrompt === true
        ? {}
        : {
            choose: (frame: MenuFrame, chooseOpt?: { locale?: "en" | "zh"; refreshWhen?: Promise<unknown>; getFrame?: () => MenuFrame }) => {
              frames.push(frame);
              chooseOpts.push(chooseOpt);
              chunks.push(`\n${renderMenuFrame(frame, -1, plain).join("\n")}\n\n`);
              return Promise.resolve(answers[i++] ?? "q");
            },
          }),
      dispatch: (cmd, positional) => {
        dispatched.push({ cmd, positional });
        opts?.onDispatch?.(cmd);
        if (opts?.throwOn === cmd) throw opts.throwError ?? new Error(`boom in ${cmd}`);
        return Promise.resolve(0);
      },
      showHelp: () => {
        h.helpShown = true;
      },
      configured: opts?.configured ?? true,
      ...(opts?.locale !== undefined ? { locale: opts.locale } : {}),
      ...(opts?.matchingPaused !== undefined ? { matchingPaused: opts.matchingPaused } : {}),
      ...(opts?.dailyCap !== undefined ? { dailyCap: opts.dailyCap } : {}),
      ...(opts?.autoGames !== undefined ? { autoGames: opts.autoGames } : {}),
      ...(opts?.serviceInstalled !== undefined ? { serviceInstalled: opts.serviceInstalled } : {}),
      ...(opts?.claim !== undefined ? { claim: opts.claim } : {}),
      ...(opts?.statusBox !== undefined ? { statusBox: opts.statusBox } : {}),
    },
  };
  return h;
}

describe("interactive menu", () => {
  it("first run (unconfigured) runs the guided setup inline — no prompt gate (V3)", async () => {
    const h = harness([], { configured: false });
    const code = await runInteractiveMenu(h.deps);
    expect(code).toBe(0);
    expect(h.dispatched).toEqual([{ cmd: "setup", positional: [] }]);
  });

  it("first run: a setup that left no identity exits with the next-step hints (en+zh)", async () => {
    const h = harness([], { configured: false });
    const code = await runInteractiveMenu(h.deps);
    expect(code).toBe(0);
    expect(h.out()).toContain("starting the guided setup");
    expect(h.out()).toContain("run `aifight setup` any time");
    // No panel was drawn — there is nothing to show without an identity.
    expect(h.frames).toEqual([]);

    const hz = harness([], { configured: false, locale: () => "zh" as const });
    await runInteractiveMenu(hz.deps);
    expect(hz.out()).toContain("开始向导式初始化");
    expect(hz.out()).toContain("随时运行 aifight setup 继续");
  });

  it("first run: a successful setup continues straight into the panel", async () => {
    const h = harness(["q"], {
      configured: false,
      onDispatch: (cmd) => {
        if (cmd === "setup") seedBridge(); // the real setup leaves bridge.json behind
      },
    });
    const code = await runInteractiveMenu(h.deps);
    expect(code).toBe(0);
    expect(h.dispatched).toEqual([{ cmd: "setup", positional: [] }]);
    expect(h.out()).toContain("Setup complete");
    // ...and the panel loop ran: one frame was offered to the chooser.
    expect(h.frames.length).toBeGreaterThan(0);
  });

  it("picks status then quits", async () => {
    const h = harness(["3", "q"]);
    const code = await runInteractiveMenu(h.deps);
    expect(code).toBe(0);
    expect(h.dispatched).toEqual([{ cmd: "status", positional: [] }]);
  });

  it("record is item 4", async () => {
    const h = harness(["4", "q"]);
    await runInteractiveMenu(h.deps);
    expect(h.dispatched).toEqual([{ cmd: "record", positional: [] }]);
  });

  it("rename prompts for a name and dispatches it joined", async () => {
    const h = harness(["11", "Dark Knight", "q"]);
    await runInteractiveMenu(h.deps);
    expect(h.dispatched).toEqual([{ cmd: "rename", positional: ["Dark Knight"] }]);
  });

  it("play asks game + count → start [game] [N]", async () => {
    const h = harness(["1", "texas_holdem", "2", "q"]);
    await runInteractiveMenu(h.deps);
    expect(h.dispatched).toEqual([{ cmd: "start", positional: ["texas_holdem", "2"] }]);
  });

  it("play with blank game → start [N] (auto game)", async () => {
    const h = harness(["1", "", "", "q"]); // blank game, blank count → default 1
    await runInteractiveMenu(h.deps);
    expect(h.dispatched).toEqual([{ cmd: "start", positional: ["1"] }]);
  });

  it("daily cap without an agent on this machine says so instead of prompting", async () => {
    const h = harness(["7", "q"]);
    await runInteractiveMenu(h.deps);
    expect(h.out()).toContain("No agent on this machine yet");
    expect(h.dispatched).toEqual([]);
  });

  it("rejects a non-numeric daily cap without writing anything", async () => {
    seedBridge();
    const h = harness(["7", "lots", "q"]);
    await runInteractiveMenu(h.deps);
    expect(h.out()).toContain("Enter a whole number");
    expect(h.dispatched).toEqual([]);
  });

  it("update dispatches the update command", async () => {
    const h = harness(["14", "q"]);
    await runInteractiveMenu(h.deps);
    expect(h.dispatched).toEqual([{ cmd: "update", positional: [] }]);
    expect(h.helpShown).toBe(false);
  });

  it("telegram is item 12 (not 0, which quits) and dispatches bare", async () => {
    const h = harness(["12", "q"]);
    await runInteractiveMenu(h.deps);
    expect(h.dispatched).toEqual([{ cmd: "telegram", positional: [] }]);
  });

  it("0 still quits rather than picking the telegram item", async () => {
    const h = harness(["0"]);
    const code = await runInteractiveMenu(h.deps);
    expect(code).toBe(0);
    expect(h.dispatched).toEqual([]);
  });

  it("help (item 18) calls showHelp", async () => {
    const h = harness(["18", "q"]);
    await runInteractiveMenu(h.deps);
    expect(h.helpShown).toBe(true);
    expect(h.dispatched).toEqual([]);
  });

  it("config (item 15) shows the current settings", async () => {
    const h = harness(["15", "q"]);
    await runInteractiveMenu(h.deps);
    expect(h.dispatched).toEqual([{ cmd: "config", positional: ["show"] }]);
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
    const h = harness(["6", "q"]);
    await runInteractiveMenu(h.deps);
    expect(h.dispatched).toEqual([{ cmd: "config", positional: ["llm"] }]);
  });

  it("strategy dispatches `strategy path`", async () => {
    const h = harness(["9", "q"]);
    await runInteractiveMenu(h.deps);
    expect(h.dispatched).toEqual([{ cmd: "strategy", positional: ["path"] }]);
  });

  it("a failing action is caught and the panel continues", async () => {
    const h = harness(["3", "4", "q"], { throwOn: "status" });
    const code = await runInteractiveMenu(h.deps);
    expect(code).toBe(0);
    // status threw but was caught; record still ran afterwards.
    expect(h.dispatched).toEqual([
      { cmd: "status", positional: [] },
      { cmd: "record", positional: [] },
    ]);
    expect(h.out()).toContain("aifight: boom in status");
  });

  it("a failing action prints the error's hint, not just its message", async () => {
    // The CLI funnel always prints a CommandError's hint (e.g. "Start it with
    // `aifight service start`"); the menu's catch used to swallow it and leave
    // the failure a dead end.
    const h = harness(["3", "q"], {
      throwOn: "status",
      throwError: new CommandError("bridge_not_running", "AIFight Bridge is not running.", {
        hint: "Start it with `aifight service start`.",
      }),
    });
    const code = await runInteractiveMenu(h.deps);
    expect(code).toBe(0);
    expect(h.out()).toContain("aifight: AIFight Bridge is not running.");
    expect(h.out()).toContain("aifight service start");
  });

  it("play rejects a count of 0 before dispatching", async () => {
    const h = harness(["1", "coup", "0", "q"]);
    await runInteractiveMenu(h.deps);
    expect(h.dispatched).toEqual([]);
    expect(h.out()).toContain("between 1 and 20");
  });

  it("play rejects a count above 20 before dispatching", async () => {
    const h = harness(["1", "coup", "999", "q"]);
    await runInteractiveMenu(h.deps);
    expect(h.dispatched).toEqual([]);
    expect(h.out()).toContain("between 1 and 20");
  });

  it("play accepts the 1-20 boundary", async () => {
    const h = harness(["1", "coup", "20", "q"]);
    await runInteractiveMenu(h.deps);
    expect(h.dispatched).toEqual([{ cmd: "start", positional: ["coup", "20"] }]);
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
    const h = harness(["3", "q"], { claim: PENDING });
    await runInteractiveMenu(h.deps);
    // Drawn before the first choice and again after the action returns —
    // a one-shot banner scrolls away behind the command's own output.
    expect(h.out().match(/NOT CLAIMED/g)?.length).toBe(2);
  });

  it("the claim item hands back the link", async () => {
    const h = harness(["13", "q"], { claim: PENDING });
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
    const h = harness(["13", "q"], { claim: { pending: false } });
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

// V3 ③: configured but no aifight.service — the bridge dies when the window
// closes. One gentle yellow banner line per repaint, no nag dialogs.
describe("service-not-installed hint", () => {
  it("adds the banner line when the service is not installed", async () => {
    const h = harness(["q"], { serviceInstalled: false });
    await runInteractiveMenu(h.deps);
    expect(h.frames[0]?.banner.some((l) => l.includes("service not installed"))).toBe(true);
    expect(h.out()).toContain("aifight service install");
  });

  it("stays away when the service is installed, or its state is unknown", async () => {
    const installed = harness(["q"], { serviceInstalled: true });
    await runInteractiveMenu(installed.deps);
    expect(installed.frames[0]?.banner.some((l) => l.includes("service not installed"))).toBe(false);

    const unknown = harness(["q"]); // dep omitted = probe failed
    await runInteractiveMenu(unknown.deps);
    expect(unknown.frames[0]?.banner.some((l) => l.includes("service not installed"))).toBe(false);
  });

  it("is translated (zh)", async () => {
    const h = harness(["q"], { serviceInstalled: false, locale: () => "zh" as const });
    await runInteractiveMenu(h.deps);
    expect(h.frames[0]?.banner.some((l) => l.includes("未安装常驻服务"))).toBe(true);
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
      "Status —", "Record —", "Play —", "Update —", "Help —", "Language —",
      // was only in `aifight config`
      "LLM —", "Daily cap —", "Games —", "Telegram —", "Claim —", "Strategy —",
      "Config —",
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
    const h = harness(["6", "q"]);
    await runInteractiveMenu(h.deps);
    // `config` with no subcommand would re-open this very panel — one level
    // deeper, forever. It must be `config llm`.
    expect(h.dispatched).toEqual([{ cmd: "config", positional: ["llm"] }]);
  });

  it("offers the bridge restart once on the way out, not per edit (LLM config writes)", async () => {
    seedBridge({ autoGames: ["coup"] });
    const dir = process.env.AIFIGHT_RUNTIME_HOME!;
    fs.writeFileSync(path.join(dir, "port"), "45995", { mode: 0o644 });
    const started = new Date("2020-01-02T00:00:00Z");
    fs.utimesSync(path.join(dir, "port"), started, started);
    // bridge.json OLDER than the port — nothing pending from the seed itself;
    // only the LLM write below may arm the offer.
    const before = new Date("2020-01-01T00:00:00Z");
    fs.utimesSync(path.join(dir, "bridge.json"), before, before);
    // Two LLM-profile writes back to back (what the item-5 wizard does): the
    // ONLY class that still arms the offer after V3 — daily cap / games /
    // pause / locale / declared-model are all live without a restart now.
    const profileDir = path.join(process.env.AIFIGHT_HOME!, "agents", "default");
    fs.mkdirSync(profileDir, { recursive: true });
    const llmConfig = path.join(profileDir, "config.json");
    fs.writeFileSync(llmConfig, "{}");
    fs.writeFileSync(llmConfig, "{}\n");

    const h = harness(["q"]);
    await runInteractiveMenu(h.deps);

    const offers = h.out().match(/service restart|next time it starts/g) ?? [];
    expect(offers.length, "the owner's complaint was being told three times in a row").toBe(1);
  });

  it("daily/games edits no longer arm the restart offer at all (V3 connect-edge)", async () => {
    // Isolate from the LLM-write test above (they share the file's AIFIGHT_HOME).
    fs.rmSync(path.join(process.env.AIFIGHT_HOME!, "agents"), { recursive: true, force: true });
    seedBridge({ autoGames: ["coup"] });
    const dir = process.env.AIFIGHT_RUNTIME_HOME!;
    fs.writeFileSync(path.join(dir, "port"), "45995", { mode: 0o644 });
    const started = new Date("2020-01-02T00:00:00Z");
    fs.utimesSync(path.join(dir, "port"), started, started);
    // bridge.json older than the port: any offer after the games edit can only
    // come from THAT write — and V3 says there must be none.
    const before = new Date("2020-01-01T00:00:00Z");
    fs.utimesSync(path.join(dir, "bridge.json"), before, before);

    const h = harness(["8", "texas_holdem", "q"]);
    await runInteractiveMenu(h.deps);

    expect(h.out()).toContain("Automatic match games set to: texas_holdem");
    const offers = h.out().match(/service restart|next time it starts/g) ?? [];
    expect(offers.length).toBe(0);
  });
});

// Item 2 is the CLI twin of the desktop app's pause switch (owner gap
// 2026-07-30: the app persists a pause; the CLI only had "daily cap 0").
// Its main word AND its dispatch follow the live flag in bridge.json.
describe("pause/resume matching item", () => {
  const livePaused = (): boolean => {
    try {
      return readBridgeConfig().matchingPaused === true;
    } catch {
      return false;
    }
  };

  it("shows 'Pause' as item 2 when not paused, and dispatches pause", async () => {
    seedBridge();
    const h = harness(["2", "q"], { matchingPaused: livePaused });
    await runInteractiveMenu(h.deps);
    expect(h.out()).toContain("2) Pause — pause auto-matching");
    expect(h.out()).not.toContain("Resume — resume auto-matching");
    expect(h.dispatched).toEqual([{ cmd: "pause", positional: [] }]);
  });

  it("shows 'Resume' and dispatches resume while paused", async () => {
    seedBridge({ matchingPaused: true });
    const h = harness(["2", "q"], { matchingPaused: livePaused });
    await runInteractiveMenu(h.deps);
    expect(h.out()).toContain("2) Resume — resume auto-matching");
    expect(h.out()).not.toContain("Pause — pause auto-matching");
    expect(h.dispatched).toEqual([{ cmd: "resume", positional: [] }]);
  });

  it("flips the label on the repaint right after the command rewrote the flag", async () => {
    seedBridge();
    const h = harness(["2", "q"], {
      matchingPaused: livePaused,
      // Stand in for `aifight pause`: the real command rewrites bridge.json.
      onDispatch: (cmd) => {
        if (cmd === "pause") {
          writeBridgeConfig({ ...readBridgeConfig(), matchingPaused: true });
        }
      },
    });
    await runInteractiveMenu(h.deps);
    const text = h.out();
    expect(text).toContain("2) Pause — pause auto-matching"); // first paint
    expect(text).toContain("2) Resume — resume auto-matching"); // repaint after the write
  });
});

// V2 live hints: the settings rows show their current value, re-read on
// every build, so the repaint right after an edit already says the new one.
describe("live hints (V2)", () => {
  it("daily cap shows [N/day], [off] at 0, [not set] when unset", async () => {
    for (const [cap, expected] of [
      [5, "Daily cap — auto matches [5/day]"],
      [0, "Daily cap — auto matches [off]"],
      [undefined, "Daily cap — auto matches [not set]"],
    ] as const) {
      const h = harness(["q"], { dailyCap: () => cap });
      await runInteractiveMenu(h.deps);
      expect(h.out(), `cap ${String(cap)}`).toContain(expected);
    }
  });

  it("games shows the live selection count", async () => {
    const h = harness(["q"], { autoGames: () => ["texas_holdem", "liars_dice", "coup"] });
    await runInteractiveMenu(h.deps);
    expect(h.out()).toContain("Games — auto-play [3 selected]");
    const fewer = harness(["q"], { autoGames: () => ["coup"] });
    await runInteractiveMenu(fewer.deps);
    expect(fewer.out()).toContain("Games — auto-play [1 selected]");
  });

  it("games falls back to the full default list when no reader is wired", async () => {
    const h = harness(["q"]);
    await runInteractiveMenu(h.deps);
    expect(h.out()).toContain("Games — auto-play [3 selected]");
    expect(h.out()).toContain("Daily cap — auto matches [not set]");
  });

  it("the hint is re-read on every build — a change shows on the next repaint", async () => {
    let cap: number | undefined = 5;
    // Any action returning triggers a rebuild; the reader then answers anew
    // (the production reader re-reads bridge.json the same way).
    const h = harness(["3", "q"], {
      dailyCap: () => cap,
      onDispatch: () => {
        cap = 9;
      },
    });
    await runInteractiveMenu(h.deps);
    const text = h.out();
    expect(text).toContain("Daily cap — auto matches [5/day]"); // first paint
    expect(text).toContain("Daily cap — auto matches [9/day]"); // after the change
  });

  it("update is a dim 'check & update' without a known-newer version", async () => {
    const h = harness(["q"]);
    await runInteractiveMenu(h.deps);
    const frame = h.frames[0]!;
    const update = frame.choices.find((c) => c.key === "14")!;
    expect(update.main).toBe("Update");
    expect(update.hint).toBe("check & update");
    expect(update.hintTone ?? "dim").toBe("dim");
  });

  it("update turns yellow with the version once one is known-newer", async () => {
    const provider: NonNullable<MenuDeps["statusBox"]> = {
      title: "AIFight · v0.1.0-beta.40",
      lines: () => [[{ text: "PokerMind", style: "bold" }]],
      refreshed: () => undefined,
      updateVersion: () => "0.1.0-beta.41",
    };
    const h = harness(["q"], { statusBox: provider });
    await runInteractiveMenu(h.deps);
    const update = h.frames[0]!.choices.find((c) => c.key === "14")!;
    expect(update.hint).toBe("↑ 0.1.0-beta.41 available");
    expect(update.hintTone).toBe("yellow");
    expect(h.out()).toContain("14) Update — ↑ 0.1.0-beta.41 available");
  });
});

// The frame is what the chooser (arrow-key UI) is handed each loop iteration.
// These pin its shape so the interactive presentation cannot quietly lose the
// Quit row or stale a dynamic label.
describe("menu frame handed to the chooser", () => {
  it("offers Quit as the last selectable row, after all 18 actions", async () => {
    const h = harness(["q"]);
    await runInteractiveMenu(h.deps);
    expect(h.frames).toHaveLength(1);
    const choices = h.frames[0]!.choices;
    expect(choices).toHaveLength(19);
    expect(choices[18]).toEqual({ key: "q", main: "Quit" });
    expect(choices.map((c) => c.key)).toEqual([
      "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "q",
    ]);
  });

  it("carries the final V3 order (Profile at 9) and the two-tone main/hint split", async () => {
    seedBridge();
    const h = harness(["q"], { dailyCap: () => 5, autoGames: () => ["coup"] });
    await runInteractiveMenu(h.deps);
    const mains = h.frames[0]!.choices.map((c) => c.main);
    expect(mains).toEqual([
      "Play", "Pause", "Status", "Record", "Challenge", "LLM", "Daily cap", "Games",
      "Strategy", "Profile", "Rename", "Telegram", "Claim", "Update", "Config", "Language", "Service", "Help", "Quit",
    ]);
    const byKey = new Map(h.frames[0]!.choices.map((c) => [c.key, c]));
    expect(byKey.get("1")).toMatchObject({ main: "Play", hint: "request a ranked match" });
    expect(byKey.get("5")).toMatchObject({ main: "Challenge", hint: "create · view · accept" });
    expect(byKey.get("7")).toMatchObject({ main: "Daily cap", hint: "auto matches [5/day]" });
    expect(byKey.get("8")).toMatchObject({ main: "Games", hint: "auto-play [1 selected]" });
    expect(byKey.get("10")).toMatchObject({ main: "Profile", hint: "switch agent identity" });
    expect(byKey.get("16")).toMatchObject({ main: "Language", hint: "switch to 中文" });
    expect(byKey.get("17")).toMatchObject({ main: "Service", hint: "status · start · restart" });
    expect(byKey.get("18")).toMatchObject({ main: "Help", hint: "full command list" });
  });

  it("carries the NOT CLAIMED banner in the frame, not just in text", async () => {
    const h = harness(["q"], {
      claim: { pending: true, url: "https://aifight.ai/claim/abc123", agentName: "PokerMind" },
    });
    await runInteractiveMenu(h.deps);
    const banner = h.frames[0]!.banner.join("\n");
    expect(banner).toContain("NOT CLAIMED");
    expect(banner).toContain("https://aifight.ai/claim/abc123");
  });

  it("re-evaluates the dynamic pause/resume label on every frame", async () => {
    seedBridge();
    const paused = (): boolean => {
      try {
        return readBridgeConfig().matchingPaused === true;
      } catch {
        return false;
      }
    };
    const h = harness(["2", "q"], {
      matchingPaused: paused,
      onDispatch: (cmd) => {
        if (cmd === "pause") writeBridgeConfig({ ...readBridgeConfig(), matchingPaused: true });
      },
    });
    await runInteractiveMenu(h.deps);
    expect(h.frames).toHaveLength(2);
    const mainOf = (f: (typeof h.frames)[number]) =>
      f.choices.find((c) => c.key === "2")!.main;
    expect(mainOf(h.frames[0]!)).toBe("Pause");
    expect(mainOf(h.frames[1]!)).toBe("Resume");
  });
});

// The chooser-less presentation: print the frame, read a number. main.ts only
// opens the panel on a TTY and always wires the arrow-key chooser, so this
// path is test-only — but it must keep working, because it is how these tests
// (and any future non-raw host) drive the panel.
describe("line-prompt fallback (no chooser wired)", () => {
  it("picks by number and quits on q", async () => {
    const h = harness(["3", "q"], { linePrompt: true });
    const code = await runInteractiveMenu(h.deps);
    expect(code).toBe(0);
    expect(h.dispatched).toEqual([{ cmd: "status", positional: [] }]);
    expect(h.out()).toContain("Pick an action (number, or q to quit): ");
    expect(h.out()).toContain("what would you like to do?");
  });

  it("an unknown number re-prompts without dispatching", async () => {
    const h = harness(["zzz", "q"], { linePrompt: true });
    await runInteractiveMenu(h.deps);
    expect(h.dispatched).toEqual([]);
    expect(h.out()).toContain("Unknown choice");
  });

  it("0 still quits", async () => {
    const h = harness(["0"], { linePrompt: true });
    const code = await runInteractiveMenu(h.deps);
    expect(code).toBe(0);
    expect(h.dispatched).toEqual([]);
  });
});

// The boxed status banner (owner ask 2026-07-30, 3x-ui style): the panel
// carries the provider's box into every frame it builds, and hands the
// chooser the one-shot refresh hook while the remote answers are still in
// flight — so the first paint is local-only and the repaint lands the
// enrichment. The provider itself is covered in cli-menu-status.test.ts.
describe("status banner in the panel", () => {
  function fakeProvider(opts: { pending: boolean }): NonNullable<MenuDeps["statusBox"]> {
    let lines = [
      [{ text: "Phantom Maverick", style: "bold" as const }, { text: " · " }, { text: "✓ claimed", style: "green" as const }],
    ];
    return {
      title: "AIFight · v0.1.0-beta.40",
      lines: () => lines,
      refreshed: () => (opts.pending ? Promise.resolve().then(() => {
        lines = [[{ text: "Phantom Maverick", style: "bold" as const }, { text: " · enriched" }]];
      }) : undefined),
    };
  }

  it("carries the provider's box into the frame handed to the chooser", async () => {
    const h = harness(["q"], { statusBox: fakeProvider({ pending: false }) });
    await runInteractiveMenu(h.deps);
    expect(h.frames).toHaveLength(1);
    const box = h.frames[0]!.statusBox;
    expect(box).toBeDefined();
    expect(box!.title).toBe("AIFight · v0.1.0-beta.40");
    expect(box!.lines[0]!.map((s) => s.text).join("")).toContain("Phantom Maverick");
    // And the renderer drew it (plain ASCII frame in tests).
    expect(h.out()).toContain("+- AIFight · v0.1.0-beta.40");
  });

  it("hands the chooser the refresh hook while the remote answers are pending", async () => {
    const h = harness(["q"], { statusBox: fakeProvider({ pending: true }) });
    await runInteractiveMenu(h.deps);
    expect(h.chooseOpts).toHaveLength(1);
    expect(h.chooseOpts[0]?.refreshWhen).toBeDefined();
    expect(typeof h.chooseOpts[0]?.getFrame).toBe("function");
    // The locale rides along on every chooser call.
    expect(h.chooseOpts[0]?.locale).toBe("en");
  });

  it("passes no refresh hook once the provider has settled", async () => {
    const h = harness(["q"], { statusBox: fakeProvider({ pending: false }) });
    await runInteractiveMenu(h.deps);
    expect(h.chooseOpts[0]?.refreshWhen).toBeUndefined();
    expect(h.chooseOpts[0]?.getFrame).toBeUndefined();
  });

  it("no provider → no box, and the panel renders exactly as before", async () => {
    const h = harness(["q"]);
    await runInteractiveMenu(h.deps);
    expect(h.frames[0]!.statusBox).toBeUndefined();
    expect(h.out()).not.toContain("+- AIFight · v");
    expect(h.chooseOpts[0]?.refreshWhen).toBeUndefined();
  });

  it("the getFrame hook rebuilds from the provider's (possibly enriched) lines", async () => {
    const provider = fakeProvider({ pending: true });
    const h = harness(["q"], { statusBox: provider });
    await runInteractiveMenu(h.deps);
    await provider.refreshed(); // let the fake's enrichment land
    const enriched = h.chooseOpts[0]!.getFrame!();
    expect(enriched.statusBox!.lines[0]!.map((s) => s.text).join("")).toContain("enriched");
  });
});
