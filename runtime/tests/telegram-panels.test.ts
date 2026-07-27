// The in-chat control panel. Everything is driven through handleUpdate() with
// a stubbed Bot API and a stubbed runner, so each case is one tap.

import { describe, expect, it } from "vitest";

import {
  createNonceStore,
  createPanelHandler,
  decodeCallback,
  encodeCallback,
  type PanelRunner,
} from "../src/notify/telegram/panels";
import { defaultTelegramConfig } from "../src/notify/telegram/settings";
import type { BridgeConfig, BridgeTelegramConfig } from "../src/bridge/config";
import type { TelegramApi, TelegramUpdate } from "../src/notify/telegram/api";

const CHAT = 4242;

interface Sent {
  readonly kind: "send" | "edit" | "answer";
  readonly text: string;
  readonly keyboard?: ReadonlyArray<ReadonlyArray<{ text: string; callback_data?: string; url?: string }>>;
}

function apiStub(): { api: TelegramApi; sent: Sent[]; buttons: () => string[] } {
  const sent: Sent[] = [];
  const api = {
    sendMessage: async (p: { text: string; keyboard?: never }) => {
      sent.push({ kind: "send", text: p.text, ...(p.keyboard !== undefined ? { keyboard: p.keyboard } : {}) });
      return { message_id: sent.length, chat: { id: CHAT } };
    },
    editMessageText: async (p: { text: string; keyboard?: never }) => {
      sent.push({ kind: "edit", text: p.text, ...(p.keyboard !== undefined ? { keyboard: p.keyboard } : {}) });
    },
    answerCallbackQuery: async (p: { text?: string }) => {
      sent.push({ kind: "answer", text: p.text ?? "" });
    },
  } as unknown as TelegramApi;
  return {
    api,
    sent,
    buttons: () => {
      const last = [...sent].reverse().find((s) => s.keyboard !== undefined);
      return (last?.keyboard ?? []).flat().map((b) => b.callback_data ?? b.url ?? "");
    },
  };
}

function runnerStub(overrides: Partial<PanelRunner> = {}): {
  runner: PanelRunner;
  joined: Array<{ game: string; mode?: string; oneShot?: boolean }>;
  left: number;
} {
  const joined: Array<{ game: string; mode?: string; oneShot?: boolean }> = [];
  let left = 0;
  const runner: PanelRunner = {
    snapshot: () => ({ state: { phase: "idle" } }),
    connectionSnapshot: () => ({ state: "connected", connectedAt: Date.now() - 60_000 }),
    joinQueue: (game, mode, opts) => {
      joined.push({ game, ...(mode !== undefined ? { mode } : {}), ...(opts?.oneShot !== undefined ? { oneShot: opts.oneShot } : {}) });
    },
    leaveQueue: () => {
      left += 1;
    },
    ...overrides,
  };
  return {
    runner,
    joined,
    get left() {
      return left;
    },
  } as { runner: PanelRunner; joined: Array<{ game: string; mode?: string; oneShot?: boolean }>; left: number };
}

function bridgeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    version: 1,
    baseUrl: "https://aifight.ai",
    wsUrl: "wss://aifight.ai/api/ws",
    agentId: "agent-1",
    agentName: "PokerMind",
    apiKey: "sk-secret",
    runtimeType: "direct",
    runtimeLocalUrl: "direct://local",
    autoDailyLimit: 2,
    updatedAt: "2026-07-27T00:00:00.000Z",
    ...overrides,
  };
}

interface Harness {
  readonly handle: (update: TelegramUpdate) => Promise<void>;
  readonly sent: Sent[];
  readonly buttons: () => string[];
  readonly lastText: () => string;
  readonly settings: () => BridgeTelegramConfig;
  readonly config: () => BridgeConfig;
  readonly runner: ReturnType<typeof runnerStub>;
  readonly nonces: ReturnType<typeof createNonceStore>;
}

function harness(opts: {
  section?: Partial<BridgeTelegramConfig>;
  config?: Partial<BridgeConfig>;
  runner?: Partial<PanelRunner> | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
} = {}): Harness {
  const stub = apiStub();
  const runner = runnerStub(opts.runner ?? {});
  let settings: BridgeTelegramConfig = { ...defaultTelegramConfig(CHAT), ...opts.section };
  let config: BridgeConfig = bridgeConfig(opts.config);
  const nonces = createNonceStore(opts.now !== undefined ? { now: opts.now } : {});

  const handler = createPanelHandler({
    api: stub.api,
    settings: () => settings,
    updateSettings: (next) => {
      settings = next;
      config = { ...config, telegram: next };
    },
    config: () => config,
    updateConfig: (next) => {
      config = next;
    },
    runner: opts.runner === null ? null : runner.runner,
    nonces,
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });

  return {
    handle: (u) => handler.handleUpdate(u),
    sent: stub.sent,
    buttons: stub.buttons,
    lastText: () => [...stub.sent].reverse().find((s) => s.kind !== "answer")?.text ?? "",
    settings: () => settings,
    config: () => config,
    runner,
    nonces,
  };
}

function command(text: string, chatId = CHAT): TelegramUpdate {
  return { update_id: 1, message: { message_id: 1, chat: { id: chatId, type: "private" }, text } };
}

function tap(data: string, chatId = CHAT): TelegramUpdate {
  return {
    update_id: 2,
    callback_query: {
      id: "cb",
      from: { id: chatId },
      message: { message_id: 10, chat: { id: chatId, type: "private" } },
      data,
    },
  };
}

/** A fetch that answers the two panel endpoints with fixed data. */
function statusFetch(): typeof fetch {
  return (async (url: string | URL) => {
    const text = String(url);
    if (text.endsWith("/api/agents/me/status")) {
      return new Response(JSON.stringify({ games_today: 1, max_games_per_day: 3 }), { status: 200 });
    }
    if (text.includes("/profile")) {
      return new Response(JSON.stringify({ ratings: [{ game: "coup", rating: 1520.4, games_played: 12 }] }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("callback data codec", () => {
  it("round-trips every field and drops empty tails", () => {
    expect(decodeCallback(encodeCallback({ panel: "home", action: "open" }))).toEqual({ panel: "home", action: "open" });
    expect(encodeCallback({ panel: "home", action: "open" })).toBe("v1:home:open");
    expect(decodeCallback(encodeCallback({ panel: "play", action: "start", arg: "coup", nonce: "abc12345" }))).toEqual({
      panel: "play",
      action: "start",
      arg: "coup",
      nonce: "abc12345",
    });
    expect(decodeCallback(encodeCallback({ panel: "notify", action: "mute", arg: "1h" }))).toEqual({
      panel: "notify",
      action: "mute",
      arg: "1h",
    });
  });

  it("refuses to build a button Telegram would reject", () => {
    expect(() => encodeCallback({ panel: "play", action: "start", arg: "x".repeat(70) })).toThrow(/too long/);
  });

  it("rejects junk, other versions, and truncated data", () => {
    expect(decodeCallback("")).toBeNull();
    expect(decodeCallback("v1:home")).toBeNull();
    expect(decodeCallback("v2:home:open")).toBeNull();
    expect(decodeCallback("v1::open")).toBeNull();
    expect(decodeCallback("v1:a:b:c:d:e")).toBeNull();
  });

  it("keeps every real button inside the 64-byte limit", async () => {
    const h = harness();
    await h.handle(command("/menu"));
    await h.handle(tap("v1:play:open"));
    await h.handle(tap("v1:notify:open"));
    await h.handle(tap("v1:settings:open"));
    for (const data of h.sent.flatMap((s) => (s.keyboard ?? []).flat()).map((b) => b.callback_data)) {
      if (data !== undefined) expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
    }
  });
});

describe("nonce store", () => {
  it("accepts a nonce once, for its own intent", () => {
    const store = createNonceStore();
    const nonce = store.issue("play:start:coup");
    expect(store.consume(nonce, "play:start:coup")).toBe(true);
    expect(store.consume(nonce, "play:start:coup")).toBe(false); // replay
  });

  it("refuses a nonce minted for a different action", () => {
    const store = createNonceStore();
    const nonce = store.issue("play:pause");
    expect(store.consume(nonce, "play:start:coup")).toBe(false);
  });

  it("expires", () => {
    let clock = 1_000;
    const store = createNonceStore({ now: () => clock, ttlMs: 60_000 });
    const nonce = store.issue("play:pause");
    clock += 61_000;
    expect(store.consume(nonce, "play:pause")).toBe(false);
  });

  it("rejects one that was never issued", () => {
    expect(createNonceStore().consume("deadbeef", "play:pause")).toBe(false);
  });
});

describe("panel access control", () => {
  it("ignores every other chat, in silence", async () => {
    const h = harness();
    await h.handle(command("/menu", 999));
    await h.handle(tap("v1:play:ask_start:coup", 999));
    expect(h.sent).toHaveLength(0);
  });

  it("with control off, explains itself once and does nothing", async () => {
    const h = harness({ section: { control: false } });

    await h.handle(command("/menu"));
    await h.handle(tap("v1:play:ask_start:coup"));

    expect(h.runner.joined).toHaveLength(0);
    expect(h.sent.map((s) => s.kind)).toEqual(["send", "answer"]);
    expect(h.sent[0]!.text).toContain("aifight telegram set control on");
  });
});

describe("panel navigation", () => {
  it("opens the main panel on /menu and /start", async () => {
    const h = harness();
    await h.handle(command("/menu"));
    expect(h.lastText()).toContain("PokerMind");
    expect(h.buttons()).toContain("v1:play:open");

    await h.handle(command("/start"));
    expect(h.sent.filter((s) => s.kind === "send")).toHaveLength(2);
  });

  it("edits the same message when navigating from a button", async () => {
    const h = harness();
    await h.handle(tap("v1:play:open"));
    expect(h.sent.map((s) => s.kind)).toEqual(["answer", "edit"]);
  });

  it("shows today's count, phase and ratings on the status panel", async () => {
    const h = harness({ fetchImpl: statusFetch() });
    await h.handle(command("/status"));
    const text = h.lastText();
    expect(text).toContain("1 / 3");
    expect(text).toContain("Online");
    expect(text).toContain("Now: idle"); // the phase line, not just its absence
    expect(text).toContain("Coup 1520");
  });

  // Every one of these three used to be unasserted: a panel that claimed
  // "🟢 Online" while reconnecting, or "in a match" while idle, passed.
  it("does not claim to be online while the bridge is reconnecting", async () => {
    const h = harness({
      fetchImpl: statusFetch(),
      runner: { connectionSnapshot: () => ({ state: "reconnecting", connectedAt: null }) },
    });
    await h.handle(command("/status"));
    expect(h.lastText()).toContain("Offline");
    expect(h.lastText()).not.toContain("Online");
  });

  it("says the connection state in words rather than as its internal name", async () => {
    const h = harness({
      section: { locale: "zh" },
      fetchImpl: statusFetch(),
      runner: { connectionSnapshot: () => ({ state: "reconnecting", connectedAt: null }) },
    });
    await h.handle(command("/status"));
    expect(h.lastText()).toContain("重连中");
    expect(h.lastText()).not.toContain("reconnecting");
  });

  it("reports the phase the runner is actually in", async () => {
    const h = harness({
      fetchImpl: statusFetch(),
      runner: { snapshot: () => ({ state: { phase: "in_match" } }) },
    });
    await h.handle(command("/status"));
    expect(h.lastText()).toContain("in a match");
  });

  // A cap of 0 is stored server-side as auto_requeue:false, leaving the old
  // max_games_per_day in place — so trusting the platform number here would
  // contradict the settings panel one tap away.
  it("shows the cap as off when this machine is set to manual only", async () => {
    const h = harness({ fetchImpl: statusFetch(), config: { autoDailyLimit: 0 } });
    await h.handle(command("/status"));
    expect(h.lastText()).toContain("1 / off");
  });

  it("shows the rating everyone else shows", async () => {
    const withDisplay = (async (url: string | URL) => {
      const text = String(url);
      if (text.endsWith("/api/agents/me/status")) {
        return new Response(JSON.stringify({ games_today: 1, max_games_per_day: 3 }), { status: 200 });
      }
      if (text.includes("/profile")) {
        return new Response(
          JSON.stringify({ ratings: [{ game: "coup", rating: 1720, display_rating: 1520, games_played: 12 }] }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const h = harness({ fetchImpl: withDisplay });

    await h.handle(command("/status"));

    expect(h.lastText()).toContain("Coup 1520");
    expect(h.lastText()).not.toContain("1720");
  });

  it("still opens the status panel when the platform is unreachable", async () => {
    const failing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const h = harness({ fetchImpl: failing });

    await h.handle(command("/status"));

    expect(h.lastText()).toContain("unavailable");
    expect(h.buttons()).toContain("v1:status:refresh");
  });

  it("offers only real links", async () => {
    const h = harness();
    await h.handle(command("/links"));
    expect(h.buttons()).toEqual([
      "https://aifight.ai/agents/agent-1",
      "https://aifight.ai/dashboard",
      "https://aifight.ai/leaderboard",
      "v1:home:open",
    ]);
  });
});

describe("play panel", () => {
  it("asks before starting a match, then starts exactly one", async () => {
    const h = harness();

    await h.handle(tap("v1:play:ask_start:coup"));
    expect(h.lastText()).toContain("Start a <b>Coup</b> match?");
    expect(h.runner.joined).toHaveLength(0);

    const confirm = h.buttons().find((b) => b.startsWith("v1:play:start"))!;
    await h.handle(tap(confirm));

    expect(h.runner.joined).toEqual([{ game: "coup", mode: "ranked", oneShot: true }]);
    expect(h.lastText()).toContain("Queued: Coup");
  });

  it("refuses a replayed confirmation", async () => {
    const h = harness();
    await h.handle(tap("v1:play:ask_start:coup"));
    const confirm = h.buttons().find((b) => b.startsWith("v1:play:start"))!;
    await h.handle(tap(confirm));
    await h.handle(tap(confirm));

    expect(h.runner.joined).toHaveLength(1);
    expect(h.sent.some((s) => s.kind === "answer" && s.text.includes("expired"))).toBe(true);
  });

  it("refuses a start button with no nonce at all", async () => {
    const h = harness();
    await h.handle(tap("v1:play:start:coup"));
    expect(h.runner.joined).toHaveLength(0);
  });

  it("refuses an unknown game", async () => {
    const h = harness();
    await h.handle(tap("v1:play:ask_start:chess"));
    expect(h.sent.map((s) => s.kind)).toEqual(["answer"]);
  });

  it("translates a busy runner into words instead of an error", async () => {
    const h = harness({
      runner: {
        joinQueue: () => {
          throw new Error("agent is already in or entering a match; try again after the current match completes");
        },
      },
    });

    await h.handle(tap("v1:play:ask_start:coup"));
    await h.handle(tap(h.buttons().find((b) => b.startsWith("v1:play:start"))!));

    expect(h.lastText()).toContain("Already in a match");
  });

  it("says so when there is no bridge to control", async () => {
    const h = harness({ runner: null });
    await h.handle(tap("v1:play:ask_start:coup"));
    await h.handle(tap(h.buttons().find((b) => b.startsWith("v1:play:start"))!));
    expect(h.lastText()).toContain("not connected");
  });

  it("pauses and resumes automatic matching, each behind a confirmation", async () => {
    const h = harness();

    await h.handle(tap("v1:play:ask_pause"));
    await h.handle(tap(h.buttons().find((b) => b.startsWith("v1:play:pause"))!));
    expect(h.runner.left).toBe(1);
    expect(h.lastText()).toContain("Left the matchmaking queue");
    expect(h.buttons().some((b) => b === "v1:play:ask_resume")).toBe(true);

    await h.handle(tap("v1:play:ask_resume"));
    await h.handle(tap(h.buttons().find((b) => b.startsWith("v1:play:resume"))!));
    expect(h.runner.joined).toHaveLength(1);
    expect(h.runner.joined[0]!.oneShot).toBeUndefined(); // a standing queue, not one match
  });

  it("warns that pausing only lasts until the bridge restarts", async () => {
    const h = harness();
    await h.handle(tap("v1:play:ask_pause"));
    expect(h.lastText()).toContain("until the bridge restarts");
  });

  // A cap of 0 means the bridge never queues by itself (automaticJoinOptions),
  // so "running" would be a lie and there would be nothing to pause.
  it("does not claim automatic matching is running when the daily cap is 0", async () => {
    const h = harness({ config: { autoDailyLimit: 0 } });
    await h.handle(tap("v1:play:open"));

    expect(h.lastText()).toContain("Auto-matching: ⏹ off");
    expect(h.buttons().some((b) => b.startsWith("v1:play:ask_pause"))).toBe(false);
    expect(h.buttons().some((b) => b.startsWith("v1:play:ask_resume"))).toBe(false);
    // Manual matches are still one tap away — that is the point of the panel.
    expect(h.buttons()).toContain("v1:play:ask_start:coup");
  });

  it("offers the pause control once the cap allows automatic matches", async () => {
    const h = harness({ config: { autoDailyLimit: 3 } });
    await h.handle(tap("v1:play:open"));
    expect(h.lastText()).toContain("running");
    expect(h.buttons()).toContain("v1:play:ask_pause");
  });
});

describe("notify panel", () => {
  it("switches the result granularity", async () => {
    const h = harness();
    await h.handle(tap("v1:notify:results:daily"));
    expect(h.settings().results).toBe("daily");
    await h.handle(tap("v1:notify:results:off"));
    expect(h.settings().results).toBe("off");
  });

  it("mutes and unmutes without a confirmation (it is reversible)", async () => {
    const clock = 1_000_000;
    const h = harness({ now: () => clock });

    await h.handle(tap("v1:notify:mute:1h"));
    expect(h.settings().mutedUntil).toBe(clock + 60 * 60_000);
    expect(h.lastText()).toContain("Muted until");

    await h.handle(tap("v1:notify:mute:off"));
    expect(h.settings().mutedUntil).toBeUndefined();
  });

  it("toggles alerts", async () => {
    const h = harness();
    await h.handle(tap("v1:notify:alerts:off"));
    expect(h.settings().alerts).toBe(false);
    await h.handle(tap("v1:notify:alerts:on"));
    expect(h.settings().alerts).toBe(true);
  });

  // The stored value is an enum; a Chinese reader used to get "战果推送：
  // per_match" right next to translated buttons.
  it("says the result preference in words, not as its stored enum", async () => {
    const h = harness({ section: { locale: "zh" } });
    await h.handle(tap("v1:notify:open"));
    expect(h.lastText()).toContain("每局都推");
    expect(h.lastText()).not.toContain("per_match");

    await h.handle(tap("v1:notify:results:both"));
    expect(h.settings().results).toBe("both");
    expect(h.lastText()).toContain("每局 + 每日摘要");
  });

  it("offers a button for every stored value, so `both` is not a trap", async () => {
    const h = harness({ section: { results: "both" } });
    await h.handle(tap("v1:notify:open"));
    expect(h.buttons()).toContain("v1:notify:results:both");
  });

  it("says muting for the rest of today plainly, not as a midnight clock time", async () => {
    const clock = new Date("2026-07-27T14:00:00").getTime();
    const h = harness({ now: () => clock });
    await h.handle(tap("v1:notify:mute:today"));
    expect(h.lastText()).toContain("rest of today");
    expect(h.lastText()).not.toContain("00:00");
  });

  it("toggles challenge events from the panel that displays them", async () => {
    const h = harness();
    await h.handle(tap("v1:notify:open"));
    expect(h.buttons()).toContain("v1:notify:challenges:off");

    await h.handle(tap("v1:notify:challenges:off"));
    expect(h.settings().challengeEvents).toBe(false);
    expect(h.buttons()).toContain("v1:notify:challenges:on");

    await h.handle(tap("v1:notify:challenges:on"));
    expect(h.settings().challengeEvents).toBe(true);
  });

  it("ignores a bogus value rather than storing it", async () => {
    const h = harness();
    await h.handle(tap("v1:notify:results:hourly"));
    expect(h.settings().results).toBe("per_match");
  });
});

describe("settings panel", () => {
  const okPolicy = (): typeof fetch =>
    (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;

  it("confirms, then applies and saves a new daily cap", async () => {
    const h = harness({ fetchImpl: okPolicy() });

    await h.handle(tap("v1:settings:ask_daily:5"));
    expect(h.lastText()).toContain("cap to 5");
    expect(h.config().autoDailyLimit).toBe(2);

    await h.handle(tap(h.buttons().find((b) => b.startsWith("v1:settings:daily"))!));

    expect(h.config().autoDailyLimit).toBe(5);
    expect(h.lastText()).toContain("Daily cap set to 5");
  });

  it("uses the token-burn wording above the shared threshold", async () => {
    const h = harness({ fetchImpl: okPolicy() });
    await h.handle(tap("v1:settings:ask_daily:20"));
    expect(h.lastText()).toContain("costs add up fast");
    expect(h.lastText()).toContain("20/day");
  });

  it("explains that crossing 0 needs a restart to take effect", async () => {
    const off = harness({ fetchImpl: okPolicy() });
    await off.handle(tap("v1:settings:ask_daily:0"));
    await off.handle(tap(off.buttons().find((b) => b.startsWith("v1:settings:daily"))!));
    expect(off.lastText()).toContain("restart");

    const on = harness({ config: { autoDailyLimit: 0 }, fetchImpl: okPolicy() });
    await on.handle(tap("v1:settings:ask_daily:3"));
    await on.handle(tap(on.buttons().find((b) => b.startsWith("v1:settings:daily"))!));
    expect(on.lastText()).toContain("starts after the bridge restarts");
  });

  it("says nothing about restarts for an ordinary change", async () => {
    const h = harness({ fetchImpl: okPolicy() });
    await h.handle(tap("v1:settings:ask_daily:5"));
    await h.handle(tap(h.buttons().find((b) => b.startsWith("v1:settings:daily"))!));
    expect(h.lastText()).not.toContain("restart");
  });

  it("keeps the old cap when the platform refuses the change", async () => {
    const failing = (async () =>
      new Response(JSON.stringify({ error: "cap exceeds the server ceiling" }), { status: 400 })) as unknown as typeof fetch;
    const h = harness({ fetchImpl: failing });

    await h.handle(tap("v1:settings:ask_daily:9"));
    await h.handle(tap(h.buttons().find((b) => b.startsWith("v1:settings:daily"))!));

    expect(h.config().autoDailyLimit).toBe(2);
    expect(h.lastText()).toContain("cap exceeds the server ceiling");
  });

  // The server clamps to the account ceiling and answers with what it stored.
  // Echoing the request back would tell the user a number that is not in force.
  it("reports the cap the platform actually stored, not the one asked for", async () => {
    const clamping = (async () =>
      new Response(JSON.stringify({ policy: { max_games_per_day: 20, auto_requeue: true } }), {
        status: 200,
      })) as unknown as typeof fetch;
    const h = harness({ fetchImpl: clamping });

    await h.handle(tap("v1:settings:custom_daily"));
    await h.handle(command("80"));
    await h.handle(tap(h.buttons().find((b) => b.startsWith("v1:settings:daily"))!));

    expect(h.config().autoDailyLimit).toBe(20);
    expect(h.lastText()).toContain("capped it at 20");
    expect(h.lastText()).toContain("asked for 80");
  });

  it("refuses a stale daily confirmation", async () => {
    const h = harness({ fetchImpl: okPolicy() });
    await h.handle(tap("v1:settings:ask_daily:5"));
    const confirm = h.buttons().find((b) => b.startsWith("v1:settings:daily"))!;
    await h.handle(tap(confirm));
    await h.handle(tap(confirm));
    expect(h.config().autoDailyLimit).toBe(5); // applied once, not twice
    expect(h.sent.some((s) => s.kind === "answer" && s.text.includes("expired"))).toBe(true);
  });

  it("takes a custom cap by reply, and rejects nonsense", async () => {
    const h = harness({ fetchImpl: okPolicy() });

    await h.handle(tap("v1:settings:custom_daily"));
    expect(h.lastText()).toContain("Reply with a whole number");

    await h.handle(command("banana"));
    expect(h.lastText()).toContain("Please reply");

    await h.handle(tap("v1:settings:custom_daily"));
    await h.handle(command("7"));
    expect(h.lastText()).toContain("cap to 7");
    await h.handle(tap(h.buttons().find((b) => b.startsWith("v1:settings:daily"))!));
    expect(h.config().autoDailyLimit).toBe(7);
  });

  it("rejects a custom cap above the client ceiling", async () => {
    const h = harness({ fetchImpl: okPolicy() });
    await h.handle(tap("v1:settings:custom_daily"));
    await h.handle(command("500"));
    expect(h.lastText()).toContain("Please reply");
  });

  // A prompt left armed after the user walked away would swallow the next
  // ordinary message — a forwarded challenge link, most likely — as its answer.
  it("drops a pending prompt as soon as a command is issued", async () => {
    const h = harness({ fetchImpl: okPolicy() });
    const token = "dl_0123456789abcdef0123456789abcdef";

    await h.handle(tap("v1:settings:custom_daily"));
    await h.handle(command("/menu"));
    await h.handle(command(`https://aifight.ai/challenge/${token}`));

    expect(h.lastText()).toContain("challenge link");
    expect(h.buttons().some((b) => b.startsWith("v1:duel:accept"))).toBe(true);
  });

  it("switches language for everything that follows", async () => {
    const h = harness();
    await h.handle(tap("v1:settings:locale:zh"));
    expect(h.settings().locale).toBe("zh");
    expect(h.lastText()).toContain("设置");
  });
});

describe("panel resilience", () => {
  it("never throws, whatever Telegram does", async () => {
    const api = {
      sendMessage: async () => {
        throw new Error("Bad Gateway");
      },
      editMessageText: async () => {
        throw new Error("Bad Gateway");
      },
      answerCallbackQuery: async () => {
        throw new Error("Bad Gateway");
      },
    } as unknown as TelegramApi;
    const logs: string[] = [];
    const handler = createPanelHandler({
      api,
      settings: () => defaultTelegramConfig(CHAT),
      updateSettings: () => undefined,
      config: () => bridgeConfig(),
      updateConfig: () => undefined,
      runner: null,
      onLog: (e) => logs.push(e.code),
    });

    await expect(handler.handleUpdate(command("/menu"))).resolves.toBeUndefined();
    await expect(handler.handleUpdate(tap("v1:play:open"))).resolves.toBeUndefined();
    expect(logs).toContain("telegram.panel_failed");
  });

  it("ignores an update that is neither a message nor a callback", async () => {
    const h = harness();
    await h.handle({ update_id: 5 });
    expect(h.sent).toHaveLength(0);
  });
});
