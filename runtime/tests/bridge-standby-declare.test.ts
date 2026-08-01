// R2 platform orchestration — the bridge's standby declaration + fallback join
// (MATCH_FORMATION_V2_SPEC §5). These tests pin the NEW default path: a daily
// bridge no longer self-joins a game at the connect edge; it PATCHes its
// standby set and lets the platform's supply sweep assign a game, self-joining
// only after the fallback window passes with nothing to do. The legacy
// immediate-join behavior (standbyFallbackJoinMinutes: 0) stays pinned by
// bridge-runner.test.ts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BridgeRunner } from "../src/bridge/runner";
import { resetDeviceIdCacheForTests } from "../src/account/device-id";
import { resetMachineIdCacheForTests } from "../src/account/machine-id";
import { createMockRuntimeProvider } from "../src/bridge/provider";
import { writeBridgeConfig, type BridgeConfig } from "../src/bridge/config";
import type { MsgGameStart } from "../src/protocol/types";
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
    // The R2 default under test: declare first, self-join after 5 quiet
    // minutes. (No bridge.json exists in the temp home, so the runner's
    // disk-fresh reads fall back to exactly this snapshot.)
    standbyFallbackJoinMinutes: 5,
  };
}

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

/** A minimal ok Response for the stubbed global fetch (fetchNoFollow reads
 *  status/type before handing it back; the terms probe also calls json()). */
function okResponse(): unknown {
  return { ok: true, status: 200, type: "basic", json: async () => ({}) };
}

type FetchCall = { url: string; method: string; body: unknown };

/** Stub globalThis.fetch, recording every call. The runner's connect edge
 *  fires two fire-and-forget requests through it: the terms probe (GET
 *  /api/agents/me/status) and the standby declaration (PATCH
 *  /api/agents/me/policy). */
function stubFetch(
  calls: FetchCall[],
  opts: { failPolicyPatch?: boolean } = {},
): void {
  vi.stubGlobal("fetch", vi.fn(async (url: URL | string, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(url),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    if (opts.failPolicyPatch && call.method === "PATCH" && call.url.includes("/api/agents/me/policy")) {
      throw new Error("connect ECONNREFUSED");
    }
    return okResponse();
  }));
}

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aifight-standby-declare-"));
}

let suiteHome: string;
let prevSuiteHome: string | undefined;
let prevMachineId: string | undefined;

beforeEach(() => {
  suiteHome = tempHome();
  prevSuiteHome = process.env.AIFIGHT_HOME;
  prevMachineId = process.env.AIFIGHT_MACHINE_ID_OVERRIDE;
  process.env.AIFIGHT_HOME = suiteHome;
  process.env.AIFIGHT_MACHINE_ID_OVERRIDE = "11111111-2222-3333-4444-555555555555";
  resetDeviceIdCacheForTests();
  resetMachineIdCacheForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (prevSuiteHome === undefined) delete process.env.AIFIGHT_HOME;
  else process.env.AIFIGHT_HOME = prevSuiteHome;
  if (prevMachineId === undefined) delete process.env.AIFIGHT_MACHINE_ID_OVERRIDE;
  else process.env.AIFIGHT_MACHINE_ID_OVERRIDE = prevMachineId;
  resetDeviceIdCacheForTests();
  resetMachineIdCacheForTests();
  fs.rmSync(suiteHome, { recursive: true, force: true });
});

/** Flush microtasks and zero-delay timers under fake timers. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await Promise.resolve();
}

type Started = {
  runner: BridgeRunner;
  client: FakeReconnectClient;
  logs: Array<{ code: string; message: string }>;
};

async function startDailyRunner(): Promise<Started> {
  const client = new FakeReconnectClient();
  const connect = vi.fn(async (_opts: ReconnectingWSClientOptions) => client);
  const logs: Array<{ code: string; message: string }> = [];
  const runner = new BridgeRunner({
    clientKind: "cli",
    config: bridgeConfig(),
    runtimeProvider: createMockRuntimeProvider(),
    // Daily automatic matching (NOT one-shot) — the mode R2 orchestrates.
    autoJoinGame: "liars_dice",
    autoJoinMode: "ranked",
    connect,
    onLog: (event) => logs.push(event),
    sessionStore: false,
  });
  await runner.start();
  await flush();
  return { runner, client, logs };
}

function joinFrames(client: FakeReconnectClient): WSClientMessage[] {
  return client.sent.filter((m) => m.type === "join_queue");
}

function policyPatches(calls: FetchCall[]): FetchCall[] {
  return calls.filter((c) => c.method === "PATCH" && c.url.includes("/api/agents/me/policy"));
}

describe("bridge standby declaration (R2)", () => {
  it("declares the standby set at the connect edge instead of self-joining", async () => {
    const calls: FetchCall[] = [];
    stubFetch(calls);
    const { runner, client, logs } = await startDailyRunner();

    // The whole point of R2: no immediate join_queue frame.
    expect(joinFrames(client)).toHaveLength(0);
    const patches = policyPatches(calls);
    expect(patches).toHaveLength(1);
    // autoGames unset → the full enabled pool is declared.
    expect(patches[0]!.body).toEqual({
      standby_games: ["texas_holdem", "liars_dice", "coup"],
    });
    const declared = logs.find((e) => e.code === "bridge.standby_declared");
    expect(declared?.message).toContain("the platform assigns the game");
    expect(declared?.message).toContain("5min");

    await runner.stop();
  });

  it("self-joins after the fallback window when the platform assigned nothing", async () => {
    // Declaration REJECTED (old server / network down): the fallback must
    // still restore the legacy behavior end-to-end.
    const calls: FetchCall[] = [];
    stubFetch(calls, { failPolicyPatch: true });
    const { runner, client, logs } = await startDailyRunner();

    expect(logs.some((e) => e.code === "bridge.standby_declare_failed")).toBe(true);
    expect(joinFrames(client)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const joins = joinFrames(client);
    expect(joins).toHaveLength(1);
    expect(joins[0]).toEqual({
      type: "join_queue",
      data: { game: "liars_dice", mode: "ranked" },
    });
    const fallback = logs.find((e) => e.code === "bridge.standby_fallback_join");
    expect(fallback?.message).toContain("No platform assignment after 5min");

    // The timer re-arms: a still-idle bridge keeps rescuing itself instead of
    // going quiet after one attempt. (Queue belief only flips on the server's
    // echo, so the FSM still reads idle here — the re-join is idempotent.)
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(joinFrames(client).length).toBeGreaterThanOrEqual(2);

    await runner.stop();
  });

  it("skips the fallback while a match is running, then keeps watching", async () => {
    const calls: FetchCall[] = [];
    stubFetch(calls);
    const { runner, client } = await startDailyRunner();

    // The platform DID orchestrate: a match starts before the window closes.
    client.emitMessage(gameStart());
    await flush();

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(joinFrames(client)).toHaveLength(0);

    await runner.stop();
  });

  it("skips the fallback while matching is paused", async () => {
    const calls: FetchCall[] = [];
    stubFetch(calls);
    const { runner, client } = await startDailyRunner();

    // `aifight pause` writes bridge.json while the bridge runs; the fallback
    // reads it fresh. The on-disk shape must pass readBridgeConfig validation
    // (the in-memory fixture's wsUrl host deliberately would not).
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
      matchingPaused: true,
      standbyFallbackJoinMinutes: 5,
      updatedAt: "2026-07-31T00:00:00.000Z",
    });

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(joinFrames(client)).toHaveLength(0);

    await runner.stop();
  });

  it("stop() disarms the fallback timer", async () => {
    const calls: FetchCall[] = [];
    stubFetch(calls);
    const { runner, client } = await startDailyRunner();

    await runner.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(joinFrames(client)).toHaveLength(0);
  });
});
