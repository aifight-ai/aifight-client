// The long-poll loop: offset bookkeeping, backoff, and the two ways it stops
// (asked to, or told the token is dead). The API is a hand-rolled stub and
// sleeps are injected, so nothing here waits on real time.

import { describe, expect, it } from "vitest";

import { TelegramApiError, type GetUpdatesParams, type TelegramApi, type TelegramUpdate } from "../src/notify/telegram/api";
import { startTelegramPoller } from "../src/notify/telegram/poller";

/** Mirrors MIN_EMPTY_POLL_GAP_MS in poller.ts — see the anti-spin test below. */
const MIN_EMPTY_POLL_GAP_MS = 500;

function message(updateId: number, text: string): TelegramUpdate {
  return { update_id: updateId, message: { message_id: updateId, chat: { id: 7, type: "private" }, text } };
}

/** An API whose getUpdates answers from a script of steps, one per call. */
function scriptedApi(steps: ReadonlyArray<TelegramUpdate[] | Error>): {
  api: TelegramApi;
  offsets: Array<number | undefined>;
  calls: () => number;
  exhausted: Promise<void>;
} {
  const offsets: Array<number | undefined> = [];
  let i = 0;
  let markExhausted: () => void = () => undefined;
  const exhausted = new Promise<void>((resolve) => {
    markExhausted = resolve;
  });
  const api = {
    getUpdates: async (params: GetUpdatesParams) => {
      offsets.push(params.offset);
      const step = steps[i++];
      if (step === undefined) {
        markExhausted();
        // Park forever (until aborted) rather than spinning past the script.
        return new Promise<TelegramUpdate[]>((_resolve, reject) => {
          params.signal?.addEventListener("abort", () => reject(new TelegramApiError("aborted", "aborted")), { once: true });
        });
      }
      if (step instanceof Error) throw step;
      return step;
    },
  } as unknown as TelegramApi;
  return { api, offsets, calls: () => i, exhausted };
}

describe("telegram poller", () => {
  it("skips the backlog, then advances the offset past each delivered update", async () => {
    const script = scriptedApi([
      [message(10, "stale")], // backlog probe (offset -1)
      [message(11, "hello"), message(12, "again")],
    ]);
    const seen: number[] = [];
    const poller = startTelegramPoller({
      api: script.api,
      onUpdate: (u) => {
        seen.push(u.update_id);
      },
    });

    await script.exhausted;
    await poller.stop();

    expect(script.offsets[0]).toBe(-1); // backlog probe
    expect(script.offsets[1]).toBe(11); // ...confirmed past the stale update
    expect(script.offsets[2]).toBe(13); // ...then past both handled ones
    // The stale update was never handed to the app.
    expect(seen).toEqual([11, 12]);
  });

  it("starts from nothing when the backlog probe is skipped", async () => {
    const script = scriptedApi([[message(4, "hi")]]);
    const poller = startTelegramPoller({ api: script.api, onUpdate: () => undefined, dropBacklog: false });

    await script.exhausted;
    await poller.stop();

    expect(script.offsets[0]).toBeUndefined();
    expect(script.offsets[1]).toBe(5);
  });

  it("keeps the offset moving when a handler throws, so nothing is redelivered", async () => {
    const script = scriptedApi([[], [message(3, "boom")]]);
    const logs: string[] = [];
    const poller = startTelegramPoller({
      api: script.api,
      dropBacklog: false,
      onUpdate: () => {
        throw new Error("handler exploded");
      },
      onLog: (e) => logs.push(`${e.code}:${e.message}`),
    });

    await script.exhausted;
    await poller.stop();

    expect(script.offsets.at(-1)).toBe(4);
    expect(logs.join("\n")).toContain("telegram.update_handler_failed");
  });

  it("honours retry_after on a 429 instead of its own backoff", async () => {
    const script = scriptedApi([
      new TelegramApiError("rate_limit", "Too Many Requests", { status: 429, retryAfterMs: 7_000 }),
      [],
    ]);
    const slept: number[] = [];
    const poller = startTelegramPoller({
      api: script.api,
      dropBacklog: false,
      onUpdate: () => undefined,
      sleepFn: async (ms) => {
        slept.push(ms);
      },
    });

    await script.exhausted;
    await poller.stop();

    // 7s from Telegram, then the empty-poll floor before asking again.
    expect(slept).toEqual([7_000, MIN_EMPTY_POLL_GAP_MS]);
  });

  it("backs off exponentially on transport failures and resets after a good poll", async () => {
    const boom = (): Error => new TelegramApiError("network", "could not reach Telegram");
    const script = scriptedApi([boom(), boom(), boom(), [], boom()]);
    const slept: number[] = [];
    const poller = startTelegramPoller({
      api: script.api,
      dropBacklog: false,
      onUpdate: () => undefined,
      sleepFn: async (ms) => {
        slept.push(ms);
      },
    });

    await script.exhausted;
    await poller.stop();

    // 1s, 2s, 4s — then a successful (empty) poll clears the penalty and pays
    // the anti-spin floor, so the next failure starts over at 1s.
    expect(slept).toEqual([1_000, 2_000, 4_000, MIN_EMPTY_POLL_GAP_MS, 1_000]);
  });

  it("gives up for good when the token is rejected", async () => {
    const script = scriptedApi([new TelegramApiError("auth", "getUpdates: Unauthorized", { status: 401 })]);
    const logs: Array<{ code: string; level: string; message: string }> = [];
    let failure: string | undefined;

    const poller = startTelegramPoller({
      api: script.api,
      dropBacklog: false,
      onUpdate: () => undefined,
      onLog: (e) => logs.push(e),
      onAuthFailure: (m) => {
        failure = m;
      },
    });

    await poller.done; // exits on its own — no stop() needed

    expect(failure).toContain("Unauthorized");
    expect(logs.some((l) => l.code === "telegram.auth_failed" && l.level === "error")).toBe(true);
    expect(logs.some((l) => l.message.includes("aifight telegram setup"))).toBe(true);
    expect(script.calls()).toBe(1); // it did not keep hammering
  });

  it("stops promptly while a long poll is in flight", async () => {
    const script = scriptedApi([]); // first call parks until aborted
    const poller = startTelegramPoller({ api: script.api, dropBacklog: false, onUpdate: () => undefined });

    await script.exhausted;
    await poller.stop(); // resolves only when the loop has unwound

    await expect(poller.done).resolves.toBeUndefined();
  });

  // A long poll normally blocks for ~50s. If something answers it instantly and
  // emptily — a proxy, a misbehaving edge — an unguarded loop would spin at
  // 100% CPU and starve every timer in the process (each iteration only awaits
  // already-resolved promises, so the microtask queue never drains).
  it("paces itself when empty polls return instantly", async () => {
    const script = scriptedApi([[], [], []]);
    const slept: number[] = [];
    const poller = startTelegramPoller({
      api: script.api,
      dropBacklog: false,
      onUpdate: () => undefined,
      sleepFn: async (ms) => {
        slept.push(ms);
      },
    });

    await script.exhausted;
    await poller.stop();

    expect(slept.every((ms) => ms === MIN_EMPTY_POLL_GAP_MS)).toBe(true);
    expect(slept.length).toBeGreaterThanOrEqual(3);
  });

  it("does not pace itself when updates are flowing", async () => {
    const script = scriptedApi([[message(1, "a")], [message(2, "b")]]);
    const slept: number[] = [];
    const poller = startTelegramPoller({
      api: script.api,
      dropBacklog: false,
      onUpdate: () => undefined,
      sleepFn: async (ms) => {
        slept.push(ms);
      },
    });

    await script.exhausted;
    await poller.stop();

    expect(slept).toEqual([]);
  });

  // The loop handles one update at a time and awaits the handler, and stop() is
  // the FIRST thing bridge shutdown awaits. A handler stuck on the network must
  // therefore not be able to hold the whole bridge open.
  it("stops within its budget even if a handler never returns", async () => {
    const script = scriptedApi([[message(1, "/menu")]]);
    const poller = startTelegramPoller({
      api: script.api,
      dropBacklog: false,
      onUpdate: () => new Promise<void>(() => undefined), // never resolves
      sleepFn: async () => undefined,
    });

    await new Promise((r) => setTimeout(r, 10));
    const startedAt = Date.now();
    await poller.stop();

    expect(Date.now() - startedAt).toBeLessThan(4_000);
  });

  it("survives a failing backlog probe", async () => {
    const script = scriptedApi([new TelegramApiError("server", "Bad Gateway", { status: 502 }), [message(2, "hi")]]);
    const seen: number[] = [];
    const poller = startTelegramPoller({
      api: script.api,
      onUpdate: (u) => {
        seen.push(u.update_id);
      },
      sleepFn: async () => undefined,
    });

    await script.exhausted;
    await poller.stop();

    expect(seen).toEqual([2]);
  });
});
