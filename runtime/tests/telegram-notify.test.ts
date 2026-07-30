// The notification pipeline: bridge signals in, phone messages out.
//
// Two halves are tested separately because they answer different questions —
// the notifier decides WHAT happened (channel-agnostic), the Telegram channel
// decides whether the user wants to hear about it and what it reads like.

import { describe, expect, it, vi } from "vitest";

import {
  createBridgeNotifier,
  type NotifyChannel,
  type NotifyEvent,
} from "../src/notify/events";
import { createTelegramChannel, startTelegramCompanion } from "../src/notify/telegram/companion";
import { renderNotifyEvent } from "../src/notify/telegram/render";
import { defaultTelegramConfig } from "../src/notify/telegram/settings";
import type { BridgeConfig, BridgeTelegramConfig } from "../src/bridge/config";
import type { TelegramApi, TelegramUpdate } from "../src/notify/telegram/api";
import type { ServerMessageEnvelope } from "../src/wsclient/frame-handler";

const SELF = "agent-self";
const BASE_URL = "https://aifight.ai";

/** A collecting channel — the notifier's output, with no rendering. */
function recorder(): { channel: NotifyChannel; events: NotifyEvent[] } {
  const events: NotifyEvent[] = [];
  return {
    events,
    channel: {
      deliver: (e) => events.push(e),
      stop: () => Promise.resolve(),
    },
  };
}

function gameStart(sessionId: string, game: string): ServerMessageEnvelope {
  return { type: "game_start", data: { match_id: sessionId, game, your_player_id: "p0", players: [] } };
}

interface GameOverOverrides {
  readonly sessionId?: string;
  readonly matchId?: string;
  readonly winner?: string;
  readonly payoffs?: Record<string, number>;
  readonly isDraw?: boolean;
  readonly replayUrl?: string;
  readonly forfeitedBy?: string;
  readonly forfeitReason?: string;
  readonly players?: Array<{ player_id: string; position: number; agent_id: string; agent_name: string }>;
}

function gameOver(overrides: GameOverOverrides = {}): ServerMessageEnvelope {
  const players = overrides.players ?? [
    { player_id: "p0", position: 0, agent_id: SELF, agent_name: "PokerMind" },
    { player_id: "p1", position: 1, agent_id: "agent-rival", agent_name: "GPTShark" },
  ];
  return {
    type: "game_over",
    data: {
      match_id: overrides.matchId ?? "match-1",
      session_id: overrides.sessionId ?? "sess-1",
      result: {
        payoffs: overrides.payoffs ?? { p0: 120, p1: -120 },
        ...(overrides.winner !== undefined ? { winner: overrides.winner } : {}),
        is_draw: overrides.isDraw ?? false,
      },
      players,
      ...(overrides.replayUrl !== undefined ? { replay_url: overrides.replayUrl } : {}),
      ...(overrides.forfeitedBy !== undefined ? { forfeited_by: overrides.forfeitedBy } : {}),
      ...(overrides.forfeitReason !== undefined ? { forfeit_reason: overrides.forfeitReason } : {}),
    },
  };
}

describe("bridge notifier — match results", () => {
  it("reports a win with the game learned from game_start and a full replay URL", () => {
    const rec = recorder();
    const notifier = createBridgeNotifier({ agentId: SELF, baseUrl: BASE_URL, channel: rec.channel });

    notifier.observeServerMessage(gameStart("sess-1", "texas_holdem"));
    notifier.observeServerMessage(gameOver({ replayUrl: "/replay/abc123" }));

    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toEqual({
      kind: "match.result",
      game: "texas_holdem",
      selfLabel: "1st place",
      won: true,
      draw: false,
      forfeitedSelf: false,
      opponents: ["GPTShark"],
      replayUrl: "https://aifight.ai/replay/abc123",
      playerCount: 2,
      matchId: "match-1",
    });
  });

  it("reports a loss with the placing the bridge log would show", () => {
    const rec = recorder();
    const notifier = createBridgeNotifier({ agentId: SELF, baseUrl: BASE_URL, channel: rec.channel });

    notifier.observeServerMessage(gameOver({ payoffs: { p0: -120, p1: 120 } }));

    expect(rec.events[0]).toMatchObject({ kind: "match.result", selfLabel: "2nd place", won: false });
  });

  it("reports a draw", () => {
    const rec = recorder();
    const notifier = createBridgeNotifier({ agentId: SELF, baseUrl: BASE_URL, channel: rec.channel });

    notifier.observeServerMessage(gameOver({ isDraw: true, payoffs: { p0: 0, p1: 0 } }));

    expect(rec.events[0]).toMatchObject({ selfLabel: "draw", draw: true, won: false });
  });

  it("raises an extra alert when WE forfeited, and carries the reason", () => {
    const rec = recorder();
    const notifier = createBridgeNotifier({ agentId: SELF, baseUrl: BASE_URL, channel: rec.channel });

    notifier.observeServerMessage(gameStart("sess-1", "coup"));
    notifier.observeServerMessage(gameOver({ forfeitedBy: "p0", forfeitReason: "disconnect" }));

    expect(rec.events.map((e) => e.kind)).toEqual(["match.result", "alert.forfeit"]);
    expect(rec.events[0]).toMatchObject({ selfLabel: "forfeit", forfeitedSelf: true, forfeitReason: "disconnect" });
    expect(rec.events[1]).toMatchObject({ kind: "alert.forfeit", game: "coup", reason: "disconnect" });
  });

  it("does not alert when the OPPONENT forfeited", () => {
    const rec = recorder();
    const notifier = createBridgeNotifier({ agentId: SELF, baseUrl: BASE_URL, channel: rec.channel });

    notifier.observeServerMessage(gameOver({ forfeitedBy: "p1", forfeitReason: "disconnect" }));

    expect(rec.events.map((e) => e.kind)).toEqual(["match.result"]);
    expect(rec.events[0]).toMatchObject({ selfLabel: "opponent forfeit", forfeitedSelf: false });
  });

  it("omits the replay link when the server published none", () => {
    const rec = recorder();
    const notifier = createBridgeNotifier({ agentId: SELF, baseUrl: BASE_URL, channel: rec.channel });

    notifier.observeServerMessage(gameOver({ forfeitedBy: "p0" }));

    expect(rec.events[0]).not.toHaveProperty("replayUrl");
  });

  it("names every opponent in a multi-player table", () => {
    const rec = recorder();
    const notifier = createBridgeNotifier({ agentId: SELF, baseUrl: BASE_URL, channel: rec.channel });

    notifier.observeServerMessage(gameOver({
      payoffs: { p0: 10, p1: 5, p2: -15 },
      players: [
        { player_id: "p0", position: 0, agent_id: SELF, agent_name: "PokerMind" },
        { player_id: "p1", position: 1, agent_id: "a1", agent_name: "DiceKing" },
        { player_id: "p2", position: 2, agent_id: "a2", agent_name: "BluffBot" },
      ],
    }));

    expect(rec.events[0]).toMatchObject({ opponents: ["DiceKing", "BluffBot"], playerCount: 3, won: true });
  });

  it("forgets a session's game once the match is over", () => {
    const rec = recorder();
    const notifier = createBridgeNotifier({ agentId: SELF, baseUrl: BASE_URL, channel: rec.channel });

    notifier.observeServerMessage(gameStart("sess-1", "liars_dice"));
    notifier.observeServerMessage(gameOver({ sessionId: "sess-1" }));
    notifier.observeServerMessage(gameOver({ sessionId: "sess-1", matchId: "match-2" }));

    expect(rec.events[0]).toMatchObject({ game: "liars_dice" });
    expect(rec.events[1]).not.toHaveProperty("game");
  });

  it("ignores malformed or irrelevant server messages instead of throwing", () => {
    const rec = recorder();
    const notifier = createBridgeNotifier({ agentId: SELF, baseUrl: BASE_URL, channel: rec.channel });

    expect(() => {
      notifier.observeServerMessage({ type: "game_over", data: null });
      notifier.observeServerMessage({ type: "game_over", data: { match_id: 7 } });
      notifier.observeServerMessage({ type: "action_request", data: {} });
    }).not.toThrow();
    expect(rec.events).toHaveLength(0);
  });

  it("never lets a broken channel reach the bridge", () => {
    const notifier = createBridgeNotifier({
      agentId: SELF,
      baseUrl: BASE_URL,
      channel: {
        deliver: () => {
          throw new Error("channel exploded");
        },
        stop: () => Promise.resolve(),
      },
    });

    expect(() => notifier.observeServerMessage(gameOver())).not.toThrow();
  });
});

describe("bridge notifier — alerts", () => {
  it("raises one LLM-failure alert per match per throttle window", () => {
    const rec = recorder();
    let clock = 1_000_000;
    const notifier = createBridgeNotifier({
      agentId: SELF,
      baseUrl: BASE_URL,
      channel: rec.channel,
      now: () => clock,
    });
    const failure = {
      level: "warning" as const,
      code: "bridge.fallback_required",
      message: "No action sent for match sess-9; runtime decision failed",
    };

    notifier.observeLog(failure);
    notifier.observeLog(failure);
    clock += 9 * 60_000;
    notifier.observeLog(failure); // still inside the window
    clock += 2 * 60_000;
    notifier.observeLog(failure); // window elapsed

    expect(rec.events).toHaveLength(2);
    expect(rec.events[0]).toMatchObject({ kind: "alert.llm_failure", matchId: "sess-9" });
    expect((rec.events[0] as { reasonSummary: string }).reasonSummary).toContain("runtime decision failed");
  });

  it("throttles per match, not globally", () => {
    const rec = recorder();
    const notifier = createBridgeNotifier({ agentId: SELF, baseUrl: BASE_URL, channel: rec.channel });

    notifier.observeLog({ level: "warning", code: "bridge.fallback_required", message: "No action sent for match sess-1; runtime decision failed" });
    notifier.observeLog({ level: "warning", code: "bridge.fallback_required", message: "No action sent for match sess-2; runtime decision failed" });

    expect(rec.events).toHaveLength(2);
  });

  it("alerts once per outage and re-arms after reconnecting", () => {
    const rec = recorder();
    const notifier = createBridgeNotifier({ agentId: SELF, baseUrl: BASE_URL, channel: rec.channel });
    const failed = (level: "warning" | "error") => ({ level, code: "reconnect.attempt_failure", message: `Reconnect attempt 9 failed` });

    notifier.observeLog(failed("warning")); // under the 15-minute severity bar
    expect(rec.events).toHaveLength(0);

    notifier.observeLog(failed("error"));
    notifier.observeLog(failed("error"));
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ kind: "alert.disconnected", sinceMs: 15 * 60_000 });

    notifier.observeLog({ level: "info", code: "reconnect.attempt_success", message: "back" });
    notifier.observeLog(failed("error"));
    // disconnected → recovered → disconnected again.
    expect(rec.events).toHaveLength(3);
    expect(rec.events[2]).toMatchObject({ kind: "alert.disconnected" });
  });

  // The phone that was told "the bridge is down" is waiting for exactly one
  // message; leaving it on the bad news was the whole bug.
  it("closes an alerted outage with a back-online note", () => {
    const rec = recorder();
    let clock = 1_000_000;
    const notifier = createBridgeNotifier({ agentId: SELF, baseUrl: BASE_URL, channel: rec.channel, now: () => clock });

    notifier.observeLog({ level: "error", code: "reconnect.attempt_failure", message: "Reconnect attempt 9 failed" });
    clock += 16 * 60_000;
    notifier.observeLog({ level: "info", code: "reconnect.attempt_success", message: "back" });

    expect(rec.events.map((e) => e.kind)).toEqual(["alert.disconnected", "alert.recovered"]);
    expect(rec.events[1]).toMatchObject({ offlineMs: 16 * 60_000 });

    const zh = renderNotifyEvent("zh", rec.events[1]!, { agentName: "PokerMind" }).text;
    expect(zh).toContain("已恢复在线");
    expect(zh).toContain("16 分钟");
    const en = renderNotifyEvent("en", rec.events[1]!, { agentName: "PokerMind" }).text;
    expect(en).toContain("back online");
    expect(en).toContain("16 minutes");
  });

  it("says nothing on a reconnect when the outage never reached the alert bar", () => {
    const rec = recorder();
    const notifier = createBridgeNotifier({ agentId: SELF, baseUrl: BASE_URL, channel: rec.channel });

    notifier.observeLog({ level: "warning", code: "reconnect.attempt_failure", message: "Reconnect attempt 1 failed" });
    notifier.observeLog({ level: "info", code: "reconnect.attempt_success", message: "back" });
    notifier.observeLog({ level: "info", code: "bridge.connected", message: "connected" });

    expect(rec.events).toHaveLength(0);
  });

  it("passes the three fatal refusals through with their code", () => {
    const rec = recorder();
    const notifier = createBridgeNotifier({ agentId: SELF, baseUrl: BASE_URL, channel: rec.channel });

    notifier.observeLog({ level: "error", code: "bridge.device_mismatch", message: "wrong device" });
    notifier.observeLog({ level: "error", code: "bridge.client_mismatch", message: "desktop owns it" });
    notifier.observeLog({ level: "error", code: "bridge.credential_rejected", message: "key rejected" });

    expect(rec.events.map((e) => (e as { code?: string }).code)).toEqual([
      "device_mismatch",
      "client_mismatch",
      "credential_rejected",
    ]);
  });

  // The common model failure — an expired key, an exhausted quota — never
  // throws: the provider substitutes its own move and returns normally. Nothing
  // reaches the log stream, so this used to be a silent phone.
  it("alerts when a turn was played by the fallback instead of the model", () => {
    const rec = recorder();
    const notifier = createBridgeNotifier({ agentId: SELF, baseUrl: BASE_URL, channel: rec.channel });

    notifier.observeServerMessage(gameStart("sess-3", "coup"));
    notifier.observeTrace({
      type: "runtime_failure",
      matchId: "sess-3",
      attempt: 1,
      error: "401 invalid api key",
      errorClass: "auth",
    });
    notifier.observeTrace({
      type: "final_action",
      matchId: "sess-3",
      source: "fallback",
      decisionSource: "fallback",
      reason: "runtime_failure",
      action: { type: "check" } as never,
    });

    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({
      kind: "alert.llm_failure",
      matchId: "sess-3",
      game: "coup",
      degraded: "fallback_action",
    });
    // The provider's own classification, so the message can say what to fix.
    expect((rec.events[0] as { reasonSummary: string }).reasonSummary).toContain("auth");
  });

  it("says nothing when the model answered normally", () => {
    const rec = recorder();
    const notifier = createBridgeNotifier({ agentId: SELF, baseUrl: BASE_URL, channel: rec.channel });

    notifier.observeTrace({
      type: "final_action",
      matchId: "sess-4",
      source: "runtime",
      decisionSource: "model",
      action: { type: "fold" } as never,
    });
    // One failed attempt that a retry rescued is not worth a phone alert.
    notifier.observeTrace({ type: "runtime_failure", matchId: "sess-5", attempt: 1, error: "timeout" });

    expect(rec.events).toHaveLength(0);
  });

  it("tells the two degradations apart", () => {
    const rec = recorder();
    const notifier = createBridgeNotifier({ agentId: SELF, baseUrl: BASE_URL, channel: rec.channel });

    notifier.observeLog({
      level: "warning",
      code: "bridge.fallback_required",
      message: "No action sent for match sess-6; runtime decision failed",
    });

    expect(rec.events[0]).toMatchObject({ degraded: "no_action" });
    const zh = renderNotifyEvent("zh", rec.events[0]!, { agentName: "PokerMind" }).text;
    expect(zh).toContain("什么都没发出去");
    expect(zh).not.toContain("兜底动作替它出了");
  });

  it("tells the phone when the bridge gives up reconnecting for good", () => {
    const rec = recorder();
    const notifier = createBridgeNotifier({ agentId: SELF, baseUrl: BASE_URL, channel: rec.channel });

    notifier.observeLog({ level: "error", code: "reconnect.give_up", message: "out of attempts" });

    expect(rec.events[0]).toMatchObject({ kind: "alert.fatal", code: "bridge_stopped" });
  });

  // The link lands in the user's own bot, where it carries AIFight's
  // credibility; an absolute replay_url from the server would override the base.
  it("drops a replay link that does not point at AIFight", () => {
    const rec = recorder();
    const notifier = createBridgeNotifier({ agentId: SELF, baseUrl: BASE_URL, channel: rec.channel });

    notifier.observeServerMessage(gameOver({ replayUrl: "https://evil.example/replay/abc" }));

    expect(rec.events[0]).toMatchObject({ kind: "match.result" });
    expect((rec.events[0] as { replayUrl?: string }).replayUrl).toBeUndefined();
  });

  it("ignores the rest of the log stream", () => {
    const rec = recorder();
    const notifier = createBridgeNotifier({ agentId: SELF, baseUrl: BASE_URL, channel: rec.channel });

    notifier.observeLog({ level: "info", code: "bridge.queue_joined", message: "Joined coup" });
    notifier.observeLog({ level: "info", code: "fsm.game_state", message: "state" });

    expect(rec.events).toHaveLength(0);
  });
});

// ── The Telegram channel ─────────────────────────────────────────────

function apiStub(): { api: TelegramApi; sent: Array<{ chatId: number; text: string; keyboard?: unknown }> } {
  const sent: Array<{ chatId: number; text: string; keyboard?: unknown }> = [];
  const api = {
    sendMessage: async (params: { chatId: number; text: string; keyboard?: unknown }) => {
      sent.push(params);
      return { message_id: sent.length, chat: { id: params.chatId } };
    },
  } as unknown as TelegramApi;
  return { api, sent };
}

const RESULT_EVENT: NotifyEvent = {
  kind: "match.result",
  game: "texas_holdem",
  selfLabel: "1st place",
  won: true,
  draw: false,
  forfeitedSelf: false,
  opponents: ["GPTShark"],
  replayUrl: "https://aifight.ai/replay/abc",
  playerCount: 4,
  matchId: "m1",
};

const ALERT_EVENT: NotifyEvent = { kind: "alert.disconnected", sinceMs: 15 * 60_000 };

function channelFor(section: Partial<BridgeTelegramConfig>, now = () => Date.now()) {
  const stub = apiStub();
  const settings: BridgeTelegramConfig = { ...defaultTelegramConfig(4242), ...section };
  const channel = createTelegramChannel({
    api: stub.api,
    settings: () => settings,
    agentName: () => "PokerMind",
    now,
  });
  return { ...stub, channel };
}

describe("telegram channel", () => {
  it("renders a win with a replay button", async () => {
    const c = channelFor({});
    c.channel.deliver(RESULT_EVENT);
    await c.channel.stop();

    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]!.chatId).toBe(4242);
    expect(c.sent[0]!.text).toContain("Win");
    expect(c.sent[0]!.text).toContain("Texas Hold'em");
    expect(c.sent[0]!.text).toContain("GPTShark");
    expect(c.sent[0]!.keyboard).toEqual([[{ text: "🎬 Watch replay", url: "https://aifight.ai/replay/abc" }]]);
  });

  it("speaks Chinese when the section says so", async () => {
    const c = channelFor({ locale: "zh" });
    c.channel.deliver(RESULT_EVENT);
    await c.channel.stop();
    expect(c.sent[0]!.text).toContain("胜利");
    expect(c.sent[0]!.text).toContain("德州扑克");
    expect(c.sent[0]!.text).toContain("第 1 名"); // not the raw "1st place"
  });

  // resultLabel() is an English wire-ish value from the session store; a Chinese
  // reader should not be told "opponent forfeit".
  it("says the placing and the odd outcomes in the reader's language", async () => {
    const c = channelFor({ locale: "zh" });
    c.channel.deliver({ ...RESULT_EVENT, selfLabel: "opponent forfeit", won: false });
    c.channel.deliver({ ...RESULT_EVENT, selfLabel: "3rd place", won: false });
    await c.channel.stop();

    expect(c.sent[0]!.text).toContain("对手中途退出");
    expect(c.sent[0]!.text).not.toContain("opponent forfeit");
    expect(c.sent[1]!.text).toContain("第 3 名");
  });

  it("honours the results preference", async () => {
    const off = channelFor({ results: "off" });
    off.channel.deliver(RESULT_EVENT);
    await off.channel.stop();
    expect(off.sent).toHaveLength(0);

    const daily = channelFor({ results: "daily" });
    daily.channel.deliver(RESULT_EVENT);
    await daily.channel.stop();
    expect(daily.sent).toHaveLength(0);

    const both = channelFor({ results: "both" });
    both.channel.deliver(RESULT_EVENT);
    await both.channel.stop();
    expect(both.sent).toHaveLength(1);
  });

  it("mutes results but never alerts", async () => {
    const now = () => 1_000_000;
    const c = channelFor({ mutedUntil: 2_000_000 }, now);

    c.channel.deliver(RESULT_EVENT);
    c.channel.deliver(ALERT_EVENT);
    await c.channel.stop();

    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]!.text).toContain("Needs your attention");
  });

  it("stops sending alerts when the user turns them off", async () => {
    const c = channelFor({ alerts: false });
    c.channel.deliver(ALERT_EVENT);
    await c.channel.stop();
    expect(c.sent).toHaveLength(0);
  });

  it("gates challenge events on their own switch", async () => {
    const on = channelFor({});
    on.channel.deliver({ kind: "challenge.accepted", game: "coup" });
    await on.channel.stop();
    expect(on.sent).toHaveLength(1);

    const off = channelFor({ challengeEvents: false });
    off.channel.deliver({ kind: "challenge.accepted", game: "coup" });
    await off.channel.stop();
    expect(off.sent).toHaveLength(0);
  });

  // deliver() runs inside the bridge's own message loop, so it must never wait
  // on a round trip: a slow Telegram would otherwise slow down playing.
  it("returns from deliver() immediately, before the send resolves", async () => {
    let started = false;
    let resolveSend: () => void = () => undefined;
    const api = {
      sendMessage: () => new Promise((resolve) => {
        started = true;
        resolveSend = () => resolve({ message_id: 1, chat: { id: 1 } });
      }),
    } as unknown as TelegramApi;
    const channel = createTelegramChannel({
      api,
      settings: () => defaultTelegramConfig(1),
      agentName: () => "PokerMind",
    });

    const before = Date.now();
    channel.deliver(RESULT_EVENT);

    expect(Date.now() - before).toBeLessThan(50);
    expect(started).toBe(false); // not even dialled yet — it is queued behind a tick
    resolveSend();
    await channel.stop();
  });

  it("swallows a send failure and keeps going", async () => {
    const logs: string[] = [];
    let calls = 0;
    const api = {
      sendMessage: async () => {
        calls += 1;
        if (calls === 1) throw new Error("Bad Gateway");
        return { message_id: 2, chat: { id: 1 } };
      },
    } as unknown as TelegramApi;
    const channel = createTelegramChannel({
      api,
      settings: () => defaultTelegramConfig(1),
      agentName: () => "PokerMind",
      onLog: (e) => logs.push(`${e.code}:${e.message}`),
    });

    channel.deliver(RESULT_EVENT);
    channel.deliver(RESULT_EVENT);
    await channel.stop();

    expect(calls).toBe(2);
    expect(logs.join("")).toContain("telegram.send_failed");
  });

  it("stops accepting events once stopped", async () => {
    const c = channelFor({});
    await c.channel.stop();
    c.channel.deliver(RESULT_EVENT);
    expect(c.sent).toHaveLength(0);
  });

  it("gives up rather than hanging shutdown on a wedged network", async () => {
    const api = {
      sendMessage: () => new Promise(() => undefined), // never resolves
    } as unknown as TelegramApi;
    const channel = createTelegramChannel({
      api,
      settings: () => defaultTelegramConfig(1),
      agentName: () => "PokerMind",
    });

    channel.deliver(RESULT_EVENT);
    const started = Date.now();
    await channel.stop();

    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("drops notifications rather than queueing without bound", async () => {
    const logs: string[] = [];
    const api = { sendMessage: () => new Promise(() => undefined) } as unknown as TelegramApi;
    const channel = createTelegramChannel({
      api,
      settings: () => defaultTelegramConfig(1),
      agentName: () => "PokerMind",
      onLog: (e) => logs.push(e.code),
    });

    for (let i = 0; i < 60; i += 1) channel.deliver(RESULT_EVENT);

    expect(logs.filter((c) => c === "telegram.queue_full").length).toBeGreaterThan(0);
    await channel.stop();
  });

  // A full queue of match reports must not be able to swallow "the bridge is
  // down" — the alert takes the oldest unsent report's slot instead.
  it("sacrifices the oldest queued non-alert when an alert needs the slot", async () => {
    const logs: string[] = [];
    const stub = apiStub();
    const channel = createTelegramChannel({
      api: stub.api,
      settings: () => defaultTelegramConfig(1),
      agentName: () => "PokerMind",
      onLog: (e) => logs.push(e.message),
    });

    // MAX_PENDING is 50: fill it, then deliver the alert. All delivered
    // synchronously, so nothing has started sending yet — Rival0 is oldest.
    for (let i = 0; i < 50; i += 1) channel.deliver({ ...RESULT_EVENT, opponents: [`Rival${i}`] });
    channel.deliver(ALERT_EVENT);
    await channel.stop();

    expect(stub.sent).toHaveLength(50);
    expect(stub.sent.some((s) => s.text.startsWith("🚨"))).toBe(true); // the alert got through
    expect(stub.sent.some((s) => s.text.includes("Rival0"))).toBe(false); // ...at the oldest report's cost
    expect(stub.sent.some((s) => s.text.includes("Rival49"))).toBe(true);
    expect(logs.some((m) => m.includes("to make room for an alert"))).toBe(true);
  });

  // ...but a queue that is nothing BUT alerts keeps the old policy: the
  // newcomer is the one that goes.
  it("still drops the newcomer when the whole queue is alerts", async () => {
    const logs: string[] = [];
    const stub = apiStub();
    const channel = createTelegramChannel({
      api: stub.api,
      settings: () => defaultTelegramConfig(1),
      agentName: () => "PokerMind",
      onLog: (e) => logs.push(e.message),
    });

    for (let i = 0; i < 51; i += 1) channel.deliver(ALERT_EVENT);
    await channel.stop();

    expect(stub.sent).toHaveLength(50);
    expect(logs.some((m) => m.includes("dropped a alert.disconnected"))).toBe(true);
    expect(logs.some((m) => m.includes("to make room"))).toBe(false);
  });

  // 、 is the Chinese list comma; an English report takes ", ".
  it("joins the opponent list with the reader's own list comma", () => {
    const event: NotifyEvent = { ...RESULT_EVENT, opponents: ["Alice", "Bob"] };

    const en = renderNotifyEvent("en", event, { agentName: "PokerMind" }).text;
    expect(en).toContain("Alice, Bob");
    expect(en).not.toContain("、");

    const zh = renderNotifyEvent("zh", event, { agentName: "PokerMind" }).text;
    expect(zh).toContain("Alice、Bob");
  });
});

// ── Composition ──────────────────────────────────────────────────────

function bridgeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    version: 1,
    baseUrl: BASE_URL,
    wsUrl: "wss://aifight.ai/api/ws",
    agentId: SELF,
    agentName: "PokerMind",
    apiKey: "sk-secret",
    runtimeType: "direct",
    runtimeLocalUrl: "direct://local",
    updatedAt: "2026-07-27T00:00:00.000Z",
    ...overrides,
  };
}

describe("startTelegramCompanion", () => {
  it("stays out of the way when it is not configured", () => {
    expect(startTelegramCompanion({ config: bridgeConfig() })).toBeNull();
    expect(startTelegramCompanion({ config: bridgeConfig({ telegramBotToken: "1234567:TEST" }) })).toBeNull();
  });

  it("turns a game_over from the bridge into a message on the phone", async () => {
    const stub = apiStub();
    const companion = startTelegramCompanion({
      config: bridgeConfig({
        telegramBotToken: "1234567:TEST",
        telegram: defaultTelegramConfig(4242),
      }),
      apiFactory: () => stub.api,
      poll: false,
    });

    companion!.observeServerMessage(gameStart("sess-1", "coup"));
    companion!.observeServerMessage(gameOver({ replayUrl: "/replay/xyz" }));
    await companion!.stop();

    expect(stub.sent).toHaveLength(1);
    expect(stub.sent[0]!.chatId).toBe(4242);
    expect(stub.sent[0]!.text).toContain("Coup");
    expect(stub.sent[0]!.text).toContain("PokerMind");
  });

  it("escapes an agent name that would otherwise be read as markup", async () => {
    const stub = apiStub();
    const companion = startTelegramCompanion({
      config: bridgeConfig({
        agentName: "<b>Bold</b>",
        telegramBotToken: "1234567:TEST",
        telegram: defaultTelegramConfig(1),
      }),
      apiFactory: () => stub.api,
      poll: false,
    });

    companion!.observeServerMessage(gameOver());
    await companion!.stop();

    expect(stub.sent[0]!.text).toContain("&lt;b&gt;Bold&lt;/b&gt;");
  });

  // The channel used to capture the name once, at startup, so every report after
  // a rename from the chat still carried the old one until the bridge restarted.
  it("signs the next report with a name changed from the chat", async () => {
    const stub = apiStub();
    const fetchImpl = (async (input: string | URL | Request) =>
      String(input).includes("/api/agents/me/name")
        ? new Response(JSON.stringify({ name: "Dark Knight" }), { status: 200 })
        : new Response("{}", { status: 404 })) as unknown as typeof fetch;

    const companion = startTelegramCompanion({
      config: bridgeConfig({ telegramBotToken: "1234567:TEST", telegram: defaultTelegramConfig(4242) }),
      apiFactory: () => stub.api,
      persistConfig: () => undefined, // keep the test off bridge.json
      fetchImpl,
      poll: false,
    });

    const message = (text: string): TelegramUpdate => ({
      update_id: 1,
      message: { message_id: 1, chat: { id: 4242, type: "private" }, text },
    });
    const tap = (data: string): TelegramUpdate => ({
      update_id: 2,
      callback_query: {
        id: "cb",
        from: { id: 4242 },
        message: { message_id: 9, chat: { id: 4242, type: "private" } },
        data,
      },
    });

    await companion!.handleUpdate(tap("v1:settings:ask_rename"));
    await companion!.handleUpdate(message("Dark Knight"));
    const keyboard = [...stub.sent].reverse().find((s) => s.keyboard !== undefined)?.keyboard as
      | Array<Array<{ callback_data?: string }>>
      | undefined;
    const confirm = (keyboard ?? []).flat().find((b) => b.callback_data?.startsWith("v1:settings:rename") === true);
    await companion!.handleUpdate(tap(confirm!.callback_data!));

    companion!.observeServerMessage(gameOver());
    await companion!.stop();

    const report = stub.sent[stub.sent.length - 1]!.text;
    expect(report).toContain("Dark Knight");
    expect(report).not.toContain("PokerMind");
  });

  it("announces itself on the bridge log", () => {
    const logs: string[] = [];
    startTelegramCompanion({
      config: bridgeConfig({ telegramBotToken: "1234567:TEST", telegram: defaultTelegramConfig(9) }),
      apiFactory: () => apiStub().api,
      onLog: (e) => logs.push(e.code),
      poll: false,
    });
    expect(logs).toContain("telegram.started");
  });

  it("listens for taps when remote control is on", async () => {
    let polled = 0;
    const api = {
      getUpdates: async () => {
        polled += 1;
        return [];
      },
      sendMessage: async () => ({ message_id: 1, chat: { id: 1 } }),
    } as unknown as TelegramApi;

    const companion = startTelegramCompanion({
      config: bridgeConfig({ telegramBotToken: "1234567:TEST", telegram: defaultTelegramConfig(1) }),
      apiFactory: () => api,
    });
    await new Promise((r) => setTimeout(r, 10));
    await companion!.stop();

    expect(polled).toBeGreaterThan(0);
  });

  // Notifications-only mode: nothing is polled, so the bot has no inbound
  // surface at all — but the phone still gets told what happened.
  it("does not listen at all when remote control is off, yet still notifies", async () => {
    const stub = apiStub();
    let polled = 0;
    const api = {
      ...stub.api,
      getUpdates: async () => {
        polled += 1;
        return [];
      },
    } as unknown as TelegramApi;

    const companion = startTelegramCompanion({
      config: bridgeConfig({
        telegramBotToken: "1234567:TEST",
        telegram: { ...defaultTelegramConfig(4242), control: false },
      }),
      apiFactory: () => api,
    });
    companion!.observeServerMessage(gameOver());
    await new Promise((r) => setTimeout(r, 10));
    await companion!.stop();

    expect(polled).toBe(0);
    expect(stub.sent).toHaveLength(1);
  });

  it("does not fail the bridge when Telegram is unreachable", async () => {
    const api = {
      sendMessage: vi.fn(async () => {
        throw new Error("could not reach Telegram");
      }),
    } as unknown as TelegramApi;
    const companion = startTelegramCompanion({
      config: bridgeConfig({ telegramBotToken: "1234567:TEST", telegram: defaultTelegramConfig(1) }),
      apiFactory: () => api,
      poll: false,
    });

    expect(() => companion!.observeServerMessage(gameOver())).not.toThrow();
    await expect(companion!.stop()).resolves.toBeUndefined();
  });
});
