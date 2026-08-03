import { describe, expect, it } from "vitest";

import { normalizeLeaderboard } from "./leaderboard";

describe("normalizeLeaderboard", () => {
  it("normalizes a per-game board (rating = display_rating, win_rate percent → fraction)", () => {
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
          deviation: 81.4,
          games_played: 10,
          wins: 7,
          losses: 2,
          draws: 1,
          // The server sends percentage points (Round(wins/games*1000)/10) —
          // the 2300%-win-rate bug was this exact unit passed through verbatim.
          win_rate: 70,
          recent_form: ["win", "loss", "win"],
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
      rd: 81.4,
      recentForm: ["win", "loss", "win"],
      isLandmark: false,
    });
  });

  it("normalizes a cross-game board (rating = aggregate_rating, win_rate derived, no rd)", () => {
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
    expect(rows[0].rd).toBeNull();
    expect(rows[0].recentForm).toBeNull();
  });

  it("gives landmark house rows no rank number and renumbers real agents (website rule)", () => {
    const json = {
      game: "liars_dice",
      leaderboard: [
        { rank: 1, agent_id: "u1", agent_name: "user-one", wins: 3, losses: 1, draws: 0 },
        { rank: 2, agent_id: "h1", agent_name: "house-bot", is_house: true, wins: 2, losses: 2, draws: 0 },
        { rank: 3, agent_id: "u2", agent_name: "user-two", wins: 1, losses: 3, draws: 0 },
      ],
    };
    const rows = normalizeLeaderboard("liars_dice", json);
    expect(rows.map((r) => r.rank)).toEqual([1, 0, 2]);
    expect(rows.map((r) => r.isLandmark)).toEqual([false, true, false]);
  });

  it("assigns index-order ranks and computes games when fields are missing", () => {
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
