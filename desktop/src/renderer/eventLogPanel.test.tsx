// D11 event-log panel — SSR render tests (same technique as traceSync). Covers:
// replay cutoff at the transport step, the trace-embedding position rule
// (group at step S renders BEFORE the row at array index S), live showing the
// full arrived stream, the current-row highlight + click-to-jump wiring,
// per-player colors vs. the owner accent, and result-row emphasis.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { agentGradient } from "@aifight/ui";
import type { MatchEvent } from "@aifight/api-types";
import "./i18n";
import { EventLogPanel } from "./views/EventLogPanel";
import type { StampedTrace } from "./liveStore";

const players = [
  { agent_id: "a0", agent_name: "Claude Opus", player_id: "p0", position: 0 },
  { agent_id: "a1", agent_name: "GPT-5", player_id: "p1", position: 1 },
  { agent_id: "a2", agent_name: "Kimi K3", player_id: "p2", position: 2 },
];

function ev(seq: number, type: string, data: Record<string, unknown> = {}, player_id?: string): MatchEvent {
  return { seq, type, data, created_at: "", ...(player_id !== undefined ? { player_id } : {}) };
}

// A poker mini-match: blinds, a raise, a call, the flop, the hand + match result.
const events: MatchEvent[] = [
  ev(0, "new_hand", { hand_num: 1 }),
  ev(1, "player_action", { action: "small_blind", amount: 100 }, "p0"),
  ev(2, "player_action", { action: "big_blind", amount: 200 }, "p1"),
  ev(3, "player_action", { action: "raise", amount: 800 }, "p2"),
  ev(4, "player_action", { action: "call", amount: 700 }, "p0"),
  ev(5, "community_cards", { cards: ["Ah", "7d", "2c"] }),
  ev(6, "hand_result", { winners: ["p2"], pot: 1900, hand: 1, reason: "all_folded" }),
  ev(7, "match_result", { winner: "p2", winners: ["p2"], is_draw: false }),
];

// The owner's decision taken looking at events[0..2) (embeds before row index 2),
// plus a later decision at step 5 (used for cutoff assertions).
const traces: StampedTrace[] = [
  { type: "decision_request", matchId: "m1", game: "texas_holdem", legalActionCount: 3, timeoutMs: 1000, step: 2 },
  {
    type: "runtime_success",
    matchId: "m1",
    attempt: 1,
    raw: { kind: "text", sha256: "x", bytes: 12, preview: "early-thinking" },
    step: 2,
  },
  { type: "final_action", matchId: "m1", source: "runtime", action: { type: "raise", data: { amount: 800 } }, step: 2 },
  { type: "decision_request", matchId: "m1", game: "texas_holdem", legalActionCount: 2, timeoutMs: 1000, step: 5 },
  {
    type: "runtime_success",
    matchId: "m1",
    attempt: 2,
    raw: { kind: "text", sha256: "y", bytes: 11, preview: "late-thinking" },
    step: 5,
  },
] as unknown as StampedTrace[];

function render(opts: { isLive: boolean; transportStep: number; withTraces?: boolean }) {
  return renderToStaticMarkup(
    createElement(EventLogPanel, {
      game: "texas_holdem",
      events,
      traces: opts.withTraces === false ? [] : traces,
      players,
      ownerPlayerId: "p0",
      badge: opts.isLive ? "live" : "replay",
      isLive: opts.isLive,
      transportStep: opts.transportStep,
      following: true,
      onJumpToStep: () => {},
    }),
  );
}

describe("replay cutoff at the transport step", () => {
  it("rows past the step are hidden; traces past the step are hidden", () => {
    const markup = render({ isLive: false, transportStep: 3 });
    expect(markup).toContain("small blind 100"); // idx 1
    expect(markup).toContain("big blind 200"); // idx 2
    expect(markup).not.toContain("raise to 800"); // idx 3 — beyond the cutoff
    expect(markup).toContain("early-thinking"); // step 2 ≤ 3 — visible
    expect(markup).not.toContain("late-thinking"); // step 5 > 3 — hidden
  });

  it("a replay at the tip shows every row and every trace", () => {
    const markup = render({ isLive: false, transportStep: events.length });
    expect(markup).toContain("raise to 800");
    expect(markup).toContain("call 700");
    expect(markup).toContain("Match over — winner: Kimi K3");
    expect(markup).toContain("early-thinking");
    expect(markup).toContain("late-thinking");
  });
});

describe("trace embedding position (group at step S renders BEFORE row index S)", () => {
  it("the step-2 group lands after row #2 (idx 1) and before row #3 (idx 2)", () => {
    const markup = render({ isLive: false, transportStep: events.length });
    const smallBlind = markup.indexOf("small blind 100"); // row idx 1
    const thinking = markup.indexOf("early-thinking");
    const bigBlind = markup.indexOf("big blind 200"); // row idx 2
    expect(smallBlind).toBeGreaterThanOrEqual(0);
    expect(thinking).toBeGreaterThan(smallBlind);
    expect(bigBlind).toBeGreaterThan(thinking);
  });

  it("the step-5 group lands before row idx 5; an unstamped trace anchors after the last row", () => {
    const markup = render({ isLive: false, transportStep: events.length });
    const call = markup.indexOf("call 700"); // row idx 4
    const late = markup.indexOf("late-thinking");
    const board = markup.indexOf("Board: Ah 7d 2c"); // row idx 5
    expect(late).toBeGreaterThan(call);
    expect(board).toBeGreaterThan(late);
    // Unstamped (older stored sessions) → the tip, past even the final row.
    const withUnstamped = renderToStaticMarkup(
      createElement(EventLogPanel, {
        game: "texas_holdem",
        events,
        traces: [
          {
            type: "runtime_success",
            matchId: "m1",
            attempt: 1,
            raw: { kind: "text", sha256: "z", bytes: 9, preview: "tip-thinking" },
          } as unknown as StampedTrace,
        ],
        players,
        ownerPlayerId: "p0",
        badge: "replay",
        isLive: false,
        transportStep: events.length,
        following: true,
        onJumpToStep: () => {},
      }),
    );
    expect(withUnstamped.indexOf("tip-thinking")).toBeGreaterThan(
      withUnstamped.indexOf("Match over — winner: Kimi K3"),
    );
  });
});

describe("live mode", () => {
  it("shows ALL arrived rows and traces even when the transport lags (catch-up walk)", () => {
    const markup = render({ isLive: true, transportStep: 2 });
    expect(markup).toContain("Match over — winner: Kimi K3"); // full stream
    expect(markup).toContain("late-thinking"); // live never filters traces
  });
});

describe("current-row highlight + click-to-jump wiring", () => {
  it("the row at index step-1 carries v3-el-cur; every row's data-jump is idx+1", () => {
    const markup = render({ isLive: false, transportStep: 3 });
    expect(markup).toMatch(/class="v3-el-row v3-el-row--action v3-el-cur" data-idx="2" data-jump="3"/);
    // No other row is current.
    expect(markup.match(/v3-el-cur/g)).toHaveLength(1);
    expect(markup).toContain('data-idx="0" data-jump="1"');
  });

  it("rows are buttons (click → jump), titled with the seek hint", () => {
    const markup = render({ isLive: false, transportStep: events.length });
    expect(markup.match(/<button type="button" class="v3-el-row/g)?.length).toBe(8);
    expect(markup).toContain('title="Jump to this step"');
  });
});

describe("player names: per-player colors, owner accent", () => {
  it("opponent names carry their deterministic gradient color; the owner keeps the accent class", () => {
    const markup = render({ isLive: false, transportStep: events.length });
    expect(markup).toContain(`style="color:${agentGradient("p1")[1]}"`);
    expect(markup).toContain(`style="color:${agentGradient("p2")[1]}"`);
    // Owner (p0): no inline color — the v3-el-you class drives the accent.
    expect(markup).toMatch(/class="v3-el-name v3-el-you"(?![^>]*style)/);
    expect(markup).toContain(">You</span>");
  });
});

describe("result rows are emphasized; phases separated", () => {
  it("hand_result / match_result render as result rows", () => {
    const markup = render({ isLive: false, transportStep: events.length });
    expect(markup.match(/v3-el-row--result/g)?.length).toBe(2);
    expect(markup).toContain("Hand 1: Kimi K3 won the pot of 1,900 (all folded)");
    expect(markup).toContain("v3-el-row--phase");
  });
});

describe("demo path: fixtures + synthesized traces through CockpitPanel", () => {
  it("all three games render the full log with amounts and inline reasoning", async () => {
    const { FIXTURES, FIXTURE_GAMES } = await import("./fixtures");
    const { synthesizeTraces } = await import("./demoMatch");
    const { CockpitPanel } = await import("./views/CockpitPanel");
    for (const g of FIXTURE_GAMES) {
      const fix = FIXTURES[g];
      const markup = renderToStaticMarkup(
        createElement(CockpitPanel, {
          game: g,
          match: fix.match,
          events: fix.events,
          ownerPlayerId: fix.ownerPlayerId,
          ownerPrivate: fix.ownerPrivate,
          traces: synthesizeTraces(fix.match, fix.events, fix.ownerPlayerId),
          isLive: false,
          badge: "demo",
          note: "note",
          headerLeft: null,
        }),
      );
      // The panel header switched from own-agent reasoning to the event log.
      expect(markup).toContain("Event log");
      // Opponent rows render with their names — the log is no longer own-agent-only.
      expect(markup).toContain("GPT-5");
      // Every fixture carries a chip/dice amount somewhere in its action rows.
      expect(markup).toMatch(/call 100|bet 400|bid 2×5|income/);
      // The owner's synthesized reasoning is embedded inline.
      expect(markup).toContain("v3-el-trace");
      expect(markup).toContain("v3-tr-card");
    }
  });
});

describe("empty state", () => {
  it("no events + no traces → the empty hint", () => {
    const markup = renderToStaticMarkup(
      createElement(EventLogPanel, {
        game: "texas_holdem",
        events: [],
        traces: [],
        players,
        ownerPlayerId: "p0",
        badge: "live",
        isLive: true,
        transportStep: 0,
        following: true,
        onJumpToStep: () => {},
        emptyHint: "Waiting for your agent's first decision…",
      }),
    );
    expect(markup).toContain("Waiting for your agent"); // SSR escapes the apostrophe (&#x27;)
  });
});
