import { describe, expect, it } from "vitest";

import { buildReviewContext } from "../src/review/build-review-context";
import type { LocalSessionExport } from "../src/session/local-match-session-store";

function exportFixture(overrides: Partial<LocalSessionExport> = {}): LocalSessionExport {
  return {
    summary: {
      version: 1,
      agent_id: "agent-1",
      agent_name: "alpha",
      session_id: "session-1",
      status: "completed",
      game: "texas_holdem",
      player_id: "p0",
      started_at: "2026-06-18T00:00:00.000Z",
      updated_at: "2026-06-18T00:10:00.000Z",
      inbound_count: 3,
      outbound_count: 2,
      decision_count: 2,
      final_action_count: 2,
      strategy_hashes: ["h-global", "h-game"],
      result_label: "1st place",
    },
    path: "/tmp/whatever/session-1",
    inbound: [
      {
        at: "2026-06-18T00:00:00.000Z",
        direction: "inbound",
        type: "game_start",
        message: {
          type: "game_start",
          data: {
            match_id: "session-1",
            game: "texas_holdem",
            your_player_id: "p0",
            players: [
              { name: "Me", player_id: "p0", position: 0 },
              { name: "Rival Bot", player_id: "p1", position: 1 },
            ],
          },
        },
      },
    ],
    outbound: [],
    decisions: [
      {
        action_request: { legal_actions: [{ type: "raise" }, { type: "fold" }], state: { pot: 100 } },
        final_action: { action: "raise", data: { amount: 50 }, summary: "value bet with top pair" },
        traces: [],
      },
      {
        action_request: { legal_actions: ["check", "bet"], state: { pot: 220 } },
        final_action: { action: "check" },
        traces: [{ type: "final_action", reason: "pot control" }],
      },
    ],
    strategySnapshot: {
      version: 1,
      sections: {
        h1: { scope: "global", content: "Global plan: be aggressive." },
        h2: { scope: "game", game: "texas_holdem", content: "Poker plan: 3-bet light in position." },
        h3: { scope: "game", game: "coup", content: "Coup plan (should be ignored)." },
      },
    },
    selfReview: null,
    ...overrides,
  };
}

describe("buildReviewContext", () => {
  it("compresses a finished match into the review context", () => {
    const ctx = buildReviewContext(exportFixture());
    expect(ctx.game).toBe("texas_holdem");
    expect(ctx.outcome).toBe("win");
    expect(ctx.resultLabel).toBe("1st place");
    expect(ctx.opponents).toEqual(["Rival Bot"]);
    expect(ctx.strategyGlobal).toContain("Global plan");
    expect(ctx.strategyGame).toContain("Poker plan");
    // The other game's strategy section must not leak in.
    expect(ctx.strategyGame).not.toContain("Coup plan");
    expect(ctx.strategyHashes).toEqual(["h-global", "h-game"]);
    expect(ctx.turns).toHaveLength(2);
    expect(ctx.turns[0]!.legal).toEqual(["raise", "fold"]);
    expect(ctx.turns[0]!.chose).toContain("raise");
    expect(ctx.turns[0]!.reasoning).toBe("value bet with top pair");
    // Reason falls back to the trace's final_action.reason when no summary.
    expect(ctx.turns[1]!.reasoning).toBe("pot control");
    expect(ctx.omittedTurns).toBe(0);
  });

  it("derives a loss outcome from a non-first placement", () => {
    const ctx = buildReviewContext(
      exportFixture({ summary: { ...exportFixture().summary, result_label: "3rd place" } }),
    );
    expect(ctx.outcome).toBe("loss");
  });

  it("samples long matches: keeps the opening + most recent turns and reports the omission", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      action_request: { legal_actions: ["check"], state: { turn: i } },
      final_action: { action: "check", summary: `turn ${i}` },
      traces: [],
    }));
    const ctx = buildReviewContext(exportFixture({ decisions: many }), { maxTurns: 10 });
    expect(ctx.turns).toHaveLength(10);
    expect(ctx.omittedTurns).toBe(40);
    // Opening preserved.
    expect(ctx.turns[0]!.reasoning).toBe("turn 0");
    // Tail preserved (last decision is turn 49).
    expect(ctx.turns.at(-1)!.reasoning).toBe("turn 49");
  });

  it("falls back to inbound game + empty opponents when summary is sparse", () => {
    const ctx = buildReviewContext(
      exportFixture({
        summary: { ...exportFixture().summary, game: undefined, result_label: undefined },
      }),
    );
    expect(ctx.game).toBe("texas_holdem"); // recovered from game_start
    expect(ctx.resultLabel).toBe("completed");
    expect(ctx.outcome).toBe("unknown");
  });
});
