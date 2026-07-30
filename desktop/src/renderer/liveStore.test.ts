import { beforeEach, describe, expect, it } from "vitest";

import { __resetLiveStoreForTest, ensureLiveStoreStarted, getLiveStoreState } from "./liveStore";
import type { AifightBridgeApi, BridgeDecisionTrace, MatchEventsPayload, ServerMessage } from "../shared/ipc";

function makeFakeApi() {
  let sm: ((m: ServerMessage) => void) | null = null;
  let tr: ((t: BridgeDecisionTrace) => void) | null = null;
  let me: ((p: MatchEventsPayload) => void) | null = null;
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
    onMatchEvents: (cb: (p: MatchEventsPayload) => void) => {
      me = cb;
      return () => {};
    },
  } as unknown as AifightBridgeApi;
  return {
    api,
    emitMsg: (m: ServerMessage) => sm?.(m),
    emitTrace: (t: BridgeDecisionTrace) => tr?.(t),
    emitMatchEvents: (p: MatchEventsPayload) => me?.(p),
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

  it("F1: folds polled participant-feed pages into the match, deduped by seq", () => {
    const fake = makeFakeApi();
    ensureLiveStoreStarted(fake.api);
    fake.emitMsg(gameStart("m1"));
    fake.emitMatchEvents({
      sessionId: "m1",
      events: [
        { type: "game_setup", seq: 0, ts: "t0" },
        { type: "action", player: "p1", data: { action: "income" }, seq: 1, ts: "t1" },
      ],
    });
    expect(getLiveStoreState().match.events.map((e) => e.seq)).toEqual([0, 1]);
    // Same page again (full-history feed) → nothing new, state untouched.
    const before = getLiveStoreState().match;
    fake.emitMatchEvents({
      sessionId: "m1",
      events: [
        { type: "game_setup", seq: 0, ts: "t0" },
        { type: "action", player: "p1", data: { action: "income" }, seq: 1, ts: "t1" },
      ],
    });
    expect(getLiveStoreState().match).toBe(before);
    // A page for another session is dropped.
    fake.emitMatchEvents({ sessionId: "elsewhere", events: [{ type: "action", seq: 9 }] });
    expect(getLiveStoreState().match.events).toHaveLength(2);
  });

  it("F2: a final_action trace injects the synthetic own-action onto the board", () => {
    const fake = makeFakeApi();
    ensureLiveStoreStarted(fake.api);
    fake.emitMsg(gameStart("m1"));
    fake.emitTrace({
      type: "final_action",
      matchId: "m1",
      source: "runtime",
      action: { type: "income" },
    });
    const { match, traces } = getLiveStoreState();
    expect(traces).toHaveLength(1);
    expect(traces[0]!.at).toBeTypeOf("number"); // arrival stamp for the F4 elapsed counter
    expect(match.events).toHaveLength(1);
    expect(match.events[0]).toMatchObject({ type: "action", player_id: "p0", data: { action: "income" } });
    expect(match.pendingAction).not.toBeNull();
    expect(match.maxSeq).toBe(-1); // synthetic never advances the dedupe watermark
  });
});
