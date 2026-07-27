// The Telegram companion's half of bridge.json: the bot token rides the
// existing encrypted-field pipeline, and the settings block is a strictly
// shaped but strictly optional section.

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getBridgeConfigPath,
  isBridgeTelegramConfig,
  readBridgeConfig,
  redactBridgeConfig,
  writeBridgeConfig,
  type BridgeConfig,
  type BridgeTelegramConfig,
} from "../src/bridge/config";
import { defaultTelegramConfig } from "../src/notify/telegram/settings";

let prevHome: string | undefined;
let tmpDir: string | null = null;

function useTempHome(): string {
  prevHome = process.env.AIFIGHT_RUNTIME_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-telegram-config-"));
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

const BOT_TOKEN = "1234567:TEST-bot-token-not-real-9zx";

function config(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    version: 1,
    baseUrl: "https://aifight.ai",
    wsUrl: "wss://aifight.ai/api/ws",
    agentId: "agent-1",
    agentName: "alpha",
    apiKey: "sk-test-secret-key",
    runtimeType: "direct",
    runtimeLocalUrl: "direct://local",
    runtimeModel: "direct",
    directAgentSlug: "default",
    updatedAt: "2026-07-27T00:00:00.000Z",
    ...overrides,
  };
}

function rawOnDisk(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(getBridgeConfigPath(), "utf8")) as Record<string, unknown>;
}

// The section is an object inside a file three programs write. A panel edit
// that carried the whole in-memory section back would revert a CLI change made
// since the bridge started — and could resurrect a section `unlink` removed.
describe("panel writes into a shared bridge.json", () => {
  const stubApi = () => ({
    sendMessage: async () => ({ message_id: 1, chat: { id: 4242 } }),
    editMessageText: async () => undefined,
    answerCallbackQuery: async () => undefined,
  });

  const tapNotify = (data: string) => ({
    update_id: 1,
    callback_query: {
      id: "cb",
      from: { id: 4242 },
      message: { message_id: 9, chat: { id: 4242, type: "private" } },
      data,
    },
  });

  it("keeps a CLI change to another field in the same section", async () => {
    useTempHome();
    const { startTelegramCompanion } = await import("../src/notify/telegram/companion");
    const started = config({ telegramBotToken: BOT_TOKEN, telegram: defaultTelegramConfig(4242) });
    writeBridgeConfig(started);

    const companion = startTelegramCompanion({
      config: started,
      apiFactory: () => stubApi() as never,
      poll: false,
    });

    // Meanwhile, from the CLI: `aifight telegram set digest_at 08:00`.
    const onDisk = readBridgeConfig();
    writeBridgeConfig({ ...onDisk, telegram: { ...onDisk.telegram!, digestAt: "08:00" } });

    await companion!.handleUpdate(tapNotify("v1:notify:alerts:off") as never);
    await companion!.stop();

    const after = readBridgeConfig().telegram!;
    expect(after.alerts).toBe(false); // the panel's own change landed
    expect(after.digestAt).toBe("08:00"); // and did not take the CLI's with it
  });

  it("does not put back a section that `telegram unlink` removed", async () => {
    useTempHome();
    const { startTelegramCompanion } = await import("../src/notify/telegram/companion");
    const started = config({ telegramBotToken: BOT_TOKEN, telegram: defaultTelegramConfig(4242) });
    writeBridgeConfig(started);

    const companion = startTelegramCompanion({
      config: started,
      apiFactory: () => stubApi() as never,
      poll: false,
    });

    // Meanwhile, from the CLI: `aifight telegram unlink`.
    const { telegram: _dropped, ...rest } = readBridgeConfig();
    writeBridgeConfig(rest);

    await companion!.handleUpdate(tapNotify("v1:notify:results:off") as never);
    await companion!.stop();

    expect(readBridgeConfig().telegram).toBeUndefined();
  });
});

describe("telegram config storage", () => {
  it("round-trips the token and the settings section", () => {
    useTempHome();
    const cfg = config({ telegramBotToken: BOT_TOKEN, telegram: defaultTelegramConfig(4242) });

    writeBridgeConfig(cfg);

    expect(readBridgeConfig()).toEqual(cfg);
  });

  it("encrypts the bot token at rest and never leaves it in the file", () => {
    useTempHome();
    writeBridgeConfig(config({ telegramBotToken: BOT_TOKEN, telegram: defaultTelegramConfig(7) }));

    expect(rawOnDisk().telegramBotToken).toMatch(/^enc:/);
    expect(fs.readFileSync(getBridgeConfigPath(), "utf8")).not.toContain(BOT_TOKEN);
    // The non-secret settings stay readable — only the credential is wrapped.
    expect((rawOnDisk().telegram as Record<string, unknown>).chatId).toBe(7);
  });

  it("redacts the bot token for status output", () => {
    const redacted = redactBridgeConfig(config({ telegramBotToken: BOT_TOKEN }));
    expect(redacted.telegramBotToken).not.toContain("TEST-bot-token");
    expect(redacted.telegramBotToken).toBe("1234...-9zx");
  });

  it("releases the stored secret when the token is dropped", () => {
    useTempHome();
    writeBridgeConfig(config({ telegramBotToken: BOT_TOKEN }));
    const encrypted = rawOnDisk().telegramBotToken;
    expect(encrypted).toMatch(/^enc:/);

    writeBridgeConfig(config()); // token removed

    expect(rawOnDisk()).not.toHaveProperty("telegramBotToken");
    expect(readBridgeConfig().telegramBotToken).toBeUndefined();
  });

  it("keeps a config without any telegram fields valid", () => {
    useTempHome();
    writeBridgeConfig(config());
    expect(readBridgeConfig().telegram).toBeUndefined();
  });

  // A hand-edited or half-written settings block must not take the bridge down
  // with it: the section is dropped and the companion reads as "not set up".
  it("drops a malformed telegram section instead of failing the whole config", () => {
    const dir = useTempHome();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      getBridgeConfigPath(),
      JSON.stringify({ ...config(), telegram: { chatId: "not-a-number", results: "hourly" } }, null, 2) + "\n",
    );

    const read = readBridgeConfig();
    expect(read.telegram).toBeUndefined();
    expect(read.agentId).toBe("agent-1"); // ...and the rest survived
  });
});

describe("isBridgeTelegramConfig", () => {
  const valid: BridgeTelegramConfig = defaultTelegramConfig(99);

  it("accepts the default section and an explicitly configured one", () => {
    expect(isBridgeTelegramConfig(valid)).toBe(true);
    expect(isBridgeTelegramConfig({ ...valid, locale: "zh", mutedUntil: 1_700_000_000_000 })).toBe(true);
  });

  it("rejects a missing or non-integer chat id", () => {
    const { chatId: _dropped, ...noChat } = valid;
    expect(isBridgeTelegramConfig(noChat)).toBe(false);
    expect(isBridgeTelegramConfig({ ...valid, chatId: 1.5 })).toBe(false);
  });

  it("rejects unknown enum values and malformed digest times", () => {
    expect(isBridgeTelegramConfig({ ...valid, results: "hourly" })).toBe(false);
    expect(isBridgeTelegramConfig({ ...valid, locale: "fr" })).toBe(false);
    expect(isBridgeTelegramConfig({ ...valid, digestAt: "25:00" })).toBe(false);
    expect(isBridgeTelegramConfig({ ...valid, digestAt: "9:30" })).toBe(false);
    expect(isBridgeTelegramConfig({ ...valid, alerts: "yes" })).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isBridgeTelegramConfig(null)).toBe(false);
    expect(isBridgeTelegramConfig([valid])).toBe(false);
    expect(isBridgeTelegramConfig("linked")).toBe(false);
  });
});
