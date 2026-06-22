// Unit tests for the Play-view ranked-progress hint: the pure state logic plus
// an i18n resolution check. Claim is the only ranked gate now (owner ruling
// 2026-06-18) — the retired "needName" state is gone.

import { describe, expect, it } from "vitest";

import i18next from "i18next";
import "./i18n";
import { computeRankedHint } from "./rankedHint";

const HREF = "https://aifight.ai/dashboard";

describe("computeRankedHint", () => {
  it("unclaimed agent → needs claim (identity_status irrelevant)", () => {
    expect(computeRankedHint({ is_claimed: false }, null, HREF)).toEqual({ kind: "needClaim", href: HREF });
    expect(computeRankedHint({ identity_status: "bootstrap", is_claimed: false }, null, HREF)).toEqual({
      kind: "needClaim",
      href: HREF,
    });
    // is_claimed missing defaults to the claim path (safer: never imply ranked-ready).
    expect(computeRankedHint({ identity_status: "bootstrap" }, null, HREF)).toEqual({ kind: "needClaim", href: HREF });
  });

  it("claimed-but-never-renamed agent → NO name nag (the retired trap is gone)", () => {
    expect(computeRankedHint({ identity_status: "bootstrap", is_claimed: true }, null, HREF)).toBeNull();
  });

  it("claimed but short of the per-game minimum → games needed", () => {
    expect(
      computeRankedHint({ is_claimed: true }, { leaderboard_eligible: false, leaderboard_games_needed: 3 }, HREF),
    ).toEqual({ kind: "gamesNeeded", count: 3 });
  });

  it("claimed + eligible → no hint (rank KPI already shows position)", () => {
    expect(
      computeRankedHint({ is_claimed: true }, { leaderboard_eligible: true, leaderboard_games_needed: 0 }, HREF),
    ).toBeNull();
  });

  it("claimed + zero games needed → no hint", () => {
    expect(
      computeRankedHint({ is_claimed: true }, { leaderboard_eligible: false, leaderboard_games_needed: 0 }, HREF),
    ).toBeNull();
  });

  it("loading (agent undefined/null) → no hint, never flashes a warning", () => {
    expect(computeRankedHint(undefined, undefined, HREF)).toBeNull();
    expect(computeRankedHint(null, null, HREF)).toBeNull();
    // claimed with no summary yet → no premature games-needed nag.
    expect(computeRankedHint({ is_claimed: true }, undefined, HREF)).toBeNull();
  });
});

describe("ranked hint i18n", () => {
  it("resolves the claim warning copy in English", () => {
    const claim = i18next.t("play.ranked.needClaim", { lng: "en" });
    expect(claim).toContain("Claim");
    // not a raw key leak
    expect(claim).not.toContain("play.ranked");
  });

  it("pluralizes the games-needed copy", () => {
    expect(i18next.t("play.ranked.gamesNeeded", { lng: "en", count: 1 })).toBe(
      "1 more ranked match in a single game to reach the leaderboard.",
    );
    expect(i18next.t("play.ranked.gamesNeeded", { lng: "en", count: 4 })).toContain("4 more ranked matches");
  });

  it("resolves the Chinese copy", () => {
    expect(i18next.t("play.ranked.needClaim", { lng: "zh" })).toContain("认领");
    expect(i18next.t("play.ranked.gamesNeeded", { lng: "zh", count: 2 })).toContain("2 局");
  });
});
