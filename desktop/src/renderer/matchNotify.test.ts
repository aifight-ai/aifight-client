import { describe, expect, it } from "vitest";

import { detectMatchAlert } from "./matchNotify";
import { emptyLiveMatch, type LiveMatchState } from "./liveMatch";

const mk = (p: Partial<LiveMatchState>): LiveMatchState => ({ ...emptyLiveMatch(), ...p });

describe("detectMatchAlert", () => {
  it("flags a newly started match", () => {
    const alert = detectMatchAlert(emptyLiveMatch(), mk({ sessionId: "m1", game: "coup" }));
    expect(alert).toEqual({ kind: "start", matchId: "m1", game: "coup", outcome: "unknown" });
  });

  it("flags a finished match with its outcome", () => {
    const prev = mk({ sessionId: "m1", game: "coup" });
    const next = mk({ sessionId: "m1", game: "coup", finished: true, outcome: "win" });
    expect(detectMatchAlert(prev, next)).toEqual({ kind: "over", matchId: "m1", game: "coup", outcome: "win" });
  });

  it("does not re-flag an unchanged in-progress match", () => {
    const s = mk({ sessionId: "m1", game: "coup" });
    expect(detectMatchAlert(s, s)).toBeNull();
  });

  it("does not re-flag an already-finished match (no duplicate 'over')", () => {
    const fin = mk({ sessionId: "m1", finished: true, outcome: "loss" });
    expect(detectMatchAlert(fin, fin)).toBeNull();
  });

  it("flags a back-to-back match as a new start", () => {
    const finA = mk({ sessionId: "A", finished: true, outcome: "win" });
    const startB = mk({ sessionId: "B", game: "liars_dice" });
    expect(detectMatchAlert(finA, startB)).toEqual({
      kind: "start",
      matchId: "B",
      game: "liars_dice",
      outcome: "unknown",
    });
  });

  it("reports the ending frame as 'over', never as a fresh 'start'", () => {
    // A match id appearing for the first time AND already finished (degenerate,
    // but the over-branch must win) must still read as "over".
    const next = mk({ sessionId: "m1", game: "coup", finished: true, outcome: "draw" });
    expect(detectMatchAlert(emptyLiveMatch(), next)).toEqual({
      kind: "over",
      matchId: "m1",
      game: "coup",
      outcome: "draw",
    });
  });

  it("ignores the idle steady state", () => {
    expect(detectMatchAlert(emptyLiveMatch(), emptyLiveMatch())).toBeNull();
  });
});
