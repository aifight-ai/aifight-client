import { describe, expect, it } from "vitest";

import { normalizeLeaderboard } from "./leaderboard";

describe("normalizeLeaderboard", () => {
  it("normalizes a per-game board (rating = display_rating, win_rate verbatim)", () => {
    const json = {
      game: "texas_holdem",
      leaderboard: [
        {
          rank: 1,
          agent_id: "a1",
          agent_name: "alpha",
          model: "claude",
          rating: 1500,
          display_rating: 1523,
          games_played: 10,
          wins: 7,
          losses: 2,
          draws: 1,
          win_rate: 0.7,
        },
      ],
    };
    const rows = normalizeLeaderboard("texas_holdem", json);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      rank: 1,
      agentId: "a1",
      agentName: "alpha",
      model: "claude",
      rating: 1523,
      games: 10,
      wins: 7,
      losses: 2,
      draws: 1,
      winRate: 0.7,
    });
  });

  it("normalizes a cross-game board (rating = aggregate_rating, win_rate derived)", () => {
    const json = {
      count: 1,
      leaderboard: [
        {
          rank: 2,
          agent_id: "b2",
          agent_name: "beta",
          model: null,
          aggregate_rating: 1487.6,
          total_games: 20,
          total_wins: 9,
          total_losses: 10,
          total_draws: 1,
        },
      ],
    };
    const rows = normalizeLeaderboard("all", json);
    expect(rows[0].rating).toBe(1488); // rounded
    expect(rows[0].games).toBe(20);
    expect(rows[0].wins).toBe(9);
    expect(rows[0].winRate).toBeCloseTo(9 / 20);
    expect(rows[0].model).toBeNull();
  });

  it("falls back to index rank and computes games when fields are missing", () => {
    const rows = normalizeLeaderboard("coup", {
      leaderboard: [{ agent_id: "c", agent_name: "c", wins: 1, losses: 1, draws: 0 }],
    });
    expect(rows[0].rank).toBe(1);
    expect(rows[0].games).toBe(2); // wins+losses+draws fallback
    expect(rows[0].rating).toBe(0);
  });

  it("returns [] for malformed payloads", () => {
    expect(normalizeLeaderboard("all", null)).toEqual([]);
    expect(normalizeLeaderboard("all", {})).toEqual([]);
    expect(normalizeLeaderboard("all", { leaderboard: "nope" })).toEqual([]);
  });
});
