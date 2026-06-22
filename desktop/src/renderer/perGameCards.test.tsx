// Render test for the per-game cards' extra-detail line (peak / performance /
// best streak). The data ships in the profile the Play view already fetches;
// this asserts the secondary line renders when meaningful and is omitted when
// every extra metric is zero. SSR markup mirrors achievementShelf.test.tsx;
// importing ./i18n initialises i18next so labels resolve.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import "./i18n";
import { PerGameCards } from "./views/AgentProfileViz";
import type { AgentRating } from "@aifight/api-types";

function rating(over: Partial<AgentRating>): AgentRating {
  return {
    game: "texas_holdem",
    rating: 1200,
    display_rating: 1200,
    performance_rating: 0,
    deviation: 0,
    games_played: 10,
    wins: 5,
    losses: 4,
    draws: 1,
    win_rate: 0.5,
    avg_opponent_rating: 0,
    upset_wins: 0,
    unique_opponents: 0,
    best_streak: 0,
    current_streak: 0,
    peak_rating: 0,
    ...over,
  };
}

describe("PerGameCards", () => {
  it("surfaces peak / performance / best streak when present", () => {
    const markup = renderToStaticMarkup(
      createElement(PerGameCards, {
        ratings: [rating({ peak_rating: 1801, performance_rating: 1758, best_streak: 7 })],
      }),
    );
    expect(markup).toContain("Peak");
    expect(markup).toContain("1801");
    expect(markup).toContain("Perf");
    expect(markup).toContain("1758");
    expect(markup).toContain("Streak");
    // hover tooltips explain each metric
    expect(markup).toContain("Peak rating");
  });

  it("omits the detail line when every extra metric is zero", () => {
    const markup = renderToStaticMarkup(
      createElement(PerGameCards, {
        ratings: [rating({ peak_rating: 0, performance_rating: 0, best_streak: 0 })],
      }),
    );
    // base card still renders
    expect(markup).toContain("1200");
    expect(markup).toContain("5-4-1");
    // no secondary detail labels
    expect(markup).not.toContain("Peak");
    expect(markup).not.toContain("Streak");
  });

  it("renders the empty state when there are no rated games", () => {
    const markup = renderToStaticMarkup(createElement(PerGameCards, { ratings: [] }));
    expect(markup).toContain("No rated games yet");
  });
});
