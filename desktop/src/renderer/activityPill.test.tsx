// D2 (U8a, owner ruling 2026-08-03) — the hero pill gained a 待命 state: the
// bridge has DECLARED itself available and the platform picks the game. This
// pins the priority the CLI status box uses (a real queue entry beats standby)
// and both locales' wording, which must stay word-for-word aligned with the
// CLI's matching row. SSR markup mirrors perGameCards.test.tsx; importing
// ./i18n initialises i18next so labels resolve.

import { afterAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import i18n from "./i18n";
import { ActivityPill } from "./views/PlayView";

function pill(props: Parameters<typeof ActivityPill>[0]): string {
  return renderToStaticMarkup(createElement(ActivityPill, props));
}

afterAll(async () => {
  await i18n.changeLanguage("en");
});

describe("ActivityPill standby row", () => {
  it("en: a declared standby pool replaces the vague 'Online · ready'", async () => {
    await i18n.changeLanguage("en");
    const markup = pill({ activity: "matching", connecting: false, queued: null, standby: ["coup", "liars_dice"] });
    expect(markup).toContain("Standing by · platform assigns the game");
    expect(markup).not.toContain("Online · ready");
  });

  it("zh: same row, CLI wording", async () => {
    await i18n.changeLanguage("zh");
    const markup = pill({ activity: "matching", connecting: false, queued: null, standby: ["coup"] });
    expect(markup).toContain("待命 · 游戏由平台安排");
    expect(markup).not.toContain("在线 · 候战");
  });

  it("a real queue entry wins over standby (same priority as the CLI status box)", async () => {
    await i18n.changeLanguage("en");
    // Explicit manual request: names its game.
    const oneShot = pill({
      activity: "matching",
      connecting: false,
      queued: { game: "coup", oneShot: true },
      standby: ["coup"],
    });
    expect(oneShot).toContain("in queue");
    expect(oneShot).not.toContain("Standing by");

    // Server-side enrollment echo: game-agnostic, but still a real commitment,
    // so it must not be relabelled as merely standing by.
    const serverSide = pill({
      activity: "matching",
      connecting: false,
      queued: { game: "coup", oneShot: false },
      standby: ["coup"],
    });
    expect(serverSide).toContain("Online · ready");
    expect(serverSide).not.toContain("Standing by");
  });

  it("standby never overrides a state that says more: paused / resting / manual-only / in a match", async () => {
    await i18n.changeLanguage("en");
    const standby = ["coup"] as const;
    expect(pill({ activity: "paused", connecting: false, queued: null, standby })).toContain("Paused");
    expect(pill({ activity: "resting", connecting: false, queued: null, standby })).toContain("Resting");
    expect(pill({ activity: "idle", connecting: false, queued: null, standby })).toContain("manual only");
    expect(pill({ activity: "in_match", connecting: false, queued: null, standby })).toContain("In a match");
    expect(pill({ activity: "offline", connecting: false, queued: null, standby })).toContain("Offline");
    // Connecting outranks everything, standby included.
    expect(pill({ activity: "matching", connecting: true, queued: null, standby })).toContain("Connecting");
  });

  it("no declaration (older runtime, paused, cap 0) falls back to the plain activity", async () => {
    await i18n.changeLanguage("en");
    expect(pill({ activity: "matching", connecting: false, queued: null, standby: null })).toContain("Online · ready");
    expect(pill({ activity: "matching", connecting: false, queued: null, standby: [] })).toContain("Online · ready");
    expect(pill({ activity: "matching", connecting: false, queued: null })).toContain("Online · ready");
  });
});
