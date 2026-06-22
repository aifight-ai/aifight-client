import { describe, expect, it } from "vitest";

import {
  buildDecisionProtocolRequest,
  DecisionProtocolResponseError,
  readDecisionProtocolAction,
} from "../src/decision/protocol";
import type { AgentDecisionContext } from "../src/agents/agent";

function makeContext(overrides: Partial<AgentDecisionContext["actionRequest"]["data"]> = {}): AgentDecisionContext {
  return {
    matchId: "session-1",
    game: "coup",
    state: {
      phase: "deciding",
      transport: "connected",
      agentId: "agent-1",
      agentName: "Agent One",
      availableGames: ["coup"],
      autoConfirmMatches: true,
    },
    actionRequest: {
      type: "action_request",
      data: {
        match_id: "session-1",
        state: { coins: 3 },
        legal_actions: [{ type: "income" }],
        players: [],
        timeout_ms: 300_000,
        new_events: [{ type: "turn_started", data: {} }],
        ...overrides,
      },
    } as AgentDecisionContext["actionRequest"],
  };
}

describe("Decision Protocol v1", () => {
  it("builds a runtime-independent request from AgentDecisionContext", () => {
    const req = buildDecisionProtocolRequest(makeContext(), {
      requestId: "req-1",
      now: new Date("2026-05-20T00:00:00.000Z"),
      strategy: [{ name: "general", format: "markdown", sha256: "abc" }],
    });

    expect(req).toMatchObject({
      type: "aifight.decision.request",
      protocol_version: "aifight.decision.v1",
      request_id: "req-1",
      agent: { id: "agent-1", name: "Agent One" },
      match: { session_id: "session-1", game: "coup" },
      turn: {
        timeout_ms: 300_000,
        deadline_at: "2026-05-20T00:05:00.000Z",
        is_reconnect: false,
        retry: false,
      },
      context: {
        state: { coins: 3 },
        legal_actions: [{ type: "income" }],
        events: [{ type: "turn_started", data: {} }],
      },
      strategy: [{ name: "general", format: "markdown", sha256: "abc" }],
    });
  });

  it("normalizes null legal actions and reconnect event history", () => {
    const req = buildDecisionProtocolRequest(makeContext({
      legal_actions: null,
      new_events: null,
      is_reconnect: true,
      event_history: [{ type: "game_started", data: {} }],
    }));

    expect(req.context.legal_actions).toEqual([]);
    expect(req.context.events).toEqual([{ type: "game_started", data: {} }]);
    expect(req.turn.is_reconnect).toBe(true);
  });

  it("reads action from a protocol response", () => {
    expect(readDecisionProtocolAction({ action: { type: "income" } })).toEqual({ type: "income" });
    expect(() => readDecisionProtocolAction({ summary: "missing" })).toThrow(DecisionProtocolResponseError);
    expect(() => readDecisionProtocolAction({ action: undefined })).toThrow(DecisionProtocolResponseError);
  });
});
