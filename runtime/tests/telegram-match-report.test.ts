// The rating line under a match report: profile + leaderboard reads diffed
// against a local per-match snapshot. Everything injected; no real network,
// no real clock, no filesystem.

import { describe, expect, it } from "vitest";

import type { NotifyEvent } from "../src/notify/events";
import { enrichMatchResult, type MatchSnapshot } from "../src/notify/telegram/match-report";
import { renderNotifyEvent } from "../src/notify/telegram/render";

type MatchResult = Extract<NotifyEvent, { kind: "match.result" }>;

const EVENT: MatchResult = {
  kind: "match.result",
  game: "texas_holdem",
  selfLabel: "1st place",
  won: true,
  draw: false,
  forfeitedSelf: false,
  opponents: ["GPTShark"],
  playerCount: 2,
  matchId: "m1",
};

function fetchStub(opts: {
  profile?: unknown;
  leaderboard?: unknown;
  failProfile?: boolean;
  failBoard?: boolean;
}): typeof fetch {
  return (async (url: string | URL) => {
    const text = String(url);
    if (text.includes("/profile")) {
      if (opts.failProfile === true) return new Response("nope", { status: 500 });
      return new Response(JSON.stringify(opts.profile ?? {}), { status: 200 });
    }
    if (text.includes("/leaderboard/")) {
      if (opts.failBoard === true) return new Response("nope", { status: 500 });
      return new Response(JSON.stringify(opts.leaderboard ?? {}), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}

function deps(overrides: Partial<Parameters<typeof enrichMatchResult>[1]> = {}) {
  const written: MatchSnapshot[] = [];
  return {
    written,
    deps: {
      baseUrl: "https://aifight.ai",
      agentId: "agent-1",
      delayMs: 0,
      readState: () => null,
      writeState: (s: MatchSnapshot) => {
        written.push(s);
      },
      ...overrides,
    },
  };
}

describe("enrichMatchResult", () => {
  it("adds rating, delta, rank and rank change against the previous snapshot", async () => {
    const d = deps({
      readState: () => ({
        ratings: { texas_holdem: { rating: 1498, rank: 25 }, coup: { rating: 1400, rank: 9 } },
      }),
      fetchImpl: fetchStub({
        profile: {
          ratings: [
            // display_rating is what every other surface shows; the raw rating
            // here is deliberately higher to prove which one is read.
            { game: "texas_holdem", rating: 1700, display_rating: 1512.4, games_played: 20 },
            { game: "coup", rating: 1500, display_rating: 1401, games_played: 8 },
          ],
        },
        leaderboard: {
          leaderboard: [
            { rank: 22, agent_id: "someone-else" },
            { rank: 23, agent_id: "agent-1" },
          ],
        },
      }),
    });

    const out = await enrichMatchResult(EVENT, d.deps);
    expect(out.rating).toEqual({
      game: "texas_holdem",
      rating: 1512.4,
      delta: 1512.4 - 1498,
      rank: 23,
      rankDelta: 2, // climbed from 25 to 23
    });

    // The snapshot advances: fresh ratings for every game, the played game's
    // fresh rank, and the OTHER game's remembered rank.
    expect(d.written).toHaveLength(1);
    expect(d.written[0]).toEqual({
      ratings: {
        texas_holdem: { rating: 1512.4, rank: 23 },
        coup: { rating: 1401, rank: 9 },
      },
    });
  });

  it("shows the rating without a delta on the first ever report", async () => {
    const d = deps({
      fetchImpl: fetchStub({
        profile: { ratings: [{ game: "texas_holdem", display_rating: 1500, games_played: 1 }] },
        leaderboard: { leaderboard: [] },
      }),
    });
    const out = await enrichMatchResult(EVENT, d.deps);
    expect(out.rating).toEqual({ game: "texas_holdem", rating: 1500 });
  });

  it("returns the event unchanged — and writes nothing — when the profile read fails", async () => {
    const d = deps({ fetchImpl: fetchStub({ failProfile: true }) });
    const out = await enrichMatchResult(EVENT, d.deps);
    expect(out).toBe(EVENT);
    expect(d.written).toHaveLength(0);
  });

  it("survives a failed leaderboard read: rating line without a rank", async () => {
    const d = deps({
      readState: () => ({ ratings: { texas_holdem: { rating: 1500, rank: 30 } } }),
      fetchImpl: fetchStub({
        profile: { ratings: [{ game: "texas_holdem", display_rating: 1510, games_played: 6 }] },
        failBoard: true,
      }),
    });
    const out = await enrichMatchResult(EVENT, d.deps);
    expect(out.rating).toEqual({ game: "texas_holdem", rating: 1510, delta: 10 });
    // The snapshot drops the stale rank rather than aging it forever.
    expect(d.written[0]!.ratings.texas_holdem).toEqual({ rating: 1510 });
  });

  it("does not touch an event whose game is unknown", async () => {
    const { game: _dropped, ...rest } = EVENT;
    const bare = rest as MatchResult;
    const d = deps({ fetchImpl: fetchStub({}) });
    expect(await enrichMatchResult(bare, d.deps)).toBe(bare);
  });
});

describe("the rendered rating line", () => {
  it("says rating, signed delta, rank and arrow in both languages", () => {
    const enriched: MatchResult = {
      ...EVENT,
      durationMs: 12 * 60_000,
      rating: { game: "texas_holdem", rating: 1512.4, delta: 14.4, rank: 23, rankDelta: 2 },
    };
    const en = renderNotifyEvent("en", enriched, { agentName: "PokerMind", baseUrl: "https://aifight.ai" });
    expect(en.text).toContain("📈 Texas Hold'em 1512 (+14) · #23 (↑2)");
    expect(en.text).toContain("12 min");

    const zh = renderNotifyEvent("zh", enriched, { agentName: "PokerMind" }).text;
    expect(zh).toContain("📈 德州扑克 1512 分（+14） · 第 23 名（↑2）");
  });

  it("drops the pieces it does not have instead of printing blanks", () => {
    const enriched: MatchResult = {
      ...EVENT,
      rating: { game: "texas_holdem", rating: 1500, delta: -9.6 },
    };
    const text = renderNotifyEvent("en", enriched, { agentName: "P" }).text;
    expect(text).toContain("📈 Texas Hold'em 1500 (−10)");
    expect(text).not.toContain("#");

    // No enrichment at all → no rating line at all.
    const plain = renderNotifyEvent("en", EVENT, { agentName: "P" }).text;
    expect(plain).not.toContain("📈");
  });

  it("puts the leaderboard button on the report only when the origin is known", () => {
    const withBase = renderNotifyEvent("en", EVENT, { agentName: "P", baseUrl: "https://aifight.ai" });
    expect(withBase.keyboard!.flat().some((b) => b.url === "https://aifight.ai/leaderboard")).toBe(true);

    const without = renderNotifyEvent("en", EVENT, { agentName: "P" });
    expect(without.keyboard!.flat().every((b) => b.url === undefined || !b.url.endsWith("/leaderboard"))).toBe(true);
  });
});
