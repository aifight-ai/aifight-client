// 连接审计 #3/#12 — queueTransitionOf is the single point deciding how a raw
// server frame moves the host's queued belief. These lock the three-way
// contract: join echo → info, leave/game_start → null (belief over), anything
// else (or malformed join) → undefined (no opinion).

import { describe, expect, it } from "vitest";

import { queueTransitionOf } from "./queueTruth";

describe("queueTransitionOf", () => {
  it("queue_joined with game+mode → that queue", () => {
    expect(queueTransitionOf({ type: "queue_joined", data: { game: "texas_holdem", mode: "friendly" } })).toEqual({
      game: "texas_holdem",
      mode: "friendly",
      oneShot: false,
    });
  });

  it("queue_joined without mode defaults to ranked", () => {
    expect(queueTransitionOf({ type: "queue_joined", data: { game: "coup" } })).toEqual({
      game: "coup",
      mode: "ranked",
      oneShot: false,
    });
  });

  it("one_shot echo survives; anything but literal true reads as false", () => {
    // The UI names a game ONLY for an explicit manual request (owner ruling
    // 2026-08-01) — a server-side enrollment echo (one_shot:false or absent,
    // hub.NotifyQueueJoined) must never masquerade as one.
    expect(queueTransitionOf({ type: "queue_joined", data: { game: "coup", mode: "ranked", one_shot: true } })).toEqual({
      game: "coup",
      mode: "ranked",
      oneShot: true,
    });
    expect(
      queueTransitionOf({ type: "queue_joined", data: { game: "coup", mode: "ranked", one_shot: "true" } })?.oneShot,
    ).toBe(false);
  });

  it("queue_left and game_start both end the belief (null)", () => {
    expect(queueTransitionOf({ type: "queue_left", data: {} })).toBeNull();
    expect(queueTransitionOf({ type: "game_start", data: { session_id: "m1" } })).toBeNull();
  });

  it("unrelated frames say nothing (undefined)", () => {
    expect(queueTransitionOf({ type: "action_request", data: {} })).toBeUndefined();
    expect(queueTransitionOf({ type: "pong" })).toBeUndefined();
  });

  it("malformed input says nothing: null, non-object, join without a game", () => {
    expect(queueTransitionOf(null)).toBeUndefined();
    expect(queueTransitionOf("queue_joined")).toBeUndefined();
    expect(queueTransitionOf({ type: "queue_joined" })).toBeUndefined();
    expect(queueTransitionOf({ type: "queue_joined", data: { game: "" } })).toBeUndefined();
    expect(queueTransitionOf({ type: "queue_joined", data: { game: 7 } })).toBeUndefined();
  });
});
