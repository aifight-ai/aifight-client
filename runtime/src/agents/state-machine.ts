// M1-08 Agent finite-state machine.
//
// This module is deliberately pure: no sockets, no timers, no storage,
// no model calls, and no Date.now(). It turns external inputs into the
// next state plus effects for M1-09 AgentInstance to execute.

import type {
  MsgActionRequest,
  MsgActionStale,
  MsgError,
  MsgEvent,
  MsgGameOver,
  MsgGameStart,
  MsgGameState,
  MsgMatchCancelled,
  MsgMatchConfirmRequest,
  MsgQueueJoined,
} from "../protocol/types";
import type { ServerMessageEnvelope } from "../wsclient/frame-handler";
import type { WSClientMessage, WSWelcome } from "../wsclient/client";
import type { ReconnectCloseInfo, ReconnectEvent } from "../wsclient/reconnect";
import { MAX_CONCURRENT_MATCHES } from "./limits";

export type AgentPhase =
  | "connected"
  | "queuing"
  | "confirming"
  | "matching"
  | "in_match"
  | "deciding"
  | "reporting"
  | "closed";

export type AgentTransportState = "connected" | "backoff" | "closed";

export interface AgentFSMState {
  readonly phase: AgentPhase;
  readonly transport: AgentTransportState;
  readonly agentId: string;
  readonly agentName: string;
  readonly availableGames: readonly string[];
  readonly autoConfirmMatches: boolean;
  readonly queue?: { readonly game: string; readonly mode: string; readonly one_shot?: boolean };
  /**
   * Bookkeeping for an OPTIMISTIC join_queue: set when command.join_queue
   * applies the queue locally before the server's verdict arrives, cleared by
   * queue_joined (accept), an error frame (reject → rolled back), leave_queue,
   * game_start, or a reconnect. `previous` is the last CONFIRMED queue
   * membership, so a rejected join restores what the server actually still
   * holds instead of leaving the runtime believing in a queue that was
   * refused (the 2026-07-29 desktop state fork: app showed the new game,
   * the server still had the old one).
   */
  readonly pendingQueueJoin?: {
    readonly previous?: { readonly game: string; readonly mode: string; readonly one_shot?: boolean };
  };
  readonly pendingConfirm?: MsgMatchConfirmRequest["data"];
  /**
   * D1: set once we have SENT match_confirm and are waiting for game_start —
   * i.e. the "matching" phase. Without it that fact would live only in the
   * `phase` scalar, and phase is now a derived projection (see derivePhase), so
   * it has to be recoverable from real state. Single-slot on purpose, same as
   * `queue`/`pendingConfirm`: the server gives an agent one queue entry.
   */
  readonly confirmed?: { readonly confirmId: string; readonly game: string; readonly mode: string };
  readonly activeMatch?: AgentFSMActiveMatch;
  readonly activeMatches?: Readonly<Record<string, AgentFSMActiveMatch>>;
  readonly pendingAction?: MsgActionRequest;
  readonly pendingActions?: Readonly<Record<string, MsgActionRequest>>;
  /**
   * Most-recently-processed action_request `request_id` per match (R13-F02
   * idempotency). A repeat delivery of the same request_id while that match
   * still has a decision in flight is dropped instead of spawning a second
   * (paid) provider call. A DIFFERENT request_id for the same match is a
   * genuine supersede and is processed (the agent aborts the stale call).
   */
  readonly lastRequestIds?: Readonly<Record<string, string>>;
  readonly lastGameOver?: MsgGameOver;
  readonly lastError?: string;
}

export interface AgentFSMActiveMatch {
  readonly sessionId: string;
  readonly game: string;
  readonly startedAt: number;
}

/**
 * Wire-shape model usage metadata attached to an outbound action message
 * (protocol v1.1 client_action.schema.json `usage`). Token counts only —
 * never prompts or model output. Field names are snake_case because this
 * object is sent verbatim on the wire.
 */
export interface AgentDecisionWireUsage {
  readonly model: string;
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly reasoning_tokens?: number;
  readonly cached_tokens?: number;
  readonly cache_write_tokens?: number;
}

/**
 * Wire-shape decision-provenance telemetry attached to an outbound action
 * message (protocol v1.2 client_action.schema.json `decision`, F09/AIF-03):
 * who actually authored the action — the model, the model after corrective
 * feedback, or the bridge's deterministic fallback. Carried separately from
 * `usage` because a fallback decision involves no model call. snake_case:
 * sent verbatim on the wire.
 */
export interface AgentDecisionWireDecision {
  readonly source: "model" | "model_retry" | "fallback";
  readonly illegal_retries?: number;
  readonly fallback_reason?: string;
}

export type AgentFSMInput =
  | { type: "start"; welcome: WSWelcome; autoConfirmMatches?: boolean; now?: number }
  | { type: "command.join_queue"; game: string; mode?: string; oneShot?: boolean }
  | { type: "command.leave_queue" }
  | { type: "command.confirm_match"; confirmId?: string }
  | { type: "ws.message"; message: ServerMessageEnvelope; now?: number }
  | { type: "decision.ready"; action: unknown; matchId?: string; usage?: AgentDecisionWireUsage; decision?: AgentDecisionWireDecision }
  | { type: "decision.failed"; reason: unknown; matchId?: string }
  /**
   * D2: an outbound message could not be handed to the socket. Without this the
   * FSM believed every send succeeded — see sendFailed() for what that cost.
   */
  | { type: "send.failed"; message: WSClientMessage; restore?: MsgActionRequest; cause: unknown }
  | { type: "reconnect.event"; event: ReconnectEvent }
  | { type: "reconnect.close"; info: ReconnectCloseInfo }
  | { type: "stop"; reason?: string };

export type AgentFSMEffect =
  /**
   * D2: `restoreOnFailure` is the action_request this message answers. Effects
   * run on a serialized queue, so the send happens strictly AFTER the state
   * update that produced it — carrying the payload here is what lets a failed
   * send be undone without parking it in FSM state for the gap in between.
   */
  | { type: "send"; message: WSClientMessage; restoreOnFailure?: MsgActionRequest }
  | { type: "request_decision"; actionRequest: MsgActionRequest; matchId: string; game?: string; requestId?: string }
  | { type: "fallback_required"; actionRequest: MsgActionRequest; reason: unknown }
  | { type: "record_result"; gameOver: MsgGameOver; game?: string }
  | { type: "notify"; level: "info" | "warning" | "error"; code: string; message: string };

export interface AgentFSMTransition {
  readonly state: AgentFSMState;
  readonly effects: readonly AgentFSMEffect[];
}

export interface CreateInitialAgentFSMInput {
  readonly welcome: WSWelcome;
  readonly autoConfirmMatches?: boolean;
  readonly now?: number;
}

export function createInitialAgentFSM(input: CreateInitialAgentFSMInput): AgentFSMState {
  return {
    phase: "connected",
    transport: "connected",
    agentId: input.welcome.data.agent_id,
    agentName: input.welcome.data.agent_name,
    availableGames: [...input.welcome.data.games],
    autoConfirmMatches: input.autoConfirmMatches ?? true,
  };
}

export function transitionAgentFSM(
  state: AgentFSMState,
  input: AgentFSMInput,
): AgentFSMTransition {
  if (input.type === "start") {
    return ok(createInitialAgentFSM(input));
  }
  if (state.phase === "closed") {
    if (input.type === "stop") return ok(state);
    return warn(state, "fsm.closed", `Ignoring ${input.type} because agent FSM is closed`);
  }

  switch (input.type) {
    case "command.join_queue":
      return joinQueue(state, input.game, input.mode, input.oneShot);
    case "command.leave_queue":
      return leaveQueue(state);
    case "command.confirm_match":
      return confirmMatch(state, input.confirmId);
    case "ws.message":
      return applyServerMessage(state, input.message, input.now);
    case "decision.ready":
      return decisionReady(state, input.action, input.matchId, input.usage, input.decision);
    case "decision.failed":
      return decisionFailed(state, input.reason, input.matchId);
    case "send.failed":
      return sendFailed(state, input.message, input.restore, input.cause);
    case "reconnect.event":
      return reconnectEvent(state, input.event);
    case "reconnect.close":
      return reconnectClose(state, input.info);
    case "stop":
      return ok({ ...state, phase: "closed", transport: "closed" });
  }
}

function joinQueue(state: AgentFSMState, game: string, mode?: string, oneShot?: boolean): AgentFSMTransition {
  if (!state.availableGames.includes(game)) {
    return warn(state, "fsm.unknown_game", `Cannot join unavailable game '${game}'`);
  }
  const queue = {
    game,
    mode: normalizeMode(mode),
    ...(oneShot === true ? { one_shot: true } : {}),
  };
  return ok(
    withDerivedPhase({
      ...state,
      queue,
      // Mark the join as awaiting its server verdict. A rapid second join
      // before the first verdict keeps the ORIGINAL previous membership —
      // the optimistic queue of the first join was never confirmed, so it
      // must not become the rollback target.
      pendingQueueJoin: { previous: state.pendingQueueJoin ? state.pendingQueueJoin.previous : state.queue },
      pendingConfirm: undefined,
      confirmed: undefined,
      lastGameOver: undefined,
    }),
    [{ type: "send", message: { type: "join_queue", data: queue } }],
  );
}

function leaveQueue(state: AgentFSMState): AgentFSMTransition {
  // D1: ask about the QUEUE, not about the aggregate phase. Now that phase
  // reports the most important thing, an agent that is playing one match while
  // queued for another reads "in_match" — and the old phase test would have
  // refused to let it leave that queue.
  if (!state.queue && !state.pendingConfirm && !state.confirmed) {
    return warn(state, "fsm.not_queued", "Ignoring leave_queue because agent is not queued");
  }
  return ok(
    withDerivedPhase({
      ...state,
      queue: undefined,
      // An explicit leave makes any unconfirmed join moot — without clearing
      // the marker, a late error frame would resurrect the queue the user
      // just asked to exit.
      pendingQueueJoin: undefined,
      pendingConfirm: undefined,
      confirmed: undefined,
    }),
    [{ type: "send", message: { type: "leave_queue" } }],
  );
}

function confirmMatch(state: AgentFSMState, confirmId?: string): AgentFSMTransition {
  const id = confirmId ?? state.pendingConfirm?.confirm_id;
  // D1: the pending confirm itself is the precondition, not the phase.
  if (!id || !state.pendingConfirm) {
    return warn(state, "fsm.no_pending_confirm", "Ignoring match confirmation without a pending confirm request");
  }
  return ok(
    withDerivedPhase({
      ...state,
      pendingConfirm: undefined,
      confirmed: {
        confirmId: id,
        game: state.pendingConfirm.game,
        mode: normalizeMode(state.pendingConfirm.mode),
      },
    }),
    [{ type: "send", message: { type: "match_confirm", data: { confirm_id: id } } }],
  );
}

function applyServerMessage(
  state: AgentFSMState,
  message: ServerMessageEnvelope,
  now?: number,
): AgentFSMTransition {
  switch (message.type) {
    case "queue_joined":
      return queueJoined(state, message as MsgQueueJoined);
    case "queue_left":
      return ok(withDerivedPhase({ ...state, queue: undefined, pendingConfirm: undefined, confirmed: undefined }));
    case "match_confirm_request":
      return matchConfirmRequest(state, message as MsgMatchConfirmRequest);
    case "match_cancelled":
      return matchCancelled(state, message as MsgMatchCancelled);
    case "game_start":
      return gameStart(state, message as MsgGameStart, now);
    case "game_state":
      return gameState(state, message as MsgGameState);
    case "action_request":
      return actionRequest(state, message as MsgActionRequest);
    case "action_stale":
      return actionStale(state, message as MsgActionStale);
    case "game_over":
      return gameOver(state, message as MsgGameOver);
    case "error":
      return serverError(state, message as MsgError);
    case "event":
      return serverEvent(state, message as MsgEvent);
    default:
      return warn(state, "fsm.unknown_server_message", `Ignoring unknown server message '${message.type}'`);
  }
}

function queueJoined(state: AgentFSMState, msg: MsgQueueJoined): AgentFSMTransition {
  return ok(
    withDerivedPhase({
      ...state,
      confirmed: undefined,
      // The server's accept verdict: the join is confirmed, so there is no
      // optimistic membership left to roll back.
      pendingQueueJoin: undefined,
      queue: {
        game: msg.data.game,
        mode: normalizeMode(msg.data.mode),
        ...(msg.data.one_shot === true ? { one_shot: true } : {}),
      },
    }),
  );
}

function matchConfirmRequest(
  state: AgentFSMState,
  msg: MsgMatchConfirmRequest,
): AgentFSMTransition {
  const queue = {
    game: msg.data.game,
    mode: normalizeMode(msg.data.mode),
    ...(state.queue?.one_shot === true ? { one_shot: true } : {}),
  };
  if (state.autoConfirmMatches) {
    return ok(
      withDerivedPhase({
        ...state,
        queue,
        pendingConfirm: undefined,
        confirmed: { confirmId: msg.data.confirm_id, game: queue.game, mode: queue.mode },
      }),
      [{ type: "send", message: { type: "match_confirm", data: { confirm_id: msg.data.confirm_id } } }],
    );
  }
  return ok(
    withDerivedPhase({
      ...state,
      queue,
      pendingConfirm: msg.data,
      confirmed: undefined,
    }),
    [
      notify(
        "info",
        "fsm.match_confirm_required",
        `Match confirmation required for ${msg.data.game}/${msg.data.mode}`,
      ),
    ],
  );
}

function matchCancelled(state: AgentFSMState, msg: MsgMatchCancelled): AgentFSMTransition {
  if (msg.data.action === "re_queued") {
    const fallbackQueue = state.pendingConfirm
      ? { game: state.pendingConfirm.game, mode: normalizeMode(state.pendingConfirm.mode) }
      : state.queue;
    const queue =
      msg.data.reason === "opponent_disconnected"
        ? { game: msg.data.game, mode: normalizeMode(msg.data.mode) }
        : fallbackQueue;
    return ok(
      withDerivedPhase({
        ...state,
        queue,
        pendingConfirm: undefined,
        confirmed: undefined,
      }),
      [notify("warning", "fsm.match_cancelled", `Match cancelled: ${msg.data.reason}`)],
    );
  }
  return ok(
    withDerivedPhase({
      ...state,
      queue: undefined,
      pendingConfirm: undefined,
      confirmed: undefined,
    }),
    [notify("warning", "fsm.match_cancelled", `Match cancelled: ${msg.data.reason}`)],
  );
}

function gameStart(state: AgentFSMState, msg: MsgGameStart, now?: number): AgentFSMTransition {
  const existingMatches = normalizeActiveMatches(state);
  const alreadyAdmitted = existingMatches[msg.data.match_id] !== undefined;
  // R13-F02 local admission gate: refuse a NEW match once we already hold
  // MAX_CONCURRENT_MATCHES. The server's readiness probe is answered with the
  // same ceiling, so this is a belt-and-suspenders backstop for a race where a
  // match is started anyway; it never drops turns of an already-admitted match
  // (that path re-admits below). Refusing here is safer than accepting an
  // (N+1)th match and spawning unbounded parallel paid decision loops.
  if (!alreadyAdmitted && Object.keys(existingMatches).length >= MAX_CONCURRENT_MATCHES) {
    return warn(
      state,
      "fsm.match_admission_refused",
      `Refusing game_start for session ${msg.data.match_id}; already at ${MAX_CONCURRENT_MATCHES} concurrent matches`,
    );
  }
  const activeMatch = {
    sessionId: msg.data.match_id,
    game: msg.data.game,
    startedAt: now ?? 0,
  };
  const activeMatches = {
    ...existingMatches,
    [activeMatch.sessionId]: activeMatch,
  };
  // D1: derived, NOT `phase: "in_match"`. Hard-writing it here is the exact
  // step that used to discard another match's in-flight decision as stale.
  return ok(
    withDerivedPhase({
      ...state,
      queue: undefined,
      // A started match settles any optimistic join still awaiting a verdict.
      pendingQueueJoin: undefined,
      pendingConfirm: undefined,
      confirmed: undefined,
      activeMatch,
      activeMatches,
    }),
  );
}

function gameState(state: AgentFSMState, msg: MsgGameState): AgentFSMTransition {
  const activeMatches = normalizeActiveMatches(state);
  const activeMatch = activeMatches[msg.data.match_id];
  if (Object.keys(activeMatches).length > 0 && !activeMatch) {
    return warn(
      state,
      "fsm.game_state_mismatch",
      `Ignoring game_state for session ${msg.data.match_id}; no active session with that id`,
    );
  }
  return ok(
    Object.keys(activeMatches).length > 0 ? withDerivedPhase({ ...state, activeMatches }) : state,
    [notify("info", "fsm.game_state", "Received game state update")],
  );
}

function actionRequest(state: AgentFSMState, msg: MsgActionRequest): AgentFSMTransition {
  const activeMatches = normalizeActiveMatches(state);
  // D1: ask whether we hold ANY match, not what the aggregate phase says — a
  // phase test here rejected turns of a live match whenever a queue/confirm
  // event for a DIFFERENT match had lowered the scalar.
  if (Object.keys(activeMatches).length === 0) {
    return warn(state, "fsm.action_request_out_of_phase", "Ignoring action_request outside an active match");
  }
  const activeMatch = activeMatches[msg.data.match_id];
  if (!activeMatch) {
    return warn(
      state,
      "fsm.action_request_mismatch",
      `Ignoring action_request for session ${msg.data.match_id}; no active session with that id`,
    );
  }
  const matchId = msg.data.match_id;
  const requestId = typeof msg.data.request_id === "string" ? msg.data.request_id : undefined;
  const existingPending = normalizePendingActions(state);
  // R13-F02 idempotency: a repeat delivery of the SAME request_id for a match
  // that already has a decision in flight must not spawn a second paid provider
  // call. A different request_id (or no request_id) is a genuine new/superseding
  // request and is processed — the agent aborts any stale in-flight call.
  if (
    requestId !== undefined &&
    existingPending[matchId] !== undefined &&
    state.lastRequestIds?.[matchId] === requestId
  ) {
    return warn(
      state,
      "fsm.duplicate_action_request",
      `Ignoring duplicate action_request (request_id ${requestId}) for session ${matchId}; a decision is already in flight`,
    );
  }
  const pendingActions = {
    ...existingPending,
    [matchId]: msg,
  };
  const lastRequestIds =
    requestId !== undefined
      ? { ...(state.lastRequestIds ?? {}), [matchId]: requestId }
      : state.lastRequestIds;
  return ok(
    withDerivedPhase({
      ...state,
      activeMatch,
      activeMatches,
      pendingAction: msg,
      pendingActions,
      ...(lastRequestIds !== undefined ? { lastRequestIds } : {}),
    }),
    [
      {
        type: "request_decision",
        actionRequest: msg,
        matchId,
        game: activeMatch.game,
        ...(requestId !== undefined ? { requestId } : {}),
      },
    ],
  );
}

// actionStale acknowledges that an action we sent answered a SUPERSEDED
// action_request (protocol v1.2, F07/R3-01) — e.g. another responder closed a
// Coup challenge/block window first. Not our fault, nothing to recover: the
// pending action for that session was already cleared when we sent the
// action, and the server will send a fresh action_request when it actually
// wants something from us.
function actionStale(state: AgentFSMState, msg: MsgActionStale): AgentFSMTransition {
  return ok(state, [
    notify(
      "info",
      "fsm.action_stale",
      `Action for session ${msg.data.match_id} answered a superseded request (${msg.data.reason}); waiting for the next action_request`,
    ),
  ]);
}

function decisionReady(
  state: AgentFSMState,
  action: unknown,
  matchId?: string,
  usage?: AgentDecisionWireUsage,
  decision?: AgentDecisionWireDecision,
): AgentFSMTransition {
  const id = matchId ?? state.pendingAction?.data.match_id;
  const pendingActions = normalizePendingActions(state);
  const pendingAction = id ? pendingActions[id] ?? (state.pendingAction?.data.match_id === id ? state.pendingAction : undefined) : undefined;
  // D1: a pending action for THIS match is the precondition. The old
  // `phase !== "deciding"` term is now redundant (a pending action derives that
  // phase) AND was the bug: another match's event could lower the scalar and
  // this decision — already paid for — was thrown away.
  if (!id || !pendingAction) {
    return warn(state, "fsm.no_pending_action", "Ignoring decision result without a pending action_request");
  }
  const nextPendingActions = { ...pendingActions };
  delete nextPendingActions[id];
  const activeMatches = normalizeActiveMatches(state);
  const nextPendingAction = selectPendingAction(nextPendingActions);
  return ok(
    withDerivedPhase({
      ...state,
      activeMatch: selectActiveMatch(activeMatches, id),
      activeMatches: emptyRecordAsUndefined(activeMatches),
      pendingAction: nextPendingAction,
      pendingActions: emptyRecordAsUndefined(nextPendingActions),
    }),
    [
      {
        type: "send",
        // D2: if this never reaches the socket, put the turn back.
        restoreOnFailure: pendingAction,
        message: {
          type: "action",
          match_id: pendingAction.data.match_id,
          data: action,
          // F07 (protocol v1.2, REQUIRED since the 2026-07-16 enforcement):
          // echo the request_id so the server can pin this answer to the
          // decision it belongs to; an id-less submission is refused unjudged.
          request_id: pendingAction.data.request_id,
          ...(usage !== undefined ? { usage } : {}),
          // F09 (protocol v1.2): decision provenance — lets the platform
          // show how much of the record is model vs local fallback.
          ...(decision !== undefined ? { decision } : {}),
        },
      },
    ],
  );
}

function decisionFailed(state: AgentFSMState, reason: unknown, matchId?: string): AgentFSMTransition {
  const id = matchId ?? state.pendingAction?.data.match_id;
  const pendingActions = normalizePendingActions(state);
  const pendingAction = id ? pendingActions[id] ?? (state.pendingAction?.data.match_id === id ? state.pendingAction : undefined) : undefined;
  // D1: same as decisionReady — the pending action is the precondition.
  if (!id || !pendingAction) {
    return warn(state, "fsm.no_pending_action", "Ignoring decision failure without a pending action_request");
  }
  // R15 2026-07-26: forget this match's last request_id on failure — otherwise
  // a server redelivery of the same request_id would be swallowed by the
  // duplicate gate (see actionRequest) and the agent would lose its retry.
  const nextLastRequestIds = pruneRecord(state.lastRequestIds, id);
  return ok(
    {
      ...state,
      ...(nextLastRequestIds !== undefined ? { lastRequestIds: nextLastRequestIds } : { lastRequestIds: undefined }),
    },
    [{ type: "fallback_required", actionRequest: pendingAction, reason }],
  );
}

// D2 (windows-loop, 2026-07-26). AgentInstance used to swallow a failed send:
// it logged and moved on, so the FSM went on believing the message had gone out.
// For an `action` that is the whole game — decisionReady has ALREADY cleared the
// match's pending action, so the agent thinks it answered, the server never got
// an answer, and the turn times out into a judged loss. A network blip was
// enough.
//
// Recovery has two halves and BOTH are required:
//   - put the pending action back, because we do still owe an answer (and the
//     phase derives back to "deciding", which is the honest report); and
//   - drop this match's lastRequestId, or the server's redelivery of the SAME
//     request_id hits actionRequest's duplicate gate (pending action present +
//     same id) and is swallowed — which would wedge the match permanently,
//     strictly worse than the bug being fixed.
//
// Non-action sends (join_queue, match_confirm, leave_queue) have no per-match
// bookkeeping to undo; they are reported and left to the caller/server to retry.
function sendFailed(
  state: AgentFSMState,
  message: WSClientMessage,
  restore: MsgActionRequest | undefined,
  cause: unknown,
): AgentFSMTransition {
  const detail = cause instanceof Error ? cause.message : String(cause);
  if (message.type !== "action") {
    return warn(
      state,
      "fsm.send_failed",
      `Failed to send ${message.type}: ${detail}`,
    );
  }
  const matchId = message.match_id;
  const pendingActions = normalizePendingActions(state);
  if (!restore || pendingActions[matchId] !== undefined) {
    // Nothing to restore (or the match already has a newer request in flight,
    // which supersedes the one we failed to answer).
    return warn(
      state,
      "fsm.send_failed",
      `Failed to send action for session ${matchId}: ${detail}`,
    );
  }
  return ok(
    withDerivedPhase({
      ...state,
      pendingActions: { ...pendingActions, [matchId]: restore },
      pendingAction: restore,
      ...(() => {
        const pruned = pruneRecord(state.lastRequestIds, matchId);
        return pruned !== undefined ? { lastRequestIds: pruned } : { lastRequestIds: undefined };
      })(),
    }),
    [
      notify(
        "error",
        "fsm.send_failed",
        `Failed to send action for session ${matchId} (${detail}); the turn is still owed — awaiting the server's redelivery`,
      ),
    ],
  );
}

function gameOver(state: AgentFSMState, msg: MsgGameOver): AgentFSMTransition {
  const activeMatches = normalizeActiveMatches(state);
  const activeMatch = activeMatches[msg.data.session_id];
  if (Object.keys(activeMatches).length > 0 && !activeMatch) {
    return warn(
      state,
      "fsm.game_over_mismatch",
      `Ignoring game_over for session ${msg.data.session_id}; no active session with that id`,
    );
  }
  const nextActiveMatches = { ...activeMatches };
  delete nextActiveMatches[msg.data.session_id];
  const nextPendingActions = { ...normalizePendingActions(state) };
  delete nextPendingActions[msg.data.session_id];
  const nextPendingAction = selectPendingAction(nextPendingActions);
  // R13-F02: forget this match's last request_id so the per-agent map cannot
  // grow without bound across a long-lived agent's many matches.
  const nextLastRequestIds = pruneRecord(state.lastRequestIds, msg.data.session_id);
  return ok(
    withDerivedPhase({
      ...state,
      queue: undefined,
      pendingConfirm: undefined,
      confirmed: undefined,
      activeMatch: selectActiveMatch(nextActiveMatches),
      activeMatches: emptyRecordAsUndefined(nextActiveMatches),
      pendingAction: nextPendingAction,
      pendingActions: emptyRecordAsUndefined(nextPendingActions),
      ...(nextLastRequestIds !== undefined ? { lastRequestIds: nextLastRequestIds } : { lastRequestIds: undefined }),
      lastGameOver: msg,
    }),
    [{
      type: "record_result",
      gameOver: msg,
      ...(activeMatch?.game !== undefined ? { game: activeMatch.game } : {}),
    }],
  );
}

function serverError(state: AgentFSMState, msg: MsgError): AgentFSMTransition {
  const message = typeof msg.data.message === "string" ? msg.data.message : "Server error";
  const effects: AgentFSMEffect[] = [notify("error", "server.error", message)];
  // Error frames carry no request id, so an exact join_queue correlation is
  // impossible — but the connection is ordered and the server answers a
  // join_queue synchronously, so the join's verdict (queue_joined or error)
  // always lands BEFORE the error of any message sent after it. "An error
  // arrived while a join is unconfirmed" is therefore conservatively treated
  // as that join's rejection: roll the optimistic queue back to the last
  // confirmed membership (undefined when there was none). If the error in
  // fact belonged to something earlier on the wire, the join's real
  // queue_joined arrives right after and re-establishes the queue — the
  // rollback is then a transient, never a fork.
  if (state.pendingQueueJoin) {
    effects.push(
      notify(
        "warning",
        "fsm.join_queue_rejected",
        "Queue join rejected by the server; restored the previous queue state",
      ),
    );
    return ok(
      withDerivedPhase({
        ...state,
        queue: state.pendingQueueJoin.previous,
        pendingQueueJoin: undefined,
        lastError: message,
      }),
      effects,
    );
  }
  return ok({ ...state, lastError: message }, effects);
}

function serverEvent(state: AgentFSMState, msg: MsgEvent): AgentFSMTransition {
  return ok(state, [
    notify("info", "server.event", `Received server event batch (${msg.data.events.length} events)`),
  ]);
}

function reconnectEvent(state: AgentFSMState, event: ReconnectEvent): AgentFSMTransition {
  if (event.type === "attempt-success") {
    // The success MUST be told (审查 F8): this used to emit nothing, leaving
    // every host blind to recovery — the desktop pill sat on「连接中」while
    // the bridge was online for 82 minutes (2026-07-25 incident).
    //
    // Queue truth (连接审计 #15, 2026-07-28): the server drops this agent from
    // every queue the moment the old socket dies (hub.OnQueueLeave), so any
    // queue/pendingConfirm carried across a reconnect is a stale belief —
    // Telegram/control-API kept reporting「匹配中」for a queue that no longer
    // existed. Clear it; the caller re-joins explicitly (BridgeRunner rejoin).
    // activeMatches is untouched: a mid-match reconnect stays in_match.
    return ok(
      withDerivedPhase({
        ...state,
        transport: "connected",
        queue: undefined,
        pendingQueueJoin: undefined,
        pendingConfirm: undefined,
        confirmed: undefined,
      }),
      [
        notify(
          "info",
          "reconnect.attempt_success",
          `Reconnected (attempt ${event.attempt})`,
        ),
      ],
    );
  }
  if (event.type === "attempt-start") {
    return ok({ ...state, transport: "backoff" }, [
      notify("info", "reconnect.attempt_start", `Reconnect attempt ${event.attempt} started`),
    ]);
  }
  if (event.type === "attempt-failure") {
    // Always state WHY. A bare "attempt N failed" is what made the 2026-07-24
    // eviction storm unreadable: the log looked identical whether the network
    // was down or another local client had taken over the same agent.
    const cause = event.cause?.message ? `: ${event.cause.message}` : "";
    const retryIn =
      typeof event.nextDelayMs === "number"
        ? ` (retrying in ${Math.round(event.nextDelayMs / 1000)}s)`
        : "";
    return ok({ ...state, transport: "backoff" }, [
      notify(
        event.severity,
        "reconnect.attempt_failure",
        `Reconnect attempt ${event.attempt} failed${cause}${retryIn}`,
      ),
    ]);
  }
  if (event.type === "parked") {
    // Seat taken by another connection — the facade is probing, NOT dead.
    // Deliberately NOT phase "closed": parked is a recoverable state (redesign
    // P7), and letting it fall through to the give-up arm below would have the
    // FSM tear the agent down over a state the facade recovers from on its own.
    return ok({ ...state, transport: "backoff" }, [
      notify(
        "warning",
        "reconnect.parked",
        "Another connection holds this agent's seat — standing by, probing every few minutes",
      ),
    ]);
  }
  if (event.type === "superseded-self") {
    // Structurally impossible under single-flight unless something forged our
    // instance id or the invariant regressed — either way it must be LOUD
    // (审查 F7/F10: a silent stop here would be a forgeable kill switch).
    return ok({ ...state, transport: "backoff" }, [
      notify(
        "error",
        "reconnect.superseded_self",
        "Evicted by a connection claiming THIS process's identity — parking and probing (possible instance-id forgery or a client bug; please report)",
      ),
    ]);
  }
  return ok(
    { ...state, phase: "closed", transport: "closed" },
    [notify(event.severity, "reconnect.give_up", "Reconnect gave up")],
  );
}

function reconnectClose(state: AgentFSMState, info: ReconnectCloseInfo): AgentFSMTransition {
  return ok(
    { ...state, phase: "closed", transport: "closed" },
    [notify("error", "reconnect.closed", `Reconnect closed: ${info.kind}`)],
  );
}

function normalizeActiveMatches(state: AgentFSMState): Record<string, AgentFSMActiveMatch> {
  const activeMatches: Record<string, AgentFSMActiveMatch> = { ...(state.activeMatches ?? {}) };
  if (state.activeMatch) {
    activeMatches[state.activeMatch.sessionId] = state.activeMatch;
  }
  return activeMatches;
}

function normalizePendingActions(state: AgentFSMState): Record<string, MsgActionRequest> {
  const pendingActions: Record<string, MsgActionRequest> = { ...(state.pendingActions ?? {}) };
  if (state.pendingAction) {
    pendingActions[state.pendingAction.data.match_id] = state.pendingAction;
  }
  return pendingActions;
}

function emptyRecordAsUndefined<T>(record: Record<string, T>): Readonly<Record<string, T>> | undefined {
  return Object.keys(record).length > 0 ? record : undefined;
}

/** Return the record without `key`, or undefined when the result is empty (so
 *  the optional state field is dropped rather than kept as `{}`). */
function pruneRecord<T>(
  record: Readonly<Record<string, T>> | undefined,
  key: string,
): Readonly<Record<string, T>> | undefined {
  if (record === undefined || record[key] === undefined) return record;
  const next = { ...record };
  delete next[key];
  return emptyRecordAsUndefined(next);
}

function selectActiveMatch(
  activeMatches: Record<string, AgentFSMActiveMatch>,
  preferredSessionId?: string,
): AgentFSMActiveMatch | undefined {
  if (preferredSessionId && activeMatches[preferredSessionId]) {
    return activeMatches[preferredSessionId];
  }
  const lastKey = Object.keys(activeMatches).at(-1);
  return lastKey ? activeMatches[lastKey] : undefined;
}

function selectPendingAction(pendingActions: Record<string, MsgActionRequest>): MsgActionRequest | undefined {
  const lastKey = Object.keys(pendingActions).at(-1);
  return lastKey ? pendingActions[lastKey] : undefined;
}

// D1 (windows-loop, 2026-07-26). `phase` is a SCALAR but this FSM runs several
// matches at once (activeMatches / pendingActions are keyed by match_id). One
// scalar cannot hold every match's progress, so any match's event used to
// overwrite every other match's — and two guards read that scalar, which turned
// the overwrite into a lost turn:
//
//   1. match A's action_request  → phase "deciding", A's provider call starts
//   2. match B's game_start      → phase hard-set to "in_match"
//   3. A's decision comes back   → phase is not "deciding" → discarded as stale
//   4. A never answers           → server turn timeout → judged a loss
//
// Reachable on default settings, with no error anywhere. Joining a queue while
// a match is running was enough to trigger it too.
//
// The priority order below is the fix: a phase that means "there is work in
// flight" outranks one that means "waiting around", so the phase always reports
// the most important thing and no other match's event can lower it.
// DO NOT reorder these — swapping deciding/in_match revives the bug outright.
//
// See docs/agent-bridge/AGENT_FSM_PHASE_DERIVATION_DESIGN.md.
function derivePhase(state: AgentFSMState): AgentPhase {
  if (Object.keys(normalizePendingActions(state)).length > 0) {
    return "deciding";
  }
  if (Object.keys(normalizeActiveMatches(state)).length > 0) {
    return "in_match";
  }
  if (state.pendingConfirm) {
    return "confirming";
  }
  if (state.confirmed) {
    return "matching";
  }
  if (state.queue) {
    return "queuing";
  }
  return "connected";
}

/**
 * The single place `phase` is decided. Every transition that changes a
 * phase-relevant field returns through here instead of writing a literal.
 *
 * `closed` is the one phase that stays hard-written: it is a true terminal
 * state, not implied by any field. transitionAgentFSM short-circuits on it at
 * the top, so a closed FSM never reaches a derive site anyway — this guard is
 * belt-and-braces.
 */
function withDerivedPhase(state: AgentFSMState): AgentFSMState {
  if (state.phase === "closed") return state;
  return { ...state, phase: derivePhase(state) };
}

function ok(state: AgentFSMState, effects: readonly AgentFSMEffect[] = []): AgentFSMTransition {
  return { state, effects };
}

function warn(state: AgentFSMState, code: string, message: string): AgentFSMTransition {
  return ok(state, [notify("warning", code, message)]);
}

function notify(
  level: "info" | "warning" | "error",
  code: string,
  message: string,
): AgentFSMEffect {
  return { type: "notify", level, code, message };
}

function normalizeMode(mode: string | undefined): string {
  return mode && mode.length > 0 ? mode : "ranked";
}
