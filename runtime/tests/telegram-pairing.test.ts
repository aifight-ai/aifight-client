// Pairing: whichever private chat sends the six-digit code first becomes the
// one chat this companion ever talks to. Everything else is discarded in
// silence — a probe learns nothing.

import { describe, expect, it } from "vitest";

import { TelegramApiError, type GetUpdatesParams, type TelegramApi, type TelegramUpdate } from "../src/notify/telegram/api";
import {
  containsPairingCode,
  generatePairingCode,
  waitForPairingCode,
} from "../src/notify/telegram/pairing";

function chatMessage(updateId: number, chatId: number, text: string, type = "private"): TelegramUpdate {
  return { update_id: updateId, message: { message_id: updateId, chat: { id: chatId, type }, text } };
}

function scriptedApi(steps: ReadonlyArray<TelegramUpdate[] | Error>): {
  api: TelegramApi;
  offsets: Array<number | undefined>;
} {
  const offsets: Array<number | undefined> = [];
  let i = 0;
  const api = {
    getUpdates: async (params: GetUpdatesParams) => {
      offsets.push(params.offset);
      const step = steps[i++] ?? [];
      if (step instanceof Error) throw step;
      return step;
    },
  } as unknown as TelegramApi;
  return { api, offsets };
}

/** A clock that advances one minute per read, so a 10-minute deadline ends. */
function steppingClock(start: number, stepMs: number): () => number {
  let t = start;
  return () => {
    const current = t;
    t += stepMs;
    return current;
  };
}

describe("waitForPairingCode", () => {
  it("locks onto the chat that sent the code", async () => {
    const script = scriptedApi([[chatMessage(1, 55_501, "123456")]]);

    const outcome = await waitForPairingCode({ api: script.api, code: "123456", deadline: Date.now() + 60_000 });

    expect(outcome).toEqual({ status: "paired", chatId: 55_501, lastUpdateId: 1 });
  });

  it("accepts the code inside a /start payload", async () => {
    const script = scriptedApi([[chatMessage(9, 42, "/start 123456")]]);
    const outcome = await waitForPairingCode({ api: script.api, code: "123456", deadline: Date.now() + 60_000 });
    expect(outcome).toMatchObject({ status: "paired", chatId: 42 });
  });

  it("ignores wrong codes and other chatter, then pairs on the right one", async () => {
    const script = scriptedApi([
      [chatMessage(1, 900, "hello?"), chatMessage(2, 901, "654321")],
      [chatMessage(3, 902, "123456")],
    ]);

    const outcome = await waitForPairingCode({ api: script.api, code: "123456", deadline: Date.now() + 60_000 });

    expect(outcome).toMatchObject({ status: "paired", chatId: 902 });
    // The second poll confirmed everything already seen.
    expect(script.offsets).toEqual([undefined, 3]);
  });

  it("refuses to pair with a group chat", async () => {
    const script = scriptedApi([[chatMessage(1, -100, "123456", "supergroup")]]);
    const outcome = await waitForPairingCode({
      api: script.api,
      code: "123456",
      deadline: 10_000,
      now: steppingClock(0, 4_000),
    });
    expect(outcome).toEqual({ status: "timeout" });
  });

  it("gives up at the deadline", async () => {
    const script = scriptedApi([[], [], []]);
    const outcome = await waitForPairingCode({
      api: script.api,
      code: "123456",
      deadline: 600_000,
      now: steppingClock(0, 200_000),
    });
    expect(outcome).toEqual({ status: "timeout" });
  });

  it("keeps trying through a transient network failure", async () => {
    const script = scriptedApi([
      new TelegramApiError("network", "could not reach Telegram"),
      [chatMessage(4, 77, "123456")],
    ]);
    const logs: string[] = [];

    const outcome = await waitForPairingCode({
      api: script.api,
      code: "123456",
      deadline: Date.now() + 60_000,
      onLog: (m) => logs.push(m),
    });

    expect(outcome).toMatchObject({ status: "paired", chatId: 77 });
    expect(logs).toHaveLength(1);
  });

  it("surfaces a dead token immediately instead of burning the window", async () => {
    const script = scriptedApi([new TelegramApiError("auth", "getUpdates: Unauthorized", { status: 401 })]);

    await expect(
      waitForPairingCode({ api: script.api, code: "123456", deadline: Date.now() + 60_000 }),
    ).rejects.toMatchObject({ kind: "auth" });
  });

  // A six-digit code has 900,000 values, but one Telegram message holds 4096
  // characters — room for ~585 of them. Counting messages instead of candidates
  // would let a stranger sweep the whole space inside the ten-minute window.
  it("gives up when wrong codes keep arriving, however few messages carry them", async () => {
    const spray = Array.from({ length: 600 }, (_, i) => String(100_000 + i)).join(" ");
    const script = scriptedApi([[chatMessage(1, 66, spray)]]);

    const outcome = await waitForPairingCode({
      api: script.api,
      code: "999999",
      deadline: Date.now() + 600_000,
    });

    expect(outcome).toEqual({ status: "abandoned" });
  });

  it("still forgives a handful of typos", async () => {
    const script = scriptedApi([
      [chatMessage(1, 66, "123455"), chatMessage(2, 66, "123457")],
      [chatMessage(3, 66, "123456")],
    ]);

    const outcome = await waitForPairingCode({
      api: script.api,
      code: "123456",
      deadline: Date.now() + 60_000,
    });

    expect(outcome).toMatchObject({ status: "paired", chatId: 66 });
  });

  // Telegram answers the second getUpdates on a token with 409. Retrying cannot
  // win that race — and the running bridge may swallow the code meanwhile.
  it("reports a second listener instead of fighting it", async () => {
    const script = scriptedApi([
      new TelegramApiError("request", "Conflict: terminated by other getUpdates request", { status: 409 }),
    ]);

    const outcome = await waitForPairingCode({
      api: script.api,
      code: "123456",
      deadline: Date.now() + 600_000,
    });

    expect(outcome).toMatchObject({ status: "conflict" });
  });

  // Without a wait, a fast failure spins the loop for the whole ten minutes:
  // 100% of a core and a flooded terminal. Measured in polls, not in seconds.
  it("waits between failed polls instead of spinning", async () => {
    const waits: number[] = [];
    const script = scriptedApi([
      new TelegramApiError("network", "boom"),
      new TelegramApiError("network", "boom"),
      [chatMessage(7, 66, "123456")],
    ]);

    const outcome = await waitForPairingCode({
      api: script.api,
      code: "123456",
      deadline: Date.now() + 600_000,
      sleepFn: async (ms) => {
        waits.push(ms);
      },
    });

    expect(outcome).toMatchObject({ status: "paired" });
    expect(waits).toEqual([1_000, 2_000]); // backing off, not hammering
  });

  it("honours a rate-limit's own retry_after", async () => {
    const waits: number[] = [];
    const script = scriptedApi([
      new TelegramApiError("rate_limit", "Too Many Requests", { status: 429, retryAfterMs: 30_000 }),
      [chatMessage(8, 66, "123456")],
    ]);

    await waitForPairingCode({
      api: script.api,
      code: "123456",
      deadline: Date.now() + 600_000,
      sleepFn: async (ms) => {
        waits.push(ms);
      },
    });

    expect(waits).toEqual([30_000]);
  });

  it("paces itself when a proxy answers empty polls instantly", async () => {
    const waits: number[] = [];
    const script = scriptedApi([[], [], [chatMessage(9, 66, "123456")]]);

    await waitForPairingCode({
      api: script.api,
      code: "123456",
      deadline: Date.now() + 600_000,
      sleepFn: async (ms) => {
        waits.push(ms);
      },
    });

    // Close to the floor, minus however long the instant poll itself took.
    expect(waits).toHaveLength(2);
    for (const waited of waits) expect(waited).toBeGreaterThan(400);
  });
});

describe("containsPairingCode", () => {
  it("matches the code as a standalone number", () => {
    expect(containsPairingCode("123456", "123456")).toBe(true);
    expect(containsPairingCode("  123456 ", "123456")).toBe(true);
    expect(containsPairingCode("code: 123456!", "123456")).toBe(true);
  });

  it("does not match digits embedded in a longer number", () => {
    expect(containsPairingCode("91234567", "123456")).toBe(false);
    expect(containsPairingCode("1234567", "123456")).toBe(false);
  });
});

describe("generatePairingCode", () => {
  it("is always six digits", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generatePairingCode()).toMatch(/^\d{6}$/);
    }
  });
});
