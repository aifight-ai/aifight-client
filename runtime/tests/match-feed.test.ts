// match_feed consumption contract (design:
// docs/design/LIVE_MATCH_FEED_DESIGN_2026-07-30.md v2).
//
// The feed is a RENDER/LOG-ONLY stream. These tests pin the four hard rules:
//   1. The frame validates through the normal schema layer.
//   2. The agent forwards it to the host (onServerMessage) and the session log.
//   3. The FSM explicitly ignores it — zero state change, zero effects, no
//      unknown-type warning, and NO decision (LLM) may ever come out of it.
//   4. The FSM keeps no feed seq bookkeeping, so a later action_request whose
//      new_events overlap the feed's seqs is processed exactly as before.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentInstance, type AgentInstanceNotify } from "../src/agents/agent";
import {
  createInitialAgentFSM,
  transitionAgentFSM,
} from "../src/agents/state-machine";
import { BridgeRunner } from "../src/bridge/runner";
import { createMockRuntimeProvider } from "../src/bridge/provider";
import { resetDeviceIdCacheForTests } from "../src/account/device-id";
import { resetMachineIdCacheForTests } from "../src/account/machine-id";
import type { BridgeConfig } from "../src/bridge/config";
import type {
  MsgActionRequest,
  MsgGameOver,
  MsgGameStart,
  MsgMatchFeed,
} from "../src/protocol/types";
import { LocalMatchSessionStore } from "../src/session/local-match-session-store";
import { parseServerFrame } from "../src/wsclient/frame-handler";
import { WSSchemaError } from "../src/wsclient/errors";
import type { ServerMessageEnvelope } from "../src/wsclient/frame-handler";
import type {
  ReconnectingWSClient,
  ReconnectingWSClientOptions,
  ReconnectStateSnapshot,
  ReconnectCloseHandler,
  ReconnectEventHandler,
} from "../src/wsclient/reconnect";
import type {
  WSClientMessage,
  WSErrorHandler,
  WSMessageHandler,
  WSWelcome,
} from "../src/wsclient/client";
import { CLIENT_CAPABILITY_MATCH_FEED } from "../src/wsclient/capabilities";

const SESSION_A = "22222222-2222-4222-8222-222222222222";
const SESSION_B = "44444444-4444-4444-8444-444444444444";

const welcome: WSWelcome = {
  type: "welcome",
  data: {
    server_protocol_version: "v1.0.0",
    agent_id: "agent-1",
    agent_name: "Feed Agent",
    server_time: "2026-07-30T00:00:00Z",
    games: ["texas_holdem", "liars_dice", "coup"],
  },
};

function feedFrame(sessionId = SESSION_A, seqs: number[] = [5, 6]): MsgMatchFeed {
  return {
    type: "match_feed",
    data: {
      match_id: sessionId,
      events: seqs.map((seq) => ({
        type: "player_action",
        player: "p1",
        seq,
        ts: "2026-07-30T00:00:01Z",
        data: { action: "call" },
      })),
    },
  };
}

function gameStart(sessionId = SESSION_A): MsgGameStart {
  return {
    type: "game_start",
    data: {
      match_id: sessionId,
      game: "coup",
      mode: "ranked",
      your_position: 0,
      player_id: "p0",
      players: [],
      rules: {},
      config: {},
    },
  } as unknown as MsgGameStart;
}

function actionRequest(sessionId = SESSION_A, seqs: number[] = []): MsgActionRequest {
  return {
    type: "action_request",
    data: {
      match_id: sessionId,
      request_id: "req-1",
      state: {},
      legal_actions: [{ type: "income" }],
      players: [],
      timeout_ms: 300_000,
      new_events: seqs.map((seq) => ({
        type: "player_action",
        player: "p1",
        seq,
        data: { action: "call" },
      })),
    },
  } as unknown as MsgActionRequest;
}

// ─── 1. Schema validation ───────────────────────────────────────────

describe("match_feed schema validation", () => {
  it("accepts a well-formed match_feed frame", () => {
    const parsed = parseServerFrame(JSON.stringify(feedFrame()));
    expect(parsed.type).toBe("match_feed");
    const data = parsed.data as MsgMatchFeed["data"];
    expect(data.match_id).toBe(SESSION_A);
    expect(data.events).toHaveLength(2);
  });

  it("accepts an empty events array (a heartbeat-shaped feed is legal)", () => {
    const parsed = parseServerFrame(JSON.stringify(feedFrame(SESSION_A, [])));
    expect(parsed.type).toBe("match_feed");
  });

  it("rejects a frame missing data.match_id", () => {
    const bad = { type: "match_feed", data: { events: [] } };
    expect(() => parseServerFrame(JSON.stringify(bad))).toThrow(WSSchemaError);
  });

  it("rejects a frame missing data.events", () => {
    const bad = { type: "match_feed", data: { match_id: SESSION_A } };
    expect(() => parseServerFrame(JSON.stringify(bad))).toThrow(WSSchemaError);
  });

  it("rejects a non-uuid match_id", () => {
    const bad = { type: "match_feed", data: { match_id: "not-a-uuid", events: [] } };
    expect(() => parseServerFrame(JSON.stringify(bad))).toThrow(WSSchemaError);
  });

  it("rejects malformed events and unknown properties (additionalProperties: false)", () => {
    const badEvent = {
      type: "match_feed",
      data: { match_id: SESSION_A, events: [{ seq: 1 }] }, // event.type required
    };
    expect(() => parseServerFrame(JSON.stringify(badEvent))).toThrow(WSSchemaError);
    const extra = { ...feedFrame(), surprise: true };
    expect(() => parseServerFrame(JSON.stringify(extra))).toThrow(WSSchemaError);
  });
});

// ─── 2. FSM: explicit no-op ─────────────────────────────────────────

describe("agent FSM match_feed arm", () => {
  it("returns the SAME state object and zero effects", () => {
    const base = createInitialAgentFSM({ welcome });
    // Put the FSM inside a live match first — the feed must not disturb it.
    const started = transitionAgentFSM(base, {
      type: "ws.message",
      message: gameStart() as unknown as ServerMessageEnvelope,
      now: 42,
    });
    expect(started.state.activeMatch?.sessionId).toBe(SESSION_A);

    const next = transitionAgentFSM(started.state, {
      type: "ws.message",
      message: feedFrame() as unknown as ServerMessageEnvelope,
      now: 43,
    });

    // Reference equality: the state was not even rebuilt, and no effect (no
    // request_decision, no notify — not even an informational one) came out.
    expect(next.state).toBe(started.state);
    expect(next.effects).toEqual([]);
  });

  it("does not fall into the unknown-message warning branch", () => {
    const base = createInitialAgentFSM({ welcome });
    const next = transitionAgentFSM(base, {
      type: "ws.message",
      message: feedFrame() as unknown as ServerMessageEnvelope,
    });
    expect(next.effects).toEqual([]);
    // Contrast: a genuinely unknown type still warns.
    const unknown = transitionAgentFSM(base, {
      type: "ws.message",
      message: { type: "mystery_frame", data: {} },
    });
    expect(unknown.effects).toHaveLength(1);
    expect(unknown.effects[0]).toMatchObject({
      type: "notify",
      code: "fsm.unknown_server_message",
    });
  });
});

// ─── 3. Agent wiring: forward to host, never decide ─────────────────

class FakeReconnectClient implements ReconnectingWSClient {
  totalAttempts = 1;
  nextRetryAt: number | null = null;
  connectedAtMs: number | null = null;
  parkedReason: ReconnectStateSnapshot["parkedReason"] = null;
  onStateChange(handler: (snap: ReconnectStateSnapshot) => void): () => void {
    handler(this.snapshot());
    return () => {};
  }
  snapshot(): ReconnectStateSnapshot {
    return {
      state: this.state,
      attempt: this.attempt,
      totalAttempts: this.totalAttempts,
      nextRetryAt: this.nextRetryAt,
      connectedAt: this.connectedAtMs,
      welcome: this.welcome,
      parkedReason: this.parkedReason,
      authFailures: 0,
      seq: 0,
    };
  }
  poke(): void {}
  suspend(): void {}
  state: ReconnectingWSClient["state"] = "connected";
  attempt = 1;
  welcome: WSWelcome | null = welcome;
  readonly sent: WSClientMessage[] = [];
  readonly messageHandlers = new Set<WSMessageHandler>();
  send(msg: WSClientMessage): void {
    this.sent.push(msg);
  }
  onMessage(handler: WSMessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }
  onError(_handler: WSErrorHandler): () => void {
    return () => {};
  }
  onClose(_handler: ReconnectCloseHandler): () => void {
    return () => {};
  }
  onReconnect(_handler: ReconnectEventHandler): () => void {
    return () => {};
  }
  async close(): Promise<void> {
    this.state = "closed";
  }
  emitMessage(msg: ServerMessageEnvelope): void {
    for (const handler of [...this.messageHandlers]) handler(msg);
  }
}

async function flushEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function makeAgent() {
  const client = new FakeReconnectClient();
  const connect = vi.fn(async (_ws: ReconnectingWSClientOptions) => client);
  const onNotify = vi.fn<(event: AgentInstanceNotify) => void>();
  const onServerMessage = vi.fn<(message: ServerMessageEnvelope) => void>();
  const decisionProvider = { decide: vi.fn(async () => ({ type: "income" })) };
  const agent = new AgentInstance({
    name: "alpha",
    ws: {
      url: "ws://127.0.0.1:1/api/ws",
      apiKey: "sk-test",
      expectedProtocolVersion: "v1.0.0",
    },
    connect,
    decisionProvider,
    onNotify,
    onServerMessage,
    now: () => 42,
  });
  return { agent, client, onNotify, onServerMessage, decisionProvider };
}

describe("AgentInstance match_feed routing", () => {
  it("forwards to onServerMessage, changes no FSM state, and never calls the provider", async () => {
    const { agent, client, onNotify, onServerMessage, decisionProvider } = makeAgent();
    await agent.start();
    client.emitMessage(gameStart() as unknown as ServerMessageEnvelope);
    await flushEffects();
    const before = agent.snapshot().state;

    client.emitMessage(feedFrame() as unknown as ServerMessageEnvelope);
    await flushEffects();

    // (a) Host forwarding — the desktop live view depends on this.
    expect(onServerMessage).toHaveBeenCalledTimes(2); // game_start + match_feed
    expect(onServerMessage.mock.calls[1]![0]).toMatchObject({ type: "match_feed" });
    // (c) FSM untouched — same state object, phase still in_match, no queue/
    // activeMatch/pendingActions mutation possible (nothing was rebuilt).
    expect(agent.snapshot().state).toBe(before);
    expect(agent.snapshot().state?.phase).toBe("in_match");
    // Never a decision: no provider call, no outbound frame, no warning.
    expect(decisionProvider.decide).not.toHaveBeenCalled();
    expect(client.sent).toEqual([]);
    expect(
      onNotify.mock.calls.some(([e]) => e.code === "fsm.unknown_server_message"),
    ).toBe(false);
    expect(onNotify).not.toHaveBeenCalled();
  });

  it("keeps no feed seq bookkeeping: an action_request overlapping the feed's seqs still decides", async () => {
    const { agent, client, decisionProvider } = makeAgent();
    await agent.start();
    client.emitMessage(gameStart() as unknown as ServerMessageEnvelope);
    await flushEffects();

    // Feed delivers events seq 5-8; the next action_request's new_events
    // overlap (seq 5-9). Dedupe is the RENDER consumers' job (desktop
    // liveStore, session counters) — the FSM must not swallow or distort the
    // decision trigger over shared seqs.
    client.emitMessage(feedFrame(SESSION_A, [5, 6, 7, 8]) as unknown as ServerMessageEnvelope);
    await flushEffects();
    expect(decisionProvider.decide).not.toHaveBeenCalled();

    client.emitMessage(actionRequest(SESSION_A, [5, 6, 7, 8, 9]) as unknown as ServerMessageEnvelope);
    await flushEffects();

    expect(decisionProvider.decide).toHaveBeenCalledTimes(1);
    // The decision answered with an outbound action — the decision path ran
    // end-to-end, undisturbed by the earlier feed.
    expect(client.sent.filter((m) => m.type === "action")).toHaveLength(1);
    // And the FSM holds no seq state a test could even inspect: the only
    // per-match bookkeeping is the request id of the in-flight decision.
    const state = agent.snapshot().state;
    expect(state?.lastRequestIds?.[SESSION_A]).toBe("req-1");
    expect(state).not.toHaveProperty("lastEventSeq");
    expect(state).not.toHaveProperty("feedSeq");
  });
});

// ─── 4. BridgeRunner capability declaration ─────────────────────────

function bridgeConfig(): BridgeConfig {
  return {
    version: 1,
    baseUrl: "https://aifight.ai",
    wsUrl: "ws://127.0.0.1:1/api/ws",
    agentId: "agent-1",
    agentName: "alpha",
    apiKey: "sk-local-agent-key",
    runtimeType: "mock",
    runtimeLocalUrl: "mock://local",
    runtimeModel: "mock",
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
}

describe("BridgeRunner match_feed capability", () => {
  // start() checks the local device identity against the shared AIFight home —
  // point it at a temp dir, mirroring bridge-runner.test.ts.
  let suiteHome: string;
  let prevHome: string | undefined;
  let prevMachine: string | undefined;

  beforeEach(() => {
    suiteHome = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-match-feed-"));
    prevHome = process.env.AIFIGHT_HOME;
    prevMachine = process.env.AIFIGHT_MACHINE_ID_OVERRIDE;
    process.env.AIFIGHT_HOME = suiteHome;
    process.env.AIFIGHT_MACHINE_ID_OVERRIDE = "11111111-2222-3333-4444-555555555555";
    resetDeviceIdCacheForTests();
    resetMachineIdCacheForTests();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.AIFIGHT_HOME;
    else process.env.AIFIGHT_HOME = prevHome;
    if (prevMachine === undefined) delete process.env.AIFIGHT_MACHINE_ID_OVERRIDE;
    else process.env.AIFIGHT_MACHINE_ID_OVERRIDE = prevMachine;
    resetDeviceIdCacheForTests();
    resetMachineIdCacheForTests();
    fs.rmSync(suiteHome, { recursive: true, force: true });
  });

  it("declares the match_feed capability by default", async () => {
    const client = new FakeReconnectClient();
    const connect = vi.fn(async (_opts: ReconnectingWSClientOptions) => client);
    const runner = new BridgeRunner({
      clientKind: "cli",
      config: bridgeConfig(),
      runtimeProvider: createMockRuntimeProvider(),
      connect,
      sessionStore: false,
    });

    await runner.start();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0]![0].capabilities).toEqual([CLIENT_CAPABILITY_MATCH_FEED]);
    await runner.stop();
  });

  it("omits the capability when matchFeed is false (no header, old behaviour)", async () => {
    const client = new FakeReconnectClient();
    const connect = vi.fn(async (_opts: ReconnectingWSClientOptions) => client);
    const runner = new BridgeRunner({
      clientKind: "desktop",
      config: bridgeConfig(),
      runtimeProvider: createMockRuntimeProvider(),
      matchFeed: false,
      connect,
      sessionStore: false,
    });

    await runner.start();
    expect(connect.mock.calls[0]![0].capabilities).toBeUndefined();
    await runner.stop();
  });
});

// ─── 5. Session attribution under concurrent matches ────────────────

describe("match_feed session persistence", () => {
  it("attributes feed frames to their own match's inbound log", () => {
    const store = new LocalMatchSessionStore({
      runtimeHome: fs.mkdtempSync(path.join(os.tmpdir(), "aifight-feed-store-")),
      now: () => new Date("2026-07-30T01:02:03.000Z"),
    });
    const config = bridgeConfig();

    store.recordServerMessage(config, gameStart(SESSION_A) as unknown as ServerMessageEnvelope);
    store.recordServerMessage(config, gameStart(SESSION_B) as unknown as ServerMessageEnvelope);
    store.recordServerMessage(config, feedFrame(SESSION_B, [3]) as unknown as ServerMessageEnvelope);

    const sessionB = store.exportSession(SESSION_B);
    const feedRecords = (sessionB?.inbound ?? []).filter(
      (r) => (r as { type?: string }).type === "match_feed",
    );
    expect(feedRecords).toHaveLength(1);

    const sessionA = store.exportSession(SESSION_A);
    expect(
      (sessionA?.inbound ?? []).filter((r) => (r as { type?: string }).type === "match_feed"),
    ).toHaveLength(0);
  });

  it("a feed naming an unknown session is dropped, not minted into a session", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-feed-store-"));
    const store = new LocalMatchSessionStore({
      runtimeHome: home,
      now: () => new Date("2026-07-30T01:02:03.000Z"),
    });
    const config = bridgeConfig();

    store.recordServerMessage(config, feedFrame(SESSION_A, [5]) as unknown as ServerMessageEnvelope);

    // No summary, and no directory either — a stray feed must not leave a
    // garbage never-completing session behind.
    expect(store.listSessions()).toHaveLength(0);
    expect(fs.existsSync(path.join(home, "agents", "agent-1", "sessions", SESSION_A))).toBe(false);

    // Other message types keep the old behavior: an action_request for an
    // unknown session still mints one.
    store.recordServerMessage(config, actionRequest(SESSION_B) as unknown as ServerMessageEnvelope);
    expect(store.listSessions().map((s) => s.session_id)).toEqual([SESSION_B]);
  });

  it("a late feed on a completed session lands in inbound.jsonl without bumping updated_at", () => {
    let now = new Date("2026-07-30T01:02:03.000Z");
    const store = new LocalMatchSessionStore({
      runtimeHome: fs.mkdtempSync(path.join(os.tmpdir(), "aifight-feed-store-")),
      now: () => now,
    });
    const config = bridgeConfig();

    store.recordServerMessage(config, gameStart(SESSION_A) as unknown as ServerMessageEnvelope);

    // Feed on an ACTIVE session keeps the updated_at bump.
    now = new Date("2026-07-30T01:02:10.000Z");
    store.recordServerMessage(config, feedFrame(SESSION_A, [3]) as unknown as ServerMessageEnvelope);
    expect(store.getSession(SESSION_A)?.updated_at).toBe("2026-07-30T01:02:10.000Z");

    now = new Date("2026-07-30T01:02:20.000Z");
    store.recordServerMessage(config, gameOver(SESSION_A) as unknown as ServerMessageEnvelope);
    expect(store.getSession(SESSION_A)).toMatchObject({
      status: "completed",
      updated_at: "2026-07-30T01:02:20.000Z",
    });

    // The end-of-match tail still lands in the log, but listSessions ordering
    // (updated_at desc) must not be disturbed by it.
    now = new Date("2026-07-30T01:02:30.000Z");
    store.recordServerMessage(config, feedFrame(SESSION_A, [9]) as unknown as ServerMessageEnvelope);

    const summary = store.getSession(SESSION_A);
    expect(summary?.updated_at).toBe("2026-07-30T01:02:20.000Z");
    expect(summary?.inbound_count).toBe(4);
    const feeds = (store.exportSession(SESSION_A)?.inbound ?? []).filter(
      (r) => (r as { type?: string }).type === "match_feed",
    );
    expect(feeds).toHaveLength(2);
  });
});

function gameOver(sessionId = SESSION_A): MsgGameOver {
  return {
    type: "game_over",
    data: {
      match_id: "99999999-9999-4999-8999-999999999999",
      session_id: sessionId,
      result: { payoffs: { p0: 1, p1: 0 }, winner: "p0", is_draw: false },
      players: [
        { agent_id: "agent-1", agent_name: "alpha", player_id: "p0", position: 0 },
        { agent_id: "agent-2", agent_name: "beta", player_id: "p1", position: 1 },
      ],
    },
  } as unknown as MsgGameOver;
}
