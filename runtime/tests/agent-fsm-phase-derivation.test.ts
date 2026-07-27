import { describe, expect, it } from "vitest";

import {
  createInitialAgentFSM,
  transitionAgentFSM,
  type AgentFSMEffect,
  type AgentFSMState,
} from "../src/agents/state-machine";
import { isSafeAutoUpdatePhase } from "../src/bridge/auto-update";
import type { MsgActionRequest, MsgGameStart } from "../src/protocol/types";
import type { WSWelcome } from "../src/wsclient/client";

// D1 (windows-loop). `phase` is one scalar but the FSM runs several matches at
// once, so any match's event used to overwrite every other match's progress —
// and two guards read that scalar, which turned the overwrite into a lost turn:
// a finished, already-paid-for decision was discarded as stale, the turn went
// unanswered, and the server judged a forfeit. Reachable on default settings.
//
// The fix makes phase a pure projection of the concrete per-match state (see
// docs/agent-bridge/AGENT_FSM_PHASE_DERIVATION_DESIGN.md). These tests pin the
// scenarios that used to lose a match. Mutation-checked: restoring any of the
// hard-written phases turns them red.

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

const MATCH_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MATCH_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function base(): AgentFSMState {
  return createInitialAgentFSM({ welcome });
}

function gameStart(matchId: string, game = "texas_holdem"): MsgGameStart {
  return {
    type: "game_start",
    data: {
      match_id: matchId,
      game,
      mode: "ranked",
      your_position: 0,
      player_id: "p0",
      players: [],
      rules: {},
      config: {},
    },
  } as unknown as MsgGameStart;
}

function actionRequest(matchId: string, requestId?: string): MsgActionRequest {
  return {
    type: "action_request",
    data: {
      match_id: matchId,
      state: {},
      legal_actions: [{ type: "fold" }],
      players: [],
      timeout_ms: 300_000,
      new_events: [],
      ...(requestId !== undefined ? { request_id: requestId } : {}),
    },
  } as unknown as MsgActionRequest;
}

function sendEffects(effects: readonly AgentFSMEffect[]) {
  return effects.filter((e): e is Extract<AgentFSMEffect, { type: "send" }> => e.type === "send");
}

function step(state: AgentFSMState, input: Parameters<typeof transitionAgentFSM>[1]): AgentFSMState {
  return transitionAgentFSM(state, input).state;
}

/** Agent in match A with a decision in flight for it. */
function decidingOnA(): AgentFSMState {
  let s = step(base(), { type: "ws.message", message: gameStart(MATCH_A), now: 1 });
  s = step(s, { type: "ws.message", message: actionRequest(MATCH_A, "req-a1") });
  expect(s.phase).toBe("deciding");
  return s;
}

describe("D1 — phase is a projection, not a scalar other matches can trample", () => {
  it("a second match starting does NOT discard the first match's in-flight decision", () => {
    let s = decidingOnA();

    // The exact step that used to break it: match B starts while A is deciding.
    s = step(s, { type: "ws.message", message: gameStart(MATCH_B, "coup"), now: 2 });
    expect(s.phase).toBe("deciding"); // A still owes an answer — that outranks B being in_match

    const out = transitionAgentFSM(s, {
      type: "decision.ready",
      action: { type: "fold" },
      matchId: MATCH_A,
    });

    const sends = sendEffects(out.effects);
    expect(
      sends,
      "match A's decision must still be submitted; dropping it is the unanswered turn that gets judged a loss",
    ).toHaveLength(1);
    expect(sends[0]!.message).toMatchObject({ type: "action", match_id: MATCH_A, request_id: "req-a1" });
    // Both matches survive: answering A must not evict B.
    expect(Object.keys(out.state.activeMatches ?? {}).sort()).toEqual([MATCH_A, MATCH_B].sort());
  });

  it("a second match starting does NOT block the first match's next action_request", () => {
    let s = decidingOnA();
    s = step(s, { type: "decision.ready", action: { type: "fold" }, matchId: MATCH_A });
    s = step(s, { type: "ws.message", message: gameStart(MATCH_B, "coup"), now: 2 });

    const out = transitionAgentFSM(s, { type: "ws.message", message: actionRequest(MATCH_A, "req-a2") });
    expect(out.effects.some((e) => e.type === "request_decision")).toBe(true);
  });

  it("joining a queue while playing does not strand the running match", () => {
    let s = decidingOnA();

    s = step(s, { type: "command.join_queue", game: "liars_dice" });
    expect(s.queue?.game).toBe("liars_dice");
    // Queuing must NOT outrank a decision in flight.
    expect(s.phase).toBe("deciding");

    const out = transitionAgentFSM(s, {
      type: "decision.ready",
      action: { type: "fold" },
      matchId: MATCH_A,
    });
    expect(sendEffects(out.effects)).toHaveLength(1);
    expect(out.state.queue?.game).toBe("liars_dice"); // and the queue join stands
  });

  it("leaving a queue while playing is allowed and leaves the match alone", () => {
    let s = decidingOnA();
    s = step(s, { type: "command.join_queue", game: "liars_dice" });

    const out = transitionAgentFSM(s, { type: "command.leave_queue" });
    expect(
      sendEffects(out.effects).map((e) => e.message.type),
      "leave_queue must work while in a match — the old phase test refused it",
    ).toEqual(["leave_queue"]);
    expect(out.state.queue).toBeUndefined();
    expect(out.state.phase).toBe("deciding");
    expect(out.state.pendingActions?.[MATCH_A] ?? out.state.pendingAction).toBeTruthy();
  });

  it("leave_queue is still refused when there is genuinely no queue", () => {
    const out = transitionAgentFSM(base(), { type: "command.leave_queue" });
    expect(out.effects).toEqual([
      { type: "notify", level: "warning", code: "fsm.not_queued", message: expect.any(String) },
    ]);
  });

  it("a match_confirm_request for a second match does not trample a live decision", () => {
    let s = decidingOnA();
    s = step(s, { type: "command.join_queue", game: "coup" });
    s = step(s, {
      type: "ws.message",
      message: {
        type: "match_confirm_request",
        data: {
          confirm_id: "11111111-1111-4111-8111-111111111111",
          game: "coup",
          mode: "ranked",
          players: 2,
          timeout_ms: 30_000,
        },
      } as never,
    });

    expect(s.phase).toBe("deciding");
    expect(s.confirmed?.game, "the confirm itself is recorded, it just does not outrank the live match").toBe("coup");
    expect(sendEffects(transitionAgentFSM(s, {
      type: "decision.ready",
      action: { type: "fold" },
      matchId: MATCH_A,
    }).effects)).toHaveLength(1);
  });
});

describe("D1 — the matching phase stays reachable now that it is derived", () => {
  it("auto-confirm reaches matching, and game_start clears it", () => {
    let s = step(base(), { type: "command.join_queue", game: "coup" });
    s = step(s, {
      type: "ws.message",
      message: {
        type: "match_confirm_request",
        data: {
          confirm_id: "11111111-1111-4111-8111-111111111111",
          game: "coup",
          mode: "ranked",
          players: 2,
          timeout_ms: 30_000,
        },
      } as never,
    });
    expect(s.phase).toBe("matching");
    expect(s.confirmed?.confirmId).toBe("11111111-1111-4111-8111-111111111111");

    s = step(s, { type: "ws.message", message: gameStart(MATCH_A, "coup"), now: 5 });
    expect(s.phase).toBe("in_match");
    expect(s.confirmed, "a started match must not leave a stale confirm behind").toBeUndefined();
  });

  it("manual confirm reaches matching, and a cancellation clears it", () => {
    let s = step(base(), { type: "command.join_queue", game: "coup" });
    s = { ...s, autoConfirmMatches: false };
    s = step(s, {
      type: "ws.message",
      message: {
        type: "match_confirm_request",
        data: {
          confirm_id: "11111111-1111-4111-8111-111111111111",
          game: "coup",
          mode: "ranked",
          players: 2,
          timeout_ms: 30_000,
        },
      } as never,
    });
    expect(s.phase).toBe("confirming");

    s = step(s, { type: "command.confirm_match" });
    expect(s.phase).toBe("matching");
    expect(s.pendingConfirm).toBeUndefined();

    s = step(s, {
      type: "ws.message",
      message: {
        type: "match_cancelled",
        data: { reason: "confirmation_timeout", action: "removed_from_queue" },
      } as never,
    });
    expect(s.phase).toBe("connected");
    expect(s.confirmed).toBeUndefined();
  });
});

describe("D1 — downstream consumers get a MORE accurate phase", () => {
  it("an agent playing one match while queued for another is reported busy to the updater", () => {
    let s = step(base(), { type: "ws.message", message: gameStart(MATCH_A), now: 1 });
    s = step(s, { type: "command.join_queue", game: "liars_dice" });

    expect(s.phase).toBe("in_match");
    expect(
      isSafeAutoUpdatePhase(s.phase),
      "before D1 this read 'queuing' and the bridge would restart mid-match to self-update",
    ).toBe(false);
  });

  it("closed stays closed and is never re-derived from leftover match state", () => {
    let s = decidingOnA();
    s = step(s, { type: "stop" });
    expect(s.phase).toBe("closed");

    // Anything arriving after stop must be ignored, not re-derive a live phase.
    const out = transitionAgentFSM(s, { type: "ws.message", message: actionRequest(MATCH_A, "req-late") });
    expect(out.state.phase).toBe("closed");
  });
});

// D2 (windows-loop). AgentInstance used to swallow a failed send: it logged and
// moved on, so the FSM went on believing the message had gone out. For an
// `action` that is the whole game — decisionReady has ALREADY cleared the
// match's pending action, so the agent thinks it answered, the server never got
// an answer, and the turn times out into a judged loss. A network blip sufficed.
describe("D2 — a send that never left the process must be visible to the FSM", () => {
  function afterFailedActionSend() {
    const s = decidingOnA();
    const submitted = transitionAgentFSM(s, {
      type: "decision.ready",
      action: { type: "fold" },
      matchId: MATCH_A,
    });
    const sent = sendEffects(submitted.effects)[0]!;
    expect(sent.restoreOnFailure, "decisionReady must say what to put back").toBeTruthy();
    // The FSM has already moved on — that is exactly the dangerous moment.
    expect(submitted.state.pendingActions?.[MATCH_A]).toBeUndefined();
    expect(submitted.state.lastRequestIds?.[MATCH_A]).toBe("req-a1");

    return transitionAgentFSM(submitted.state, {
      type: "send.failed",
      message: sent.message,
      restore: sent.restoreOnFailure!,
      cause: new Error("socket closed"),
    });
  }

  it("puts the unanswered turn back", () => {
    const out = afterFailedActionSend();
    expect(out.state.pendingActions?.[MATCH_A] ?? out.state.pendingAction).toBeTruthy();
    expect(out.state.phase, "we still owe an answer, and the phase should say so").toBe("deciding");
    expect(out.effects).toContainEqual(
      expect.objectContaining({ type: "notify", level: "error", code: "fsm.send_failed" }),
    );
  });

  it("re-opens the duplicate gate so the server's redelivery is honoured", () => {
    const out = afterFailedActionSend();
    expect(
      out.state.lastRequestIds?.[MATCH_A],
      "keeping the id here is the trap: with the pending action restored, a redelivery of the SAME " +
        "request_id would hit actionRequest's duplicate gate and the match would wedge forever",
    ).toBeUndefined();

    // Prove it end to end: the server redelivers the same request_id.
    const redelivered = transitionAgentFSM(out.state, {
      type: "ws.message",
      message: actionRequest(MATCH_A, "req-a1"),
    });
    expect(
      redelivered.effects.some((e) => e.type === "request_decision"),
      "the redelivered turn must be decided again, not swallowed as a duplicate",
    ).toBe(true);
  });

  it("does not resurrect a turn that has since been superseded", () => {
    const s = decidingOnA();
    const submitted = transitionAgentFSM(s, {
      type: "decision.ready",
      action: { type: "fold" },
      matchId: MATCH_A,
    });
    const sent = sendEffects(submitted.effects)[0]!;
    // A newer action_request for the same match arrives before the failure lands.
    const newer = step(submitted.state, { type: "ws.message", message: actionRequest(MATCH_A, "req-a2") });

    const out = transitionAgentFSM(newer, {
      type: "send.failed",
      message: sent.message,
      restore: sent.restoreOnFailure!,
      cause: new Error("socket closed"),
    });
    expect(
      out.state.pendingActions?.[MATCH_A]?.data.request_id ?? out.state.pendingAction?.data.request_id,
      "the newer request must survive; restoring the stale one would answer the wrong turn",
    ).toBe("req-a2");
    expect(out.state.lastRequestIds?.[MATCH_A]).toBe("req-a2");
  });

  it("a failed non-action send is reported without touching match bookkeeping", () => {
    const s = decidingOnA();
    const out = transitionAgentFSM(s, {
      type: "send.failed",
      message: { type: "leave_queue" },
      cause: new Error("socket closed"),
    });
    expect(out.state).toEqual(s);
    expect(out.effects).toContainEqual(
      expect.objectContaining({ type: "notify", code: "fsm.send_failed" }),
    );
  });
});
