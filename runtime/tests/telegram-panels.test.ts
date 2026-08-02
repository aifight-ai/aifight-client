// The in-chat control panel. Everything is driven through handleUpdate() with
// a stubbed Bot API and a stubbed runner, so each case is one tap.

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createNonceStore,
  createPanelHandler,
  decodeCallback,
  encodeCallback,
  type PanelRunner,
  type UpdateSpawn,
} from "../src/notify/telegram/panels";
import { defaultTelegramConfig } from "../src/notify/telegram/settings";
import { botCommands } from "../src/notify/telegram/render";
import { getRuntimeHome } from "../src/store/paths";
import { RUNTIME_VERSION } from "../src/index";
import type { BridgeConfig, BridgeTelegramConfig } from "../src/bridge/config";
import type { BridgeUpdateCheck } from "../src/bridge/update-check";
import type { TelegramApi, TelegramUpdate } from "../src/notify/telegram/api";

const CHAT = 4242;

interface Sent {
  readonly kind: "send" | "edit" | "answer";
  readonly text: string;
  readonly keyboard?: ReadonlyArray<ReadonlyArray<{ text: string; callback_data?: string; url?: string }>>;
}

function apiStub(editError?: string): { api: TelegramApi; sent: Sent[]; buttons: () => string[] } {
  const sent: Sent[] = [];
  const api = {
    sendMessage: async (p: { text: string; keyboard?: never }) => {
      sent.push({ kind: "send", text: p.text, ...(p.keyboard !== undefined ? { keyboard: p.keyboard } : {}) });
      return { message_id: sent.length, chat: { id: CHAT } };
    },
    editMessageText: async (p: { text: string; keyboard?: never }) => {
      if (editError !== undefined) throw new Error(editError);
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
  readonly logs: string[];
}

function harness(opts: {
  section?: Partial<BridgeTelegramConfig>;
  config?: Partial<BridgeConfig>;
  runner?: Partial<PanelRunner> | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  pauseState?: () => boolean;
  declaredModel?: () => string | undefined;
  reviewMode?: () => Promise<"off" | "all" | "losses_only" | null>;
  setReviewMode?: (mode: "off" | "all" | "losses_only") => Promise<void>;
  onLocaleChanged?: (locale: "zh" | "en") => void;
  /** When set, editMessageText throws this message (a cleared chat history). */
  editError?: string;
  checkUpdate?: () => Promise<BridgeUpdateCheck>;
  spawnUpdate?: UpdateSpawn;
  isServiceRun?: () => boolean;
} = {}): Harness {
  const stub = apiStub(opts.editError);
  const runner = runnerStub(opts.runner ?? {});
  const logs: string[] = [];
  let settings: BridgeTelegramConfig = { ...defaultTelegramConfig(CHAT), ...opts.section };
  let config: BridgeConfig = bridgeConfig(opts.config);
  const nonces = createNonceStore(opts.now !== undefined ? { now: opts.now } : {});

  const handler = createPanelHandler({
    api: stub.api,
    settings: () => settings,
    updateSettings: (next) => {
      settings = next;
      config = { ...config, telegram: next };
      return true;
    },
    config: () => config,
    updateConfig: (next) => {
      config = next;
      return true;
    },
    runner: opts.runner === null ? null : runner.runner,
    nonces,
    onLog: (e) => logs.push(e.code),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.pauseState !== undefined ? { pauseState: opts.pauseState } : {}),
    ...(opts.declaredModel !== undefined ? { declaredModel: opts.declaredModel } : {}),
    ...(opts.reviewMode !== undefined ? { reviewMode: opts.reviewMode } : {}),
    ...(opts.setReviewMode !== undefined ? { setReviewMode: opts.setReviewMode } : {}),
    ...(opts.onLocaleChanged !== undefined ? { onLocaleChanged: opts.onLocaleChanged } : {}),
    ...(opts.checkUpdate !== undefined ? { checkUpdate: opts.checkUpdate } : {}),
    ...(opts.spawnUpdate !== undefined ? { spawnUpdate: opts.spawnUpdate } : {}),
    ...(opts.isServiceRun !== undefined ? { isServiceRun: opts.isServiceRun } : {}),
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
    logs,
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

// ── U6/T3 seams: the version check and the detached updater ────────────────

function updateCheck(over: Partial<BridgeUpdateCheck> = {}): BridgeUpdateCheck {
  return {
    status: "update_recommended",
    currentVersion: RUNTIME_VERSION,
    latestVersion: "9.9.9",
    latestSource: "npm",
    message: "a newer version is on npm",
    ...over,
  };
}

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: { detached: boolean; stdio: Array<"ignore" | number> };
}

function spawnRecorder(opts: { throws?: string } = {}): {
  fn: UpdateSpawn;
  calls: SpawnCall[];
  unrefs: () => number;
} {
  const calls: SpawnCall[] = [];
  let unrefs = 0;
  return {
    fn: (command, args, options) => {
      calls.push({ command, args, options });
      if (opts.throws !== undefined) throw new Error(opts.throws);
      return {
        unref: () => {
          unrefs += 1;
        },
      };
    },
    calls,
    unrefs: () => unrefs,
  };
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

  // "control: off" has no panel-level branch at all: the companion simply
  // never starts the poller (covered in telegram-notify.test.ts), so the bot
  // is silent because no update ever arrives, not because one is answered.
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

  // The user cleared the chat history, so the panel message is gone
  // ("message to edit not found"). Without a fallback every button looks dead.
  it("falls back to a fresh panel message when the edit target is gone", async () => {
    const h = harness({ editError: "Bad Request: message to edit not found" });
    await h.handle(tap("v1:play:open"));

    expect(h.sent.map((s) => s.kind)).toEqual(["answer", "send"]);
    expect(h.sent[1]!.text).toContain("Play");
    expect(h.logs).toContain("telegram.panel_failed");
  });

  // "message is not modified" just means the user re-tapped the panel they are
  // already looking at — re-sending it would duplicate the panel every time.
  it("does NOT re-send when Telegram only says the message is not modified", async () => {
    const h = harness({ editError: "Bad Request: message is not modified" });
    await h.handle(tap("v1:play:open"));

    expect(h.sent.map((s) => s.kind)).toEqual(["answer"]);
    expect(h.logs).toHaveLength(0);
  });

  it("record panel renders ratings, replay links, and achievements", async () => {
    const recordFetch: typeof fetch = (async (url: string | URL) => {
      const text = String(url);
      if (text.includes("/profile")) {
        return new Response(JSON.stringify({
          agent: { name: "PokerMind" },
          ratings: [
            { game: "coup", rating: 1560.2, display_rating: 1520.4, games_played: 12, wins: 8, losses: 4, win_rate: 0.667 },
          ],
          recent_matches: [
            { game: "coup", agent_result: "1st", opponent_names: ["Rival", "Sage"], finished_at: "2026-07-31T10:00:00Z", public_replay_id: "rep-123" },
            { game: "liars_dice", agent_result: "2nd", opponent_names: [], finished_at: "2026-07-30T10:00:00Z" },
          ],
          achievements: [{ title: "First Blood" }, { title: "Streak" }],
        }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    const h = harness({ fetchImpl: recordFetch });
    await h.handle(command("/record"));
    const text = h.lastText();
    expect(text).toContain("PokerMind");
    expect(text).toContain("1520");            // display_rating, not raw Glicko
    expect(text).toContain("8W 4L");
    expect(text).toContain("67% win rate");
    expect(text).toContain('href="https://aifight.ai/replay/rep-123"'); // replay deep link
    expect(text).toContain("vs Rival, Sage");
    expect(text).toContain("2 achievements");
    // The row without a replay id renders as plain text, not a dead link.
    expect(text).not.toContain('href="https://aifight.ai/replay/undefined"');

    // The record button also rides the home grid.
    await h.handle(command("/menu"));
    expect(h.buttons()).toContain("v1:record:open");
  });

  it("record panel degrades to a retry note when the profile is unreachable", async () => {
    const h = harness({ fetchImpl: (async () => new Response("{}", { status: 500 })) as typeof fetch });
    await h.handle(tap("v1:record:open"));
    expect(h.lastText()).toContain("unavailable right now");
  });

  it("shows today's count, phase and ratings on the status panel", async () => {
    const h = harness({ fetchImpl: statusFetch() });
    await h.handle(command("/status"));
    const text = h.lastText();
    expect(text).toContain("Auto today: 1/3");
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
    expect(h.lastText()).toContain("Auto today: 1/manual only");
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

  // The panel writes the SAME persisted flag `aifight pause` does, so the
  // pause survives a bridge restart and every client shows the same truth.
  it("persists the pause via matchingPaused, and resume clears it", async () => {
    const h = harness();
    await h.handle(tap("v1:play:ask_pause"));
    expect(h.lastText()).toContain("stays paused");

    await h.handle(tap(h.buttons().find((b) => b.startsWith("v1:play:pause"))!));
    expect(h.config().matchingPaused).toBe(true);
    expect(h.lastText()).toContain("⏸ paused (persistent");

    await h.handle(tap("v1:play:ask_resume"));
    await h.handle(tap(h.buttons().find((b) => b.startsWith("v1:play:resume"))!));
    expect(h.config().matchingPaused).toBe(false);
    expect(h.runner.joined).toHaveLength(1);
  });

  // A pause made from the CLI or the desktop app while this bridge runs must
  // show truthfully here — the panel reads the fresh disk state when wired.
  it("reflects an externally made pause via pauseState", async () => {
    const h = harness({ pauseState: () => true });
    await h.handle(tap("v1:play:open"));
    expect(h.lastText()).toContain("⏸ paused (persistent");
    expect(h.buttons()).toContain("v1:play:ask_resume");
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
      updateSettings: () => true,
      config: () => bridgeConfig(),
      updateConfig: () => true,
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

// ── Telegram UX V2 (2026-08-02): commands, settings expansion, report entry ──

describe("text commands — /play /notify /settings and the fuller /help", () => {
  it("routes /play, /notify and /settings to their panels", async () => {
    const h = harness();
    await h.handle(command("/play"));
    expect(h.lastText()).toContain("Play");
    await h.handle(command("/notify"));
    expect(h.lastText()).toContain("Notifications");
    await h.handle(command("/settings"));
    expect(h.lastText()).toContain("Settings");
  });

  it("says the current settings inside /help, and teaches the challenge trick", async () => {
    const h = harness({ section: { results: "per_match", digestAt: "21:30" } });
    await h.handle(command("/help"));
    const text = h.lastText();
    expect(text).toContain("/play");
    expect(text).toContain("/settings");
    expect(text).toContain("every match"); // the CURRENT results preference, in words
    expect(text).toContain("21:30"); // the CURRENT digest time
    expect(text).toContain("challenge link");
    expect(text).toContain("API keys");
  });
});

describe("settings panel — games, digest time, auto-review", () => {
  it("toggles a game off and writes the explicit remaining list", async () => {
    const h = harness();
    await h.handle(tap("v1:settings:game:coup"));
    expect(h.config().autoGames).toEqual(["texas_holdem", "liars_dice"]);
    expect(h.lastText()).toContain("Coup ✗");
  });

  it("refuses to turn off the last enabled game", async () => {
    const h = harness({ config: { autoGames: ["coup"] } });
    await h.handle(tap("v1:settings:game:coup"));
    expect(h.config().autoGames).toEqual(["coup"]); // unchanged
    expect(h.sent.some((s) => s.kind === "answer" && s.text.includes("At least one game"))).toBe(true);
  });

  it("applies a digest preset (HHMM in the callback, HH:MM on disk)", async () => {
    const h = harness();
    await h.handle(tap("v1:settings:open"));
    expect(h.buttons()).toContain("v1:settings:digest:2100");
    await h.handle(tap("v1:settings:digest:2100"));
    expect(h.settings().digestAt).toBe("21:00");
  });

  it("takes a custom digest time as a reply, and rejects a malformed one", async () => {
    const h = harness();
    await h.handle(tap("v1:settings:custom_digest"));
    await h.handle(command("21:45"));
    expect(h.settings().digestAt).toBe("21:45");

    await h.handle(tap("v1:settings:custom_digest"));
    await h.handle(command("quarter past nine"));
    expect(h.settings().digestAt).toBe("21:45"); // unchanged
    expect(h.lastText()).toContain("HH:MM");
  });

  it("applies losses_only on one tap, but demands a confirmation for all", async () => {
    const applied: string[] = [];
    const h = harness({
      reviewMode: () => Promise.resolve("off"),
      setReviewMode: (mode) => {
        applied.push(mode);
        return Promise.resolve();
      },
    });
    await h.handle(tap("v1:settings:review:losses_only"));
    expect(applied).toEqual(["losses_only"]);

    // "all" without its nonce is a stale/forged button: nothing applies.
    await h.handle(tap("v1:settings:review:all"));
    expect(applied).toEqual(["losses_only"]);

    await h.handle(tap("v1:settings:ask_review_all"));
    expect(h.lastText()).toContain("model call");
    await h.handle(tap(h.buttons().find((b) => b.startsWith("v1:settings:review:all"))!));
    expect(applied).toEqual(["losses_only", "all"]);
  });

  it("hides the auto-review row entirely when no LLM config is readable", async () => {
    const h = harness({ reviewMode: () => Promise.resolve(null) });
    await h.handle(tap("v1:settings:open"));
    expect(h.lastText()).not.toContain("Auto-review");
    expect(h.buttons().some((b) => b.startsWith("v1:settings:review"))).toBe(false);
  });

  it("reports a setReviewMode failure as a notice instead of pretending", async () => {
    const h = harness({
      reviewMode: () => Promise.resolve("off"),
      setReviewMode: () => Promise.reject(new Error("disk full")),
    });
    await h.handle(tap("v1:settings:review:losses_only"));
    expect(h.lastText()).toContain("disk full");
  });

  it("tells the companion when the chat language changes", async () => {
    const locales: string[] = [];
    const h = harness({ onLocaleChanged: (l) => locales.push(l) });
    await h.handle(tap("v1:settings:locale:zh"));
    expect(locales).toEqual(["zh"]);
    expect(h.settings().locale).toBe("zh");
  });
});

// ── U5/T1+T2 (2026-08-02): /status says what the CLI's status box says, and
// the settings message is grouped instead of six flat rows ──────────────────

describe("status panel — the CLI status box's rows", () => {
  it("carries matching, model, games and version, in the CLI's own words", async () => {
    const h = harness({
      fetchImpl: statusFetch(),
      config: { autoGames: ["texas_holdem", "coup"] },
      declaredModel: () => "claude-opus-4-6",
      runner: { snapshot: () => ({ state: { phase: "matching", queue: { game: "coup" } } }) },
    });
    await h.handle(command("/status"));
    const text = h.lastText();
    expect(text).toContain("matching: ⚔ queued · Coup"); // the game's display name, not its id
    expect(text).toContain("Public model: claude-opus-4-6");
    expect(text).toContain("Games: Texas Hold'em, Coup");
    expect(text).toContain(`CLI version: v${RUNTIME_VERSION}`);
  });

  it("paused beats a live queue entry — the same priority the CLI banner uses", async () => {
    const h = harness({
      fetchImpl: statusFetch(),
      pauseState: () => true,
      runner: { snapshot: () => ({ state: { phase: "idle", queue: { game: "coup" } } }) },
    });
    await h.handle(command("/status"));
    expect(h.lastText()).toContain("matching: ⏸ paused");
    expect(h.lastText()).not.toContain("queued");
  });

  it("says idle when the runner holds no queue entry at all", async () => {
    const h = harness({ fetchImpl: statusFetch() });
    await h.handle(command("/status"));
    expect(h.lastText()).toContain("matching: idle");
  });

  // A row that cannot be resolved is left OUT: a "Public model: —" would be a
  // claim of its own (the leaderboard shows something, this just cannot see it).
  it("drops the model row entirely when the companion cannot resolve one", async () => {
    const h = harness({ fetchImpl: statusFetch() });
    await h.handle(command("/status"));
    expect(h.lastText()).not.toContain("Public model");

    const blank = harness({ fetchImpl: statusFetch(), declaredModel: () => "   " });
    await blank.handle(command("/status"));
    expect(blank.lastText()).not.toContain("Public model");
  });

  it("keeps the local rows when the platform status is unreachable", async () => {
    const h = harness({
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
      declaredModel: () => "claude-opus-4-6",
    });
    await h.handle(command("/status"));
    const text = h.lastText();
    expect(text).toContain("unavailable");
    expect(text).toContain("matching: idle");
    expect(text).toContain("Public model: claude-opus-4-6");
    expect(text).toContain(`CLI version: v${RUNTIME_VERSION}`);
  });

  it("speaks Chinese, with the Chinese list comma", async () => {
    const h = harness({
      section: { locale: "zh" },
      fetchImpl: statusFetch(),
      config: { autoGames: ["texas_holdem", "coup"] },
      declaredModel: () => "claude-opus-4-6",
      runner: { snapshot: () => ({ state: { phase: "matching", queue: { game: "coup" } } }) },
    });
    await h.handle(command("/status"));
    const text = h.lastText();
    expect(text).toContain("匹配：⚔ 排队中 · 政变");
    expect(text).toContain("公开模型：claude-opus-4-6");
    expect(text).toContain("参赛游戏：德州扑克、政变");
    expect(text).toContain("今日自动 1/3");
  });
});

describe("settings panel — grouped body", () => {
  // The four bold headings, with every row still under the right one.
  it("labels four groups and keeps every value row", async () => {
    const h = harness({ reviewMode: () => Promise.resolve("losses_only") });
    await h.handle(command("/settings"));
    const text = h.lastText();
    for (const heading of ["<b>Play</b>", "<b>Notifications</b>", "<b>Review</b>", "<b>Language</b>"]) {
      expect(text, heading).toContain(heading);
    }
    expect(text).toContain("Daily automatic match cap: 2");
    expect(text).toContain("Games:");
    expect(text).toContain("Match results:");     // notification rows now live here too
    expect(text).toContain("Daily digest at:");
    expect(text).toContain("Alerts:");
    expect(text).toContain("Auto-review: losses only");
    expect(text).toContain("Message language: English");
    // Groups in reading order, each after the one before it.
    const order = ["<b>Play</b>", "<b>Notifications</b>", "<b>Review</b>", "<b>Language</b>"].map((g) => text.indexOf(g));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  // The grouping is a text change ONLY: the codec was fixed one batch ago and
  // no callback_data may drift here.
  it("changes not one callback_data", async () => {
    const h = harness();
    await h.handle(command("/settings"));
    expect(h.buttons()).toEqual([
      "v1:settings:ask_daily:0",
      "v1:settings:ask_daily:1",
      "v1:settings:ask_daily:2",
      "v1:settings:ask_daily:3",
      "v1:settings:ask_daily:5",
      "v1:settings:ask_daily:10",
      "v1:settings:custom_daily",
      "v1:settings:ask_rename",
      "v1:settings:game:texas_holdem",
      "v1:settings:game:liars_dice",
      "v1:settings:game:coup",
      "v1:settings:digest:2000",
      "v1:settings:digest:2100",
      "v1:settings:digest:2200",
      "v1:settings:digest:2300",
      "v1:settings:custom_digest",
      "v1:settings:locale:zh",
      "v1:home:open",
    ]);
  });

  it("headings speak Chinese too", async () => {
    const h = harness({ section: { locale: "zh" } });
    await h.handle(command("/settings"));
    const text = h.lastText();
    expect(text).toContain("<b>对局</b>");
    expect(text).toContain("<b>通知</b>");
    expect(text).toContain("<b>语言</b>");
  });
});

describe("panel buttons under a match report (arg \"new\")", () => {
  it("opens the notify panel as a NEW message instead of editing the report", async () => {
    const h = harness();
    await h.handle(tap("v1:notify:open:new"));
    const last = h.sent[h.sent.length - 1]!;
    expect(last.kind).toBe("send"); // never "edit" — the report must survive
    expect(last.text).toContain("Notifications");
  });

  it("still edits in place for ordinary panel navigation", async () => {
    const h = harness();
    await h.handle(tap("v1:notify:open"));
    expect(h.sent[h.sent.length - 1]!.kind).toBe("edit");
  });
});

// ── U6/T3 (2026-08-02): remote update. Owner ruled out the confirmation tap,
// so the GATES are the safety net — each test below pins one of them ────────

describe("remote update — /update and the status panel button", () => {
  it("refuses while a match is in progress, without asking npm anything", async () => {
    const spawned = spawnRecorder();
    let checks = 0;
    const h = harness({
      runner: { snapshot: () => ({ state: { phase: "deciding" } }) },
      checkUpdate: async () => {
        checks += 1;
        return updateCheck();
      },
      spawnUpdate: spawned.fn,
    });

    await h.handle(command("/update"));

    expect(h.lastText()).toContain("A match is in progress");
    expect(spawned.calls).toHaveLength(0);
    // The gate order is the property, not just the refusal: a bridge that is
    // playing never reaches the network call, let alone the spawn.
    expect(checks).toBe(0);
  });

  it("says the check could not answer, and starts nothing", async () => {
    const spawned = spawnRecorder();
    const h = harness({
      checkUpdate: async () => updateCheck({ status: "unknown", latestVersion: undefined }),
      spawnUpdate: spawned.fn,
    });

    await h.handle(command("/update"));

    expect(h.lastText()).toContain("Could not reach the version check");
    expect(spawned.calls).toHaveLength(0);
  });

  it("treats a version check that throws the same way", async () => {
    const spawned = spawnRecorder();
    const h = harness({
      checkUpdate: async () => {
        throw new Error("registry unreachable");
      },
      spawnUpdate: spawned.fn,
    });

    await h.handle(command("/update"));

    expect(h.lastText()).toContain("Could not reach the version check");
    expect(spawned.calls).toHaveLength(0);
  });

  it("says it is already current, and starts nothing", async () => {
    const spawned = spawnRecorder();
    const h = harness({
      checkUpdate: async () => updateCheck({ status: "current", latestVersion: RUNTIME_VERSION }),
      spawnUpdate: spawned.fn,
    });

    await h.handle(command("/update"));

    expect(h.lastText()).toContain(`Already on the latest: v${RUNTIME_VERSION}`);
    expect(spawned.calls).toHaveLength(0);
  });

  it("acknowledges first, then spawns `aifight update --yes` and lets go", async () => {
    const spawned = spawnRecorder();
    const h = harness({
      checkUpdate: async () => updateCheck(),
      spawnUpdate: spawned.fn,
      isServiceRun: () => true,
    });

    await h.handle(command("/update"));

    expect(h.lastText()).toContain("Updating to v9.9.9");
    expect(spawned.calls).toHaveLength(1);
    const call = spawned.calls[0]!;
    // Three literals and this process's own entry script — no chat input, ever.
    expect(call.command).toBe(process.execPath);
    expect(call.args[0]).toBe(process.argv[1]);
    expect(call.args.slice(1)).toEqual(["update", "--yes"]);
    expect(call.options.detached).toBe(true);
    expect(call.options.stdio[0]).toBe("ignore");     // never a stdin to block on
    expect(call.options.stdio[1]).toBe(call.options.stdio[2]); // one log for both streams
    expect(spawned.unrefs()).toBe(1);                 // never holds the bridge open
  });

  it("points the child's output at ~/.aifight/runtime/update.log", async () => {
    const spawned = spawnRecorder();
    const h = harness({ checkUpdate: async () => updateCheck(), spawnUpdate: spawned.fn });

    await h.handle(command("/update"));

    expect(fs.existsSync(path.join(getRuntimeHome(), "update.log"))).toBe(true);
    expect(typeof spawned.calls[0]!.options.stdio[1]).toBe("number"); // a real fd
  });

  it("adds the foreground warning unless this process is the installed service", async () => {
    const asService = harness({
      checkUpdate: async () => updateCheck(),
      spawnUpdate: spawnRecorder().fn,
      isServiceRun: () => true,
    });
    await asService.handle(command("/update"));
    expect(asService.lastText()).not.toContain("restarted by hand");

    const foreground = harness({
      checkUpdate: async () => updateCheck(),
      spawnUpdate: spawnRecorder().fn,
      isServiceRun: () => false,
    });
    await foreground.handle(command("/update"));
    expect(foreground.lastText()).toContain("restarted by hand");
  });

  it("corrects itself out loud when the child cannot be started at all", async () => {
    const spawned = spawnRecorder({ throws: "EPERM" });
    const h = harness({ checkUpdate: async () => updateCheck(), spawnUpdate: spawned.fn });

    await h.handle(command("/update"));

    const everything = h.sent.map((s) => s.text).join("\n");
    expect(everything).toContain("Updating to v9.9.9");
    expect(h.lastText()).toContain("Could not start the update");
    expect(h.logs).toContain("telegram.update_spawn_failed");
  });

  it("offers the button on /status only when there is something to update to", async () => {
    const available = harness({ fetchImpl: statusFetch(), checkUpdate: async () => updateCheck() });
    await available.handle(command("/status"));
    expect(available.lastText()).toContain(`CLI version: v${RUNTIME_VERSION} (update available → v9.9.9)`);
    // No version, no argument, no colon-separated value in the callback data.
    expect(available.buttons()).toContain("v1:status:update");

    const current = harness({
      fetchImpl: statusFetch(),
      checkUpdate: async () => updateCheck({ status: "current", latestVersion: RUNTIME_VERSION }),
    });
    await current.handle(command("/status"));
    expect(current.lastText()).toContain(`CLI version: v${RUNTIME_VERSION}`);
    expect(current.lastText()).not.toContain("update available");
    expect(current.buttons()).not.toContain("v1:status:update");
  });

  it("offers it for a version below the platform minimum too", async () => {
    const h = harness({
      fetchImpl: statusFetch(),
      checkUpdate: async () => updateCheck({ status: "unsupported" }),
    });
    await h.handle(command("/status"));
    expect(h.buttons()).toContain("v1:status:update");
  });

  it("runs the same gated flow from the button as from the command", async () => {
    const spawned = spawnRecorder();
    const h = harness({ checkUpdate: async () => updateCheck(), spawnUpdate: spawned.fn });

    await h.handle(tap("v1:status:update"));

    expect(h.sent[0]!.kind).toBe("answer"); // the phone's spinner is cleared first
    expect(h.lastText()).toContain("Updating to v9.9.9");
    expect(spawned.calls).toHaveLength(1);

    const busy = harness({
      runner: { snapshot: () => ({ state: { phase: "in_match" } }) },
      checkUpdate: async () => updateCheck(),
      spawnUpdate: spawnRecorder().fn,
    });
    await busy.handle(tap("v1:status:update"));
    expect(busy.lastText()).toContain("A match is in progress");
  });

  it("lists /update in the help text and in the registered command menu", async () => {
    const h = harness();
    await h.handle(command("/help"));
    expect(h.lastText()).toContain("/update");
    expect(botCommands("en").map((c) => c.command)).toContain("update");
    expect(botCommands("zh").find((c) => c.command === "update")?.description).toBe("升级 CLI（无对局时）");
  });

  it("speaks Chinese all the way through", async () => {
    const spawned = spawnRecorder();
    const h = harness({
      section: { locale: "zh" },
      checkUpdate: async () => updateCheck(),
      spawnUpdate: spawned.fn,
      isServiceRun: () => false,
    });
    await h.handle(command("/update"));
    expect(h.lastText()).toContain("开始升级到 v9.9.9");
    expect(h.lastText()).toContain("前台");

    const busy = harness({
      section: { locale: "zh" },
      runner: { snapshot: () => ({ state: { phase: "in_match" } }) },
      checkUpdate: async () => updateCheck(),
    });
    await busy.handle(command("/update"));
    expect(busy.lastText()).toContain("有对局在打");

    const zhStatus = harness({
      section: { locale: "zh" },
      fetchImpl: statusFetch(),
      checkUpdate: async () => updateCheck(),
    });
    await zhStatus.handle(command("/status"));
    expect(zhStatus.lastText()).toContain(`CLI 版本：v${RUNTIME_VERSION}（可更新 → v9.9.9）`);
    expect(zhStatus.sent.flatMap((s) => s.keyboard ?? []).flat().some((b) => b.text === "⬆️ 升级 CLI")).toBe(true);
  });
});
