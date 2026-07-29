// `aifight config` (bare, on a TTY) — the guided hub.
//
// The owner ran a fresh VPS install and found two different menus (2026-07-29):
// bare `aifight` had the full panel; `aifight config` had a shorter, different
// one; and picking "LLM" in the first dropped them into the second. The two are
// now split by purpose — `aifight` is the control panel (status, record, play,
// update), `aifight config` is the settings hub — with no menu opening the other
// as a submenu, and each pointing at the other in one line.
//
// The hub's IO is injected, so this drives the real loop without a terminal.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readBridgeConfig, writeBridgeConfig, type BridgeConfig } from "../src/bridge/config";
import { runConfig, runConfigInteractive } from "../src/cli/commands/config";
import type { OnboardIO } from "../src/cli/commands/onboard-llm";
import { UsageError, type HandlerEnv } from "../src/cli/shared";

let prevHome: string | undefined;
let tmpDir: string | null = null;

function useTempHome(): void {
  prevHome = process.env.AIFIGHT_RUNTIME_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-config-hub-"));
  process.env.AIFIGHT_RUNTIME_HOME = tmpDir;
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

function harness(answers: string[]): { io: OnboardIO; env: HandlerEnv; out: () => string } {
  let buf = "";
  let i = 0;
  const io: OnboardIO = {
    promptLine: async () => answers[i++] ?? "",
    promptHidden: async () => "",
    promptYesNo: async (_q, d) => d,
    discoverModels: async () => null,
    storeKey: async () => undefined,
    probe: async () => false,
  };
  return {
    io,
    env: { stdout: (s: string) => (buf += s), stderr: (s: string) => (buf += s) } as unknown as HandlerEnv,
    out: () => buf,
  };
}

describe("aifight config — settings hub", () => {
  it("lists the settings it owns, and only those", async () => {
    useTempHome();
    seed();
    const h = harness(["q"]);

    const code = await runConfigInteractive(h.env, h.io);

    expect(code).toBe(0);
    const text = h.out();
    for (const item of [
      "LLM API key & model",
      "Daily ranked matches",
      "Games to auto-play",
      "Telegram",
      "Claim your agent",
      "Strategy",
      "Show current config",
    ]) {
      expect(text, item).toContain(item);
    }
    // Deliberately NOT here — these are the control panel's, and duplicating
    // them is what made the two menus look like rivals.
    expect(text).not.toContain("Play —");
    expect(text).not.toContain("Update —");
  });

  it("points at the other menu instead of pretending to be it", async () => {
    useTempHome();
    seed();
    const h = harness(["q"]);

    await runConfigInteractive(h.env, h.io);

    expect(h.out()).toContain("run `aifight` with no arguments");
  });

  it("games is editable from here and writes through to bridge.json", async () => {
    useTempHome();
    seed({ autoGames: ["coup"] });
    const h = harness(["3", "texas_holdem,liars_dice", "q"]);

    await runConfigInteractive(h.env, h.io);

    expect(readBridgeConfig().autoGames).toEqual(["texas_holdem", "liars_dice"]);
  });

  it("blank keeps the current games rather than clearing them", async () => {
    useTempHome();
    seed({ autoGames: ["coup"] });
    const h = harness(["3", "", "q"]);

    await runConfigInteractive(h.env, h.io);

    expect(readBridgeConfig().autoGames).toEqual(["coup"]);
    expect(h.out()).toContain("Kept coup.");
  });

  it("the claim item hands back the link", async () => {
    useTempHome();
    seed({ claimUrl: "https://aifight.ai/claim/abc123" });
    const h = harness(["5", "q"]);

    await runConfigInteractive(h.env, h.io);

    expect(h.out()).toContain("https://aifight.ai/claim/abc123");
  });

  it("strategy points at the files and the command that prints their paths", async () => {
    useTempHome();
    seed();
    const h = harness(["6", "q"]);

    await runConfigInteractive(h.env, h.io);

    expect(h.out()).toContain("aifight strategy path");
  });

  it("an out-of-range choice re-prompts with the right range", async () => {
    useTempHome();
    seed();
    const h = harness(["8", "q"]);

    await runConfigInteractive(h.env, h.io);

    expect(h.out()).toContain("Please enter 1-7 or q");
  });

  it("offers the restart once on the way out, not after every edit", async () => {
    useTempHome();
    seed({ autoGames: ["coup"] });
    // A port file older than every write = "a bridge is running with stale
    // settings", which is what turns the offer on at all.
    const dir = process.env.AIFIGHT_RUNTIME_HOME!;
    fs.writeFileSync(path.join(dir, "port"), "45995", { mode: 0o644 });
    const old = new Date("2020-01-01T00:00:00Z");
    fs.utimesSync(path.join(dir, "port"), old, old);
    const h = harness(["3", "texas_holdem", "3", "coup,liars_dice", "q"]);

    await runConfigInteractive(h.env, h.io);

    expect(readBridgeConfig().autoGames).toEqual(["coup", "liars_dice"]);
    const offers = h.out().match(/service restart|next time it starts/g) ?? [];
    expect(offers.length).toBe(1);
  });

  it("a failing step is caught and the hub stays open", async () => {
    useTempHome();
    seed();
    const h = harness(["3", "chess", "q"]);

    const code = await runConfigInteractive(h.env, h.io);

    expect(code).toBe(0);
    expect(h.out()).toContain("Could not complete that step");
    expect(readBridgeConfig().autoGames).toEqual(["coup"]);
  });
});

// The control panel's "LLM" item routes here rather than to bare `config`,
// which is what stopped it opening a second menu underneath the first.
describe("aifight config llm", () => {
  const ARGS = (positional: string[]) => ({ positional, flags: {}, jsonMode: false });

  it("is a real subcommand, not an unknown one", async () => {
    useTempHome();
    seed();
    const h = harness([]);
    // vitest has no TTY, so this takes the documented non-interactive branch —
    // the point is that it dispatches at all instead of throwing.
    const code = await runConfig(ARGS(["llm"]), h.env);
    expect(code).toBe(0);
    expect(h.out()).toContain("aifight config llm");
  });

  it("is in the did-you-mean list", async () => {
    useTempHome();
    seed();
    const h = harness([]);
    await expect(runConfig(ARGS(["lm"]), h.env)).rejects.toThrow(UsageError);
    await runConfig(ARGS(["llm"]), h.env);
    try {
      await runConfig(ARGS(["lm"]), h.env);
    } catch (e) {
      expect(String((e as UsageError).message + " " + ((e as { hint?: string }).hint ?? ""))).toContain("config llm");
    }
  });
});
