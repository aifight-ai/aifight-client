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
  readonly pendingConfirm?: MsgMatchConfirmRequest["data"];
  readonly activeMatch?: AgentFSMActiveMatch;
  readonly activeMatches?: Readonly<Record<string, AgentFSMActiveMatch>>;
  readonly pendingAction?: MsgActionRequest;
  readonly pendingActions?: Readonly<Record<string, MsgActionRequest>>;
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
  | { type: "reconnect.event"; event: ReconnectEvent }
  | { type: "reconnect.close"; info: ReconnectCloseInfo }
  | { type: "stop"; reason?: string };

export type AgentFSMEffect =
  | { type: "send"; message: WSClientMessage }
  | { type: "request_decision"; actionRequest: MsgActionRequest; matchId: string; game?: string }
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
    {
      ...state,
      phase: "queuing",
      queue,
      pendingConfirm: undefined,
      lastGameOver: undefined,
    },
    [{ type: "send", message: { type: "join_queue", data: queue } }],
  );
}

function leaveQueue(state: AgentFSMState): AgentFSMTransition {
  if (state.phase !== "queuing" && state.phase !== "confirming" && state.phase !== "matching") {
    return warn(state, "fsm.not_queued", "Ignoring leave_queue because agent is not queued");
  }
  return ok(
    {
      ...state,
      phase: "connected",
      queue: undefined,
      pendingConfirm: undefined,
    },
    [{ type: "send", message: { type: "leave_queue" } }],
  );
}

function confirmMatch(state: AgentFSMState, confirmId?: string): AgentFSMTransition {
  const id = confirmId ?? state.pendingConfirm?.confirm_id;
  if (!id || state.phase !== "confirming") {
    return warn(state, "fsm.no_pending_confirm", "Ignoring match confirmation without a pending confirm request");
  }
  return ok(
    {
      ...state,
      phase: "matching",
      pendingConfirm: undefined,
    },
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
      return ok({ ...state, phase: derivePhase({ ...state, queue: undefined, pendingConfirm: undefined }), queue: undefined, pendingConfirm: undefined });
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
  return ok({
    ...state,
    phase: "queuing",
    queue: {
      game: msg.data.game,
      mode: normalizeMode(msg.data.mode),
      ...(msg.data.one_shot === true ? { one_shot: true } : {}),
    },
  });
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
      {
        ...state,
        phase: "matching",
        queue,
        pendingConfirm: undefined,
      },
      [{ type: "send", message: { type: "match_confirm", data: { confirm_id: msg.data.confirm_id } } }],
    );
  }
  return ok(
    {
      ...state,
      phase: "confirming",
      queue,
      pendingConfirm: msg.data,
    },
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
      {
        ...state,
        phase: queue ? "queuing" : derivePhase({ ...state, queue: undefined, pendingConfirm: undefined }),
        queue,
        pendingConfirm: undefined,
      },
      [notify("warning", "fsm.match_cancelled", `Match cancelled: ${msg.data.reason}`)],
    );
  }
  return ok(
    {
      ...state,
      phase: derivePhase({ ...state, queue: undefined, pendingConfirm: undefined }),
      queue: undefined,
      pendingConfirm: undefined,
    },
    [notify("warning", "fsm.match_cancelled", `Match cancelled: ${msg.data.reason}`)],
  );
}

function gameStart(state: AgentFSMState, msg: MsgGameStart, now?: number): AgentFSMTransition {
  const activeMatch = {
    sessionId: msg.data.match_id,
    game: msg.data.game,
    startedAt: now ?? 0,
  };
  const activeMatches = {
    ...normalizeActiveMatches(state),
    [activeMatch.sessionId]: activeMatch,
  };
  return ok({
    ...state,
    phase: "in_match",
    queue: undefined,
    pendingConfirm: undefined,
    activeMatch,
    activeMatches,
  });
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
    { ...state, phase: Object.keys(activeMatches).length > 0 ? derivePhase({ ...state, activeMatches }) : state.phase },
    [notify("info", "fsm.game_state", "Received game state update")],
  );
}

function actionRequest(state: AgentFSMState, msg: MsgActionRequest): AgentFSMTransition {
  if (state.phase !== "in_match" && state.phase !== "deciding") {
    return warn(state, "fsm.action_request_out_of_phase", "Ignoring action_request outside an active match");
  }
  const activeMatches = normalizeActiveMatches(state);
  const activeMatch = activeMatches[msg.data.match_id];
  if (!activeMatch) {
    return warn(
      state,
      "fsm.action_request_mismatch",
      `Ignoring action_request for session ${msg.data.match_id}; no active session with that id`,
    );
  }
  const pendingActions = {
    ...normalizePendingActions(state),
    [msg.data.match_id]: msg,
  };
  return ok(
    {
      ...state,
      phase: "deciding",
      activeMatch,
      activeMatches,
      pendingAction: msg,
      pendingActions,
    },
    [
      {
        type: "request_decision",
        actionRequest: msg,
        matchId: msg.data.match_id,
        game: activeMatch.game,
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
  if (state.phase !== "deciding" || !id || !pendingAction) {
    return warn(state, "fsm.no_pending_action", "Ignoring decision result without a pending action_request");
  }
  const nextPendingActions = { ...pendingActions };
  delete nextPendingActions[id];
  const activeMatches = normalizeActiveMatches(state);
  const nextPendingAction = selectPendingAction(nextPendingActions);
  return ok(
    {
      ...state,
      phase: derivePhase({ ...state, activeMatches, pendingAction: nextPendingAction, pendingActions: nextPendingActions }),
      activeMatch: selectActiveMatch(activeMatches, id),
      activeMatches: emptyRecordAsUndefined(activeMatches),
      pendingAction: nextPendingAction,
      pendingActions: emptyRecordAsUndefined(nextPendingActions),
    },
    [
      {
        type: "send",
        message: {
          type: "action",
          match_id: pendingAction.data.match_id,
          data: action,
          // F07 (protocol v1.2): echo the request_id so the server can
          // recognize an answer to a superseded request and reply with a
          // benign action_stale instead of judging it against new state.
          ...(pendingAction.data.request_id !== undefined
            ? { request_id: pendingAction.data.request_id }
            : {}),
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
  if (state.phase !== "deciding" || !id || !pendingAction) {
    return warn(state, "fsm.no_pending_action", "Ignoring decision failure without a pending action_request");
  }
  return ok(state, [{ type: "fallback_required", actionRequest: pendingAction, reason }]);
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
  return ok(
    {
      ...state,
      phase: derivePhase({
        ...state,
        activeMatch: undefined,
        activeMatches: nextActiveMatches,
        pendingAction: nextPendingAction,
        pendingActions: nextPendingActions,
        queue: undefined,
      }),
      queue: undefined,
      pendingConfirm: undefined,
      activeMatch: selectActiveMatch(nextActiveMatches),
      activeMatches: emptyRecordAsUndefined(nextActiveMatches),
      pendingAction: nextPendingAction,
      pendingActions: emptyRecordAsUndefined(nextPendingActions),
      lastGameOver: msg,
    },
    [{
      type: "record_result",
      gameOver: msg,
      ...(activeMatch?.game !== undefined ? { game: activeMatch.game } : {}),
    }],
  );
}

function serverError(state: AgentFSMState, msg: MsgError): AgentFSMTransition {
  const message = typeof msg.data.message === "string" ? msg.data.message : "Server error";
  return ok({ ...state, lastError: message }, [notify("error", "server.error", message)]);
}

function serverEvent(state: AgentFSMState, msg: MsgEvent): AgentFSMTransition {
  return ok(state, [
    notify("info", "server.event", `Received server event batch (${msg.data.events.length} events)`),
  ]);
}

function reconnectEvent(state: AgentFSMState, event: ReconnectEvent): AgentFSMTransition {
  if (event.type === "attempt-success") {
    return ok({ ...state, transport: "connected" });
  }
  if (event.type === "attempt-start") {
    return ok({ ...state, transport: "backoff" }, [
      notify("info", "reconnect.attempt_start", `Reconnect attempt ${event.attempt} started`),
    ]);
  }
  if (event.type === "attempt-failure") {
    return ok({ ...state, transport: "backoff" }, [
      notify(event.severity, "reconnect.attempt_failure", `Reconnect attempt ${event.attempt} failed`),
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
  if (state.queue) {
    return "queuing";
  }
  return "connected";
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
