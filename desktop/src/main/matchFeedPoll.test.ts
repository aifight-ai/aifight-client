// LIVE_MATCH_FEED Phase 2 — the F1 REST event poll becomes the FALLBACK once
// the server pushes match_feed for the session:
//
//   - while a session's feed stays fresh (a pushed frame within
//     MATCH_FEED_FRESH_MS = 15s), each 2.5s poll tick skips its network call —
//     polling a feed-healthy session is pure waste;
//   - when the feed goes quiet (the server's match_feed_enabled kill switch
//     flips off, or an old server never pushes), the last frame ages out and
//     the next tick polls again — the fallback takes over within one window;
//   - a feed frame for ANOTHER session never suppresses this match's poll;
//   - the bookkeeping never eats the frame: match_feed is still forwarded to
//     the host's onServerMessage (→ renderer liveStore) untouched.
//
// The engine and the version check are mocked at their import specifiers (same
// pattern as bridgeStartGuards.test.ts); the runner is driven by hand through
// the onServerMessage callback its constructor captured.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeBridgeConfig, type BridgeConfig } from "@aifight/aifight/bridge/config";
import type { BridgeLogEvent, ServerMessage } from "../shared/ipc";

interface FakeRunner {
  onLog: (event: BridgeLogEvent) => void;
  onServerMessage: (message: ServerMessage) => void;
  started: boolean;
  stopped: boolean;
}
const runners: FakeRunner[] = [];

vi.mock("@aifight/aifight/bridge/runner", () => ({
  BridgeRunner: class {
    #self: FakeRunner;
    constructor(opts: {
      onLog: (event: BridgeLogEvent) => void;
      onServerMessage: (message: ServerMessage) => void;
    }) {
      this.#self = {
        onLog: opts.onLog,
        onServerMessage: opts.onServerMessage,
        started: false,
        stopped: false,
      };
      runners.push(this.#self);
    }
    async start(): Promise<void> {
      this.#self.started = true;
    }
    async stop(): Promise<void> {
      this.#self.stopped = true;
    }
    onConnectionStateChange(): () => void {
      return () => {};
    }
    joinQueue(): void {}
    leaveQueue(): void {}
    poke(): void {}
    suspendConnection(): void {}
    resumeConnection(): void {}
  },
}));

vi.mock("@aifight/aifight/bridge/update-check", () => ({
  checkBridgeUpdate: async () => ({ status: "current", currentVersion: "0.1.0-beta.34", message: "current" }),
}));

const { BridgeHost } = await import("./bridge-host");

const ORIGINAL_HOME = process.env.AIFIGHT_RUNTIME_HOME;
const tmpDirs: string[] = [];

function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-feedpoll-"));
  tmpDirs.push(dir);
  process.env.AIFIGHT_RUNTIME_HOME = dir;
  return dir;
}

function validConfig(): BridgeConfig {
  return {
    version: 1,
    baseUrl: "https://aifight.ai",
    wsUrl: "wss://aifight.ai/api/ws",
    agentId: "agent-feedpoll",
    agentName: "FeedPoll Agent",
    apiKey: "sk-not-a-real-key",
    runtimeType: "direct",
    runtimeLocalUrl: "direct://local",
    runtimeLocalToken: "token-not-real",
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
}

const SESSION = "11111111-1111-1111-1111-111111111111";

function gameStart(sessionId = SESSION): ServerMessage {
  return {
    type: "game_start",
    data: {
      match_id: sessionId,
      game: "texas_holdem",
      your_position: 0,
      your_player_id: "p0",
      players: [
        { position: 0, name: "Player 1", player_id: "p0" },
        { position: 1, name: "Player 2", player_id: "p1" },
      ],
    },
  } as unknown as ServerMessage;
}

function matchFeed(sessionId = SESSION, seq = 3): ServerMessage {
  return {
    type: "match_feed",
    data: {
      match_id: sessionId,
      events: [{ type: "player_action", player: "p1", data: { action: "call" }, seq, ts: "t" }],
    },
  } as unknown as ServerMessage;
}

/** A stub participant-feed endpoint; each page carries one fresh event. */
function stubPollFetch(): ReturnType<typeof vi.fn> {
  let seq = 100;
  const fetchMock = vi.fn().mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      events: [{ type: "player_action", player: "p1", data: { action: "check" }, seq: seq++, ts: "t" }],
    }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  runners.length = 0;
  freshHome();
  writeBridgeConfig(validConfig());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  if (ORIGINAL_HOME === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
  else process.env.AIFIGHT_RUNTIME_HOME = ORIGINAL_HOME;
});

describe("match_feed poll suppression (Phase 2)", () => {
  it("skips the poll's network tick while the session's feed stays fresh", async () => {
    const forwarded: ServerMessage[] = [];
    const host = new BridgeHost({ onServerMessage: (m) => forwarded.push(m) });
    await host.start();
    expect(runners).toHaveLength(1);
    const fetchMock = stubPollFetch();
    vi.useFakeTimers();

    runners[0].onServerMessage(gameStart());
    // The poller's FIRST tick fires immediately (delay 0) — the opening page.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The server's push arrives; several 2.5s heartbeats pass with NO network.
    runners[0].onServerMessage(matchFeed());
    await vi.advanceTimersByTimeAsync(2_500);
    await vi.advanceTimersByTimeAsync(2_500);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(fetchMock, "feed-healthy session must not be polled").toHaveBeenCalledTimes(1);
    // …and the push frame itself was forwarded to the renderer untouched.
    expect(forwarded.some((m) => m.type === "match_feed")).toBe(true);
    await host.stop();
  });

  it("resumes polling within one window once the feed goes quiet", async () => {
    const host = new BridgeHost();
    await host.start();
    const fetchMock = stubPollFetch();
    vi.useFakeTimers();

    runners[0].onServerMessage(gameStart());
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    runners[0].onServerMessage(matchFeed());

    // 12.5s of feed-fresh ticks: still no poll (window is 15s).
    await vi.advanceTimersByTimeAsync(12_500);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The last frame ages out of the window → the fallback takes over.
    await vi.advanceTimersByTimeAsync(5_000); // 17.5s since the feed frame
    expect(fetchMock.mock.calls.length, "quiet feed must hand back to polling").toBeGreaterThan(1);
    await host.stop();
  });

  it("a feed for ANOTHER session does not suppress this match's poll", async () => {
    const host = new BridgeHost();
    await host.start();
    const fetchMock = stubPollFetch();
    vi.useFakeTimers();

    runners[0].onServerMessage(gameStart());
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    runners[0].onServerMessage(matchFeed("99999999-9999-9999-9999-999999999999"));
    await vi.advanceTimersByTimeAsync(2_500);
    expect(fetchMock).toHaveBeenCalledTimes(2); // tick polled normally
    await host.stop();
  });

  it("a match that never gets a feed polls on the plain F1 cadence (old server)", async () => {
    const host = new BridgeHost();
    await host.start();
    const fetchMock = stubPollFetch();
    vi.useFakeTimers();

    runners[0].onServerMessage(gameStart());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_500);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(fetchMock).toHaveBeenCalledTimes(3); // t=0, 2.5, 5 — unchanged F1 behavior
    await host.stop();
  });
});
