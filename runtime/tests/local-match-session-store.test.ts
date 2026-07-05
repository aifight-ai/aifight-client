import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { LocalMatchSessionStore } from "../src/session/local-match-session-store";
import type { BridgeConfig } from "../src/bridge/config";
import type { MsgActionRequest, MsgGameOver, MsgGameStart } from "../src/protocol/types";

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aifight-session-store-"));
}

function bridgeConfig(): BridgeConfig {
  return {
    version: 1,
    baseUrl: "https://aifight.ai",
    wsUrl: "wss://aifight.ai/api/ws",
    agentId: "agent-1",
    agentName: "alpha",
    apiKey: "sk-local-agent-key",
    runtimeType: "mock",
    runtimeLocalUrl: "mock://local",
    runtimeModel: "mock",
    updatedAt: "2026-05-18T00:00:00.000Z",
  };
}

function gameStart(): MsgGameStart {
  return {
    type: "game_start",
    data: {
      match_id: "session-1",
      game: "liars_dice",
      mode: "ranked",
      your_position: 0,
      your_player_id: "p0",
      players: [],
      rules: {},
      config: {},
    },
  } as unknown as MsgGameStart;
}

function actionRequest(): MsgActionRequest {
  return {
    type: "action_request",
    data: {
      match_id: "session-1",
      state: { your_player_id: "p0", current_bid: null },
      legal_actions: [{ type: "challenge" }],
      players: [],
      timeout_ms: 300_000,
      new_events: [],
    },
  } as unknown as MsgActionRequest;
}

function gameOver(): MsgGameOver {
  return {
    type: "game_over",
    data: {
      match_id: "real-match-1",
      session_id: "session-1",
      result: {
        payoffs: { p0: 1, p1: 0 },
        winner: "p0",
        is_draw: false,
      },
      players: [
        { agent_id: "agent-1", agent_name: "alpha", player_id: "p0", position: 0 },
        { agent_id: "agent-2", agent_name: "beta", player_id: "p1", position: 1 },
      ],
      replay_url: "/replay/real-match-1",
    },
  };
}

describe("LocalMatchSessionStore", () => {
  it("records inbound messages, decisions, outbound actions, and final summary", () => {
    const store = new LocalMatchSessionStore({
      runtimeHome: tempHome(),
      now: () => new Date("2026-05-18T01:02:03.000Z"),
    });
    const config = bridgeConfig();
    const start = gameStart();
    const request = actionRequest();

    store.recordServerMessage(config, start);
    store.recordServerMessage(config, request);
    store.recordDecision({
      config,
      context: {
        actionRequest: request,
        matchId: "session-1",
        game: "liars_dice",
        state: null,
      } as never,
      startedAt: new Date("2026-05-18T01:02:03.000Z"),
      completedAt: new Date("2026-05-18T01:02:04.000Z"),
      traces: [
        {
          type: "decision_request",
          matchId: "session-1",
          game: "liars_dice",
          playerId: "p0",
          legalActionCount: 1,
          timeoutMs: 300_000,
          strategy: [
            {
              scope: "global",
              path: "/tmp/global.md",
              content: "Prefer legal JSON.",
              sha256: "hash-1",
              bytes: 18,
              mtimeMs: 1,
            },
          ],
        },
        {
          type: "final_action",
          matchId: "session-1",
          source: "runtime",
          action: { type: "challenge" },
        },
      ],
      action: { type: "challenge" },
    });
    store.recordClientMessage(config, {
      type: "action",
      match_id: "session-1",
      data: { type: "challenge" },
    });
    store.recordServerMessage(config, gameOver());

    const sessions = store.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      session_id: "session-1",
      real_match_id: "real-match-1",
      status: "completed",
      game: "liars_dice",
      result_label: "1st place",
      decision_count: 1,
      final_action_count: 1,
      strategy_hashes: ["hash-1"],
    });

    const exported = store.exportSession("real-match-1");
    expect(exported?.inbound).toHaveLength(3);
    expect(exported?.outbound).toHaveLength(1);
    expect(exported?.decisions).toHaveLength(1);
    expect(exported?.strategySnapshot).toMatchObject({
      sections: {
        "hash-1": {
          content: "Prefer legal JSON.",
        },
      },
    });
  });

  it("tracks whole-match counters: roster size and seq-deduped event count", () => {
    const store = new LocalMatchSessionStore({
      runtimeHome: tempHome(),
      now: () => new Date("2026-05-18T01:02:03.000Z"),
    });
    const config = bridgeConfig();

    const start = gameStart();
    (start.data as { players: unknown[] }).players = [
      { position: 0, name: "You", player_id: "p0" },
      { position: 1, name: "Player 2", player_id: "p1" },
      { position: 2, name: "Player 3", player_id: "p2" },
    ];
    store.recordServerMessage(config, start);

    // First turn: three fresh events.
    const req1 = actionRequest();
    (req1.data as { new_events: unknown[] }).new_events = [
      { seq: 0, type: "bid" },
      { seq: 1, type: "bid" },
      { seq: 2, type: "bid" },
    ];
    store.recordServerMessage(config, req1);

    // Second turn overlaps the first delivery (seq 2 repeats) — counted once.
    const req2 = actionRequest();
    (req2.data as { new_events: unknown[] }).new_events = [
      { seq: 2, type: "bid" },
      { seq: 3, type: "challenge" },
      { type: "notice" }, // seq-less out-of-band event still counts
    ];
    store.recordServerMessage(config, req2);

    let listed = store.listSessions();
    expect(listed[0]).toMatchObject({ player_count: 3, event_count: 5, event_seq_max: 3 });

    // game_over's real roster is authoritative for the seat count.
    store.recordServerMessage(config, gameOver());
    listed = store.listSessions();
    expect(listed[0]).toMatchObject({ status: "completed", player_count: 2, event_count: 5 });
  });

  it("rebuilds the event count from a reconnect's full event_history", () => {
    const store = new LocalMatchSessionStore({
      runtimeHome: tempHome(),
      now: () => new Date("2026-05-18T01:02:03.000Z"),
    });
    const config = bridgeConfig();
    store.recordServerMessage(config, gameStart());

    const req1 = actionRequest();
    (req1.data as { new_events: unknown[] }).new_events = [{ seq: 0, type: "bid" }];
    store.recordServerMessage(config, req1);

    const reconnect = actionRequest();
    (reconnect.data as Record<string, unknown>).is_reconnect = true;
    (reconnect.data as Record<string, unknown>).event_history = [
      { seq: 0, type: "bid" },
      { seq: 1, type: "bid" },
      { seq: 2, type: "challenge" },
      { seq: 3, type: "round_result" },
    ];
    store.recordServerMessage(config, reconnect);

    expect(store.listSessions()[0]).toMatchObject({ event_count: 4, event_seq_max: 3 });
  });

  it("backfills legacy completed sessions from stored frames on first list", () => {
    const home = tempHome();
    const store = new LocalMatchSessionStore({
      runtimeHome: home,
      now: () => new Date("2026-05-18T01:02:03.000Z"),
    });
    const config = bridgeConfig();

    // Record a full session, then strip the new counters from session.json to
    // simulate a store written by an older runtime.
    store.recordServerMessage(config, gameStart());
    const req = actionRequest();
    (req.data as { new_events: unknown[] }).new_events = [
      { seq: 0, type: "bid" },
      { seq: 1, type: "challenge" },
    ];
    store.recordServerMessage(config, req);
    store.recordServerMessage(config, gameOver());

    const file = path.join(home, "agents", "agent-1", "sessions", "session-1", "session.json");
    const legacy = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    delete legacy.player_count;
    delete legacy.event_count;
    delete legacy.event_seq_max;
    fs.writeFileSync(file, JSON.stringify(legacy));

    const listed = store.listSessions();
    expect(listed[0]).toMatchObject({ player_count: 2, event_count: 2, event_seq_max: 1 });
    // The backfill persisted — the next read gets the counters without refolding.
    const healed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(healed.player_count).toBe(2);
    expect(healed.event_count).toBe(2);
  });
});
