// Tests for the live-game list plumbing (shared/games.ts): the two backend
// parsers (welcome frame / GET /api/games), the safe-name gate that also guards
// strategy-file paths, and the display-label fallback for not-yet-known games.

import { describe, expect, it } from "vitest";

import {
  FALLBACK_LIVE_GAMES,
  gameLabel,
  isSafeGameName,
  parseGamesResponse,
  parseWelcomeGames,
} from "./games";

describe("isSafeGameName", () => {
  it("accepts engine-style snake_case names", () => {
    for (const ok of ["texas_holdem", "liars_dice", "coup", "bocce_ball", "a", "game2"]) {
      expect(isSafeGameName(ok)).toBe(true);
    }
  });

  it("rejects path-unsafe / malformed values", () => {
    for (const bad of ["../etc", "a/b", "a.b", "Chess", "", " ", "_x", "9x", "a-b", 7, null, undefined, ["coup"]]) {
      expect(isSafeGameName(bad)).toBe(false);
    }
  });
});

describe("parseWelcomeGames (welcome frame data.games = engine.LiveNames())", () => {
  it("extracts the list in order", () => {
    expect(parseWelcomeGames({ games: ["texas_holdem", "liars_dice", "coup"] })).toEqual([
      "texas_holdem",
      "liars_dice",
      "coup",
    ]);
  });

  it("keeps order while dropping malformed entries and duplicates", () => {
    expect(parseWelcomeGames({ games: ["coup", "../x", "coup", 5, "liars_dice"] })).toEqual([
      "coup",
      "liars_dice",
    ]);
  });

  it("returns null for absent/empty/malformed payloads (caller keeps its cache)", () => {
    expect(parseWelcomeGames(undefined)).toBeNull();
    expect(parseWelcomeGames(null)).toBeNull();
    expect(parseWelcomeGames({})).toBeNull();
    expect(parseWelcomeGames({ games: [] })).toBeNull();
    expect(parseWelcomeGames({ games: "coup" })).toBeNull();
    expect(parseWelcomeGames({ games: [123, "../x"] })).toBeNull();
  });
});

describe("parseGamesResponse (GET /api/games)", () => {
  it("extracts games[].name in order", () => {
    const json = {
      games: [
        { name: "texas_holdem", display_name: "Texas Hold'em" },
        { name: "liars_dice" },
        { name: "coup" },
        { name: "bocce_ball" },
      ],
      count: 4,
    };
    expect(parseGamesResponse(json)).toEqual(["texas_holdem", "liars_dice", "coup", "bocce_ball"]);
  });

  it("returns null for malformed payloads", () => {
    expect(parseGamesResponse(undefined)).toBeNull();
    expect(parseGamesResponse({})).toBeNull();
    expect(parseGamesResponse({ games: "nope" })).toBeNull();
    expect(parseGamesResponse({ games: [{ title: "no name" }, null] })).toBeNull();
  });
});

describe("gameLabel", () => {
  it("uses the official title when known", () => {
    expect(gameLabel("texas_holdem")).toBe("Texas Hold'em");
    expect(gameLabel("liars_dice")).toBe("Liar's Dice");
    expect(gameLabel("coup")).toBe("Coup");
  });

  it("prettifies a not-yet-known live game instead of showing the raw id", () => {
    expect(gameLabel("bocce_ball")).toBe("Bocce Ball");
    expect(gameLabel("skull")).toBe("Skull");
  });
});

describe("FALLBACK_LIVE_GAMES", () => {
  it("is non-empty and well-formed (pickAutoGame and the UI seed rely on this)", () => {
    expect(FALLBACK_LIVE_GAMES.length).toBeGreaterThan(0);
    for (const g of FALLBACK_LIVE_GAMES) expect(isSafeGameName(g)).toBe(true);
  });
});
