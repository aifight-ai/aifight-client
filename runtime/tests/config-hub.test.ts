// `aifight config` (bare, on a TTY) and the settings items that live in the
// panel it opens.
//
// The owner ran a fresh VPS install and found two different menus (2026-07-29):
// bare `aifight` had the full panel, `aifight config` had a shorter different
// one, and picking "LLM" in the first dropped them into the second. The first
// pass split them by purpose. The owner's follow-up was blunter — make them the
// SAME, with bare `aifight` as the reference — so `aifight config` now opens
// that panel and the second menu is gone.
//
// These drive the real panel loop with injected IO, over a temp AIFIGHT_RUNTIME_HOME
// so the settings items actually write bridge.json.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readBridgeConfig, writeBridgeConfig, type BridgeConfig } from "../src/bridge/config";
import { runConfig } from "../src/cli/commands/config";
import { runInteractiveMenu, type MenuDeps } from "../src/cli/commands/menu";
import { UsageError, type HandlerEnv } from "../src/cli/shared";

let prevHome: string | undefined;
let tmpDir: string | null = null;

function useTempHome(): string {
  prevHome = process.env.AIFIGHT_RUNTIME_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-config-hub-"));
  process.env.AIFIGHT_RUNTIME_HOME = tmpDir;
  return tmpDir;
}

afterEach(() => {
  if (prevHome === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
  else process.env.AIFIGHT_RUNTIME_HOME = prevHome;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  prevHome = undefined;
  tmpDir = null;
});

function seed(overrides: Partial<BridgeConfig> = {}): void {
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
  });
}

interface Harness {
  readonly deps: MenuDeps;
  readonly out: () => string;
  /** Every question the panel asked. The "current value" hints live here, not
   *  in stdout — a prompt is written by the reader, which the harness fakes. */
  readonly asked: string[];
  readonly dispatched: Array<{ cmd: string; positional: string[] }>;
}

/** Drive the real panel with scripted answers over the temp home. */
function harness(answers: string[]): Harness {
  const chunks: string[] = [];
  const dispatched: Array<{ cmd: string; positional: string[] }> = [];
  const env = {
    stdout: (s: string) => chunks.push(s),
    stderr: (s: string) => chunks.push(s),
  } as unknown as HandlerEnv;
  const asked: string[] = [];
  let i = 0;
  return {
    out: () => chunks.join(""),
    asked,
    dispatched,
    deps: {
      env,
      prompt: (question: string) => {
        asked.push(question);
        return Promise.resolve(answers[i++] ?? "");
      },
      dispatch: (cmd, positional) => {
        dispatched.push({ cmd, positional });
        return Promise.resolve(0);
      },
      showHelp: () => {},
      configured: true,
    },
  };
}

describe("aifight config — opens THE panel, not a second menu", () => {
  const ARGS = (positional: string[], jsonMode = false) => ({ positional, flags: {}, jsonMode });

  it("bare `aifight config` on a TTY hands off to the main panel", async () => {
    useTempHome();
    seed();
    let opened = 0;
    const env = {
      stdout: () => {},
      stderr: () => {},
      openMainPanel: async () => {
        opened += 1;
        return 0;
      },
    } as unknown as HandlerEnv;
    const prevTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      const code = await runConfig(ARGS([]), env);
      expect(code).toBe(0);
      expect(opened, "aifight config must open the same panel bare `aifight` shows").toBe(1);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: prevTTY, configurable: true });
    }
  });

  it("prints usage instead of prompting when there is no terminal to prompt on", async () => {
    useTempHome();
    seed();
    let opened = 0;
    let buf = "";
    const env = {
      stdout: (s: string) => (buf += s),
      stderr: (s: string) => (buf += s),
      openMainPanel: async () => {
        opened += 1;
        return 0;
      },
    } as unknown as HandlerEnv;
    // --json is the scriptable path: never open an interactive panel there.
    const code = await runConfig(ARGS([], true), env);
    expect(code).toBe(0);
    expect(opened).toBe(0);
    expect(buf).toContain("aifight config");
  });
});

// The settings items the old `aifight config` hub owned. They now live in the
// panel — same behavior, one place.
describe("panel — settings items carried over from the config hub", () => {
  it("lists both the control actions and the settings, in one menu", async () => {
    useTempHome();
    seed();
    const h = harness(["q"]);

    const code = await runInteractiveMenu(h.deps);

    expect(code).toBe(0);
    const text = h.out();
    for (const item of [
      // control actions (were only in bare `aifight`)
      "Status —",
      "Record —",
      "Play —",
      "Update —",
      // settings (were only in `aifight config`)
      "LLM —",
      "Daily cap —",
      "Games —",
      "Telegram —",
      "Claim —",
      "Strategy —",
      "Show current config —",
    ]) {
      expect(text, item).toContain(item);
    }
    // And no "the other menu is over there" pointer, because there is no other menu.
    expect(text).not.toContain("run `aifight` with no arguments");
  });

  it("games is editable and writes through to bridge.json", async () => {
    useTempHome();
    seed({ autoGames: ["coup"] });
    const h = harness(["6", "texas_holdem,liars_dice", "q"]);

    await runInteractiveMenu(h.deps);

    expect(readBridgeConfig().autoGames).toEqual(["texas_holdem", "liars_dice"]);
  });

  it("blank keeps the current games rather than clearing them", async () => {
    useTempHome();
    seed({ autoGames: ["coup"] });
    const h = harness(["6", "", "q"]);

    await runInteractiveMenu(h.deps);

    expect(readBridgeConfig().autoGames).toEqual(["coup"]);
    expect(h.out()).toContain("Kept coup.");
  });

  it("daily cap shows the current value and blank keeps it", async () => {
    useTempHome();
    seed({ autoDailyLimit: 4 });
    const h = harness(["5", "", "q"]);

    await runInteractiveMenu(h.deps);

    expect(h.asked.join("\n"), "the prompt must show what it is set to now").toContain("keep 4");
    expect(h.out()).toContain("Kept 4.");
    expect(readBridgeConfig().autoDailyLimit).toBe(4);
  });

  it("show-current-config is reachable from the panel", async () => {
    useTempHome();
    seed();
    const h = harness(["13", "q"]);

    await runInteractiveMenu(h.deps);

    expect(h.dispatched).toEqual([{ cmd: "config", positional: ["show"] }]);
  });

  it("offers the restart once on the way out, not after every edit", async () => {
    const dir = useTempHome();
    seed({ autoGames: ["coup"] });
    // A port file older than every write = "a bridge is running with stale
    // settings", which is what turns the offer on at all.
    fs.writeFileSync(path.join(dir, "port"), "45995", { mode: 0o644 });
    const old = new Date("2020-01-01T00:00:00Z");
    fs.utimesSync(path.join(dir, "port"), old, old);
    const h = harness(["6", "texas_holdem", "6", "coup,liars_dice", "q"]);

    await runInteractiveMenu(h.deps);

    expect(readBridgeConfig().autoGames).toEqual(["coup", "liars_dice"]);
    const offers = h.out().match(/service restart|next time it starts/g) ?? [];
    expect(offers.length).toBe(1);
  });

  it("a failing step is caught and the panel stays open", async () => {
    useTempHome();
    seed();
    const h = harness(["6", "chess", "q"]);

    const code = await runInteractiveMenu(h.deps);

    expect(code).toBe(0);
    expect(readBridgeConfig().autoGames).toEqual(["coup"]);
  });
});

// The panel's "LLM" item routes to `config llm`, not to bare `config` — that is
// what stopped it opening a second menu underneath the first, and it still must
// not bounce back into the panel.
describe("aifight config llm", () => {
  const ARGS = (positional: string[]) => ({ positional, flags: {}, jsonMode: false });

  it("is a real subcommand, not an unknown one", async () => {
    useTempHome();
    seed();
    let buf = "";
    let opened = 0;
    const env = {
      stdout: (s: string) => (buf += s),
      stderr: (s: string) => (buf += s),
      openMainPanel: async () => {
        opened += 1;
        return 0;
      },
    } as unknown as HandlerEnv;
    // Non-TTY: the llm branch prints usage rather than prompting. What matters
    // here is that it is recognized and does NOT re-enter the panel.
    const code = await runConfig(ARGS(["llm"]), env);
    expect(code).toBe(0);
    expect(opened, "`config llm` must not bounce back into the panel").toBe(0);
    expect(buf).toContain("aifight config");
  });

  it("an unknown subcommand is still an error", async () => {
    useTempHome();
    seed();
    const env = { stdout: () => {}, stderr: () => {} } as unknown as HandlerEnv;
    await expect(runConfig(ARGS(["nope"]), env)).rejects.toBeInstanceOf(UsageError);
  });
});
