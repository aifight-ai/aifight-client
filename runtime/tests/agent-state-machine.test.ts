import { describe, expect, it } from "vitest";

import {
  createInitialAgentFSM,
  transitionAgentFSM,
  type AgentFSMEffect,
  type AgentFSMState,
} from "../src/agents/state-machine";
import { MAX_CONCURRENT_MATCHES } from "../src/agents/limits";
import type {
  MsgActionRequest,
  MsgEvent,
  MsgGameOver,
  MsgGameStart,
  MsgGameState,
  MsgMatchCancelled,
  MsgMatchConfirmRequest,
  MsgQueueJoined,
  MsgWelcome,
} from "../src/protocol/types";
import type { WSWelcome } from "../src/wsclient/client";

const welcome: WSWelcome = {
  type: "welcome",
  data: {
    server_protocol_version: "v1.0.0",
    agent_id: "agent-1",
    agent_name: "FSM Agent",
    server_time: "2026-04-26T00:00:00Z",
    games: ["texas_holdem", "liars_dice", "coup"],
  },
};

function initial(overrides: Partial<AgentFSMState> = {}): AgentFSMState {
  return { ...createInitialAgentFSM({ welcome }), ...overrides };
}

function queueJoined(game = "texas_holdem", mode = "ranked"): MsgQueueJoined {
  return { type: "queue_joined", data: { game, mode } };
}

function confirmRequest(game = "texas_holdem", mode = "ranked"): MsgMatchConfirmRequest {
  return {
    type: "match_confirm_request",
    data: {
      confirm_id: "11111111-1111-4111-8111-111111111111",
      game,
      mode,
      players: 2,
      timeout_ms: 30_000,
    },
  };
}

function gameStart(sessionId = "22222222-2222-4222-8222-222222222222"): MsgGameStart {
  return {
    type: "game_start",
    data: {
      match_id: sessionId,
      game: "texas_holdem",
      mode: "ranked",
      your_position: 0,
      player_id: "p0",
      players: [],
      rules: {},
      config: {},
    },
  } as unknown as MsgGameStart;
}

function actionRequest(sessionId = "22222222-2222-4222-8222-222222222222"): MsgActionRequest {
  return {
    type: "action_request",
    data: {
      match_id: sessionId,
      state: {},
      legal_actions: [{ type: "fold" }],
      players: [],
      timeout_ms: 300_000,
      new_events: [],
    },
  } as unknown as MsgActionRequest;
}

function gameState(sessionId = "22222222-2222-4222-8222-222222222222"): MsgGameState {
  return {
    type: "game_state",
    data: { match_id: sessionId, state: {}, players: [] },
  } as unknown as MsgGameState;
}

function gameOver(sessionId = "22222222-2222-4222-8222-222222222222"): MsgGameOver {
  return {
    type: "game_over",
    data: {
      match_id: "33333333-3333-4333-8333-333333333333",
      session_id: sessionId,
      result: { winner: "p0", payoffs: { p0: 1, p1: -1 } },
      players: [],
    },
  } as unknown as MsgGameOver;
}

function eventMessage(): MsgEvent {
  return {
    type: "event",
    data: {
      match_id: "33333333-3333-4333-8333-333333333333",
      events: [],
    },
  };
}

function sendEffect(effects: readonly AgentFSMEffect[]) {
  return effects.find((effect) => effect.type === "send");
}

function notifyEffect(effects: readonly AgentFSMEffect[]) {
  return effects.find((effect) => effect.type === "notify");
}

describe("Agent FSM", () => {
  it("seeds connected state from welcome", () => {
    const state = createInitialAgentFSM({ welcome, autoConfirmMatches: false });

    expect(state).toMatchObject({
      phase: "connected",
      transport: "connected",
      agentId: "agent-1",
      agentName: "FSM Agent",
      autoConfirmMatches: false,
    });
    expect(state.availableGames).toEqual(["texas_holdem", "liars_dice", "coup"]);
  });

  it("join_queue command emits join_queue and enters queuing", () => {
    const out = transitionAgentFSM(initial(), {
      type: "command.join_queue",
      game: "texas_holdem",
      mode: "friendly",
    });

    expect(out.state.phase).toBe("queuing");
    expect(out.state.queue).toEqual({ game: "texas_holdem", mode: "friendly" });
    expect(sendEffect(out.effects)).toEqual({
      type: "send",
      message: { type: "join_queue", data: { game: "texas_holdem", mode: "friendly" } },
    });
  });

  it("join_queue oneShot emits one_shot without changing default joins", () => {
    const out = transitionAgentFSM(initial(), {
      type: "command.join_queue",
      game: "liars_dice",
      oneShot: true,
    });

    expect(out.state.queue).toEqual({ game: "liars_dice", mode: "ranked", one_shot: true });
    expect(sendEffect(out.effects)).toEqual({
      type: "send",
      message: { type: "join_queue", data: { game: "liars_dice", mode: "ranked", one_shot: true } },
    });
  });

  it("queue_joined echo preserves queuing with server game/mode", () => {
    const out = transitionAgentFSM(initial(), {
      type: "ws.message",
      message: queueJoined("liars_dice", "ranked"),
    });

    expect(out.state.phase).toBe("queuing");
    expect(out.state.queue).toEqual({ game: "liars_dice", mode: "ranked" });
    expect(out.effects).toEqual([]);
  });

  it("leave_queue while queued emits leave_queue and clears queue", () => {
    const out = transitionAgentFSM(initial({ phase: "queuing", queue: { game: "coup", mode: "ranked" } }), {
      type: "command.leave_queue",
    });

    expect(out.state.phase).toBe("connected");
    expect(out.state.queue).toBeUndefined();
    expect(sendEffect(out.effects)).toEqual({ type: "send", message: { type: "leave_queue" } });
  });

  it("auto-confirms match_confirm_request by default", () => {
    const out = transitionAgentFSM(initial({ phase: "queuing" }), {
      type: "ws.message",
      message: confirmRequest("coup", "ranked"),
    });

    expect(out.state.phase).toBe("matching");
    expect(out.state.pendingConfirm).toBeUndefined();
    expect(sendEffect(out.effects)).toEqual({
      type: "send",
      message: {
        type: "match_confirm",
        data: { confirm_id: "11111111-1111-4111-8111-111111111111" },
      },
    });
  });

  it("manual match_confirm_request enters confirming without send", () => {
    const out = transitionAgentFSM(initial({ phase: "queuing", autoConfirmMatches: false }), {
      type: "ws.message",
      message: confirmRequest("coup", "ranked"),
    });

    expect(out.state.phase).toBe("confirming");
    expect(out.state.pendingConfirm?.confirm_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(sendEffect(out.effects)).toBeUndefined();
    expect(notifyEffect(out.effects)).toMatchObject({ type: "notify", level: "info" });
  });

  it("confirm command echoes pending confirm id", () => {
    const pendingConfirm = confirmRequest().data;
    const out = transitionAgentFSM(initial({ phase: "confirming", pendingConfirm }), {
      type: "command.confirm_match",
    });

    expect(out.state.phase).toBe("matching");
    expect(out.state.pendingConfirm).toBeUndefined();
    expect(sendEffect(out.effects)).toEqual({
      type: "send",
      message: { type: "match_confirm", data: { confirm_id: pendingConfirm.confirm_id } },
    });
  });

  it("confirmation_timeout cancellation clears pending state", () => {
    const msg: MsgMatchCancelled = {
      type: "match_cancelled",
      data: { reason: "confirmation_timeout", action: "removed_from_queue" },
    };
    const out = transitionAgentFSM(initial({ phase: "confirming", pendingConfirm: confirmRequest().data }), {
      type: "ws.message",
      message: msg,
    });

    expect(out.state.phase).toBe("connected");
    expect(out.state.pendingConfirm).toBeUndefined();
    expect(out.state.queue).toBeUndefined();
    expect(notifyEffect(out.effects)).toMatchObject({ level: "warning" });
  });

  it("opponent_disconnected cancellation re-queues with server game/mode", () => {
    const msg: MsgMatchCancelled = {
      type: "match_cancelled",
      data: {
        reason: "opponent_disconnected",
        action: "re_queued",
        game: "liars_dice",
        mode: "ranked",
      },
    };
    const out = transitionAgentFSM(initial({ phase: "matching" }), {
      type: "ws.message",
      message: msg,
    });

    expect(out.state.phase).toBe("queuing");
    expect(out.state.queue).toEqual({ game: "liars_dice", mode: "ranked" });
    expect(notifyEffect(out.effects)).toMatchObject({ level: "warning" });
  });

  it("game_start creates active match", () => {
    const out = transitionAgentFSM(initial({ phase: "matching" }), {
      type: "ws.message",
      message: gameStart(),
      now: 123,
    });

    expect(out.state.phase).toBe("in_match");
    expect(out.state.activeMatch).toEqual({
      sessionId: "22222222-2222-4222-8222-222222222222",
      game: "texas_holdem",
      startedAt: 123,
    });
  });

  it("action_request creates decision effect", () => {
    const state = initial({
      phase: "in_match",
      activeMatch: { sessionId: "22222222-2222-4222-8222-222222222222", game: "texas_holdem", startedAt: 1 },
    });
    const msg = actionRequest();
    const out = transitionAgentFSM(state, { type: "ws.message", message: msg });

    expect(out.state.phase).toBe("deciding");
    expect(out.state.pendingAction).toBe(msg);
    expect(out.effects).toEqual([
      {
        type: "request_decision",
        actionRequest: msg,
        matchId: "22222222-2222-4222-8222-222222222222",
        game: "texas_holdem",
      },
    ]);
  });

  it("decision.ready emits action and returns to in_match", () => {
    const pendingAction = actionRequest();
    const out = transitionAgentFSM(initial({
      phase: "deciding",
      activeMatch: { sessionId: "22222222-2222-4222-8222-222222222222", game: "texas_holdem", startedAt: 1 },
      pendingAction,
    }), {
      type: "decision.ready",
      action: { type: "fold" },
    });

    expect(out.state.phase).toBe("in_match");
    expect(out.state.pendingAction).toBeUndefined();
    expect(sendEffect(out.effects)).toEqual({
      type: "send",
      message: {
        type: "action",
        match_id: "22222222-2222-4222-8222-222222222222",
        data: { type: "fold" },
      },
    });
  });

  it("decision.ready with usage attaches it to the outgoing action message (§7B-1)", () => {
    const pendingAction = actionRequest();
    const usage = { model: "claude-x", input_tokens: 120, output_tokens: 40 };
    const out = transitionAgentFSM(initial({
      phase: "deciding",
      activeMatch: { sessionId: "22222222-2222-4222-8222-222222222222", game: "texas_holdem", startedAt: 1 },
      pendingAction,
    }), {
      type: "decision.ready",
      action: { type: "fold" },
      usage,
    });

    expect(sendEffect(out.effects)).toEqual({
      type: "send",
      message: {
        type: "action",
        match_id: "22222222-2222-4222-8222-222222222222",
        data: { type: "fold" },
        usage,
      },
    });
  });

  it("decision.ready echoes the action_request's request_id (F07, protocol v1.2)", () => {
    const pendingAction = actionRequest();
    (pendingAction.data as { request_id?: string }).request_id = "req-abc-123";
    const out = transitionAgentFSM(initial({
      phase: "deciding",
      activeMatch: { sessionId: "22222222-2222-4222-8222-222222222222", game: "texas_holdem", startedAt: 1 },
      pendingAction,
    }), {
      type: "decision.ready",
      action: { type: "fold" },
    });

    expect(sendEffect(out.effects)).toEqual({
      type: "send",
      message: {
        type: "action",
        match_id: "22222222-2222-4222-8222-222222222222",
        data: { type: "fold" },
        request_id: "req-abc-123",
      },
    });
  });

  it("decision.ready attaches decision provenance to the outgoing action (F09, protocol v1.2)", () => {
    const pendingAction = actionRequest();
    const decision = { source: "fallback" as const, illegal_retries: 1, fallback_reason: "illegal_runtime_action" };
    const out = transitionAgentFSM(initial({
      phase: "deciding",
      activeMatch: { sessionId: "22222222-2222-4222-8222-222222222222", game: "texas_holdem", startedAt: 1 },
      pendingAction,
    }), {
      type: "decision.ready",
      action: { type: "fold" },
      decision,
    });

    expect(sendEffect(out.effects)).toEqual({
      type: "send",
      message: {
        type: "action",
        match_id: "22222222-2222-4222-8222-222222222222",
        data: { type: "fold" },
        decision,
      },
    });
  });

  it("action_stale is acknowledged without state change or recovery (F07)", () => {
    const state = initial({
      phase: "in_match",
      activeMatch: { sessionId: "22222222-2222-4222-8222-222222222222", game: "coup", startedAt: 1 },
    });
    const out = transitionAgentFSM(state, {
      type: "ws.message",
      message: {
        type: "action_stale",
        data: {
          match_id: "22222222-2222-4222-8222-222222222222",
          reason: "the match is no longer waiting on an action from you",
        },
      } as never,
    });

    expect(out.state).toEqual(state);
    expect(out.effects).toEqual([
      expect.objectContaining({ type: "notify", level: "info", code: "fsm.action_stale" }),
    ]);
  });

  it("decision.failed emits fallback_required and stays deciding", () => {
    const pendingAction = actionRequest();
    const reason = new Error("model failed");
    const out = transitionAgentFSM(initial({ phase: "deciding", pendingAction }), {
      type: "decision.failed",
      reason,
    });

    expect(out.state.phase).toBe("deciding");
    expect(out.effects).toEqual([{ type: "fallback_required", actionRequest: pendingAction, reason }]);
  });

  it("game_over records result and clears match state", () => {
    const state = initial({
      phase: "deciding",
      pendingAction: actionRequest(),
      activeMatch: { sessionId: "22222222-2222-4222-8222-222222222222", game: "texas_holdem", startedAt: 1 },
    });
    const msg = gameOver();
    const out = transitionAgentFSM(state, { type: "ws.message", message: msg });

    expect(out.state.phase).toBe("connected");
    expect(out.state.activeMatch).toBeUndefined();
    expect(out.state.pendingAction).toBeUndefined();
    expect(out.state.lastGameOver).toBe(msg);
    expect(out.effects).toEqual([{ type: "record_result", gameOver: msg, game: "texas_holdem" }]);
  });

  it("game_state while in match emits info without decision effect", () => {
    const out = transitionAgentFSM(
      initial({
        phase: "in_match",
        activeMatch: { sessionId: "22222222-2222-4222-8222-222222222222", game: "texas_holdem", startedAt: 1 },
      }),
      { type: "ws.message", message: gameState() },
    );

    expect(out.state.phase).toBe("in_match");
    expect(out.effects).toEqual([{ type: "notify", level: "info", code: "fsm.game_state", message: "Received game state update" }]);
  });

  it("server error notifies and preserves state", () => {
    const state = initial({ phase: "queuing" });
    const out = transitionAgentFSM(state, {
      type: "ws.message",
      message: { type: "error", data: { message: "bad action" } },
    });

    expect(out.state.phase).toBe("queuing");
    expect(out.state.lastError).toBe("bad action");
    expect(notifyEffect(out.effects)).toMatchObject({ type: "notify", level: "error", code: "server.error" });
  });

  it("server event notifies and preserves state", () => {
    const state = initial({ phase: "in_match" });
    const out = transitionAgentFSM(state, { type: "ws.message", message: eventMessage() });

    expect(out.state).toEqual(state);
    expect(notifyEffect(out.effects)).toMatchObject({ type: "notify", level: "info", code: "server.event" });
  });

  it("reconnect attempt failure sets transport backoff", () => {
    const out = transitionAgentFSM(initial({ phase: "in_match", transport: "connected" }), {
      type: "reconnect.event",
      event: {
        type: "attempt-failure",
        attempt: 2,
        elapsedMs: 1500,
        severity: "warning",
        nextDelayMs: 1000,
      },
    });

    expect(out.state.phase).toBe("in_match");
    expect(out.state.transport).toBe("backoff");
    expect(notifyEffect(out.effects)).toMatchObject({ level: "warning", code: "reconnect.attempt_failure" });
  });

  it("reconnect success restores transport connected without touching match", () => {
    const activeMatch = { sessionId: "m1", game: "coup", startedAt: 1 };
    const out = transitionAgentFSM(initial({ phase: "in_match", transport: "backoff", activeMatch }), {
      type: "reconnect.event",
      event: { type: "attempt-success", attempt: 3, elapsedMs: 2000, severity: "info" },
    });

    expect(out.state.transport).toBe("connected");
    expect(out.state.activeMatch).toBe(activeMatch);
    expect(out.effects).toEqual([]);
  });

  it("reconnect close enters closed state", () => {
    const out = transitionAgentFSM(initial({ phase: "in_match" }), {
      type: "reconnect.close",
      info: { kind: "caller-close", closeReason: "bye" },
    });

    expect(out.state.phase).toBe("closed");
    expect(out.state.transport).toBe("closed");
    expect(notifyEffect(out.effects)).toMatchObject({ level: "error", code: "reconnect.closed" });
  });

  it("closed state ignores later commands with warning", () => {
    const out = transitionAgentFSM(initial({ phase: "closed", transport: "closed" }), {
      type: "command.join_queue",
      game: "coup",
    });

    expect(out.state.phase).toBe("closed");
    expect(sendEffect(out.effects)).toBeUndefined();
    expect(notifyEffect(out.effects)).toMatchObject({ level: "warning", code: "fsm.closed" });
  });

  it("out-of-order queue_left from connected is no-op plus warning", () => {
    const state = initial();
    const out = transitionAgentFSM(state, { type: "command.leave_queue" });

    expect(out.state).toEqual(state);
    expect(notifyEffect(out.effects)).toMatchObject({ level: "warning", code: "fsm.not_queued" });
  });

  it("join_queue for unavailable game is no-op plus warning", () => {
    const state = initial();
    const out = transitionAgentFSM(state, { type: "command.join_queue", game: "mahjong" });

    expect(out.state).toEqual(state);
    expect(notifyEffect(out.effects)).toMatchObject({ level: "warning", code: "fsm.unknown_game" });
  });

  it("action_request for another active match is no-op plus warning", () => {
    const state = initial({
      phase: "in_match",
      activeMatch: { sessionId: "other-session", game: "coup", startedAt: 1 },
    });
    const out = transitionAgentFSM(state, { type: "ws.message", message: actionRequest() });

    expect(out.state).toEqual(state);
    expect(notifyEffect(out.effects)).toMatchObject({ level: "warning", code: "fsm.action_request_mismatch" });
  });

  it("tracks independent pending actions for concurrent matches", () => {
    const first = transitionAgentFSM(initial({ phase: "matching" }), {
      type: "ws.message",
      message: gameStart("session-a"),
      now: 10,
    }).state;
    const second = transitionAgentFSM(first, {
      type: "ws.message",
      message: { ...gameStart("session-b"), data: { ...gameStart("session-b").data, game: "coup" } } as MsgGameStart,
      now: 20,
    }).state;

    const requestA = actionRequest("session-a");
    const requestB = actionRequest("session-b");
    const afterA = transitionAgentFSM(second, { type: "ws.message", message: requestA });
    const afterB = transitionAgentFSM(afterA.state, { type: "ws.message", message: requestB });

    expect(afterB.state.phase).toBe("deciding");
    expect(Object.keys(afterB.state.activeMatches ?? {})).toEqual(["session-a", "session-b"]);
    expect(afterB.state.pendingActions?.["session-a"]).toBe(requestA);
    expect(afterB.state.pendingActions?.["session-b"]).toBe(requestB);

    const readyA = transitionAgentFSM(afterB.state, {
      type: "decision.ready",
      matchId: "session-a",
      action: { type: "fold" },
    });

    expect(readyA.state.phase).toBe("deciding");
    expect(readyA.state.pendingActions?.["session-a"]).toBeUndefined();
    expect(readyA.state.pendingActions?.["session-b"]).toBe(requestB);
    expect(sendEffect(readyA.effects)).toEqual({
      type: "send",
      message: {
        type: "action",
        match_id: "session-a",
        data: { type: "fold" },
      },
    });
  });

  it("stop closes idempotently", () => {
    const first = transitionAgentFSM(initial({ phase: "queuing" }), { type: "stop", reason: "test" });
    const second = transitionAgentFSM(first.state, { type: "stop", reason: "again" });

    expect(first.state.phase).toBe("closed");
    expect(first.state.transport).toBe("closed");
    expect(second.state).toEqual(first.state);
    expect(second.effects).toEqual([]);
  });

  // ─── R13-F02: idempotent, bounded, cancellable decisions ─────────────
  describe("R13-F02 decision hardening", () => {
    const SESSION = "22222222-2222-4222-8222-222222222222";

    function actionRequestWithId(sessionId: string, requestId: string): MsgActionRequest {
      const base = actionRequest(sessionId);
      return { ...base, data: { ...base.data, request_id: requestId } } as MsgActionRequest;
    }

    function inMatch(sessionId = SESSION): AgentFSMState {
      return initial({
        phase: "in_match",
        activeMatch: { sessionId, game: "texas_holdem", startedAt: 1 },
      });
    }

    it("action_request threads request_id into the decision effect", () => {
      const out = transitionAgentFSM(inMatch(), {
        type: "ws.message",
        message: actionRequestWithId(SESSION, "req-1"),
      });
      expect(out.effects).toEqual([
        expect.objectContaining({ type: "request_decision", matchId: SESSION, requestId: "req-1" }),
      ]);
      expect(out.state.lastRequestIds?.[SESSION]).toBe("req-1");
    });

    it("drops a duplicate action_request (same request_id, decision already in flight)", () => {
      const first = transitionAgentFSM(inMatch(), {
        type: "ws.message",
        message: actionRequestWithId(SESSION, "req-1"),
      });
      // Same request_id arrives again while the first is still pending.
      const dup = transitionAgentFSM(first.state, {
        type: "ws.message",
        message: actionRequestWithId(SESSION, "req-1"),
      });
      expect(dup.effects.some((e) => e.type === "request_decision")).toBe(false);
      expect(notifyEffect(dup.effects)).toMatchObject({ code: "fsm.duplicate_action_request" });
    });

    it("processes a superseding action_request (different request_id) for the same match", () => {
      const first = transitionAgentFSM(inMatch(), {
        type: "ws.message",
        message: actionRequestWithId(SESSION, "req-1"),
      });
      const superseding = transitionAgentFSM(first.state, {
        type: "ws.message",
        message: actionRequestWithId(SESSION, "req-2"),
      });
      // NOT dropped — a new decision effect keyed on the new request_id.
      expect(superseding.effects).toEqual([
        expect.objectContaining({ type: "request_decision", matchId: SESSION, requestId: "req-2" }),
      ]);
      expect(superseding.state.lastRequestIds?.[SESSION]).toBe("req-2");
    });

    it(`refuses a NEW game_start beyond MAX_CONCURRENT_MATCHES (${MAX_CONCURRENT_MATCHES})`, () => {
      const activeMatches: Record<string, { sessionId: string; game: string; startedAt: number }> = {};
      for (let i = 0; i < MAX_CONCURRENT_MATCHES; i++) {
        activeMatches[`session-${i}`] = { sessionId: `session-${i}`, game: "coup", startedAt: i };
      }
      const full = initial({ phase: "in_match", activeMatches });
      const out = transitionAgentFSM(full, {
        type: "ws.message",
        message: gameStart("session-overflow"),
        now: 99,
      });
      expect(out.state.activeMatches?.["session-overflow"]).toBeUndefined();
      expect(notifyEffect(out.effects)).toMatchObject({ level: "warning", code: "fsm.match_admission_refused" });
    });

    it("still re-admits an already-active match's game_start at the cap (idempotent)", () => {
      const activeMatches: Record<string, { sessionId: string; game: string; startedAt: number }> = {};
      for (let i = 0; i < MAX_CONCURRENT_MATCHES; i++) {
        activeMatches[`session-${i}`] = { sessionId: `session-${i}`, game: "coup", startedAt: i };
      }
      const full = initial({ phase: "in_match", activeMatches });
      const out = transitionAgentFSM(full, {
        type: "ws.message",
        message: gameStart("session-0"), // already admitted → not a NEW admission
        now: 99,
      });
      expect(out.effects.some((e) => e.type === "notify" && e.code === "fsm.match_admission_refused")).toBe(false);
      expect(out.state.phase).toBe("in_match");
      expect(out.state.activeMatches?.["session-0"]).toBeDefined();
    });

    it("forgets a match's last request_id on game_over (bounded map)", () => {
      const decided = transitionAgentFSM(inMatch(), {
        type: "ws.message",
        message: actionRequestWithId(SESSION, "req-1"),
      });
      expect(decided.state.lastRequestIds?.[SESSION]).toBe("req-1");
      const over = transitionAgentFSM(decided.state, { type: "ws.message", message: gameOver(SESSION) });
      expect(over.state.lastRequestIds?.[SESSION]).toBeUndefined();
    });
  });
});
