// D6.5 — turn the raw bridge protocol stream into the renderer's match model.
//
// The local bridge is a PLAYER, not a spectator: it receives game_start, then a
// series of action_request messages whose `new_events` carry the incremental
// engine event log (already filtered to what this player may see), and finally
// game_over. This pure reducer folds that stream into the very same
// { match, events, ownerPlayerId } shape the website's renderers consume — so
// the cockpit board IS the website's board, driven live.
//
// 🔒 INFORMATION-HIDING RULE (binding): the ONLY private info this reducer ever
// surfaces is the OWNER's own (your_hand / your_dice / your_cards from
// action_request.state). Opponents' hidden info is never injected — it appears
// only if the platform itself placed it in new_events (e.g. a showdown
// hand_result, which is public by game rules). The reducer never fabricates an
// opponent secret, live or at game_over.
//
// 🔒 SESSION ISOLATION (binding): a new game_start resets to a fresh match; this
// reducer holds only the CURRENT match, never a global merge across matches.
// Past matches are loaded lazily elsewhere (D8 history), not accumulated here.

import type { MatchDetail, MatchEvent, MatchPlayer } from "@aifight/api-types";
import { isSafeGameName } from "../shared/games";
import type {
  ActionRequestData,
  GameOverData,
  GameStartData,
  GameStateData,
  ProtocolEvent,
  ServerMessage,
} from "../shared/ipc";

export type Game = "texas_holdem" | "liars_dice" | "coup";

/**
 * The owner's own private info, lifted from action_request.state. Shown ONLY for
 * the owner; opponents' equivalents are never present in the local bridge view.
 */
export interface OwnerPrivate {
  // texas_holdem
  readonly holeCards?: readonly string[];
  readonly chips?: number;
  readonly position?: string;
  // liars_dice
  readonly dice?: readonly number[];
  // coup
  readonly influence?: readonly string[];
  readonly revealed?: readonly string[];
  readonly coins?: number;
}

export type MatchOutcome = "win" | "loss" | "draw" | "unknown";

export interface LiveMatchState {
  readonly sessionId: string | null;
  readonly game: Game | null;
  readonly ownerPlayerId: string | null;
  readonly match: MatchDetail | null;
  readonly events: readonly MatchEvent[];
  readonly ownerPrivate: OwnerPrivate;
  readonly finished: boolean;
  readonly outcome: MatchOutcome;
  /** Replay page path from game_over (e.g. "/replay/<id>"); origin prepended by the view. */
  readonly replayPath: string | null;
  /** internal: highest engine seq folded in, for dedupe across action_requests. */
  readonly maxSeq: number;
  /** internal: the poker hand we've already injected owner hole cards for. */
  readonly injectedHandKey: string | null;
}

export function emptyLiveMatch(): LiveMatchState {
  return {
    sessionId: null,
    game: null,
    ownerPlayerId: null,
    match: null,
    events: [],
    ownerPrivate: {},
    finished: false,
    outcome: "unknown",
    replayPath: null,
    maxSeq: -1,
    injectedHandKey: null,
  };
}

/** Fold one server frame into the live-match state. Pure; safe to unit-test. */
export function reduceServerMessage(state: LiveMatchState, msg: ServerMessage): LiveMatchState {
  switch (msg.type) {
    case "game_start":
      return onGameStart(msg.data as GameStartData);
    case "action_request":
      return onActionRequest(state, msg.data as ActionRequestData);
    case "game_state":
      return onGameState(state, msg.data as GameStateData);
    case "game_over":
      return onGameOver(state, msg.data as GameOverData);
    default:
      // welcome / queue_joined / queue_left / match_confirm_request /
      // readiness_check / error — not board-relevant.
      return state;
  }
}

// ── game_start ───────────────────────────────────────────────────────────────

function onGameStart(data: GameStartData): LiveMatchState {
  // Accept any well-formed engine name the SERVER starts a match for — the
  // backend's live list is the authority (no hardcoded copy here). A game this
  // build can't render yet degrades gracefully: events/traces/outcome still
  // flow; the board area is empty (GameStateVisual renders null for it).
  if (data === undefined || data === null || !isSafeGameName(data.game)) return emptyLiveMatch();
  const owner = data.your_player_id;
  // Names are anonymized during play (protocol: "Player 1", …). The owner's own
  // seat is labeled "You" so the user can spot their agent; opponents stay
  // anonymous until game_over discloses real identities.
  const players: MatchPlayer[] = (data.players ?? []).map((p) => ({
    agent_id: p.player_id,
    agent_name: p.player_id === owner ? "You" : p.name,
    player_id: p.player_id,
    position: p.position,
  }));
  const match: MatchDetail = {
    id: data.match_id,
    game: data.game,
    mode: "ranked",
    status: "live",
    players,
    created_at: "",
    config: {},
    seed: 0,
    event_count: 0,
  };
  return { ...emptyLiveMatch(), sessionId: data.match_id, game: data.game, ownerPlayerId: owner, match };
}

// ── action_request ─────────────────────────────────────────────────────────

function onActionRequest(state: LiveMatchState, data: ActionRequestData): LiveMatchState {
  if (data === undefined || data === null) return state;
  // Need a game_start first; ignore frames for any other session (isolation).
  if (state.sessionId === null || state.match === null) return state;
  if (data.match_id !== state.sessionId) return state;

  let events = state.events;
  let maxSeq = state.maxSeq;

  if (data.is_reconnect === true && data.event_history && data.event_history.length > 0) {
    // Reconnect: event_history is the FULL filtered log → rebuild from scratch.
    const rebuilt: MatchEvent[] = [];
    let hi = -1;
    data.event_history.forEach((e, i) => {
      rebuilt.push(toMatchEvent(e, i));
      if (typeof e.seq === "number" && e.seq > hi) hi = e.seq;
    });
    events = rebuilt;
    maxSeq = hi;
  } else {
    const incoming = data.new_events ?? [];
    if (incoming.length > 0) {
      const appended = events.slice();
      for (const e of incoming) {
        if (typeof e.seq === "number") {
          if (e.seq <= maxSeq) continue; // dedupe across overlapping action_requests
          appended.push(toMatchEvent(e, appended.length));
          maxSeq = e.seq;
        } else {
          appended.push(toMatchEvent(e, appended.length));
        }
      }
      events = appended;
    }
  }

  // The only secrets we surface: the owner's own private info from `state`.
  const { ownerPrivate, injectKey } = extractOwnerPrivate(state.game, data.state);

  // Poker only: inject the owner's hole cards as a `cards_dealt` event so the
  // board shows them at the owner's seat (the renderer renders cards_dealt
  // natively, keyed to the current hand). Injected AFTER new_events above so the
  // current hand's `new_hand` already precedes it in the array.
  let injectedHandKey = state.injectedHandKey;
  if (
    state.game === "texas_holdem" &&
    state.ownerPlayerId !== null &&
    ownerPrivate.holeCards &&
    ownerPrivate.holeCards.length > 0 &&
    injectKey !== null &&
    injectKey !== injectedHandKey
  ) {
    const dealt: MatchEvent = {
      seq: maxSeq + 1, // sits after the latest engine event; synthetic, not deduped
      type: "cards_dealt",
      data: { cards: ownerPrivate.holeCards.slice() },
      created_at: "",
      player_id: state.ownerPlayerId,
    };
    events = [...events, dealt];
    injectedHandKey = injectKey;
  }

  return { ...state, events, ownerPrivate, maxSeq, injectedHandKey };
}

// ── game_state (reconnect, not your turn) ────────────────────────────────────

function onGameState(state: LiveMatchState, data: GameStateData): LiveMatchState {
  if (data === undefined || data === null) return state;
  if (state.sessionId === null || data.match_id !== state.sessionId) return state;
  const { ownerPrivate } = extractOwnerPrivate(state.game, data.state);
  return { ...state, ownerPrivate };
}

// ── game_over ────────────────────────────────────────────────────────────────

function onGameOver(state: LiveMatchState, data: GameOverData): LiveMatchState {
  if (data === undefined || data === null || state.sessionId === null) return state;
  // game_over carries the REAL match id but echoes the session_id we played under.
  if (data.session_id !== undefined && data.session_id !== state.sessionId) return state;

  let match = state.match;
  if (match !== null) {
    // Reveal real identities (public at game_over per protocol). The owner's own
    // seat stays "You". This discloses opponent NAMES only — never their hidden
    // cards, which the local bridge never received.
    if (data.players && data.players.length > 0) {
      const byId = new Map(data.players.map((p) => [p.player_id, p]));
      const players: MatchPlayer[] = match.players.map((p) => {
        const real = byId.get(p.player_id);
        if (real === undefined) return p;
        return {
          agent_id: real.agent_id,
          agent_name: p.player_id === state.ownerPlayerId ? "You" : real.agent_name,
          player_id: real.player_id,
          position: real.position,
        };
      });
      match = { ...match, players, status: "completed" };
    } else {
      match = { ...match, status: "completed" };
    }
  }

  return {
    ...state,
    match,
    finished: true,
    outcome: ownerOutcome(data.result, state.ownerPlayerId),
    replayPath: data.replay_url ?? null,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** common/event.schema.json → renderer MatchEvent: player→player_id, ts→created_at. */
function toMatchEvent(e: ProtocolEvent, fallbackSeq: number): MatchEvent {
  return {
    seq: typeof e.seq === "number" ? e.seq : fallbackSeq,
    type: e.type,
    data: e.data ?? {},
    created_at: e.ts ?? "",
    ...(e.player ? { player_id: e.player } : {}),
  };
}

function asStringArray(v: unknown): readonly string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
}

function asNumberArray(v: unknown): readonly number[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.every((x) => typeof x === "number") ? (v as number[]) : undefined;
}

/**
 * Lift the owner's own private fields out of the per-player `state`. Returns the
 * snapshot plus an `injectKey` (poker only) identifying the current hand+hand so
 * the caller injects the hole-card reveal exactly once per hand.
 */
function extractOwnerPrivate(
  game: Game | null,
  stateData: Record<string, unknown> | undefined,
): { ownerPrivate: OwnerPrivate; injectKey: string | null } {
  const s = stateData ?? {};
  if (game === "texas_holdem") {
    const holeCards = asStringArray(s.your_hand);
    const chips = typeof s.your_chips === "number" ? s.your_chips : undefined;
    const position = typeof s.your_position === "string" ? s.your_position : undefined;
    const handNum = typeof s.hand_num === "number" ? s.hand_num : undefined;
    const injectKey =
      holeCards && holeCards.length > 0 ? `${handNum ?? "?"}:${holeCards.join(",")}` : null;
    return {
      ownerPrivate: {
        ...(holeCards ? { holeCards } : {}),
        ...(chips !== undefined ? { chips } : {}),
        ...(position ? { position } : {}),
      },
      injectKey,
    };
  }
  if (game === "liars_dice") {
    const dice = asNumberArray(s.your_dice);
    return { ownerPrivate: dice ? { dice } : {}, injectKey: null };
  }
  if (game === "coup") {
    const influence = asStringArray(s.your_cards);
    const revealed = asStringArray(s.your_revealed);
    const coins = typeof s.coins === "number" ? s.coins : undefined;
    return {
      ownerPrivate: {
        ...(influence ? { influence } : {}),
        ...(revealed ? { revealed } : {}),
        ...(coins !== undefined ? { coins } : {}),
      },
      injectKey: null,
    };
  }
  return { ownerPrivate: {}, injectKey: null };
}

/** Derive the owner's win/loss/draw from the canonical result. Public info. */
function ownerOutcome(result: GameOverData["result"], owner: string | null): MatchOutcome {
  if (!result || owner === null) return "unknown";
  if (result.is_draw === true) return "draw";
  if (result.winner) return result.winner === owner ? "win" : "loss";
  const payoffs = result.payoffs;
  if (payoffs && typeof payoffs[owner] === "number") {
    const mine = payoffs[owner];
    let bestOther = Number.NEGATIVE_INFINITY;
    for (const [pid, v] of Object.entries(payoffs)) {
      if (pid !== owner && v > bestOther) bestOther = v;
    }
    if (bestOther === Number.NEGATIVE_INFINITY) return "unknown";
    if (mine > bestOther) return "win";
    if (mine < bestOther) return "loss";
    return "draw";
  }
  return "unknown";
}
