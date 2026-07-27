// `aifight telegram …` — local settings surface. No network is involved in any
// of these paths, so the whole command family is exercised end to end through
// the real CLI entry point against a temporary AIFight home.

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { run } from "../src/cli/main";
import {
  readBridgeConfig,
  writeBridgeConfig,
  type BridgeConfig,
  type BridgeTelegramConfig,
} from "../src/bridge/config";
import { defaultTelegramConfig } from "../src/notify/telegram/settings";

let prevHome: string | undefined;
let tmpDir: string | null = null;

function useTempHome(): string {
  prevHome = process.env.AIFIGHT_RUNTIME_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-telegram-cli-"));
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

async function runCapture(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(argv, {
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

function baseConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
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
    ...overrides,
  };
}

/** A machine with the companion paired and default settings. */
function seedLinked(section: Partial<BridgeTelegramConfig> = {}): void {
  writeBridgeConfig(baseConfig({
    telegramBotToken: "1234567:TEST-bot-token-not-real-9zx",
    telegram: { ...defaultTelegramConfig(4242), ...section },
  }));
}

function storedSection(): BridgeTelegramConfig | undefined {
  return readBridgeConfig().telegram;
}

describe("aifight telegram status", () => {
  it("points at setup when this machine has no agent at all", async () => {
    useTempHome();
    const r = await runCapture(["telegram", "status"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("aifight setup");
  });

  it("guides an agent that has no companion yet", async () => {
    useTempHome();
    writeBridgeConfig(baseConfig());

    const r = await runCapture(["telegram", "status"]);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Status: not set up");
    expect(r.stdout).toContain("aifight telegram setup");
  });

  it("reports a saved token with no linked chat", async () => {
    useTempHome();
    writeBridgeConfig(baseConfig({ telegramBotToken: "1234567:TEST-bot-token-not-real-9zx" }));

    const r = await runCapture(["telegram", "status"]);

    expect(r.stdout).toContain("no chat linked");
    expect(r.stdout).toContain("…-9zx"); // tail only
    expect(r.stdout).not.toContain("1234567:TEST");
  });

  it("shows the settings of a linked companion and never the token", async () => {
    useTempHome();
    seedLinked();

    const r = await runCapture(["telegram", "status"]);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("linked to chat 4242");
    expect(r.stdout).toContain("Match results: per_match");
    expect(r.stdout).toContain("Daily digest: 22:00");
    expect(r.stdout).toContain("Remote control: on");
    expect(r.stdout).not.toContain("1234567:TEST");
  });

  it("--json carries the settings without the token", async () => {
    useTempHome();
    seedLinked({ locale: "zh" });

    const r = await runCapture(["telegram", "status", "--json"]);

    const body = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(body.status).toBe("linked");
    expect(body.chatId).toBe(4242);
    expect((body.settings as Record<string, unknown>).locale).toBe("zh");
    expect((body.settings as Record<string, unknown>).effectiveLocale).toBe("zh");
    expect(r.stdout).not.toContain("TEST-bot-token");
  });

  it("bare `aifight telegram` behaves like status", async () => {
    useTempHome();
    seedLinked();
    const r = await runCapture(["telegram"]);
    expect(r.stdout).toContain("linked to chat 4242");
  });

  it("rejects an unknown subcommand with usage (exit 2)", async () => {
    useTempHome();
    const r = await runCapture(["telegram", "frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown telegram subcommand");
  });
});

describe("aifight telegram set", () => {
  it("applies every settable key", async () => {
    useTempHome();
    seedLinked();

    expect((await runCapture(["telegram", "set", "results", "daily"])).code).toBe(0);
    expect((await runCapture(["telegram", "set", "digest_at", "07:05"])).code).toBe(0);
    expect((await runCapture(["telegram", "set", "alerts", "off"])).code).toBe(0);
    expect((await runCapture(["telegram", "set", "challenge_events", "off"])).code).toBe(0);
    expect((await runCapture(["telegram", "set", "control", "off"])).code).toBe(0);
    expect((await runCapture(["telegram", "set", "locale", "en"])).code).toBe(0);

    expect(storedSection()).toMatchObject({
      chatId: 4242,
      results: "daily",
      digestAt: "07:05",
      alerts: false,
      challengeEvents: false,
      control: false,
      locale: "en",
    });
  });

  it("locale auto clears the override", async () => {
    useTempHome();
    seedLinked({ locale: "zh" });

    await runCapture(["telegram", "set", "locale", "auto"]);

    expect(storedSection()).not.toHaveProperty("locale");
  });

  it("rejects an unknown key and lists the real ones", async () => {
    useTempHome();
    seedLinked();

    const r = await runCapture(["telegram", "set", "volume", "11"]);

    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown telegram setting");
    expect(r.stderr).toContain("challenge_events");
    expect(storedSection()!.results).toBe("per_match");
  });

  it("rejects out-of-range values and leaves the config untouched", async () => {
    useTempHome();
    seedLinked();

    const bad = await runCapture(["telegram", "set", "results", "hourly"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("per_match");

    const badTime = await runCapture(["telegram", "set", "digest_at", "7:5"]);
    expect(badTime.code).toBe(2);

    expect(storedSection()).toMatchObject({ results: "per_match", digestAt: "22:00" });
  });

  it("refuses to set anything before the companion is linked", async () => {
    useTempHome();
    writeBridgeConfig(baseConfig());

    const r = await runCapture(["telegram", "set", "results", "daily"]);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not linked");
  });

  it("needs both a key and a value", async () => {
    useTempHome();
    seedLinked();
    expect((await runCapture(["telegram", "set", "results"])).code).toBe(2);
    expect((await runCapture(["telegram", "set", "results", "daily", "extra"])).code).toBe(2);
  });
});

describe("aifight telegram mute", () => {
  it("mutes for an hour and unmutes again", async () => {
    useTempHome();
    seedLinked();
    const before = Date.now();

    const muted = await runCapture(["telegram", "mute", "1h"]);
    expect(muted.code).toBe(0);
    expect(muted.stdout).toContain("Alerts");
    const until = storedSection()!.mutedUntil!;
    expect(until).toBeGreaterThanOrEqual(before + 60 * 60_000 - 5_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 60 * 60_000 + 5_000);

    await runCapture(["telegram", "mute", "off"]);
    expect(storedSection()).not.toHaveProperty("mutedUntil");
  });

  it("`today` mutes until the end of the local day", async () => {
    useTempHome();
    seedLinked();

    await runCapture(["telegram", "mute", "today"]);

    const until = new Date(storedSection()!.mutedUntil!);
    expect(until.getHours()).toBe(0);
    expect(until.getMinutes()).toBe(0);
    expect(until.getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects an unknown window", async () => {
    useTempHome();
    seedLinked();
    const r = await runCapture(["telegram", "mute", "forever"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("1h");
  });

  it("shows the mute state in status", async () => {
    useTempHome();
    seedLinked({ mutedUntil: Date.now() + 30 * 60_000 });
    const r = await runCapture(["telegram", "status"]);
    expect(r.stdout).toContain("muted until");
  });
});

describe("aifight telegram unlink / uninstall", () => {
  it("unlink forgets the chat and keeps the token", async () => {
    useTempHome();
    seedLinked();

    const r = await runCapture(["telegram", "unlink"]);

    expect(r.code).toBe(0);
    const after = readBridgeConfig();
    expect(after.telegram).toBeUndefined();
    expect(after.telegramBotToken).toBe("1234567:TEST-bot-token-not-real-9zx");
  });

  it("uninstall --yes removes both the settings and the token", async () => {
    useTempHome();
    seedLinked();

    const r = await runCapture(["telegram", "uninstall", "--yes"]);

    expect(r.code).toBe(0);
    const after = readBridgeConfig();
    expect(after.telegram).toBeUndefined();
    expect(after.telegramBotToken).toBeUndefined();
    // ...and the agent identity is untouched.
    expect(after.apiKey).toBe("sk-existing-secret");
  });

  it("uninstall without --yes refuses non-interactively rather than deleting", async () => {
    useTempHome();
    seedLinked();

    const r = await runCapture(["telegram", "uninstall", "--json"]);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--yes");
    expect(readBridgeConfig().telegramBotToken).toBe("1234567:TEST-bot-token-not-real-9zx");
  });

  it("uninstall on a machine with nothing configured is a no-op", async () => {
    useTempHome();
    writeBridgeConfig(baseConfig());
    const r = await runCapture(["telegram", "uninstall", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("nothing to remove");
  });
});

describe("aifight telegram help", () => {
  it("prints its own usage without touching config", async () => {
    useTempHome();
    const r = await runCapture(["telegram", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("aifight telegram set <key> <value>");
    expect(r.stdout).toContain("challenge_events");
  });
});
