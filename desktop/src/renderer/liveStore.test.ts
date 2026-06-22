import { beforeEach, describe, expect, it } from "vitest";

import { __resetLiveStoreForTest, ensureLiveStoreStarted, getLiveStoreState } from "./liveStore";
import type { AifightBridgeApi, BridgeDecisionTrace, ServerMessage } from "../shared/ipc";

function makeFakeApi() {
  let sm: ((m: ServerMessage) => void) | null = null;
  let tr: ((t: BridgeDecisionTrace) => void) | null = null;
  let subscribeCount = 0;
  const api = {
    onServerMessage: (cb: (m: ServerMessage) => void) => {
      sm = cb;
      subscribeCount += 1;
      return () => {};
    },
    onTrace: (cb: (t: BridgeDecisionTrace) => void) => {
      tr = cb;
      return () => {};
    },
  } as unknown as AifightBridgeApi;
  return {
    api,
    emitMsg: (m: ServerMessage) => sm?.(m),
    emitTrace: (t: BridgeDecisionTrace) => tr?.(t),
    get subscribeCount() {
      return subscribeCount;
    },
  };
}

const gameStart = (matchId: string): ServerMessage => ({
  type: "game_start",
  data: {
    match_id: matchId,
    game: "coup",
    your_position: 0,
    your_player_id: "p0",
    players: [
      { position: 0, name: "Player 1", player_id: "p0" },
      { position: 1, name: "Player 2", player_id: "p1" },
    ],
  },
});

const trace = (matchId: string): BridgeDecisionTrace => ({
  type: "decision_request",
  matchId,
  game: "coup",
  legalActionCount: 3,
  timeoutMs: 1000,
});

describe("liveStore", () => {
  beforeEach(() => __resetLiveStoreForTest());

  it("accumulates a live match over the persistent subscription", () => {
    const fake = makeFakeApi();
    ensureLiveStoreStarted(fake.api);
    expect(getLiveStoreState().match.sessionId).toBeNull();
    fake.emitMsg(gameStart("m1"));
    expect(getLiveStoreState().match.sessionId).toBe("m1");
    expect(getLiveStoreState().match.game).toBe("coup");
  });

  it("scopes traces to the current match (resets on a new game_start)", () => {
    const fake = makeFakeApi();
    ensureLiveStoreStarted(fake.api);
    fake.emitMsg(gameStart("m1"));
    fake.emitTrace(trace("m1"));
    fake.emitTrace(trace("m1"));
    expect(getLiveStoreState().traces).toHaveLength(2);
    fake.emitMsg(gameStart("m2"));
    expect(getLiveStoreState().match.sessionId).toBe("m2");
    expect(getLiveStoreState().traces).toHaveLength(0);
  });

  it("is idempotent — a repeated start does not double-subscribe", () => {
    const fake = makeFakeApi();
    ensureLiveStoreStarted(fake.api);
    ensureLiveStoreStarted(fake.api);
    expect(fake.subscribeCount).toBe(1);
  });

  it("no-ops when no bridge api is present (plain-browser QA)", () => {
    ensureLiveStoreStarted(undefined);
    expect(getLiveStoreState().match.sessionId).toBeNull();
  });
});
