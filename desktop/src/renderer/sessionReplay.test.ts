// D10 — tests for the history-replay builder. Confirms a stored export rebuilds
// the board through the live reducer (so info-hiding is inherited) and tolerates
// shape drift without throwing.

import { describe, it, expect } from "vitest";

import { buildReplayFromExport } from "./sessionReplay";

const SID = "sess-1234";

function exportFixture() {
  return {
    summary: { session_id: SID, game: "texas_holdem" },
    inbound: [
      {
        at: "t0",
        direction: "inbound",
        type: "game_start",
        message: {
          type: "game_start",
          data: {
            match_id: SID,
            game: "texas_holdem",
            your_position: 0,
            your_player_id: "p0",
            players: [
              { position: 0, name: "Player 1", player_id: "p0" },
              { position: 1, name: "Player 2", player_id: "p1" },
            ],
          },
        },
      },
      {
        at: "t1",
        direction: "inbound",
        type: "action_request",
        message: {
          type: "action_request",
          data: {
            match_id: SID,
            timeout_ms: 300000,
            state: { phase: "flop", hand_num: 1, your_hand: ["As", "Ks"], your_chips: 9900 },
            legal_actions: [],
            players: [],
            new_events: [
              { type: "new_hand", data: { hand_num: 1 }, seq: 0, ts: "t1a" },
              { type: "player_action", player: "p1", data: { action: "raise", amount: 200 }, seq: 1, ts: "t1b" },
            ],
          },
        },
      },
      {
        at: "t2",
        direction: "inbound",
        type: "game_over",
        message: {
          type: "game_over",
          data: {
            match_id: "real-9",
            session_id: SID,
            result: { winner: "p0", payoffs: { p0: 100, p1: -100 }, is_draw: false },
            players: [
              { player_id: "p0", position: 0, agent_id: "u0", agent_name: "Mine" },
              { player_id: "p1", position: 1, agent_id: "u1", agent_name: "Rival" },
            ],
            replay_url: "/replay/real-9",
          },
        },
      },
    ],
    outbound: [],
    decisions: [
      {
        at: "t1",
        kind: "decision",
        traces: [
          { type: "decision_request", matchId: SID, game: "texas_holdem", playerId: "p0", legalActionCount: 4, timeoutMs: 300000, strategy: [] },
          { type: "runtime_success", matchId: SID, attempt: 1, raw: { kind: "text", sha256: "abc", bytes: 10, preview: "raise for value" } },
          { type: "final_action", matchId: SID, source: "runtime", action: { type: "raise", data: { amount: 600 } } },
        ],
      },
    ],
    strategySnapshot: null,
  };
}

describe("buildReplayFromExport", () => {
  it("reconstructs the board, owner hand, and finished outcome from stored frames", () => {
    const { state, traces } = buildReplayFromExport(exportFixture());
    expect(state.game).toBe("texas_holdem");
    expect(state.finished).toBe(true);
    expect(state.outcome).toBe("win");
    // engine events folded
    const types = state.events.map((e) => e.type);
    expect(types).toContain("new_hand");
    expect(types).toContain("player_action");
    // owner private surfaced + injected once
    expect(state.ownerPrivate.holeCards).toEqual(["As", "Ks"]);
    const dealt = state.events.filter((e) => e.type === "cards_dealt");
    expect(dealt).toHaveLength(1);
    expect(dealt[0].player_id).toBe("p0");
    // real names revealed at game_over; owner stays "You"
    expect(state.match?.players.find((p) => p.player_id === "p1")?.agent_name).toBe("Rival");
    expect(state.match?.players.find((p) => p.player_id === "p0")?.agent_name).toBe("You");
    // decision traces flattened in order
    expect(traces.map((t) => t.type)).toEqual(["decision_request", "runtime_success", "final_action"]);
  });

  it("🔒 inherits information hiding — no opponent ever gets injected cards", () => {
    const { state } = buildReplayFromExport(exportFixture());
    expect(state.events.some((e) => e.type === "cards_dealt" && e.player_id !== "p0")).toBe(false);
  });

  it("tolerates missing / malformed exports without throwing", () => {
    expect(buildReplayFromExport(undefined).state.match).toBeNull();
    expect(buildReplayFromExport({}).state.match).toBeNull();
    expect(buildReplayFromExport({ inbound: "nope", decisions: 42 }).traces).toEqual([]);
    expect(buildReplayFromExport({ inbound: [{ message: { nope: true } }] }).state.match).toBeNull();
  });
});
