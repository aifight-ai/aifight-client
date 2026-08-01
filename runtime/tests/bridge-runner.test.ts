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
import { serializeClientMessage } from "../src/wsclient/frame-handler";
import { writeBridgeConfig, type BridgeConfig } from "../src/bridge/config";
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
  readonly stateHandlers = new Set<(snap: ReconnectStateSnapshot) => void>();
  onStateChange(handler: (snap: ReconnectStateSnapshot) => void): () => void {
    // Mirror the real facade: track the handler, fire the standing snapshot
    // immediately, return a real unsubscribe.
    this.stateHandlers.add(handler);
    handler(this.snapshot());
    return () => {
      this.stateHandlers.delete(handler);
    };
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
    // These tests pin the LEGACY self-join behavior; 0 opts out of the R2
    // standby declaration + fallback (its own tests live in
    // bridge-standby-declare.test.ts).
    standbyFallbackJoinMinutes: 0,
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

  // 连接审计 #2 (2026-07-28): the server drops the agent from every queue when
  // its socket dies, so a recovered connection that never re-joins sits
  // "online" but plays nothing until the process restarts (the CLI half of the
  // desktop F9 fix, now in the shared runner).
  it("re-joins the auto queue on every reconnect", async () => {
    const client = new FakeReconnectClient();
    const connect = vi.fn(async (_opts: ReconnectingWSClientOptions) => client);
    const logs: Array<{ code: string; message: string }> = [];
    const runner = new BridgeRunner({
      clientKind: "cli",
      config: bridgeConfig(),
      runtimeProvider: createMockRuntimeProvider(),
      autoJoinGame: "liars_dice",
      autoJoinMode: "ranked",
      connect,
      onLog: (event) => logs.push(event),
      sessionStore: false,
    });
    await runner.start();
    const joins = () => client.sent.filter((m) => m.type === "join_queue").length;
    await flushEffects();
    expect(joins()).toBe(1); // launch join

    // Drop and recover the link; the fake mirrors the real facade by firing
    // every subscribed handler with the fresh snapshot.
    const fire = () => {
      for (const h of [...client.stateHandlers]) h(client.snapshot());
    };
    client.state = "backoff";
    fire();
    client.state = "connected";
    fire();
    await flushEffects();

    expect(joins()).toBe(2);
    expect(logs.some((e) => e.code === "bridge.queue_rejoined")).toBe(true);

    await runner.stop();
  });

  it("one-shot auto-join never re-joins on reconnect (manual matches must not multiply)", async () => {
    const client = new FakeReconnectClient();
    const connect = vi.fn(async (_opts: ReconnectingWSClientOptions) => client);
    const runner = new BridgeRunner({
      clientKind: "cli",
      config: bridgeConfig(),
      runtimeProvider: createMockRuntimeProvider(),
      autoJoinGame: "liars_dice",
      autoJoinMode: "ranked",
      autoJoinOneShot: true,
      connect,
      onLog: () => {},
      sessionStore: false,
    });
    await runner.start();
    await flushEffects();
    const joins = () => client.sent.filter((m) => m.type === "join_queue").length;
    expect(joins()).toBe(1);

    const fire = () => {
      for (const h of [...client.stateHandlers]) h(client.snapshot());
    };
    client.state = "backoff";
    fire();
    client.state = "connected";
    fire();
    await flushEffects();

    expect(joins()).toBe(1);

    await runner.stop();
  });

  // `aifight pause` writes matchingPaused into bridge.json while the bridge is
  // running. The runner reads the flag FRESH at every connect edge — a
  // snapshot frozen at start() would keep re-joining on every reconnect and
  // silently undo the pause until the next restart.
  function writePausedDiskConfig(paused: boolean): void {
    // The on-disk shape must pass readBridgeConfig's validation (the test's
    // in-memory bridgeConfig() deliberately would not: its wsUrl host does
    // not match its baseUrl). Only the flag matters to the runner.
    writeBridgeConfig({
      version: 1,
      baseUrl: "https://aifight.ai",
      wsUrl: "wss://aifight.ai/api/ws",
      agentId: "agent-1",
      agentName: "alpha",
      apiKey: "sk-local-agent-key",
      runtimeType: "mock",
      runtimeLocalUrl: "mock://local",
      runtimeModel: "mock",
      ...(paused ? { matchingPaused: true } : {}),
      updatedAt: "2026-07-30T00:00:00.000Z",
    });
  }

  it("skips the connect-edge auto-join when matching is paused on disk", async () => {
    writePausedDiskConfig(true);
    const client = new FakeReconnectClient();
    const connect = vi.fn(async (_opts: ReconnectingWSClientOptions) => client);
    const logs: Array<{ code: string; message: string }> = [];
    const runner = new BridgeRunner({
      clientKind: "cli",
      // No flag in the startup snapshot — the disk value must still win.
      config: bridgeConfig(),
      runtimeProvider: createMockRuntimeProvider(),
      autoJoinGame: "liars_dice",
      autoJoinMode: "ranked",
      connect,
      onLog: (event) => logs.push(event),
      sessionStore: false,
    });

    await runner.start();
    await flushEffects();

    expect(client.sent.filter((m) => m.type === "join_queue")).toHaveLength(0);
    expect(logs.some((e) => e.code === "bridge.auto_join_paused")).toBe(true);

    await runner.stop();
  });

  it("stops re-joining on reconnect once paused mid-run, and resumes when the flag clears", async () => {
    const client = new FakeReconnectClient();
    const connect = vi.fn(async (_opts: ReconnectingWSClientOptions) => client);
    const logs: Array<{ code: string; message: string }> = [];
    const runner = new BridgeRunner({
      clientKind: "cli",
      config: bridgeConfig(),
      runtimeProvider: createMockRuntimeProvider(),
      autoJoinGame: "liars_dice",
      autoJoinMode: "ranked",
      connect,
      onLog: (event) => logs.push(event),
      sessionStore: false,
    });
    await runner.start();
    const joins = () => client.sent.filter((m) => m.type === "join_queue").length;
    await flushEffects();
    expect(joins()).toBe(1); // launch join — nothing paused yet

    const fire = () => {
      for (const h of [...client.stateHandlers]) h(client.snapshot());
    };
    const reconnect = async () => {
      client.state = "backoff";
      fire();
      client.state = "connected";
      fire();
      await flushEffects();
    };

    // Pause lands on disk mid-run (what `aifight pause` does): the next
    // reconnect edge must NOT re-join, though the runner started unpaused.
    writePausedDiskConfig(true);
    await reconnect();
    expect(joins()).toBe(1);
    expect(logs.some((e) => e.code === "bridge.auto_join_paused")).toBe(true);
    expect(logs.some((e) => e.code === "bridge.queue_rejoined")).toBe(false);

    // `aifight resume` clears the flag: the following edge re-joins again,
    // still without any restart.
    writePausedDiskConfig(false);
    await reconnect();
    expect(joins()).toBe(2);
    expect(logs.some((e) => e.code === "bridge.queue_rejoined")).toBe(true);

    await runner.stop();
  });

  // V3 重启精确化: autoDailyLimit / autoGames got the same connect-edge re-read
  // as the pause flag — a running bridge adopts `aifight set daily` / `set
  // game` within ~a reconnect cycle, no manual restart.
  function writeDiskAutoConfig(fields: { cap?: number; games?: string[] }): void {
    // Same discipline as writePausedDiskConfig: a disk shape that passes
    // readBridgeConfig validation (the in-memory fixture's wsUrl would not).
    writeBridgeConfig({
      version: 1,
      baseUrl: "https://aifight.ai",
      wsUrl: "wss://aifight.ai/api/ws",
      agentId: "agent-1",
      agentName: "alpha",
      apiKey: "sk-local-agent-key",
      runtimeType: "mock",
      runtimeLocalUrl: "mock://local",
      runtimeModel: "mock",
      ...(fields.cap !== undefined ? { autoDailyLimit: fields.cap } : {}),
      ...(fields.games !== undefined ? { autoGames: fields.games } : {}),
      updatedAt: "2026-07-31T00:00:00.000Z",
    });
  }

  it("a daily cap of 0 landing mid-run stops the re-join at the next reconnect", async () => {
    const client = new FakeReconnectClient();
    const connect = vi.fn(async (_opts: ReconnectingWSClientOptions) => client);
    const logs: Array<{ code: string; message: string }> = [];
    const runner = new BridgeRunner({
      clientKind: "cli",
      config: bridgeConfig(),
      runtimeProvider: createMockRuntimeProvider(),
      autoJoinGame: "liars_dice",
      autoJoinMode: "ranked",
      connect,
      onLog: (event) => logs.push(event),
      sessionStore: false,
    });
    await runner.start();
    const joins = () => client.sent.filter((m) => m.type === "join_queue").length;
    await flushEffects();
    expect(joins()).toBe(1); // launch join — cap was still on

    const fire = () => {
      for (const h of [...client.stateHandlers]) h(client.snapshot());
    };
    // `aifight set daily 0` lands on disk mid-run.
    writeDiskAutoConfig({ cap: 0 });
    client.state = "backoff";
    fire();
    client.state = "connected";
    fire();
    await flushEffects();

    expect(joins()).toBe(1); // no re-join under the new cap
    expect(logs.some((e) => e.code === "bridge.auto_join_cap_off")).toBe(true);
    expect(logs.some((e) => e.code === "bridge.queue_rejoined")).toBe(false);

    await runner.stop();
  });

  it("a new games list landing mid-run is picked from at the next reconnect", async () => {
    const client = new FakeReconnectClient();
    const connect = vi.fn(async (_opts: ReconnectingWSClientOptions) => client);
    const runner = new BridgeRunner({
      clientKind: "cli",
      config: bridgeConfig(),
      runtimeProvider: createMockRuntimeProvider(),
      autoJoinGame: "liars_dice",
      autoJoinMode: "ranked",
      connect,
      onLog: () => {},
      sessionStore: false,
    });
    await runner.start();
    await flushEffects();

    const fire = () => {
      for (const h of [...client.stateHandlers]) h(client.snapshot());
    };
    // `aifight set game coup` lands on disk mid-run — a single-game list makes
    // the random pick deterministic.
    writeDiskAutoConfig({ cap: 2, games: ["coup"] });
    client.state = "backoff";
    fire();
    client.state = "connected";
    fire();
    await flushEffects();

    const rejoins = client.sent.filter((m) => m.type === "join_queue");
    expect(rejoins).toHaveLength(2);
    expect(rejoins[1]).toEqual({
      type: "join_queue",
      data: { game: "coup", mode: "ranked" },
    });

    await runner.stop();
  });

  it("a cap raised from 0 mid-run starts the auto-join on a manual-only bridge", async () => {
    const client = new FakeReconnectClient();
    const connect = vi.fn(async (_opts: ReconnectingWSClientOptions) => client);
    const logs: Array<{ code: string; message: string }> = [];
    const runner = new BridgeRunner({
      clientKind: "cli",
      config: bridgeConfig(),
      runtimeProvider: createMockRuntimeProvider(),
      // No autoJoinGame — launched manual-only (cap 0 at startup).
      connect,
      onLog: (event) => logs.push(event),
      sessionStore: false,
    });
    await runner.start();
    const joins = () => client.sent.filter((m) => m.type === "join_queue").length;
    await flushEffects();
    expect(joins()).toBe(0); // manual-only launch: nothing to join

    const fire = () => {
      for (const h of [...client.stateHandlers]) h(client.snapshot());
    };
    // `aifight set daily 3` (+ games) lands on disk mid-run.
    writeDiskAutoConfig({ cap: 3, games: ["texas_holdem"] });
    client.state = "backoff";
    fire();
    client.state = "connected";
    fire();
    await flushEffects();

    expect(joins()).toBe(1);
    expect(client.sent.filter((m) => m.type === "join_queue")[0]).toEqual({
      type: "join_queue",
      data: { game: "texas_holdem", mode: "ranked" },
    });
    expect(logs.some((e) => e.code === "bridge.queue_rejoined")).toBe(true);

    await runner.stop();
  });

  it("a cap of 0 already on disk at start skips the launch join", async () => {
    writeDiskAutoConfig({ cap: 0 });
    const client = new FakeReconnectClient();
    const connect = vi.fn(async (_opts: ReconnectingWSClientOptions) => client);
    const logs: Array<{ code: string; message: string }> = [];
    const runner = new BridgeRunner({
      clientKind: "cli",
      config: bridgeConfig(),
      runtimeProvider: createMockRuntimeProvider(),
      autoJoinGame: "liars_dice",
      autoJoinMode: "ranked",
      connect,
      onLog: (event) => logs.push(event),
      sessionStore: false,
    });

    await runner.start();
    await flushEffects();

    expect(client.sent.filter((m) => m.type === "join_queue")).toHaveLength(0);
    expect(logs.some((e) => e.code === "bridge.auto_join_cap_off")).toBe(true);

    await runner.stop();
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
      detail: "ready (0/8 matches in flight)",
    });
    // The schema is closed (additionalProperties:false) — capacity info rides
    // inside `detail`, never as extra top-level keys (2026-07-30: such keys made
    // serializeClientMessage reject every readiness reply).
    expect(Object.keys(status!.data as Record<string, unknown>).sort()).toEqual(
      ["checked_at", "detail", "ready", "request_id", "runtime_name", "runtime_type"].sort(),
    );
    // And the payload must survive the REAL outbound validation path, not just
    // the fake client (which captures frames before serialization).
    expect(() =>
      serializeClientMessage({ type: "runtime_status", data: status!.data }),
    ).not.toThrow();
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

  it("a generic fatal start error resets the runner so a retry can dial again (R14 audit pin)", async () => {
    const client = new FakeReconnectClient();
    let attempts = 0;
    const connect = vi.fn(async (_opts: ReconnectingWSClientOptions) => {
      attempts += 1;
      if (attempts === 1) {
        throw new WSHandshakeError(503, "upstream down", "handshake failed with 503");
      }
      return client;
    });
    const runner = new BridgeRunner({
      clientKind: "cli",
      config: bridgeConfig(),
      runtimeProvider: createMockRuntimeProvider(),
      connect,
      sessionStore: false,
    });

    await expect(runner.start()).rejects.toThrow();
    // Pre-R13 the failed start left a dead agent behind, so this returned its
    // success-shaped snapshot without dialing; the reset arm must dial again.
    await runner.start();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("buffers connection-state subscribers registered before start() and attaches them on connect (R15)", async () => {
    const client = new FakeReconnectClient();
    const runner = new BridgeRunner({
      clientKind: "cli",
      config: bridgeConfig(),
      runtimeProvider: createMockRuntimeProvider(),
      connect: vi.fn(async () => client),
      sessionStore: false,
    });

    const snaps: ReconnectStateSnapshot[] = [];
    const unsubscribe = runner.onConnectionStateChange((snap) => snaps.push(snap));
    expect(snaps).toHaveLength(0);

    await runner.start();
    // Attached on start: the facade's immediate snapshot fire reaches the early
    // subscriber. Pre-R15 the subscription was silently dropped (no-op
    // unsubscribe, no snapshots ever).
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.state).toBe("connected");

    // And the returned unsubscribe is the real one, not a no-op. One handler
    // stays behind: the runner's own auto-join reconnect subscriber, attached
    // since V3 so a daily cap set mid-run is adopted at the next connect edge.
    unsubscribe();
    expect(client.stateHandlers.size).toBe(1);
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
