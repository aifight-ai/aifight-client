// replayIntentSupersededByLive (owner report 2026-08-03): a recent-matches
// click on the match that is CURRENTLY live must fall through to the live
// cockpit instead of parking a frozen stored-frames replay.

import { describe, expect, it } from "vitest";

import { replayIntentSupersededByLive } from "./watchIntent";

describe("replayIntentSupersededByLive", () => {
  it("supersedes when the intent targets the live, unfinished session", () => {
    expect(
      replayIntentSupersededByLive("sess-1", { sessionId: "sess-1", finished: false }),
    ).toBe(true);
  });

  it("keeps the replay path for a finished session", () => {
    expect(
      replayIntentSupersededByLive("sess-1", { sessionId: "sess-1", finished: true }),
    ).toBe(false);
  });

  it("keeps the replay path for a different session", () => {
    expect(
      replayIntentSupersededByLive("sess-1", { sessionId: "sess-2", finished: false }),
    ).toBe(false);
  });

  it("keeps the replay path when nothing is live", () => {
    expect(replayIntentSupersededByLive("sess-1", { sessionId: null, finished: false })).toBe(
      false,
    );
  });
});
