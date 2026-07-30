// The companion's disk writes for settings changed from the chat.
//
// Three things can go wrong between "the tap worked" and "it is on disk", and
// each used to be silent: the write can fail outright, the chat can have been
// unlinked under the running bridge, and the write itself can impersonate a
// settings change to the restart-pending mtime check. These drive the real
// bridge.json through a temporary AIFight home.

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getBridgeConfigPath,
  readBridgeConfig,
  writeBridgeConfig,
  type BridgeConfig,
} from "../src/bridge/config";
import { startTelegramCompanion } from "../src/notify/telegram/companion";
import { defaultTelegramConfig } from "../src/notify/telegram/settings";
import type { TelegramApi, TelegramUpdate } from "../src/notify/telegram/api";

const CHAT = 4242;

let prevHome: string | undefined;
let tmpDir: string | null = null;

function useTempHome(): string {
  prevHome = process.env.AIFIGHT_RUNTIME_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-telegram-persist-"));
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

function baseConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    version: 1,
    baseUrl: "https://aifight.ai",
    wsUrl: "wss://aifight.ai/api/ws",
    agentId: "agent-1",
    agentName: "PokerMind",
    apiKey: "sk-secret",
    runtimeType: "direct",
    runtimeLocalUrl: "direct://local",
    updatedAt: "2026-07-27T00:00:00.000Z",
    ...overrides,
  };
}

/** English is pinned so the assertions do not depend on the test runner's LANG. */
const SECTION = { ...defaultTelegramConfig(CHAT), locale: "en" as const };

function apiStub(): { api: TelegramApi; sent: Array<{ text: string; keyboard?: unknown }> } {
  const sent: Array<{ text: string; keyboard?: unknown }> = [];
  const api = {
    sendMessage: async (p: { text: string; keyboard?: unknown }) => {
      sent.push(p);
      return { message_id: sent.length, chat: { id: CHAT } };
    },
    editMessageText: async (p: { text: string; keyboard?: unknown }) => {
      sent.push(p);
    },
    answerCallbackQuery: async () => undefined,
  } as unknown as TelegramApi;
  return { api, sent };
}

function tap(data: string): TelegramUpdate {
  return {
    update_id: 2,
    callback_query: {
      id: "cb",
      from: { id: CHAT },
      message: { message_id: 10, chat: { id: CHAT, type: "private" } },
      data,
    },
  };
}

function message(text: string): TelegramUpdate {
  return { update_id: 1, message: { message_id: 1, chat: { id: CHAT, type: "private" }, text } };
}

/** The same mtime comparison apply-settings' bridgeRestartPending makes. */
function restartPendingLike(home: string): boolean {
  try {
    const started = fs.statSync(path.join(home, "port")).mtimeMs;
    return fs.statSync(getBridgeConfigPath()).mtimeMs > started;
  } catch {
    return false;
  }
}

describe("telegram companion — persisting chat edits", () => {
  it("a settings edit lands on disk without looking like a restart is pending", async () => {
    const dir = useTempHome();
    writeBridgeConfig(baseConfig({ telegramBotToken: "1234567:TEST", telegram: SECTION }));
    // The bridge started an hour ago and read this file two hours ago.
    fs.writeFileSync(path.join(dir, "port"), "45996", { mode: 0o644 });
    fs.utimesSync(path.join(dir, "port"), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    const readAt = new Date(Date.now() - 7_200_000);
    fs.utimesSync(getBridgeConfigPath(), readAt, readAt);

    const stub = apiStub();
    const companion = startTelegramCompanion({
      config: baseConfig({ telegramBotToken: "1234567:TEST", telegram: SECTION }),
      apiFactory: () => stub.api,
      poll: false,
    });

    await companion!.handleUpdate(tap("v1:notify:results:daily"));

    // The edit is on disk (the in-memory change alone would not show up here)...
    expect(readBridgeConfig().telegram?.results).toBe("daily");
    // ...but it is already live in this process, so the write must not read as
    // "settings changed since the bridge started".
    expect(restartPendingLike(dir)).toBe(false);
    await companion!.stop();
  });

  it("a settings edit after an unlink is flagged session-only instead of silently dropped", async () => {
    useTempHome();
    // On disk the chat was already unlinked; this process still has the
    // section from startup, so its panel keeps answering.
    writeBridgeConfig(baseConfig({ telegramBotToken: "1234567:TEST" }));
    const logs: string[] = [];
    const stub = apiStub();
    const companion = startTelegramCompanion({
      config: baseConfig({ telegramBotToken: "1234567:TEST", telegram: SECTION }),
      apiFactory: () => stub.api,
      onLog: (e) => logs.push(e.code),
      poll: false,
    });

    await companion!.handleUpdate(tap("v1:notify:results:daily"));

    // The panel admits it instead of implying "saved"...
    expect(stub.sent.some((s) => s.text.includes("could not be written to disk"))).toBe(true);
    // ...the skip is logged...
    expect(logs).toContain("telegram.config_write_skipped");
    // ...and the unlink is NOT undone by the panel's snapshot.
    expect(readBridgeConfig().telegram).toBeUndefined();
    await companion!.stop();
  });

  it("a chat rename is NOT mtime-neutral — the CLI restart hint must fire", async () => {
    const dir = useTempHome();
    writeBridgeConfig(baseConfig({ telegramBotToken: "1234567:TEST", telegram: SECTION }));
    // Same clock layout as the neutral-edit case above: bridge started an hour
    // ago, config last read two hours ago. A toggle write must stay invisible
    // to that comparison (previous test); a RENAME must not — the control API
    // keeps routing by the boot-time name, so `aifight start` addressed to the
    // new name 404s until a restart, and the mtime bump is what surfaces that.
    fs.writeFileSync(path.join(dir, "port"), "45996", { mode: 0o644 });
    fs.utimesSync(path.join(dir, "port"), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    const readAt = new Date(Date.now() - 7_200_000);
    fs.utimesSync(getBridgeConfigPath(), readAt, readAt);

    const fetchImpl = (async (input: string | URL | Request) =>
      String(input).includes("/api/agents/me/name")
        ? new Response(JSON.stringify({ name: "Dark Knight" }), { status: 200 })
        : new Response("{}", { status: 404 })) as unknown as typeof fetch;
    const stub = apiStub();
    const companion = startTelegramCompanion({
      config: baseConfig({ telegramBotToken: "1234567:TEST", telegram: SECTION }),
      apiFactory: () => stub.api,
      fetchImpl,
      poll: false,
    });

    await companion!.handleUpdate(tap("v1:settings:ask_rename"));
    await companion!.handleUpdate(message("Dark Knight"));
    const keyboard = [...stub.sent].reverse().find((s) => s.keyboard !== undefined)?.keyboard as
      | Array<Array<{ callback_data?: string }>>
      | undefined;
    const confirm = (keyboard ?? []).flat().find((b) => b.callback_data?.startsWith("v1:settings:rename") === true);
    await companion!.handleUpdate(tap(confirm!.callback_data!));

    expect(readBridgeConfig().agentName).toBe("Dark Knight");
    expect(restartPendingLike(dir)).toBe(true);
    // The receipt itself must say so — a hint the CLI only shows later is not
    // enough for a user who never leaves the chat.
    const receipt = stub.sent.map((s) => s.text).join("\n");
    expect(receipt).toContain("after the bridge restarts");
    await companion!.stop();
  });

  it("a rename after an unlink still saves the name — only the telegram half is dropped", async () => {
    useTempHome();
    writeBridgeConfig(baseConfig({ telegramBotToken: "1234567:TEST" })); // unlinked on disk
    const fetchImpl = (async (input: string | URL | Request) =>
      String(input).includes("/api/agents/me/name")
        ? new Response(JSON.stringify({ name: "Dark Knight" }), { status: 200 })
        : new Response("{}", { status: 404 })) as unknown as typeof fetch;
    const stub = apiStub();
    const companion = startTelegramCompanion({
      config: baseConfig({ telegramBotToken: "1234567:TEST", telegram: SECTION }),
      apiFactory: () => stub.api,
      fetchImpl,
      poll: false,
    });

    await companion!.handleUpdate(tap("v1:settings:ask_rename"));
    await companion!.handleUpdate(message("Dark Knight"));
    const keyboard = [...stub.sent].reverse().find((s) => s.keyboard !== undefined)?.keyboard as
      | Array<Array<{ callback_data?: string }>>
      | undefined;
    const confirm = (keyboard ?? []).flat().find((b) => b.callback_data?.startsWith("v1:settings:rename") === true);
    await companion!.handleUpdate(tap(confirm!.callback_data!));

    expect(readBridgeConfig().agentName).toBe("Dark Knight");
    expect(readBridgeConfig().telegram).toBeUndefined(); // still not resurrected
    await companion!.stop();
  });

  it("a failed write is admitted in the panel, not implied saved", async () => {
    useTempHome();
    writeBridgeConfig(baseConfig({ telegramBotToken: "1234567:TEST", telegram: SECTION }));
    // Sabotage the config path: a DIRECTORY named bridge.json breaks the write.
    fs.rmSync(getBridgeConfigPath());
    fs.mkdirSync(getBridgeConfigPath());
    const logs: string[] = [];
    const stub = apiStub();
    const companion = startTelegramCompanion({
      config: baseConfig({ telegramBotToken: "1234567:TEST", telegram: SECTION }),
      apiFactory: () => stub.api,
      onLog: (e) => logs.push(e.code),
      poll: false,
    });

    await companion!.handleUpdate(tap("v1:notify:results:daily"));

    // The new value shows (it IS live for this session)...
    expect(stub.sent.some((s) => s.text.includes("daily digest only"))).toBe(true);
    // ...but the panel also says it will not survive a restart.
    expect(stub.sent.some((s) => s.text.includes("could not be written to disk"))).toBe(true);
    expect(logs).toContain("telegram.config_write_failed");
    await companion!.stop();
  });
});
