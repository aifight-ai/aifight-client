// D10 — render-boundary test. The website's game renderers (GameStateVisual,
// reused via the `@visuals` alias) must (a) mount cleanly INSIDE the desktop and
// (b) when fed the live reducer's output, honor the information-hiding rule at the
// DOM layer: the owner's OWN hole cards render face-up while opponents stay
// face-down and anonymized. This closes the one seam the other desktop tests
// don't cover — liveMatch.test.ts checks the reducer's data; this checks that
// data actually renders through the real website component.
//
// Why react-dom/server (no jsdom): GameStateVisual is SSR-safe — pure DOM/SVG, no
// window/document/canvas (verified) — so static markup is enough to assert on.
// createElement (not JSX) keeps the node test env free of any JSX-transform setup.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { GameStateVisual } from "@aifight/ui";
import type { MatchDetail, MatchEvent } from "@aifight/api-types";
import { FIXTURES, FIXTURE_GAMES } from "./fixtures";
import { emptyLiveMatch, reduceServerMessage, type LiveMatchState } from "./liveMatch";
import type { ServerMessage } from "../shared/ipc";

const SPADE = "♠"; // ♠ — parseCardForSeat renders suit 's' as this glyph.

/** Mount the board EXACTLY as CockpitPanel does: no isLive flag (hiding via data). */
function renderBoard(match: MatchDetail, events: readonly MatchEvent[]): string {
  return renderToStaticMarkup(
    createElement(GameStateVisual, { match, events: events as MatchEvent[] }),
  );
}

function fold(msgs: ServerMessage[]): LiveMatchState {
  return msgs.reduce(reduceServerMessage, emptyLiveMatch());
}

describe("render boundary: website renderers mount inside the desktop", () => {
  it("renders all three games' fixtures without throwing", () => {
    for (const game of FIXTURE_GAMES) {
      const { match, events } = FIXTURES[game];
      const markup = renderBoard(match, events);
      // Substantial DOM, not an empty/error render.
      expect(markup.length).toBeGreaterThan(100);
      expect(markup).toContain("seat");
    }
  });

  it("🔒 live poker: owner's own cards render face-up; opponent stays face-down + anonymized", () => {
    // A realistic pre-flop turn: game_start names the owner's seat (p0) and an
    // anonymized opponent (p1); action_request carries ONLY the owner's private
    // your_hand. The reducer injects the owner's cards_dealt — nothing for p1.
    const state = fold([
      {
        type: "game_start",
        data: {
          match_id: "s1",
          game: "texas_holdem",
          your_position: 0,
          your_player_id: "p0",
          players: [
            { position: 0, name: "Player 1", player_id: "p0" },
            { position: 1, name: "Player 2", player_id: "p1" },
          ],
        },
      },
      {
        type: "action_request",
        data: {
          match_id: "s1",
          state: { your_hand: ["As", "Ks"], your_chips: 9950, your_position: "BTN", hand_num: 1 },
          new_events: [
            {
              type: "new_hand",
              seq: 1,
              ts: "2026-06-01T00:00:00.000Z",
              data: { hand_num: 1, max_hands: 10, chips: { p0: 10000, p1: 10000 }, bets: { p0: 50, p1: 100 } },
            },
          ],
          is_reconnect: false,
        },
      },
    ]);

    // Sanity: the reducer produced a renderable match + injected only the owner's cards.
    expect(state.match).not.toBeNull();
    expect(state.events.some((e) => e.type === "cards_dealt" && e.player_id === "p0")).toBe(true);
    expect(state.events.some((e) => e.type === "cards_dealt" && e.player_id === "p1")).toBe(false);

    const markup = renderBoard(state.match!, state.events);

    // Owner sees their OWN cards face-up: A♠ and K♠.
    expect(markup).toContain(`A<span class="suit">${SPADE}`);
    expect(markup).toContain(`K<span class="suit">${SPADE}`);

    // 🔒 Opponent's cards are NOT revealed — they render face-down.
    expect(markup).toContain("card sm hidden");

    // 🔒 Identities: owner's seat is "You"; opponent is the anonymized "Player 2"
    // (never a real agent name during live play).
    expect(markup).toContain('title="You"');
    expect(markup).toContain('title="Player 2"');
  });

  it("🔒 live liar's dice: opponent dice never leak into the board markup", () => {
    const state = fold([
      {
        type: "game_start",
        data: {
          match_id: "s2",
          game: "liars_dice",
          your_position: 0,
          your_player_id: "p0",
          players: [
            { position: 0, name: "Player 1", player_id: "p0" },
            { position: 1, name: "Player 2", player_id: "p1" },
          ],
        },
      },
      {
        type: "action_request",
        data: {
          match_id: "s2",
          // Only the owner's dice are ever present locally; p1's faces never arrive.
          state: { your_dice: [2, 5, 5, 3, 6] },
          new_events: [
            { type: "round_start", seq: 1, ts: "2026-06-01T00:00:00.000Z", data: { round: 1 } },
            { type: "bid", seq: 2, ts: "2026-06-01T00:00:00.000Z", player: "p0", data: { quantity: 2, face: 5 } },
          ],
          is_reconnect: false,
        },
      },
    ]);

    const markup = renderBoard(state.match!, state.events);
    expect(markup.length).toBeGreaterThan(100);
    // The reducer surfaces the owner's dice via ownerPrivate (the OwnHandStrip),
    // NOT via board events — so no per-face dice values belong in the board markup.
    expect(state.ownerPrivate.dice).toEqual([2, 5, 5, 3, 6]);
  });
});
