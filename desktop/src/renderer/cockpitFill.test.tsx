// Layout-mode boundary for CockpitPanel (owner report 2026-07-28): the History
// detail page stacks the self-review card BELOW the cockpit, and the old
// unconditional h-full pair made a taller-than-viewport board paint over that
// card (the Generate button floated on top of the Texas hand ledger). fill
// controls exactly two class strings — pin both modes so neither regresses.
// Same SSR technique as ReviewSection.test.tsx: static markup, ./i18n loaded.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import "./i18n";
import { CockpitPanel } from "./views/CockpitPanel";
import type { MatchDetail } from "@aifight/api-types";

const match: MatchDetail = {
  id: "m-fill-test",
  game: "coup",
  status: "finished",
  players: [
    { position: 0, name: "Player 1", player_id: "p0" },
    { position: 1, name: "Player 2", player_id: "p1" },
    { position: 2, name: "Player 3", player_id: "p2" },
  ],
} as unknown as MatchDetail;

function render(fill: boolean | undefined) {
  return renderToStaticMarkup(
    createElement(CockpitPanel, {
      game: "coup",
      match,
      events: [],
      ownerPlayerId: "p0",
      ownerPrivate: {},
      traces: [],
      isLive: false,
      badge: "replay",
      note: "note",
      headerLeft: null,
      ...(fill === undefined ? {} : { fill }),
    }),
  );
}

describe("CockpitPanel fill mode", () => {
  it("defaults to viewport-fill (h-full) for the Watch/Replay panes", () => {
    const markup = render(undefined);
    expect(markup).toContain("v3-cockpit flex h-full min-h-0 flex-col");
    expect(markup).toContain("min-h-[320px] xl:h-auto xl:w-[340px]");
  });

  it("fill=false renders natural document height (no h-full anywhere)", () => {
    const markup = render(false);
    expect(markup).toContain("v3-cockpit flex flex-col");
    expect(markup).not.toContain("h-full");
    // The stage row must not flex-grow either — that is what let the board
    // bleed over the review card when the column had a capped height.
    expect(markup).not.toContain("flex-1 flex-col gap-3 xl:flex-row");
  });

  it("fill=false bounds the trace panel so it scrolls internally", () => {
    // Document flow gives .v3-trace (height:100%) no height to inherit, so an
    // unbounded wrapper grew with every trace — the whole page scrolled instead
    // of the panel (owner report 2026-07-28). The wrapper must carry a hard
    // height; .v3-trace's own overflow does the scrolling inside it.
    const markup = render(false);
    expect(markup).toContain("h-[420px] xl:sticky xl:top-4 xl:h-[calc(100vh-8rem)]");
  });
});
