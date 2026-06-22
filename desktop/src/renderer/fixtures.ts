// Sample matches for the cockpit's offline demo. Event shapes mirror what the
// platform emits (and what gameVisuals.tsx reduces over).
//
// INFORMATION-HIDING RULE (matches the platform): the desktop only ever shows
// the USER'S OWN agent's private info. Opponents' hidden info (hole cards, dice
// faces, influence) stays hidden — the local bridge never receives it anyway.
// So these fixtures reveal ONLY the owner's private info:
//   - poker: only the owner's hole cards are dealt-revealed (no opponent cards).
//   - dice/coup: no private values revealed for anyone (counts/backs only).
// `ownerPlayerId` marks which seat is "you"; reasoning traces are synthesized
// only for that seat (you never see an opponent's reasoning).

import type { MatchDetail, MatchEvent } from "@aifight/api-types";
import type { OwnerPrivate } from "./liveMatch";

type Game = "texas_holdem" | "liars_dice" | "coup";

const OWNER = "p0";

function players(): MatchDetail["players"] {
  return [
    { agent_id: "p0", agent_name: "Claude Opus", player_id: "p0", position: 0 },
    { agent_id: "p1", agent_name: "GPT-5", player_id: "p1", position: 1 },
  ];
}

function detail(game: Game): MatchDetail {
  return {
    id: `fixture-${game}`,
    game,
    mode: "ranked",
    status: "completed",
    players: players(),
    created_at: "2026-06-01T00:00:00.000Z",
    config: {},
    seed: 1,
    event_count: 0,
  };
}

let seq = 0;
function ev(type: string, data: Record<string, unknown>, player_id?: string): MatchEvent {
  seq += 1;
  return {
    seq,
    type,
    data,
    created_at: "2026-06-01T00:00:00.000Z",
    ...(player_id !== undefined ? { player_id } : {}),
  };
}

// Only the owner's (p0) hole cards are revealed. The opponent's cards are NOT
// dealt-revealed, so the board renders them face-down — same as the platform.
const texasEvents: MatchEvent[] = [
  ev("game_start", {}),
  ev("new_hand", { hand_num: 1, max_hands: 10, chips: { p0: 10000, p1: 10000 }, bets: { p0: 50, p1: 100 } }),
  ev("cards_dealt", { cards: ["As", "Ks"] }, OWNER),
  ev("player_action", { action: "call", amount: 50, total_bet: 100 }, "p0"),
  ev("community_cards", { cards: ["Ah", "7d", "2c"] }),
  ev("player_action", { action: "check" }, "p1"),
];

// Dice faces are private and never revealed here (no challenge); only the public
// bids + per-player dice counts show.
const liarsDiceEvents: MatchEvent[] = [
  ev("round_start", { round: 1 }),
  ev("bid", { quantity: 2, face: 5 }, "p0"),
  ev("bid", { quantity: 3, face: 5 }, "p1"),
  ev("bid", { quantity: 4, face: 6 }, "p0"),
];

// Influence cards stay face-down for everyone (no reveal events).
const coupEvents: MatchEvent[] = [ev("game_start", {})];

export interface GameFixture {
  readonly match: MatchDetail;
  readonly events: MatchEvent[];
  /** Which seat is "you" — the only agent whose private info + reasoning is shown. */
  readonly ownerPlayerId: string;
  /** The owner's OWN private info, for the "your agent" strip. Owner-only by construction. */
  readonly ownerPrivate: OwnerPrivate;
}

// Owner-only private views for the demo strip. These are p0's OWN secrets (the
// only info a real bridge ever sees about its own agent) — never an opponent's.
const texasOwn: OwnerPrivate = { holeCards: ["As", "Ks"], chips: 9950, position: "BTN" };
const liarsDiceOwn: OwnerPrivate = { dice: [2, 5, 5, 3, 6] };
const coupOwn: OwnerPrivate = { influence: ["Duke", "Captain"], coins: 2 };

export const FIXTURES: Record<Game, GameFixture> = {
  texas_holdem: { match: detail("texas_holdem"), events: texasEvents, ownerPlayerId: OWNER, ownerPrivate: texasOwn },
  liars_dice: { match: detail("liars_dice"), events: liarsDiceEvents, ownerPlayerId: OWNER, ownerPrivate: liarsDiceOwn },
  coup: { match: detail("coup"), events: coupEvents, ownerPlayerId: OWNER, ownerPrivate: coupOwn },
};

export const FIXTURE_GAMES: readonly Game[] = ["texas_holdem", "liars_dice", "coup"];
