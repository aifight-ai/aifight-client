// The post-game tail: the bridge's own stream ends at this player's last
// decision, so the closing stretch (opponents' final actions, showdown, result)
// must be completed from the finished match's PUBLIC replay — otherwise the
// board freezes mid-hand on "opponent thinking…" forever (owner report,
// 2026-07-28). These tests pin the merge (liveMatch.appendFinalEvents) and the
// store trigger (game_over → getReplayTail → fold), plus the step stamping the
// reasoning panel's anchors rely on.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { appendFinalEvents, emptyLiveMatch, reduceServerMessage, type LiveMatchState } from "./liveMatch";
import { __resetLiveStoreForTest, ensureLiveStoreStarted, getLiveStoreState } from "./liveStore";
import type { AifightBridgeApi, BridgeDecisionTrace, ReplayTailFrame, ServerMessage } from "../shared/ipc";

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
      { position: 2, name: "Player 3", player_id: "p2" },
    ],
  },
});

const actionRequest = (matchId: string, events: Array<{ seq: number; type: string }>): ServerMessage => ({
  type: "action_request",
  data: {
    match_id: matchId,
    state: {},
    new_events: events.map((e) => ({ type: e.type, seq: e.seq, ts: "2026-07-28T00:00:00.000Z", data: {} })),
    is_reconnect: false,
  },
});

const gameOver = (matchId: string, replayUrl?: string): ServerMessage => ({
  type: "game_over",
  data: {
    match_id: "real-id",
    session_id: matchId,
    result: { winner: "p1", is_draw: false },
    ...(replayUrl !== undefined ? { replay_url: replayUrl } : {}),
  },
});

function playedState(matchId: string): LiveMatchState {
  let s = emptyLiveMatch();
  s = reduceServerMessage(s, gameStart(matchId));
  s = reduceServerMessage(
    s,
    actionRequest(matchId, [
      { seq: 0, type: "action" },
      { seq: 1, type: "challenge_pass" },
    ]),
  );
  return s;
}

describe("appendFinalEvents", () => {
  it("appends only the genuinely-missing tail (seq beyond what the bridge saw)", () => {
    const s = playedState("m1");
    const frames: ReplayTailFrame[] = [
      { seq: 0, type: "action", data: {} }, // duplicate — must be skipped
      { seq: 1, type: "challenge_pass", data: {} }, // duplicate — must be skipped
      { seq: 2, type: "action", data: {}, player_id: "p1" },
      { seq: 3, type: "player_eliminated", data: {}, player_id: "p2" },
    ];
    const merged = appendFinalEvents(s, frames);
    expect(merged.events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(merged.maxSeq).toBe(3);
    // player mapping survives the merge
    expect(merged.events[3]!.player_id).toBe("p2");
  });

  it("accepts frames that carry the event name as `kind`", () => {
    const s = playedState("m1");
    const merged = appendFinalEvents(s, [{ seq: 2, kind: "showdown", data: {} }]);
    expect(merged.events[2]!.type).toBe("showdown");
  });

  it("returns the SAME state when nothing is new (no spurious re-render)", () => {
    const s = playedState("m1");
    expect(appendFinalEvents(s, [{ seq: 0, type: "action" }, { seq: 1, type: "x" }])).toBe(s);
    expect(appendFinalEvents(s, [])).toBe(s);
  });

  it("ignores malformed frames rather than throwing", () => {
    const s = playedState("m1");
    const merged = appendFinalEvents(s, [
      { seq: 2 }, // no type
      { type: "no_seq" }, // no seq
      { seq: 3, type: "real", data: {} },
    ]);
    expect(merged.events.map((e) => e.seq)).toEqual([0, 1, 3]);
  });
});

describe("liveStore final-tail trigger", () => {
  beforeEach(() => __resetLiveStoreForTest());

  function makeFakeApi(tail: readonly ReplayTailFrame[] | null) {
    let sm: ((m: ServerMessage) => void) | null = null;
    let tr: ((t: BridgeDecisionTrace) => void) | null = null;
    const calls: string[] = [];
    const api = {
      onServerMessage: (cb: (m: ServerMessage) => void) => {
        sm = cb;
        return () => {};
      },
      onTrace: (cb: (t: BridgeDecisionTrace) => void) => {
        tr = cb;
        return () => {};
      },
      getReplayTail: (path: string) => {
        calls.push(path);
        return Promise.resolve(tail);
      },
    } as unknown as AifightBridgeApi;
    return {
      api,
      emitMsg: (m: ServerMessage) => sm?.(m),
      emitTrace: (t: BridgeDecisionTrace) => tr?.(t),
      calls,
    };
  }

  it("fetches the public tail once on game_over and folds it into the board", async () => {
    const fake = makeFakeApi([
      { seq: 2, type: "action", data: {}, player_id: "p1" },
      { seq: 3, type: "game_result", data: {} },
    ]);
    ensureLiveStoreStarted(fake.api);
    fake.emitMsg(gameStart("m1"));
    fake.emitMsg(actionRequest("m1", [{ seq: 0, type: "action" }, { seq: 1, type: "challenge_pass" }]));
    fake.emitMsg(gameOver("m1", "/replay/replay_abc"));

    expect(fake.calls).toEqual(["/replay/replay_abc"]);
    await vi.waitFor(() => {
      expect(getLiveStoreState().match.events).toHaveLength(4);
    });
    expect(getLiveStoreState().match.finished).toBe(true);
    expect(getLiveStoreState().match.events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
  });

  it("does not fetch when game_over carries no replay path", () => {
    const fake = makeFakeApi([]);
    ensureLiveStoreStarted(fake.api);
    fake.emitMsg(gameStart("m1"));
    fake.emitMsg(gameOver("m1"));
    expect(fake.calls).toEqual([]);
  });

  it("discards a tail that resolves after a NEW match started (session isolation)", async () => {
    let resolveTail: (v: readonly ReplayTailFrame[] | null) => void = () => {};
    const pending = new Promise<readonly ReplayTailFrame[] | null>((r) => {
      resolveTail = r;
    });
    let sm: ((m: ServerMessage) => void) | null = null;
    const api = {
      onServerMessage: (cb: (m: ServerMessage) => void) => {
        sm = cb;
        return () => {};
      },
      onTrace: () => () => {},
      getReplayTail: () => pending,
    } as unknown as AifightBridgeApi;
    ensureLiveStoreStarted(api);
    sm!(gameStart("m1"));
    sm!(actionRequest("m1", [{ seq: 0, type: "action" }]));
    sm!(gameOver("m1", "/replay/replay_abc"));
    // A brand-new match begins before the tail arrives.
    sm!(gameStart("m2"));
    resolveTail([{ seq: 5, type: "stale_tail", data: {} }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(getLiveStoreState().match.sessionId).toBe("m2");
    expect(getLiveStoreState().match.events).toHaveLength(0);
  });

  it("stamps each trace with the board step it belongs to", () => {
    const fake = makeFakeApi(null);
    ensureLiveStoreStarted(fake.api);
    fake.emitMsg(gameStart("m1"));
    fake.emitTrace({ type: "decision_request", matchId: "m1", game: "coup", legalActionCount: 3, timeoutMs: 1000 });
    fake.emitMsg(actionRequest("m1", [{ seq: 0, type: "action" }, { seq: 1, type: "challenge_pass" }]));
    fake.emitTrace({ type: "decision_request", matchId: "m1", game: "coup", legalActionCount: 2, timeoutMs: 1000 });

    const traces = getLiveStoreState().traces;
    expect(traces[0]!.step).toBe(0); // before any event arrived
    expect(traces[1]!.step).toBe(2); // after the two-event batch folded
  });
});

describe("replayPathOf (History-opened replays reuse the same tail fetch)", () => {
  it("extracts the path from a full URL, keeps a bare path, rejects garbage", async () => {
    const { replayPathOf } = await import("./sessionReplay");
    expect(replayPathOf("https://aifight.ai/replay/replay_abc?step=3")).toBe("/replay/replay_abc");
    expect(replayPathOf("/replay/replay_abc")).toBe("/replay/replay_abc");
    expect(replayPathOf("")).toBeNull();
    expect(replayPathOf(undefined)).toBeNull();
    expect(replayPathOf("not a url")).toBeNull();
  });
});
