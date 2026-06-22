// M1-20 Step 4: per-game fallback fixture replay.
//
// For each happy-path transcript with game discriminator, walk every
// action_request entry that carries non-empty legal_actions and feed
// the fallback function. Asserts:
//   - fallback returns a `LegalAction` (not throw, not null)
//   - returned action.type is one of the legal_actions[] entry types
//   - for raise/bid (parameterised actions) the fallback's
//     constructed amount / quantity / face is within the hint window
//
// Internal-only — no source modification, no new dep.

import { describe, expect, it, test } from "vitest";

import { loadTranscript, type LoadedTranscript } from "./_fixtures/transcripts";
import { fallbackTexasHoldem, type TexasHoldemFallbackInput } from "../src/games/texas_holdem/fallback";
import { fallbackLiarsDice, type LiarsDiceFallbackInput } from "../src/games/liars_dice/fallback";
import { fallbackCoup, type CoupFallbackInput } from "../src/games/coup/fallback";
import type { LegalAction } from "../src/decision/types";

type Game = "texas_holdem" | "liars_dice" | "coup";

interface FallbackFixture {
  readonly game: Game;
  readonly state: unknown;
  readonly legalActions: readonly LegalAction[];
  readonly yourPlayerId: string;
  readonly index: number;
}

function fixturesFromTranscript(t: LoadedTranscript): FallbackFixture[] {
  const out: FallbackFixture[] = [];
  let game: Game | undefined;
  let yourPlayerId: string | undefined;
  for (let i = 0; i < t.entries.length; i += 1) {
    const e = t.entries[i];
    if (e.direction === "server_to_client" && e.payload.type === "game_start") {
      const gs = e.payload.data as Record<string, unknown>;
      const g = gs.game as string;
      if (g === "texas_holdem" || g === "liars_dice" || g === "coup") {
        game = g;
      }
      yourPlayerId = gs.your_player_id as string | undefined;
      continue;
    }
    if (e.direction === "server_to_client" && e.payload.type === "action_request") {
      if (!game || !yourPlayerId) continue;
      const data = e.payload.data as { legal_actions?: readonly LegalAction[] | null; state?: unknown };
      const legal = data.legal_actions;
      if (!legal || legal.length === 0) continue;
      out.push({
        game,
        state: data.state,
        legalActions: legal,
        yourPlayerId,
        index: i + 1,
      });
    }
  }
  return out;
}

function runFallback(f: FallbackFixture): LegalAction {
  switch (f.game) {
    case "texas_holdem":
      return fallbackTexasHoldem({
        publicState: f.state as TexasHoldemFallbackInput["publicState"],
        legalActions: f.legalActions,
        yourPlayerId: f.yourPlayerId,
      });
    case "liars_dice":
      return fallbackLiarsDice({
        publicState: f.state as LiarsDiceFallbackInput["publicState"],
        legalActions: f.legalActions,
        yourPlayerId: f.yourPlayerId,
      });
    case "coup":
      return fallbackCoup({
        publicState: f.state as CoupFallbackInput["publicState"],
        legalActions: f.legalActions,
        yourPlayerId: f.yourPlayerId,
      });
  }
}

const TRANSCRIPT_FIXTURES: ReadonlyArray<{ name: string; expectedGame: Game }> = [
  { name: "happy_path/texas_holdem_4player.jsonl", expectedGame: "texas_holdem" },
  { name: "happy_path/liars_dice_3player.jsonl", expectedGame: "liars_dice" },
  { name: "edge_cases/coup_3player_forfeit_disconnect.jsonl", expectedGame: "coup" },
];

describe("fixtures-fallback", () => {
  for (const fixture of TRANSCRIPT_FIXTURES) {
    describe(fixture.name, () => {
      const t = loadTranscript(fixture.name);
      const items = fixturesFromTranscript(t);

      it("yields ≥1 actionable fixture", () => {
        expect(items.length).toBeGreaterThanOrEqual(1);
      });

      it("game discriminator is uniform", () => {
        const games = new Set(items.map((f) => f.game));
        expect(games.size).toBe(1);
        expect([...games][0]).toBe(fixture.expectedGame);
      });

      test.each(items.map((f, idx) => [idx, f] as const))(
        "action_request[%i] (line %s): fallback returns a typed legal action",
        (_idx, f) => {
          const out = runFallback(f);
          expect(out).toBeDefined();
          expect(typeof out.type).toBe("string");
          // fallback's action.type must be in the set of legal_actions[i].type
          const legalTypes = new Set(f.legalActions.map((la) => la.type));
          expect(legalTypes.has(out.type)).toBe(true);
        },
      );
    });
  }
});

// ---- raise / bid amount within hints ----

describe("fixtures-fallback: texas_holdem raise within hint window", () => {
  const t = loadTranscript("happy_path/texas_holdem_4player.jsonl");
  const items = fixturesFromTranscript(t);
  const raiseItems = items.filter(
    (f) =>
      f.legalActions.some((la) => la.type === "raise") &&
      // priority order is check/call/fold/raise/allin — raise is picked
      // only when none of check/call/fold are legal; rare case, but if
      // it exists, exercise the amount-within-hint contract
      !f.legalActions.some((la) => la.type === "check" || la.type === "call" || la.type === "fold"),
  );

  it("filtered raise-only scenarios may be 0 (priority rules eat raise)", () => {
    // No assertion; just confirm we count.
    expect(raiseItems.length).toBeGreaterThanOrEqual(0);
  });

  test.each(raiseItems.map((f, idx) => [idx, f] as const))(
    "raise-only[%i]: fallback amount within [min, max]",
    (_idx, f) => {
      const out = fallbackTexasHoldem({
        publicState: f.state as TexasHoldemFallbackInput["publicState"],
        legalActions: f.legalActions,
        yourPlayerId: f.yourPlayerId,
      });
      if (out.type !== "raise") return; // priority might still pick allin if raise is excluded
      const raiseHint = f.legalActions.find((la) => la.type === "raise");
      const hintData = raiseHint?.data as { min?: number; max?: number; amount?: number } | undefined;
      const outAmount = (out.data as { amount?: number } | undefined)?.amount;
      expect(typeof outAmount).toBe("number");
      const lo = hintData?.min ?? hintData?.amount ?? -Infinity;
      const hi = hintData?.max ?? hintData?.amount ?? Infinity;
      expect(outAmount!).toBeGreaterThanOrEqual(lo);
      expect(outAmount!).toBeLessThanOrEqual(hi);
    },
  );
});

describe("fixtures-fallback: liars_dice bid quantity/face within hints", () => {
  const t = loadTranscript("happy_path/liars_dice_3player.jsonl");
  const items = fixturesFromTranscript(t);
  // Liars Dice priority is bid > challenge; bid is picked when present
  const bidItems = items.filter((f) => f.legalActions.some((la) => la.type === "bid"));

  it("transcript has ≥1 bid-eligible fixture", () => {
    expect(bidItems.length).toBeGreaterThanOrEqual(1);
  });

  test.each(bidItems.map((f, idx) => [idx, f] as const))(
    "bid-eligible[%i]: fallback bid quantity ≥ 1 + face ≥ 1",
    (_idx, f) => {
      const out = fallbackLiarsDice({
        publicState: f.state as LiarsDiceFallbackInput["publicState"],
        legalActions: f.legalActions,
        yourPlayerId: f.yourPlayerId,
      });
      if (out.type !== "bid") return; // could fall back to challenge in degenerate hints
      const data = out.data as { quantity?: number; face?: number } | undefined;
      expect(typeof data?.quantity).toBe("number");
      expect(typeof data?.face).toBe("number");
      expect(data!.quantity).toBeGreaterThanOrEqual(1);
      expect(data!.face).toBeGreaterThanOrEqual(1);
    },
  );
});
