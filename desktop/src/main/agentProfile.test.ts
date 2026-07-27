import { describe, expect, it } from "vitest";

import { normalizeAgentProfile } from "./agentProfile";

describe("normalizeAgentProfile", () => {
  it("reads name + stats from the summary block", () => {
    const out = normalizeAgentProfile({
      agent: { name: "agent-aaa" },
      summary: {
        total_games: 64,
        total_wins: 38,
        total_losses: 24,
        total_draws: 2,
        overall_win_rate: 0.594,
        aggregate_rating: 1574,
        global_rank: 2,
        leaderboard_eligible: true,
      },
    });
    expect(out.name).toBe("agent-aaa");
    expect(out.stats).toEqual({
      totalGames: 64,
      wins: 38,
      losses: 24,
      draws: 2,
      winRate: 0.594,
      rating: 1574,
      rank: 2,
      leaderboardEligible: true,
    });
  });

  it("falls back to the ranking block + derives win rate", () => {
    const out = normalizeAgentProfile({
      agent: { name: "beta" },
      ranking: { rank: 5, aggregate_rating: 1490, total_games: 20, total_wins: 9, total_losses: 10, total_draws: 1 },
    });
    expect(out.stats?.rating).toBe(1490);
    expect(out.stats?.rank).toBe(5);
    expect(out.stats?.winRate).toBeCloseTo(9 / 20);
    expect(out.stats?.leaderboardEligible).toBe(false);
  });

  it("returns null stats when neither summary nor ranking is present", () => {
    const out = normalizeAgentProfile({ agent: { name: "fresh" } });
    expect(out.name).toBe("fresh");
    expect(out.stats).toBeNull();
  });

  it("returns null name when unclaimed/blank, and null rating when unrated", () => {
    const out = normalizeAgentProfile({
      agent: { name: "" },
      summary: { total_games: 0, aggregate_rating: null, global_rank: null },
    });
    expect(out.name).toBeNull();
    expect(out.stats?.rating).toBeNull();
    expect(out.stats?.rank).toBeNull();
    expect(out.stats?.winRate).toBe(0);
  });

  it("tolerates malformed input", () => {
    expect(normalizeAgentProfile(null)).toEqual({ name: null, stats: null });
    expect(normalizeAgentProfile("nope")).toEqual({ name: null, stats: null });
  });

  // R12 (2026-07-26): JSON.parse("1e400") yields Infinity — a buggy/hostile
  // server on this remote boundary must not leak a non-finite win rate into the
  // UI ("Infinity%"). The finiteness guard makes it fall back like every sibling.
  it("rejects a non-finite overall_win_rate, falling back to wins/total", () => {
    const out = normalizeAgentProfile({
      agent: { name: "inf" },
      summary: { total_games: 10, total_wins: 4, overall_win_rate: Infinity },
    });
    expect(Number.isFinite(out.stats?.winRate)).toBe(true);
    expect(out.stats?.winRate).toBeCloseTo(4 / 10);
  });
});
