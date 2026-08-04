// Zombie "active" sessions (owner report 2026-07-28): a match cancelled
// server-side while the bridge wasn't listening never sends game_over, so the
// local session stays status="active" forever and the app shows 进行中 all
// night. staleSession.ts is the display-layer cutoff shared by the History
// list and the live Watch cockpit: platform rules cap a live match's silence
// at 10 minutes per turn, so 30 minutes without an update is proof of death.
// Pin the boundary and the fail-closed branches of both helpers.

import { describe, expect, it } from "vitest";

import { STALE_LIVE_SESSION_MS, isSilentPastCutoff, isStaleLiveSession } from "../shared/staleSession";

const NOW = Date.parse("2026-07-29T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe("isStaleLiveSession", () => {
  it("keeps a recently-updated live session live", () => {
    expect(isStaleLiveSession("active", iso(5 * 60 * 1000), NOW)).toBe(false);
  });

  it("flags a live session silent past the cutoff", () => {
    expect(isStaleLiveSession("active", iso(STALE_LIVE_SESSION_MS + 1000), NOW)).toBe(true);
  });

  it("stays live exactly at the cutoff (strictly-greater comparison)", () => {
    expect(isStaleLiveSession("active", iso(STALE_LIVE_SESSION_MS), NOW)).toBe(false);
  });

  it("never flags non-active sessions, however old", () => {
    expect(isStaleLiveSession("completed", iso(48 * 60 * 60 * 1000), NOW)).toBe(false);
    expect(isStaleLiveSession(undefined, iso(48 * 60 * 60 * 1000), NOW)).toBe(false);
  });

  it("treats a live session with a missing or unparsable timestamp as dead", () => {
    expect(isStaleLiveSession("active", undefined, NOW)).toBe(true);
    expect(isStaleLiveSession("active", "not-a-date", NOW)).toBe(true);
  });
});

describe("isSilentPastCutoff", () => {
  it("recent activity is not silence", () => {
    expect(isSilentPastCutoff(NOW - 60_000, NOW)).toBe(false);
  });

  it("silence past the cutoff trips", () => {
    expect(isSilentPastCutoff(NOW - STALE_LIVE_SESSION_MS - 1, NOW)).toBe(true);
  });

  it("no recorded activity never trips (a session that never spoke has nothing to go stale)", () => {
    expect(isSilentPastCutoff(null, NOW)).toBe(false);
  });
});
