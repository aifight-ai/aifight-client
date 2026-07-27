// `aifight telegram setup` / `test` driven through the real CLI entry point
// with a stubbed Telegram. Non-interactive by construction (vitest has no TTY),
// so the token arrives via --token-env — the same path a VPS install uses.

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { run } from "../src/cli/main";
import { readBridgeConfig, writeBridgeConfig, type BridgeConfig } from "../src/bridge/config";
import { defaultTelegramConfig } from "../src/notify/telegram/settings";
import type { TelegramUpdate } from "../src/notify/telegram/api";

const TOKEN = "1234567:TEST-bot-token-not-real-9zx";
const TOKEN_ENV = "AIFIGHT_TEST_TELEGRAM_TOKEN";

let prevHome: string | undefined;
let tmpDir: string | null = null;

function useTempHome(): void {
  prevHome = process.env.AIFIGHT_RUNTIME_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-telegram-setup-"));
  process.env.AIFIGHT_RUNTIME_HOME = tmpDir;
}

afterEach(() => {
  if (prevHome === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
  else process.env.AIFIGHT_RUNTIME_HOME = prevHome;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  prevHome = undefined;
  tmpDir = null;
  delete process.env[TOKEN_ENV];
});

async function runCapture(argv: readonly string[], fetchImpl?: typeof fetch): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(argv, {
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
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

interface TelegramStub {
  fetchImpl: typeof fetch;
  calls: Array<{ method: string; body: Record<string, unknown> }>;
  /** What the user "sends" from their phone, one getUpdates answer per entry. */
  updates: TelegramUpdate[][];
}

/** A Telegram that answers getMe, hands over scripted updates, and accepts
 *  every send. Individual cases override single methods via `overrides`. */
function telegramStub(
  updates: TelegramUpdate[][],
  overrides: Partial<Record<string, () => Response>> = {},
): TelegramStub {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let poll = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const text = String(url);
    const method = text.slice(text.lastIndexOf("/") + 1);
    const body = init?.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>);
    calls.push({ method, body });
    const override = overrides[method];
    if (override !== undefined) return override();
    if (method === "getMe") {
      return json({ id: 42, is_bot: true, first_name: "PokerMind bot", username: "pokermind_bot" });
    }
    if (method === "getUpdates") return json(updates[poll++] ?? []);
    return json({ message_id: 1, chat: { id: 55_501 } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, updates };
}

function json(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, description: string): Response {
  return new Response(JSON.stringify({ ok: false, error_code: status, description }), { status });
}

/** The pairing message the phone sends, carrying whatever code was printed. */
function pairingUpdate(code: string): TelegramUpdate {
  return { update_id: 1, message: { message_id: 1, chat: { id: 55_501, type: "private" }, text: code } };
}

/** A stub that reads the printed code out of stdout at poll time, so the test
 *  does not need to predict the random code. */
function pairingStub(readStdout: () => string): TelegramStub {
  const stub = telegramStub([]);
  const inner = stub.fetchImpl;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const text = String(url);
    if (text.endsWith("/getUpdates")) {
      const code = /pairing code:\s+(\d{6})/.exec(readStdout())?.[1];
      stub.calls.push({ method: "getUpdates", body: {} });
      return json(code === undefined ? [] : [pairingUpdate(code)]);
    }
    return inner(url, init);
  }) as unknown as typeof fetch;
  return { ...stub, fetchImpl };
}

describe("aifight telegram setup", () => {
  it("verifies the token, pairs the chat, and writes the whole section", async () => {
    useTempHome();
    writeBridgeConfig(baseConfig());
    process.env[TOKEN_ENV] = TOKEN;
    const chunks: string[] = [];
    const stub = pairingStub(() => chunks.join(""));

    const code = await run(["telegram", "setup", "--token-env", TOKEN_ENV], {
      stdout: (s) => chunks.push(s),
      stderr: (s) => chunks.push(s),
      fetchImpl: stub.fetchImpl,
    });
    const out = chunks.join("");

    expect(code).toBe(0);
    expect(out).toContain("Bot verified: @pokermind_bot");
    expect(out).toContain("Linked to chat 55501");

    const saved = readBridgeConfig();
    expect(saved.telegramBotToken).toBe(TOKEN);
    expect(saved.telegram).toEqual({ ...defaultTelegramConfig(55_501) });

    // Welcome message + command menu, in that order, to the paired chat only.
    const sent = stub.calls.filter((c) => c.method === "sendMessage");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.chat_id).toBe(55_501);
    expect(String(sent[0]!.body.text)).toContain("PokerMind");
    expect(stub.calls.some((c) => c.method === "setMyCommands")).toBe(true);
  });

  it("keeps existing settings when re-pairing a different chat", async () => {
    useTempHome();
    writeBridgeConfig(baseConfig({
      telegramBotToken: TOKEN,
      telegram: { ...defaultTelegramConfig(1), results: "daily", control: false, locale: "zh" },
    }));
    const chunks: string[] = [];
    const stub = pairingStub(() => chunks.join(""));

    const code = await run(["telegram", "setup", "--yes"], {
      stdout: (s) => chunks.push(s),
      stderr: (s) => chunks.push(s),
      fetchImpl: stub.fetchImpl,
    });

    expect(code).toBe(0);
    expect(readBridgeConfig().telegram).toEqual({
      ...defaultTelegramConfig(55_501),
      results: "daily",
      control: false,
      locale: "zh",
    });
  });

  it("refuses to re-pair an already linked machine without --yes", async () => {
    useTempHome();
    writeBridgeConfig(baseConfig({ telegramBotToken: TOKEN, telegram: defaultTelegramConfig(1) }));
    const stub = telegramStub([]);

    const r = await runCapture(["telegram", "setup"], stub.fetchImpl);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--yes");
    expect(stub.calls).toHaveLength(0); // nothing was even asked of Telegram
  });

  it("rejects a bad token without storing anything", async () => {
    useTempHome();
    writeBridgeConfig(baseConfig());
    process.env[TOKEN_ENV] = TOKEN;
    const stub = telegramStub([], { getMe: () => errorResponse(404, "Not Found") });

    const r = await runCapture(["telegram", "setup", "--token-env", TOKEN_ENV], stub.fetchImpl);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("rejected that bot token");
    expect(r.stderr).not.toContain(TOKEN);
    expect(readBridgeConfig().telegramBotToken).toBeUndefined();
  });

  it("says which environment variable is empty rather than prompting", async () => {
    useTempHome();
    writeBridgeConfig(baseConfig());
    const r = await runCapture(["telegram", "setup", "--token-env", TOKEN_ENV]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(TOKEN_ENV);
  });

  it("catches a token pasted into --token-env instead of a variable name", async () => {
    useTempHome();
    writeBridgeConfig(baseConfig());
    const r = await runCapture(["telegram", "setup", "--token-env", TOKEN]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("NAME of an environment variable");
  });

  it("needs an agent before it can notify about one", async () => {
    useTempHome();
    process.env[TOKEN_ENV] = TOKEN;
    const r = await runCapture(["telegram", "setup", "--token-env", TOKEN_ENV]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no AIFight agent");
  });

  it("has no --json form (it is a conversation with a phone)", async () => {
    useTempHome();
    writeBridgeConfig(baseConfig());
    const r = await runCapture(["telegram", "setup", "--json"]);
    expect(r.code).toBe(2);
  });

  it("survives a welcome message that fails after pairing succeeded", async () => {
    useTempHome();
    writeBridgeConfig(baseConfig());
    process.env[TOKEN_ENV] = TOKEN;
    const chunks: string[] = [];
    const stub = pairingStub(() => chunks.join(""));
    const failing = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/sendMessage")) return errorResponse(403, "Forbidden: bot was blocked by the user");
      return stub.fetchImpl(url, init);
    }) as unknown as typeof fetch;

    const code = await run(["telegram", "setup", "--token-env", TOKEN_ENV], {
      stdout: (s) => chunks.push(s),
      stderr: (s) => chunks.push(s),
      fetchImpl: failing,
    });

    expect(code).toBe(0);
    expect(chunks.join("")).toContain("welcome message failed");
    expect(readBridgeConfig().telegram?.chatId).toBe(55_501); // the pairing still stands
  });
});

describe("aifight telegram test", () => {
  it("sends one message to the linked chat", async () => {
    useTempHome();
    writeBridgeConfig(baseConfig({ telegramBotToken: TOKEN, telegram: defaultTelegramConfig(55_501) }));
    const stub = telegramStub([]);

    const r = await runCapture(["telegram", "test"], stub.fetchImpl);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Test message sent to chat 55501");
    const sent = stub.calls.filter((c) => c.method === "sendMessage");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ chat_id: 55_501, parse_mode: "HTML" });
  });

  it("reports a blocked bot in words the user can act on", async () => {
    useTempHome();
    writeBridgeConfig(baseConfig({ telegramBotToken: TOKEN, telegram: defaultTelegramConfig(55_501) }));
    const stub = telegramStub([], {
      sendMessage: () => errorResponse(403, "Forbidden: bot was blocked by the user"),
    });

    const r = await runCapture(["telegram", "test"], stub.fetchImpl);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("blocked");
    expect(r.stderr).toContain("aifight telegram setup");
  });

  it("refuses before anything is linked", async () => {
    useTempHome();
    writeBridgeConfig(baseConfig());
    const r = await runCapture(["telegram", "test"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not linked");
  });
});
