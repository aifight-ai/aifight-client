// Render test for the Play-view achievement shelf. The badge data
// (raw.achievements) already ships in the profile the Play view fetches; this
// asserts the shelf renders earned badges (title + tier label + count) and a
// sensible empty state. SSR markup (no jsdom) mirrors cockpitRender.test.tsx;
// importing ./i18n initialises the global i18next instance that useTranslation()
// reads, so the rendered strings resolve instead of leaking raw keys.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import "./i18n";
import { AchievementShelf } from "./views/AgentProfileViz";
import type { AgentAchievement } from "@aifight/api-types";

function ach(over: Partial<AgentAchievement>): AgentAchievement {
  return {
    id: "a1",
    key: "first_victory",
    game: "texas_holdem",
    category: "performance_badge",
    tier: "common",
    title: "First Victory",
    description: "Won your first ranked match.",
    evidence: {},
    unlocked_at: "2026-01-01T00:00:00Z",
    shareable_label: "First Victory",
    ...over,
  };
}

describe("AchievementShelf", () => {
  it("renders earned badges with title, tier label and count", () => {
    const markup = renderToStaticMarkup(
      createElement(AchievementShelf, {
        achievements: [
          ach({}),
          ach({ id: "a2", tier: "legendary", title: "Giant Slayer", category: "poker_moment" }),
        ],
      }),
    );
    expect(markup).toContain("First Victory");
    expect(markup).toContain("Giant Slayer");
    expect(markup).toContain("Legendary");
    expect(markup).toContain("Common");
    expect(markup).toContain("2 unlocked");
  });

  it("caps the shelf at 8 featured badges", () => {
    const many = Array.from({ length: 12 }, (_, i) => ach({ id: `a${i}`, title: `Badge ${i}` }));
    const markup = renderToStaticMarkup(createElement(AchievementShelf, { achievements: many }));
    expect(markup).toContain("Badge 7");
    expect(markup).not.toContain("Badge 8");
    expect(markup).toContain("12 unlocked");
  });

  it("renders an empty state when there are no badges", () => {
    const markup = renderToStaticMarkup(createElement(AchievementShelf, { achievements: [] }));
    expect(markup).toContain("Keep playing ranked matches");
    expect(markup).not.toContain("unlocked");
  });
});
