// D6.5 — turn the raw bridge protocol stream into the renderer's match model.
//
// The local bridge is a PLAYER, not a spectator: it receives game_start, then a
// series of action_request messages whose `new_events` carry the incremental
// engine event log (already filtered to what this player may see), and finally
// game_over. This pure reducer folds that stream into the very same
// { match, events, ownerPlayerId } shape the website's renderers consume — so
// the cockpit board IS the website's board, driven live.
//
// LIVE_MATCH_FEED (2026-07-30): two more streams fold into the same log —
//  F1: mergePolledEvents merges the participant REST feed (polled by main every
//      ~2.5s; full per-player-filtered history, deduped by seq), so opponents'
//      moves reach the board between our turns instead of in turn-sized jumps.
//  F2: injectFinalAction injects the owner's just-decided action from the
//      runtime's final_action trace as a SYNTHETIC event (never advancing
//      maxSeq); the reconciler swaps in the server's real event on arrival, or
//      rolls the synthetic back (mismatch / boundary / action_stale) with a
//      one-shot syncNotice. Both streams are render-only — they NEVER trigger
//      an LLM call.
// Phase 2 (match_feed): the server itself pushes the same per-player-filtered
//      events between turns (capability-gated at the WS handshake, dark-shipped
//      behind the server's match_feed_enabled switch). Same seq space, so the
//      reducer folds feed frames through mergePolledEvents' seq-dedupe path —
//      whichever stream (push / poll / new_events) delivers an event first wins,
//      the others skip it. While the feed is healthy main suppresses poll ticks.
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
  MatchFeedData,
  ProtocolEvent,
  ReplayTailFrame,
  ServerMessage,
  TraceAction,
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

/**
 * F2 — a synthetic own-action event injected from the runtime's final_action
 * trace (emitted BEFORE the LLM round-trip finishes / the action is submitted),
 * so the owner's own move lands on the board immediately instead of one turn
 * later. It awaits the server's confirming real event (dedupe by player + action
 * kind + amount); a mismatch, a hand/round boundary arriving first, or an
 * action_stale frame rolls it back and flags syncNotice.
 */
export interface PendingAction {
  /** Identity of the injected event — removed on confirm/rollback. */
  readonly event: MatchEvent;
  /** Normalized action kind (fold/call/raise/…, "bid", or a coup turn action). */
  readonly kind: string;
  /** Amount part of the dedupe key (raise/call total, "3x4" bid, coup target). null = kind-only match. */
  readonly amountKey: string | null;
  /**
   * Seq of the LAST hand/round boundary already in the log at injection (-1 =
   * none). A boundary event only contradicts the synthetic when it sits PAST
   * this seq — the current hand's own new_hand (replayed by a reconnect's full
   * event_history) must not roll back the action taken in that hand.
   */
  readonly boundarySeq: number;
}

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
  /** internal: unconfirmed synthetic own-action (F2); null when none is pending. */
  readonly pendingAction: PendingAction | null;
  /** One-shot UI notice: the synthetic own-action was rolled back unconfirmed. */
  readonly syncNotice: "action_unconfirmed" | null;
  /**
   * Live turn authority (2026-07-30): true from an action_request (our decision
   * window opens — we are thinking) until the decision leaves (final_action
   * trace), closes without landing (action_stale / unconfirmed rollback), a
   * not-our-turn reconnect (game_state) lands, or the match ends. The shared
   * board renderer can't know this — its "acting" seat is event-derived
   * (poker/coup mark the LAST actor) — so the cockpit reads this flag for the
   * authoritative turn state instead.
   */
  readonly myTurn: boolean;
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
    pendingAction: null,
    syncNotice: null,
    myTurn: false,
  };
}

/** Fold one server frame into the live-match state. Pure; safe to unit-test. */
export function reduceServerMessage(state: LiveMatchState, msg: ServerMessage): LiveMatchState {
  switch (msg.type) {
    case "game_start":
      return onGameStart(msg.data as GameStartData);
    case "action_request":
      return onActionRequest(state, msg.data as ActionRequestData);
    case "match_feed":
      return onMatchFeed(state, msg.data as MatchFeedData);
    case "game_state":
      return onGameState(state, msg.data as GameStateData);
    case "game_over":
      return onGameOver(state, msg.data as GameOverData);
    case "action_stale": {
      // The server refused our submitted action (it answered a superseded
      // request, so it was never judged) — the synthetic own-action (F2) must
      // roll back to the last confirmed state. Benign when nothing is pending
      // (e.g. a Coup response window another player closed first — those
      // responses are never synthesized). Either way our decision window is
      // closed, so myTurn clears too.
      const next = state.pendingAction !== null ? rollbackPendingAction(state, state.pendingAction) : state;
      return next.myTurn ? { ...next, myTurn: false } : next;
    }
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
  // Real engine events folded in by THIS frame — the F2 reconciler scans them
  // for the server's confirmation (or contradiction) of a pending synthetic.
  let fresh: readonly MatchEvent[] = [];

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
    // Server-authoritative: reconcile the pending synthetic against the whole log.
    fresh = rebuilt;
  } else {
    const incoming = data.new_events ?? [];
    if (incoming.length > 0) {
      const appended = events.slice();
      const added: MatchEvent[] = [];
      for (const e of incoming) {
        if (typeof e.seq === "number") {
          if (e.seq <= maxSeq) continue; // dedupe across overlapping action_requests
          const ev = toMatchEvent(e, appended.length);
          appended.push(ev);
          added.push(ev);
          maxSeq = e.seq;
        } else {
          const ev = toMatchEvent(e, appended.length);
          appended.push(ev);
          added.push(ev);
        }
      }
      events = appended;
      fresh = added;
    }
  }

  // F2: a pending synthetic own-action meets the real stream here — confirmed
  // (the real event takes its place) or rolled back (mismatch / hand rolled on).
  const reconciled = reconcilePendingAction({ ...state, events, maxSeq }, fresh);
  events = reconciled.events;

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

  // Our decision window opens with this request — the board's turn authority
  // (myTurn) flips to us until the final_action trace says we decided.
  return { ...reconciled, events, ownerPrivate, injectedHandKey, myTurn: true };
}

// ── game_state (reconnect, not your turn) ────────────────────────────────────

function onGameState(state: LiveMatchState, data: GameStateData): LiveMatchState {
  if (data === undefined || data === null) return state;
  if (state.sessionId === null || data.match_id !== state.sessionId) return state;
  const { ownerPrivate } = extractOwnerPrivate(state.game, data.state);
  // game_state is the reconnect snapshot for when it is NOT our turn (a
  // reconnect on our turn arrives as an action_request instead).
  return { ...state, ownerPrivate, myTurn: false };
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

  const pending = state.pendingAction;
  return {
    ...state,
    // Match over: an unconfirmed synthetic own-action is moot — drop it quietly
    // (no notice; the public-replay tail merge completes the real closing stretch).
    events: pending !== null ? state.events.filter((x) => x !== pending.event) : state.events,
    pendingAction: null,
    myTurn: false,
    match,
    finished: true,
    outcome: ownerOutcome(data.result, state.ownerPlayerId),
    replayPath: data.replay_url ?? null,
  };
}

// ── final-tail merge (post-game_over) ───────────────────────────────────────

/**
 * Fold the finished match's PUBLIC replay frames into the local event log.
 *
 * The bridge's own stream ends at this player's last decision — the closing
 * stretch (opponents' final actions, showdown, result) only exists in the
 * public replay. Frames share the engine's seq space with the events we
 * already hold, so everything at/below maxSeq is a duplicate and is skipped;
 * only the genuinely-missing tail is appended. The owner's earlier synthetic
 * cards_dealt injections are untouched (they never advanced maxSeq).
 *
 * 🔒 Public data only: these frames are what any anonymous visitor gets from
 * the replay page of a FINISHED match. Nothing private is added or revealed
 * beyond what the platform itself published.
 */
export function appendFinalEvents(state: LiveMatchState, frames: readonly ReplayTailFrame[]): LiveMatchState {
  if (frames.length === 0) return state;
  let maxSeq = state.maxSeq;
  let appended: MatchEvent[] | null = null;
  const fresh: MatchEvent[] = [];
  for (const f of frames) {
    const type = f.type ?? f.kind;
    if (typeof type !== "string" || type === "") continue;
    if (typeof f.seq !== "number" || f.seq <= maxSeq) continue; // already have it
    appended ??= state.events.slice();
    const ev: MatchEvent = {
      seq: f.seq,
      type,
      data: f.data ?? {},
      created_at: f.created_at ?? "",
      ...(f.player_id ? { player_id: f.player_id } : {}),
    };
    appended.push(ev);
    fresh.push(ev);
    maxSeq = f.seq;
  }
  if (appended === null) return state;
  return reconcilePendingAction({ ...state, events: appended, maxSeq }, fresh);
}

// ── F1: participant event-feed merge (polled by main every ~2.5s) ───────────

/**
 * Fold one page of the participant event feed (GET …/matches/{sessionID}/events)
 * into the local log. The endpoint returns the FULL per-player-filtered history
 * on every poll, so everything at/below maxSeq is a duplicate of the turn-driven
 * stream and is skipped — exactly the appendFinalEvents dedupe pattern.
 *
 * This is ALSO the merge path for server-pushed match_feed frames (Phase 2):
 * same seq space, same dedupe, same F2 reconcile — see onMatchFeed below.
 *
 * Events without a numeric seq are SKIPPED (not appended): on a full-history
 * feed they would duplicate on every poll, and the engine always assigns seqs,
 * so a seqless entry here is malformed, not new information.
 *
 * 🔒 Same trust level as action_request.new_events: the server has already run
 * the game's FilterEventForPlayer for us. Nothing private is added.
 */
export function mergePolledEvents(
  state: LiveMatchState,
  sessionId: string,
  polled: readonly ProtocolEvent[],
): LiveMatchState {
  if (state.sessionId === null || state.match === null || sessionId !== state.sessionId) return state;
  let maxSeq = state.maxSeq;
  let appended: MatchEvent[] | null = null;
  const fresh: MatchEvent[] = [];
  for (const e of polled) {
    if (typeof e.seq !== "number" || e.seq <= maxSeq) continue;
    appended ??= state.events.slice();
    const ev = toMatchEvent(e, e.seq);
    appended.push(ev);
    fresh.push(ev);
    maxSeq = e.seq;
  }
  if (appended === null) return state;
  return reconcilePendingAction({ ...state, events: appended, maxSeq }, fresh);
}

// ── Phase 2: server-pushed match_feed (capability-gated, match_feed_enabled) ─

/**
 * Fold one server-pushed match_feed frame into the local log. The feed carries
 * the same per-player-filtered events action_request.new_events does, pushed
 * between turns by the server itself — the merge IS the polled-feed merge
 * (session guard + seq dedupe + F2 reconcile), so whichever stream delivers an
 * event first wins and the others skip it by seq. Render-only by protocol
 * contract: never a decision prompt, never an LLM call.
 *
 * The runtime has already ajv-validated the frame; the shape guard below keeps
 * the reducer total for hand-rolled/test frames. An empty/absent events array
 * folds to the same reference (no-op).
 */
function onMatchFeed(state: LiveMatchState, data: MatchFeedData): LiveMatchState {
  if (data === undefined || data === null) return state;
  if (typeof data.match_id !== "string" || !Array.isArray(data.events)) return state;
  return mergePolledEvents(state, data.match_id, data.events);
}

// ── F2: synthetic own-action from the final_action trace ─────────────────────

/**
 * Inject the owner's just-decided action as a synthetic board event, so their
 * own move shows immediately instead of one turn later (the runtime emits
 * final_action BEFORE submitting, with the complete action — including the
 * deterministic fallback's). The synthetic sits at the tip with seq maxSeq+1
 * but NEVER advances maxSeq; when the server's real event arrives (via
 * new_events, the polled feed, or the final tail) the reconciler swaps it in.
 *
 * Only action kinds whose real event carries NO engine-computed fields are
 * synthesized: all five poker moves, the dice bid, and coup turn actions. A
 * dice challenge / coup challenge/block/pass resolves with server-computed
 * data (actual counts, claimed roles), so those wait for the real event.
 * Either way the trace means our decision was MADE, so myTurn clears even
 * when nothing is injected. Returns the same state reference when the trace
 * belongs to another session / a finished match (nothing changed at all).
 */
export function injectFinalAction(
  state: LiveMatchState,
  trace: { readonly matchId: string; readonly action: TraceAction },
): LiveMatchState {
  if (state.sessionId === null || state.match === null || state.finished) return state;
  if (trace.matchId !== state.sessionId || state.ownerPlayerId === null) return state;
  const mapped = mapFinalAction(state.game, trace.action);
  if (mapped === null) {
    // Not synthesizable (challenge/block/pass, unknown kind) — no board event,
    // but our decision window did close with this trace.
    return state.myTurn ? { ...state, myTurn: false } : state;
  }
  // A still-pending earlier synthetic is superseded by this newer decision —
  // the runtime only asks for the next decision after the previous one closed,
  // so the unconfirmed one never landed. Drop it without the notice.
  const prev = state.pendingAction;
  const base = prev !== null ? state.events.filter((x) => x !== prev.event) : state.events;
  const synthetic: MatchEvent = {
    seq: state.maxSeq + 1, // sits after the latest engine event; synthetic, not deduped
    type: mapped.type,
    data: mapped.data,
    created_at: "",
    player_id: state.ownerPlayerId,
  };
  return {
    ...state,
    events: [...base, synthetic],
    myTurn: false, // our decision left — the window passes to the others
    pendingAction: {
      event: synthetic,
      kind: mapped.kind,
      amountKey: mapped.amountKey,
      boundarySeq: state.events.reduce(
        (acc, e) => (isBoundaryEvent(state.game, e) && e.seq > acc ? e.seq : acc),
        -1,
      ),
    },
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** A final_action trace action mapped onto its real engine-event shape. */
interface MappedAction {
  readonly type: string;
  readonly data: Record<string, unknown>;
  readonly kind: string;
  readonly amountKey: string | null;
}

/**
 * Map a trace action to the synthetic event to inject (F2). null = do not
 * synthesize: kinds whose real event carries engine-computed fields (dice
 * challenge, coup phase responses) would render with fabricated data.
 */
function mapFinalAction(game: Game | null, action: TraceAction): MappedAction | null {
  const d = action.data ?? {};
  if (game === "texas_holdem") {
    const kind = action.type;
    if (kind !== "fold" && kind !== "check" && kind !== "call" && kind !== "raise" && kind !== "allin") return null;
    const amount = typeof d.amount === "number" ? d.amount : null;
    return {
      type: "player_action",
      data: { action: kind, ...(amount !== null ? { amount } : {}) },
      kind,
      // Only the chips-carrying kinds participate in amount matching.
      amountKey: amount !== null && (kind === "call" || kind === "raise") ? String(amount) : null,
    };
  }
  if (game === "liars_dice") {
    if (action.type !== "bid") return null;
    const quantity = d.quantity;
    const face = d.face;
    if (typeof quantity !== "number" || typeof face !== "number") return null;
    return {
      type: "bid",
      data: { quantity, face },
      kind: "bid",
      amountKey: `${quantity}x${face}`,
    };
  }
  if (game === "coup") {
    const kind = action.type;
    if (
      kind !== "income" && kind !== "foreign_aid" && kind !== "coup" && kind !== "tax" &&
      kind !== "assassinate" && kind !== "steal" && kind !== "exchange"
    ) {
      return null;
    }
    const target = typeof d.target === "string" ? d.target : null;
    return {
      type: "action",
      data: { action: kind, ...(target !== null ? { target } : {}) },
      kind,
      amountKey: target,
    };
  }
  return null;
}

/**
 * The dedupe key of a REAL engine event authored by the owner, for the F2
 * reconciler. null = not an owner action (ignored). Coup phase responses the
 * reducer never synthesizes get a "#<type>" kind that can only MISMATCH a
 * pending turn action — proof the server moved on without applying ours.
 */
function realActionKeyOf(
  game: Game | null,
  e: MatchEvent,
  owner: string,
): { readonly kind: string; readonly amountKey: string | null } | null {
  if (e.player_id !== owner) return null;
  const d = e.data;
  if (game === "texas_holdem" && e.type === "player_action") {
    if (typeof d.action !== "string") return null;
    return { kind: d.action, amountKey: typeof d.amount === "number" ? String(d.amount) : null };
  }
  if (game === "liars_dice") {
    if (e.type === "bid") {
      const q = d.quantity;
      const f = d.face;
      return { kind: "bid", amountKey: typeof q === "number" && typeof f === "number" ? `${q}x${f}` : null };
    }
    if (e.type === "challenge") return { kind: "challenge", amountKey: null };
    return null;
  }
  if (game === "coup") {
    if (e.type === "action") {
      if (typeof d.action !== "string") return null;
      return { kind: d.action, amountKey: typeof d.target === "string" ? d.target : null };
    }
    if (e.type === "challenge" || e.type === "block" || e.type === "challenge_pass" || e.type === "block_pass") {
      return { kind: `#${e.type}`, amountKey: null };
    }
    return null;
  }
  return null;
}

/**
 * Hand/round boundary events (F2): if one arrives while a synthetic is still
 * pending, the hand/round rolled past without the server ever confirming our
 * action → roll the synthetic back. Poker/dice only; Coup has no boundary
 * marker and reconciles on owner-authored events alone.
 */
function isBoundaryEvent(game: Game | null, e: MatchEvent): boolean {
  if (game === "texas_holdem") return e.type === "new_hand";
  if (game === "liars_dice") return e.type === "round_start";
  return false;
}

/**
 * F2 reconciliation: scan a batch of REAL events just folded in and settle the
 * pending synthetic own-action — confirmed (the matching real event takes its
 * place) or rolled back (a different owner action landed, or the hand/round
 * moved on). Processes the batch in order, so a batch containing both our
 * confirmation and the next hand's boundary confirms first.
 */
function reconcilePendingAction(state: LiveMatchState, fresh: readonly MatchEvent[]): LiveMatchState {
  const pending = state.pendingAction;
  const owner = state.ownerPlayerId;
  if (pending === null || owner === null || fresh.length === 0) return state;
  for (const e of fresh) {
    const key = realActionKeyOf(state.game, e, owner);
    if (key !== null) {
      if (key.kind === pending.kind && (pending.amountKey === null || key.amountKey === null || key.amountKey === pending.amountKey)) {
        // Confirmed: the server's real event replaces the synthetic.
        return { ...state, events: state.events.filter((x) => x !== pending.event), pendingAction: null };
      }
      // The server recorded a DIFFERENT action for us — ours never landed
      // (e.g. the turn timer fell back to a forced fold).
      return rollbackPendingAction(state, pending);
    }
    // A hand/round boundary PAST the one current at injection means play moved
    // on without the server ever confirming our action.
    if (isBoundaryEvent(state.game, e) && e.seq > pending.boundarySeq) {
      return rollbackPendingAction(state, pending);
    }
  }
  return state;
}

/** Remove the synthetic, clear the pending slot, and flag the UI notice (F2). */
function rollbackPendingAction(state: LiveMatchState, pending: PendingAction): LiveMatchState {
  return {
    ...state,
    events: state.events.filter((x) => x !== pending.event),
    pendingAction: null,
    myTurn: false, // the window closed without our action landing
    syncNotice: "action_unconfirmed",
  };
}

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
