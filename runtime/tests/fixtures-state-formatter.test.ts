// M1-20 Step 2: state-formatter fixture replay.
//
// For each game-typed transcript, walk every server_to_client
// `action_request` entry and feed the per-game state-formatter the
// composite input (publicState + rules + players + recentEvents +
// yourPlayerId) reconstructed from `game_start` and the action_request
// itself. Asserts:
//   - formatter does not throw
//   - returned StateFormatterOutput.stateBlock is a non-empty string
//   - returned recentEventsBlock is a non-empty string (NO_EVENTS_PLACEHOLDER
//     when new_events is empty / null)
//   - stateBlock contains game-specific anchor strings (sanity check
//     the formatter received realistic input)
//
// Internal-only — no source modification, no new dep.

import { describe, expect, it, test } from "vitest";

import { loadTranscript, type LoadedTranscript } from "./_fixtures/transcripts";
import {
  formatTexasHoldemState,
  type TexasHoldemFormatterInput,
} from "../src/games/texas_holdem/state-formatter";
import {
  formatLiarsDiceState,
  type LiarsDiceFormatterInput,
} from "../src/games/liars_dice/state-formatter";
import {
  formatCoupState,
  type CoupFormatterInput,
} from "../src/games/coup/state-formatter";
import type { PlayerInfo, Event } from "../src/protocol/types";

type Game = "texas_holdem" | "liars_dice" | "coup";

interface FixtureBundle {
  readonly game: Game;
  readonly rules: unknown;
  readonly players: readonly PlayerInfo[];
  readonly yourPlayerId: string;
  readonly state: unknown;
  readonly recentEvents: readonly Event[];
  readonly index: number;
}

function bundlesFromTranscript(t: LoadedTranscript): FixtureBundle[] {
  const result: FixtureBundle[] = [];
  let game: Game | undefined;
  let rules: unknown;
  let yourPlayerId: string | undefined;

  for (let i = 0; i < t.entries.length; i += 1) {
    const e = t.entries[i];
    if (e.direction === "server_to_client" && e.payload.type === "game_start") {
      const gs = e.payload.data as Record<string, unknown>;
      const gameStr = gs.game as string;
      if (gameStr === "texas_holdem" || gameStr === "liars_dice" || gameStr === "coup") {
        game = gameStr;
      }
      rules = gs.rules;
      yourPlayerId = gs.your_player_id as string | undefined;
      continue;
    }
    if (e.direction === "server_to_client" && e.payload.type === "action_request") {
      if (!game || !yourPlayerId) continue;
      const data = e.payload.data as Record<string, unknown>;
      const players = (data.players as readonly PlayerInfo[] | undefined) ?? [];
      const events = (data.new_events as readonly Event[] | null | undefined) ?? [];
      const state = data.state;
      result.push({
        game,
        rules,
        players,
        yourPlayerId,
        state,
        recentEvents: events,
        index: i + 1,
      });
    }
  }
  return result;
}

const FIXTURES: ReadonlyArray<{ name: string; expectedGame: Game }> = [
  { name: "happy_path/texas_holdem_4player.jsonl", expectedGame: "texas_holdem" },
  { name: "happy_path/liars_dice_3player.jsonl", expectedGame: "liars_dice" },
  { name: "edge_cases/coup_3player_forfeit_disconnect.jsonl", expectedGame: "coup" },
  { name: "edge_cases/reconnect_mid_match.jsonl", expectedGame: "liars_dice" },
];

function runFormatter(b: FixtureBundle): { stateBlock: string; recentEventsBlock: string } {
  // Use typed casts on the per-game game-specific input so tsc can
  // catch shape drift between fixture-fed JSON and sealed formatter
  // signatures. `b.state` and `b.rules` arrive from JSON as `unknown`
  // and we cast to the relevant game-typed input fields directly.
  switch (b.game) {
    case "texas_holdem":
      return formatTexasHoldemState({
        publicState: b.state as TexasHoldemFormatterInput["publicState"],
        rules: b.rules as TexasHoldemFormatterInput["rules"],
        players: b.players,
        recentEvents: b.recentEvents,
        yourPlayerId: b.yourPlayerId,
      });
    case "liars_dice":
      return formatLiarsDiceState({
        publicState: b.state as LiarsDiceFormatterInput["publicState"],
        rules: b.rules as LiarsDiceFormatterInput["rules"],
        players: b.players,
        recentEvents: b.recentEvents,
        yourPlayerId: b.yourPlayerId,
      });
    case "coup":
      return formatCoupState({
        publicState: b.state as CoupFormatterInput["publicState"],
        rules: b.rules as CoupFormatterInput["rules"],
        players: b.players,
        recentEvents: b.recentEvents,
        yourPlayerId: b.yourPlayerId,
      });
  }
}

describe("fixtures-state-formatter", () => {
  for (const fixture of FIXTURES) {
    describe(fixture.name, () => {
      const t = loadTranscript(fixture.name);
      const bundles = bundlesFromTranscript(t);

      it(`yields ≥1 (game_start + action_request) bundle`, () => {
        expect(bundles.length).toBeGreaterThanOrEqual(1);
      });

      it("game discriminator matches expected", () => {
        const games = new Set(bundles.map((b) => b.game));
        expect(games.size).toBe(1);
        expect([...games][0]).toBe(fixture.expectedGame);
      });

      test.each(bundles.map((b, idx) => [idx, b] as const))(
        "action_request[%i] (line %s): formatter returns non-empty stateBlock + recentEventsBlock",
        (_idx, b) => {
          const out = runFormatter(b);
          expect(typeof out.stateBlock).toBe("string");
          expect(out.stateBlock.length).toBeGreaterThan(0);
          expect(typeof out.recentEventsBlock).toBe("string");
          expect(out.recentEventsBlock.length).toBeGreaterThan(0);
        },
      );
    });
  }
});

describe("fixtures-state-formatter: game-specific stateBlock anchors", () => {
  // Sanity that the formatter received realistic input — each game's
  // stateBlock must contain at least one anchor string identifying the
  // domain it just rendered. Not a deep contract check — just a
  // tripwire for "formatter ran on empty state and silently produced
  // a placeholder".
  it("texas_holdem stateBlock mentions chips or pot or community", () => {
    const t = loadTranscript("happy_path/texas_holdem_4player.jsonl");
    const b = bundlesFromTranscript(t)[0];
    const out = runFormatter(b);
    expect(out.stateBlock.toLowerCase()).toMatch(/pot|chip|community|hand/);
  });

  it("liars_dice stateBlock mentions dice or bid", () => {
    const t = loadTranscript("happy_path/liars_dice_3player.jsonl");
    const b = bundlesFromTranscript(t)[0];
    const out = runFormatter(b);
    expect(out.stateBlock.toLowerCase()).toMatch(/dice|bid|round/);
  });

  it("coup stateBlock mentions coins or cards or roles", () => {
    const t = loadTranscript("edge_cases/coup_3player_forfeit_disconnect.jsonl");
    const b = bundlesFromTranscript(t)[0];
    const out = runFormatter(b);
    expect(out.stateBlock.toLowerCase()).toMatch(/coin|card|role|influence/);
  });
});

describe("fixtures-state-formatter: null new_events handling (拍板点 #8)", () => {
  // First-turn action_request observed in real beta has new_events=null
  // (protocol/types.ts:1006). Formatter must accept that without
  // throwing — recentEvents `null` is normalised to [] by the bundle
  // builder, so formatter sees an empty array and emits the
  // NO_EVENTS_PLACEHOLDER literal "(no events since your last turn)"
  // (state-formatter constant). Verify the bundle path actually feeds
  // the formatter and the placeholder appears in recentEventsBlock.
  //
  // liars_dice_3player.jsonl line 2 is the canonical null-new_events
  // beta capture; using it directly so this case actually exercises
  // the formatter (not a corpus-presence sentinel).
  it("liars_dice first-turn action_request (new_events: null) → recentEventsBlock = NO_EVENTS_PLACEHOLDER", () => {
    const t = loadTranscript("happy_path/liars_dice_3player.jsonl");
    // Confirm corpus invariant before driving formatter
    const firstReq = t.entries.find(
      (e) => e.direction === "server_to_client" && e.payload.type === "action_request",
    );
    expect(firstReq).toBeDefined();
    expect((firstReq!.payload.data as { new_events?: unknown }).new_events).toBeNull();

    // Build the formatter input from the bundle path (null → []) and
    // verify recentEventsBlock contains the placeholder literal.
    const bundles = bundlesFromTranscript(t);
    const firstBundle = bundles[0];
    expect(firstBundle).toBeDefined();
    expect(firstBundle.recentEvents.length).toBe(0); // null normalised to []
    const out = runFormatter(firstBundle);
    expect(out.recentEventsBlock).toContain("(no events since your last turn)");
  });
});
