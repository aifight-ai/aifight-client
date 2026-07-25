import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BridgeClientMismatchError,
  BridgeCredentialRejectedError,
  BridgeDeviceMismatchError,
  BridgeRunner,
} from "../src/bridge/runner";
import { resetDeviceIdCacheForTests, stampLocalDeviceIdentity } from "../src/account/device-id";
import { resetMachineIdCacheForTests } from "../src/account/machine-id";
import { createMockRuntimeProvider } from "../src/bridge/provider";
import { LocalMatchSessionStore } from "../src/session/local-match-session-store";
import { WSClientMismatchError, WSHandshakeError } from "../src/wsclient/errors";
import type { BridgeConfig } from "../src/bridge/config";
import type { MsgActionRequest, MsgGameOver, MsgGameStart } from "../src/protocol/types";
import type { ServerMessageEnvelope } from "../src/wsclient/frame-handler";
import type {
  ReconnectingWSClient,
  ReconnectStateSnapshot,
  ReconnectingWSClientOptions,
  ReconnectCloseHandler,
  ReconnectEventHandler,
} from "../src/wsclient/reconnect";
import type {
  WSClientMessage,
  WSMessageHandler,
  WSErrorHandler,
  WSWelcome,
} from "../src/wsclient/client";

const welcome: WSWelcome = {
  type: "welcome",
  data: {
    server_protocol_version: "v1.1.0",
    agent_id: "agent-1",
    agent_name: "Bridge Agent",
    server_time: "2026-05-06T00:00:00Z",
    games: ["texas_holdem", "liars_dice", "coup"],
  },
};

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
    updatedAt: "2026-05-06T00:00:00.000Z",
  };
}

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aifight-bridge-runner-"));
}

// start() reads the device secret and stamps the shared AIFight home with this
// machine's device id. Point the home at a temp dir for EVERY case in this file
// so that write lands there and never in the real one — a test suite must not
// leave files in the developer's own account.
let suiteHome: string;
let prevSuiteHome: string | undefined;
let prevMachineId: string | undefined;

beforeEach(() => {
  suiteHome = tempHome();
  prevSuiteHome = process.env.AIFIGHT_HOME;
  prevMachineId = process.env.AIFIGHT_MACHINE_ID_OVERRIDE;
  process.env.AIFIGHT_HOME = suiteHome;
  // Pin the machine so the identity check is deterministic instead of asking
  // whatever host the suite happens to run on.
  process.env.AIFIGHT_MACHINE_ID_OVERRIDE = "11111111-2222-3333-4444-555555555555";
  resetDeviceIdCacheForTests();
  resetMachineIdCacheForTests();
});

afterEach(() => {
  if (prevSuiteHome === undefined) delete process.env.AIFIGHT_HOME;
  else process.env.AIFIGHT_HOME = prevSuiteHome;
  if (prevMachineId === undefined) delete process.env.AIFIGHT_MACHINE_ID_OVERRIDE;
  else process.env.AIFIGHT_MACHINE_ID_OVERRIDE = prevMachineId;
  resetDeviceIdCacheForTests();
  resetMachineIdCacheForTests();
  fs.rmSync(suiteHome, { recursive: true, force: true });
});

function gameStart(matchId = "match-1"): MsgGameStart {
  return {
    type: "game_start",
    data: {
      match_id: matchId,
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

function actionRequest(matchId = "match-1"): MsgActionRequest {
  return {
    type: "action_request",
    data: {
      match_id: matchId,
      state: { total_dice: 10, current_bid: null },
      legal_actions: [
        { type: "bid", data: { min_quantity: 1, min_face: 1, max_quantity: 10 } },
        { type: "challenge" },
      ],
      players: [],
      timeout_ms: 300_000,
      new_events: [],
    },
  } as unknown as MsgActionRequest;
}

function gameOver(matchId = "match-1"): MsgGameOver {
  return {
    type: "game_over",
    data: {
      match_id: "real-match-1",
      session_id: matchId,
      result: {
        payoffs: { p0: 12, p1: 0 },
        winner: "p0",
        is_draw: false,
      },
      players: [
        {
          agent_id: "agent-1",
          agent_name: "alpha",
          player_id: "p0",
          position: 0,
        },
        {
          agent_id: "agent-2",
          agent_name: "beta",
          player_id: "p1",
          position: 1,
        },
      ],
      replay_url: "/replay/real-match-1",
    },
  };
}

async function flushEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

describe("BridgeRunner", () => {
  it("connects, joins a queue, and sends a mock runtime action", async () => {
    const client = new FakeReconnectClient();
    const connect = vi.fn(async (_opts: ReconnectingWSClientOptions) => client);
    const logs: Array<{ code: string; message: string }> = [];
    const runner = new BridgeRunner({
      clientKind: "cli",
      config: bridgeConfig(),
      runtimeProvider: createMockRuntimeProvider(),
      autoJoinGame: "liars_dice",
      autoJoinMode: "ranked",
      autoJoinOneShot: true,
      connect,
      onLog: (event) => logs.push(event),
      sessionStore: false,
    });

    await runner.start();
    client.emitMessage(gameStart());
    client.emitMessage(actionRequest());
    await flushEffects();
    client.emitMessage(gameOver());
    await flushEffects();

    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      url: "ws://127.0.0.1:1/api/ws",
      apiKey: "sk-local-agent-key",
      expectedProtocolVersion: "v1.2.0",
    }));
    expect(client.sent[0]).toEqual({
      type: "join_queue",
      data: { game: "liars_dice", mode: "ranked", one_shot: true },
    });
    // F09: decision provenance rides the action frame. The mock provider's
    // raw object doesn't match this fixture's legal_actions, so the §3
    // pipeline burns its one retry and lands on the deterministic fallback.
    expect(client.sent.at(-1)).toEqual({
      type: "action",
      match_id: "match-1",
      data: { type: "bid", data: { quantity: 1, face: 1 } },
      decision: {
        source: "fallback",
        illegal_retries: 1,
        fallback_reason: "illegal_runtime_action",
      },
    });
    const complete = logs.find((event) => event.code === "bridge.match_complete");
    expect(complete?.message).toContain("Match complete: Liar's Dice");
    expect(complete?.message).toContain("Result: 1st place");
    expect(complete?.message).toContain("Replay: https://aifight.ai/replay/real-match-1");
  });

  it("match-complete summary stays neutral even when autoDailyLimit is exactly 2", async () => {
    // Regression guard: the old copy treated cap === 2 as "user never customized"
    // and appended a "set daily 4 to compete more often" upsell after EVERY match —
    // false for anyone who deliberately chose 2, and (with the local cap stuck at
    // the setup default) shown even to desktop users who had raised the server cap.
    // The block is gone; the summary carries no cap nag.
    const client = new FakeReconnectClient();
    const connect = vi.fn(async (_opts: ReconnectingWSClientOptions) => client);
    const logs: Array<{ code: string; message: string }> = [];
    const runner = new BridgeRunner({
      clientKind: "cli",
      config: { ...bridgeConfig(), autoDailyLimit: 2 },
      runtimeProvider: createMockRuntimeProvider(),
      autoJoinGame: "liars_dice",
      autoJoinMode: "ranked",
      autoJoinOneShot: true,
      connect,
      onLog: (event) => logs.push(event),
      sessionStore: false,
    });

    await runner.start();
    client.emitMessage(gameStart());
    client.emitMessage(actionRequest());
    await flushEffects();
    client.emitMessage(gameOver());
    await flushEffects();

    const complete = logs.find((event) => event.code === "bridge.match_complete");
    expect(complete?.message).toContain("Match complete: Liar's Dice");
    expect(complete?.message).not.toContain("set daily");
    expect(complete?.message).not.toContain("per day");
  });

  it("forwards raw server messages to onServerMessage even without a session store", async () => {
    const client = new FakeReconnectClient();
    const forwarded: ServerMessageEnvelope[] = [];
    const runner = new BridgeRunner({
      clientKind: "cli",
      config: bridgeConfig(),
      runtimeProvider: createMockRuntimeProvider(),
      connect: vi.fn(async () => client),
      onServerMessage: (message) => forwarded.push(message),
      sessionStore: false,
    });

    await runner.start();
    client.emitMessage(gameStart());
    client.emitMessage(actionRequest());
    await flushEffects();

    expect(forwarded.map((m) => m.type)).toEqual(["game_start", "action_request"]);
  });

  it("requeues manual match batches one at a time after game_over", async () => {
    const client = new FakeReconnectClient();
    const runner = new BridgeRunner({
      clientKind: "cli",
      config: bridgeConfig(),
      runtimeProvider: createMockRuntimeProvider(),
      connect: vi.fn(async () => client),
      sessionStore: false,
    });

    await runner.start();
    runner.requestManualMatches("coup", "ranked", 2);
    client.emitMessage({
      ...gameStart("match-1"),
      data: { ...gameStart("match-1").data, game: "coup" },
    });
    client.emitMessage({
      ...gameOver("match-1"),
      data: { ...gameOver("match-1").data, session_id: "match-1" },
    });
    await flushEffects();

    const joins = client.sent.filter((msg) => msg.type === "join_queue");
    expect(joins).toEqual([
      { type: "join_queue", data: { game: "coup", mode: "ranked", one_shot: true } },
      { type: "join_queue", data: { game: "coup", mode: "ranked", one_shot: true } },
    ]);
  });

  it("answers server readiness_check with local runtime_status", async () => {
    const client = new FakeReconnectClient();
    const healthCheck = vi.fn(async () => true);
    const runner = new BridgeRunner({
      clientKind: "cli",
      config: bridgeConfig(),
      runtimeProvider: {
        name: "mock",
        decide: async (req) => req.legalActions[0]!,
        healthCheck,
      },
      connect: vi.fn(async () => client),
      sessionStore: false,
    });

    await runner.start();
    client.emitMessage({
      type: "readiness_check",
      data: {
        request_id: "ready-1",
        reason: "competition_finals",
        timeout_ms: 30_000,
      },
    });
    await flushEffects();

    // Phase 1B readiness is a pure online+idle self-check — it must NEVER call the
    // LLM health probe (doing so would spend the user's tokens on every readiness
    // check). An idle, connected bridge reports ready without probing.
    expect(healthCheck).not.toHaveBeenCalled();
    const status = client.sent.find((msg) => msg.type === "runtime_status");
    expect(status?.data).toMatchObject({
      request_id: "ready-1",
      ready: true,
      runtime_type: "mock",
      runtime_name: "mock",
      detail: "ready",
      // Phase 1B: idle bridge (no in-flight matches) reports capacity.
      active_matches: 0,
      max_concurrent: 8,
    });
  });

  it("writes local match session records when enabled", async () => {
    const client = new FakeReconnectClient();
    const store = new LocalMatchSessionStore({ runtimeHome: tempHome() });
    const runner = new BridgeRunner({
      clientKind: "cli",
      config: bridgeConfig(),
      runtimeProvider: createMockRuntimeProvider(),
      connect: vi.fn(async () => client),
      sessionStore: store,
    });

    await runner.start();
    client.emitMessage(gameStart());
    client.emitMessage(actionRequest());
    await flushEffects();
    client.emitMessage(gameOver());
    await flushEffects();

    const sessions = store.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      session_id: "match-1",
      real_match_id: "real-match-1",
      status: "completed",
      inbound_count: 3,
      outbound_count: 1,
      decision_count: 1,
    });
    const exported = store.exportSession("match-1");
    expect(exported?.decisions).toHaveLength(1);
  });

  // One agent, one client. The runner must declare WHICH client it is, and it must
  // turn the server's refusal into a terminal error with instructions — never into
  // another reconnect attempt, because retrying can never succeed.
  it("declares its client kind to the connection layer", async () => {
    const client = new FakeReconnectClient();
    const connect = vi.fn(async (_opts: ReconnectingWSClientOptions) => client);
    const runner = new BridgeRunner({
      clientKind: "desktop",
      config: bridgeConfig(),
      runtimeProvider: createMockRuntimeProvider(),
      connect,
      sessionStore: new LocalMatchSessionStore({ runtimeHome: tempHome() }),
    });

    await runner.start();
    expect(connect.mock.calls[0]?.[0]?.clientKind).toBe("desktop");
    await runner.stop();
  });

  it("turns a client_mismatch rejection into a terminal BridgeClientMismatchError", async () => {
    const rejection = new WSClientMismatchError(
      '{"error":"client_mismatch","reason":"client_mismatch","bound_client":"desktop"}',
      "desktop",
      "client mismatch",
    );
    const logs: Array<{ code: string; message: string }> = [];
    const runner = new BridgeRunner({
      clientKind: "cli",
      config: bridgeConfig(),
      runtimeProvider: createMockRuntimeProvider(),
      connect: vi.fn(async () => {
        throw rejection;
      }),
      sessionStore: new LocalMatchSessionStore({ runtimeHome: tempHome() }),
      onLog: (e) => logs.push({ code: e.code, message: e.message }),
    });

    await expect(runner.start()).rejects.toBeInstanceOf(BridgeClientMismatchError);

    const logged = logs.find((l) => l.code === "bridge.client_mismatch");
    expect(logged).toBeDefined();
    // The message has to name the incumbent and the way out; a bare "refused"
    // leaves the user with a dead client and nothing to do about it.
    expect(logged?.message).toContain("desktop app");
    expect(logged?.message).toContain("aifight connect");
  });

  it("recognises client_mismatch through a wrapped cause chain", async () => {
    // Across a bundle boundary `instanceof` can fail, so the 403 body is the
    // fallback signal — same reasoning as the device-mismatch path.
    const inner = { responseBody: '{"error":"client_mismatch","bound_client":"cli"}' };
    const wrapped = new Error("connect failed", { cause: new Error("upgrade failed", { cause: inner }) });
    let caught: unknown = null;
    const runner = new BridgeRunner({
      clientKind: "desktop",
      config: bridgeConfig(),
      runtimeProvider: createMockRuntimeProvider(),
      connect: vi.fn(async () => {
        throw wrapped;
      }),
      sessionStore: new LocalMatchSessionStore({ runtimeHome: tempHome() }),
    });

    await runner.start().catch((e: unknown) => {
      caught = e;
    });

    expect(caught).toBeInstanceOf(BridgeClientMismatchError);
    expect((caught as BridgeClientMismatchError).boundClient).toBe("cli");
    expect((caught as BridgeClientMismatchError).message).toContain("background service");
  });

  // A home directory copied from another computer is refused HERE, offline,
  // before a socket is opened. The server refuses it too, but only after a
  // connect that reads to the user like the network is broken.
  it("refuses a home copied from another machine without connecting", async () => {
    // Stamp as machine A (an install that lived there), then come back as B —
    // exactly what carrying the folder to a second laptop looks like.
    stampLocalDeviceIdentity();
    process.env.AIFIGHT_MACHINE_ID_OVERRIDE = "99999999-8888-7777-6666-555555555555";
    resetDeviceIdCacheForTests();
    resetMachineIdCacheForTests();

    const connect = vi.fn(async () => {
      throw new Error("must not reach the network");
    });
    const logs: Array<{ code: string; message: string }> = [];
    const runner = new BridgeRunner({
      clientKind: "cli",
      config: bridgeConfig(),
      runtimeProvider: createMockRuntimeProvider(),
      connect,
      sessionStore: false,
      onLog: (e) => logs.push({ code: e.code, message: e.message }),
    });

    await expect(runner.start()).rejects.toBeInstanceOf(BridgeDeviceMismatchError);

    expect(connect).not.toHaveBeenCalled();
    // The desktop keys its takeover card off this log code, so the card has to
    // appear for the local verdict as well as the server's.
    const logged = logs.find((l) => l.code === "bridge.device_mismatch");
    expect(logged?.message).toContain("set up on a different computer");
    expect(logged?.message).toContain("aifight connect");
  });

  // The state every machine an agent was moved AWAY from ends up in: the pairing
  // rotated the api key, so the config left behind holds a key that no longer
  // exists. On the FIRST connect of a new process that is a hard 401 — the
  // reconnect loop's self-healing key refresh only applies after a connection has
  // once succeeded. Left unclassified it escapes as a generic start failure, the
  // process exits, and the supervisor restarts it every few seconds forever.
  it("classifies a first-connect 401 as a terminal credential rejection", async () => {
    const logs: Array<{ code: string; message: string }> = [];
    const runner = new BridgeRunner({
      clientKind: "cli",
      config: bridgeConfig(),
      runtimeProvider: createMockRuntimeProvider(),
      connect: vi.fn(async () => {
        throw new Error("connect failed", {
          cause: new WSHandshakeError(401, "invalid api key", "handshake failed with 401"),
        });
      }),
      sessionStore: false,
      onLog: (e) => logs.push({ code: e.code, message: e.message }),
    });

    await expect(runner.start()).rejects.toBeInstanceOf(BridgeCredentialRejectedError);

    const logged = logs.find((l) => l.code === "bridge.credential_rejected");
    expect(logged?.message).toContain("no longer recognizes");
    // Name the likely cause and the way out, or the user is left with a dead
    // service and a status code.
    expect(logged?.message).toContain("moved to another computer");
    expect(logged?.message).toContain("--replace-local-identity");
  });

  it("classifies a 404 (agent gone) the same way", async () => {
    const runner = new BridgeRunner({
      clientKind: "cli",
      config: bridgeConfig(),
      runtimeProvider: createMockRuntimeProvider(),
      connect: vi.fn(async () => {
        throw new WSHandshakeError(404, "no such agent", "handshake failed with 404");
      }),
      sessionStore: false,
    });

    await expect(runner.start()).rejects.toBeInstanceOf(BridgeCredentialRejectedError);
  });

  // A transient failure must NOT be mistaken for a dead credential, or a service
  // would park itself in standby every time the network hiccups on startup.
  it("leaves a transient connect failure unclassified", async () => {
    const runner = new BridgeRunner({
      clientKind: "cli",
      config: bridgeConfig(),
      runtimeProvider: createMockRuntimeProvider(),
      connect: vi.fn(async () => {
        throw new WSHandshakeError(503, "upstream down", "handshake failed with 503");
      }),
      sessionStore: false,
    });

    const caught = await runner.start().catch((e: unknown) => e);
    expect(caught).not.toBeInstanceOf(BridgeCredentialRejectedError);
  });

  it("connects normally on the machine that set the home up", async () => {
    stampLocalDeviceIdentity();
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

    expect(connect).toHaveBeenCalled();
  });
});
