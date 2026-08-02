// Bare `aifight telegram` when the companion is already linked.
//
// It used to print status and stop, so from the main menu there was NO way to
// change a Telegram setting: pick "Telegram", read the same status again, back
// out. The owner went round that loop on a fresh VPS (2026-07-29) looking for
// the edit screen. Now a linked terminal gets an editable panel; scripts and
// --json keep the status-only behaviour.
//
// The panel's IO is injected, so these tests exercise the real command handlers
// (and the real bridge.json writes) without a terminal.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readBridgeConfig, writeBridgeConfig, type BridgeConfig } from "../src/bridge/config";
import { telegramPanel, type PanelIO } from "../src/cli/commands/telegram";
import type { HandlerArgs, HandlerEnv } from "../src/cli/shared";
import { defaultTelegramConfig } from "../src/notify/telegram/settings";

let prevHome: string | undefined;
let tmpDir: string | null = null;

function useTempHome(): void {
  prevHome = process.env.AIFIGHT_RUNTIME_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-telegram-panel-"));
  process.env.AIFIGHT_RUNTIME_HOME = tmpDir;
}

afterEach(() => {
  if (prevHome === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
  else process.env.AIFIGHT_RUNTIME_HOME = prevHome;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  prevHome = undefined;
  tmpDir = null;
});

function seedLinked(section: Partial<ReturnType<typeof defaultTelegramConfig>> = {}): void {
  const config: BridgeConfig = {
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
    updatedAt: "2026-07-27T00:00:00.000Z",
    telegramBotToken: "1234567:TEST-bot-token-not-real-9zx",
    telegram: { ...defaultTelegramConfig(4242), ...section },
  };
  writeBridgeConfig(config);
}

interface Harness {
  readonly io: PanelIO;
  readonly env: HandlerEnv;
  readonly out: () => string;
  readonly asked: string[];
}

/** Make bridge.json look edited-since-startup: a port file whose mtime predates
 *  every write the panel is about to make. */
function pretendBridgeIsRunning(): void {
  const dir = process.env.AIFIGHT_RUNTIME_HOME!;
  fs.writeFileSync(path.join(dir, "port"), "45996", { mode: 0o644 });
  const old = new Date("2020-01-01T00:00:00Z");
  fs.utimesSync(path.join(dir, "port"), old, old);
}

/** Answers are consumed in order; anything past the end reads as "" (which the
 *  panel treats as Done), so a runaway loop terminates instead of hanging. */
function harness(answers: string[]): Harness {
  const chunks: string[] = [];
  const asked: string[] = [];
  let i = 0;
  return {
    asked,
    out: () => chunks.join(""),
    env: {
      stdout: (s: string) => chunks.push(s),
      stderr: (s: string) => chunks.push(s),
    } as unknown as HandlerEnv,
    io: {
      promptLine: (q: string) => {
        asked.push(q);
        return Promise.resolve(answers[i++] ?? "");
      },
      promptYesNo: (q: string) => {
        asked.push(q);
        const a = (answers[i++] ?? "").trim().toLowerCase();
        return Promise.resolve(a === "y" || a === "yes");
      },
    },
  };
}

const ARGS: HandlerArgs = { positional: [], flags: {}, jsonMode: false };

describe("aifight telegram — interactive panel", () => {
  it("lists every setting with its current value", async () => {
    useTempHome();
    seedLinked({ results: "daily", alerts: false });
    const h = harness(["q"]);

    const code = await telegramPanel(ARGS, h.env, h.io);

    expect(code).toBe(0);
    const text = h.out();
    expect(text).toContain("Linked to chat 4242");
    for (const label of [
      "Match results",
      "Daily digest time",
      "Alerts",
      "Challenge events",
      "Remote control",
      "Message language",
      "Mute",
      "Send a test message",
      "Pair a different chat",
      "Unlink this chat",
    ]) {
      expect(text, label).toContain(label);
    }
    // A1 (2026-08-02): the rows are MenuFrame rows now — the current value is
    // the " — " hint, and it must be this machine's, not the defaults.
    expect(text).toContain("Match results — daily digest");
    expect(text).toContain("Alerts — off");
    expect(text).toContain("q) Done");
  });

  it("renders fully in Chinese when the CLI display locale is zh", async () => {
    useTempHome();
    seedLinked({ results: "per_match" });
    writeBridgeConfig({ ...readBridgeConfig(), locale: "zh" });
    const h = harness(["q"]);

    await telegramPanel(ARGS, h.env, h.io);

    const text = h.out();
    expect(text).toContain("Telegram 手机助手");
    expect(text).toContain("已绑定聊天 4242");
    expect(text).toContain("战报推送 — 每局一报");
    expect(text).toContain("q) 完成");
  });

  it("editing match results writes it to bridge.json", async () => {
    useTempHome();
    seedLinked({ results: "per_match" });
    const h = harness(["1", "off", "q"]);

    await telegramPanel(ARGS, h.env, h.io);

    expect(readBridgeConfig().telegram?.results).toBe("off");
  });

  it("editing a toggle and a free-text field both persist", async () => {
    useTempHome();
    seedLinked({ control: false, digestAt: "09:00" });
    const h = harness(["5", "on", "2", "21:30", "q"]);

    await telegramPanel(ARGS, h.env, h.io);

    const section = readBridgeConfig().telegram;
    expect(section?.control).toBe(true);
    expect(section?.digestAt).toBe("21:30");
  });

  it("'b' backs out of an edit without changing anything", async () => {
    useTempHome();
    seedLinked({ alerts: true });
    const h = harness(["3", "b", "q"]);

    await telegramPanel(ARGS, h.env, h.io);

    expect(readBridgeConfig().telegram?.alerts).toBe(true);
  });

  it("re-asks on a value outside the allowed set instead of writing garbage", async () => {
    useTempHome();
    seedLinked({ results: "per_match" });
    const h = harness(["1", "sometimes", "both", "q"]);

    await telegramPanel(ARGS, h.env, h.io);

    expect(h.out()).toContain("Not one of: per_match, daily, both, off");
    expect(readBridgeConfig().telegram?.results).toBe("both");
  });

  it("an unknown menu choice re-prompts and changes nothing", async () => {
    useTempHome();
    seedLinked();
    const h = harness(["99", "q"]);

    const code = await telegramPanel(ARGS, h.env, h.io);

    expect(code).toBe(0);
    expect(h.out()).toContain("Please enter 1-10 or q");
  });

  it("declining the unlink confirmation keeps the chat linked", async () => {
    useTempHome();
    seedLinked();
    const h = harness(["10", "n", "q"]);

    await telegramPanel(ARGS, h.env, h.io);

    expect(readBridgeConfig().telegram?.chatId).toBe(4242);
    expect(h.out()).toContain("Left as is.");
  });

  it("a failing action is caught and the panel stays open", async () => {
    useTempHome();
    seedLinked();
    // An out-of-range digest time makes the underlying `telegram set` throw.
    const h = harness(["2", "25:99", "q"]);

    const code = await telegramPanel(ARGS, h.env, h.io);

    expect(code).toBe(0);
    expect(h.out()).toContain("Could not complete that");
    // Still open afterwards: the panel header printed a second time.
    expect(h.out().match(/AIFight Telegram companion/g)?.length).toBeGreaterThan(1);
  });

  // The failure message alone says THAT it failed; the UsageError hint is the
  // part that says what would succeed — swallowing it left users guessing.
  it("a rejected value also prints what would be accepted", async () => {
    useTempHome();
    seedLinked();
    const h = harness(["2", "25:99", "q"]);

    await telegramPanel(ARGS, h.env, h.io);

    expect(h.out()).toContain("Could not complete that");
    expect(h.out()).toContain("HH:MM");
  });

  // The complaint that started all of this: three edits in one sitting, three
  // separate "now go run `aifight service restart`" messages.
  it("offers the restart ONCE on the way out, not after every edit", async () => {
    useTempHome();
    seedLinked({ alerts: true, control: false, results: "per_match" });
    pretendBridgeIsRunning();
    const h = harness(["3", "off", "5", "on", "1", "daily", "q"]);

    await telegramPanel(ARGS, h.env, h.io);

    // All three edits landed...
    const section = readBridgeConfig().telegram;
    expect(section?.alerts).toBe(false);
    expect(section?.control).toBe(true);
    expect(section?.results).toBe("daily");
    // ...and the restart came up exactly once.
    const offers = h.out().match(/service restart|next time it starts/g) ?? [];
    expect(offers.length).toBe(1);
  });

  it("says nothing about restarting when no bridge is running here", async () => {
    useTempHome();
    seedLinked({ alerts: true });
    const h = harness(["3", "off", "q"]); // no port file → nothing is holding stale settings

    await telegramPanel(ARGS, h.env, h.io);

    expect(h.out()).not.toContain("service restart");
  });

  it("exits when the chat is unlinked out from under it", async () => {
    useTempHome();
    seedLinked();
    const h = harness(["10", "y"]);

    const code = await telegramPanel(ARGS, h.env, h.io);

    expect(code).toBe(0);
    expect(readBridgeConfig().telegram).toBeUndefined();
    expect(h.out()).toContain("no longer linked");
  });
});
