// M1-20 Step 3: agent FSM reducer fixture replay.
//
// Drives every transcript through the public state-machine API
// (`createInitialAgentFSM` + `transitionAgentFSM`,
// runtime/src/agents/state-machine.ts:83 / :94) — pure helper-side
// wrap, NO src diff (R3/R5 hard contract). All assertions read the
// post-transition `state` snapshot or the accumulated `effects[]`
// array (`AgentFSMEffect` enum, runtime/src/agents/state-machine.ts:65)
// — never undefined fields like `state.eventSeq` / `state.lastResult`.
//
// Internal-only — no source modification, no new dep.

import { describe, expect, it, test } from "vitest";
import {
  createInitialAgentFSM,
  transitionAgentFSM,
  type AgentFSMState,
  type AgentFSMEffect,
} from "../src/agents/state-machine";
import type { WSWelcome } from "../src/wsclient/client";
import { loadAllTranscripts, loadTranscript, type LoadedTranscript } from "./_fixtures/transcripts";

interface DriveResult {
  readonly state: AgentFSMState;
  readonly effects: readonly AgentFSMEffect[];
  readonly transitions: number;
}

/**
 * Drive a transcript through the FSM by feeding every server_to_client
 * message as `ws.message` and every client_to_server action as
 * `decision.ready`. Returns the final state + accumulated effects[].
 *
 * Uses createInitialAgentFSM on the FIRST welcome entry; subsequent
 * welcomes (reconnect transcript) flow through ws.message which hits
 * the state-machine's `welcome` re-handler.
 *
 * autoConfirmMatches defaults to true so match_confirm_request
 * auto-emits a `send: match_confirm` effect (state-machine.ts:221-230).
 * The transcript's recorded `client_to_server match_confirm` is then
 * a no-op replay (state-machine has no `command.confirm_match` issued
 * because auto-confirm already fired).
 */
function syntheticWelcome(t: LoadedTranscript): WSWelcome {
  // Some transcripts (happy_path/* + coup forfeit) are mid-match
  // captures that start at game_start, no welcome on wire. Synthesize
  // a minimal welcome so createInitialAgentFSM can prime the FSM. The
  // agent_id is taken from the transcript's first entry actor (anon
  // UUID per anonymizer); games is set to runtime's full registered
  // set.
  const firstEntry = t.entries[0];
  return {
    type: "welcome",
    data: {
      server_protocol_version: "v1.0.0",
      agent_id: firstEntry.actor,
      agent_name: "Fixture Agent",
      server_time: "2026-04-29T00:00:00Z",
      games: ["texas_holdem", "liars_dice", "coup"],
    },
  };
}

function driveTranscript(t: LoadedTranscript): DriveResult {
  const firstWelcome = t.entries.find((e) => e.payload.type === "welcome");
  const welcome: WSWelcome = firstWelcome
    ? (firstWelcome.payload as unknown as WSWelcome)
    : syntheticWelcome(t);
  let st = createInitialAgentFSM({ welcome });
  const allEffects: AgentFSMEffect[] = [];
  let transitions = 0;
  let firstWelcomeConsumed = false;

  for (const e of t.entries) {
    if (e.direction === "server_to_client") {
      // Skip the very first welcome — already used to init.
      if (e.payload.type === "welcome" && !firstWelcomeConsumed) {
        firstWelcomeConsumed = true;
        continue;
      }
      const r = transitionAgentFSM(st, {
        type: "ws.message",
        message: e.payload as never,
        now: e.timestamp_ms,
      });
      st = r.state;
      transitions += 1;
      for (const eff of r.effects) allEffects.push(eff);
      continue;
    }
    if (e.direction === "client_to_server") {
      // Recorded action → drive decision.ready so the FSM emits the
      // outbound send effect (mirrors the real decision layer).
      // join_queue / leave_queue / match_confirm are auto-handled or
      // not required for fixture replay.
      if (e.payload.type === "action") {
        const r = transitionAgentFSM(st, {
          type: "decision.ready",
          action: (e.payload as { data?: unknown }).data,
        });
        st = r.state;
        transitions += 1;
        for (const eff of r.effects) allEffects.push(eff);
      }
      continue;
    }
  }
  return { state: st, effects: allEffects, transitions };
}

const ALL = loadAllTranscripts();

// ---- Group 5.1: full-sequence drive does not throw ----

describe("fixtures-state-machine: drive without throw", () => {
  test.each(ALL.map((t) => [t.name, t] as const))(
    "%s: full transcript drives FSM cleanly",
    (_name, t: LoadedTranscript) => {
      expect(() => driveTranscript(t)).not.toThrow();
      const r = driveTranscript(t);
      expect(r.transitions).toBeGreaterThan(0);
    },
  );
});

// ---- Group 5.2: terminal classification per replay-test-spec §5 ----

describe("fixtures-state-machine: terminal classification", () => {
  test.each(ALL.map((t) => [t.name, t] as const))(
    "%s: terminal entry drives FSM to consistent end-state",
    (_name, t: LoadedTranscript) => {
      const last = t.entries[t.entries.length - 1];
      const { state, effects } = driveTranscript(t);

      if (last.payload.type === "game_over") {
        // record_result effect must have fired (state-machine.ts:386-388)
        expect(effects.some((e) => e.type === "record_result")).toBe(true);
        // lastGameOver set; session_id matches transcript's data.session_id
        const data = last.payload.data as { session_id?: string };
        expect(state.lastGameOver?.data.session_id).toBe(data.session_id);
        // activeMatch reset (state-machine.ts:384)
        expect(state.activeMatch).toBeUndefined();
        // phase returned to connected (state-machine.ts:381)
        expect(state.phase).toBe("connected");
      } else if (last.payload.type === "match_cancelled") {
        expect(
          effects.some((e) => e.type === "notify" && e.code === "fsm.match_cancelled"),
        ).toBe(true);
        // phase returned to connected or queuing
        expect(["connected", "queuing"]).toContain(state.phase);
        expect(state.pendingConfirm).toBeUndefined();
      } else if (last.payload.type === "error") {
        // state.lastError set (state-machine.ts:394)
        expect(typeof state.lastError).toBe("string");
        // notify code "server.error" emitted
        expect(effects.some((e) => e.type === "notify" && e.code === "server.error")).toBe(true);
      } else if (last.payload.type === "game_start") {
        // match_confirm_happy ends here per replay-test-spec §7.5
        expect(state.phase).toBe("in_match");
        const data = last.payload.data as { match_id?: string };
        // MsgGameStart.data.match_id is anonymized session_id (per
        // protocol/types.ts:1106 + comment 1136-1137)
        expect(state.activeMatch?.sessionId).toBe(data.match_id);
      } else if (last.payload.type === "action_request" || last.payload.type === "action") {
        // reconnect_mid_match / server_error_illegal_action terminate
        // mid-protocol — state should still be in a sensible phase
        expect(["in_match", "deciding"]).toContain(state.phase);
      }
    },
  );
});

// ---- Group 5.3 + 5.4: reconnect path under ws.message replay (限定 contract) ----
//
// IMPORTANT: reducer's `applyServerMessage` switch (state-machine.ts
// 行 196-205) has NO `case "welcome"` — second welcome arriving via
// `ws.message` falls through to `default` → `warn(state,
// "fsm.unknown_server_message", ...)`, FSM ignores it. The "real"
// reconnect behavior (transport switch, phase=backoff, event-history
// reset) is driven by `reconnect.event` input (state-machine.ts:403-421
// `reconnectEvent` function), which the wsclient feeds; this fixture
// intentionally does NOT inject `reconnect.event` — that path is
// covered by sealed wsclient-reconnect.test.ts.
//
// What this fixture DOES verify under ws.message replay:
//   - reducer doesn't crash on a second welcome (default-warn path safe)
//   - reducer doesn't dup outbound action sends (transcript has 1 action,
//     reducer emits ≤ 1 send)
//   - terminal phase remains an active-match phase (activeMatch retained
//     across the second welcome)

describe("fixtures-state-machine: reconnect_mid_match (ws.message replay only)", () => {
  it("reducer survives second welcome via default-warn path; no dup outbound action send", () => {
    const t = loadTranscript("edge_cases/reconnect_mid_match.jsonl");
    const { state, effects } = driveTranscript(t);
    // FSM landed in an active match (second welcome did not reset state)
    expect(["in_match", "deciding"]).toContain(state.phase);
    expect(state.activeMatch).toBeDefined();

    // Recorded transcript has exactly 1 client_to_server action; FSM
    // must emit ≤ 1 outbound `action` send (no dup on reconnect path).
    const actionSends = effects.filter(
      (e) => e.type === "send" && (e.message as { type?: string }).type === "action",
    );
    expect(actionSends.length).toBeLessThanOrEqual(1);

    // Second welcome triggered a default-warn notify (reducer ignored it)
    const unknownWarns = effects.filter(
      (e) =>
        e.type === "notify" &&
        e.level === "warning" &&
        e.code === "fsm.unknown_server_message",
    );
    expect(unknownWarns.length).toBeGreaterThanOrEqual(1);
  });
});

// ---- Group 5.5: first-turn null new_events (拍板点 #8) ----

describe("fixtures-state-machine: null new_events handling", () => {
  // Transcripts that contain ≥1 action_request with new_events: null
  // (real beta behavior — protocol/types.ts:1006). FSM must drive
  // them without throw / without coercing null to [] (replay-test-spec
  // §6.5).
  const NULL_FIXTURES = [
    "happy_path/liars_dice_3player.jsonl",
    "edge_cases/coup_3player_forfeit_disconnect.jsonl",
    "edge_cases/reconnect_mid_match.jsonl",
    "edge_cases/server_error_illegal_action.jsonl",
  ];

  test.each(NULL_FIXTURES)(
    "%s: contains ≥1 action_request with new_events: null + drives FSM without throw",
    (name) => {
      const t = loadTranscript(name);
      const hasNull = t.entries.some(
        (e) =>
          e.direction === "server_to_client" &&
          e.payload.type === "action_request" &&
          (e.payload.data as { new_events?: unknown }).new_events === null,
      );
      expect(hasNull).toBe(true);
      expect(() => driveTranscript(t)).not.toThrow();
    },
  );
});

// ---- Group 5.6: forfeit transcript invariants (replay-test-spec §7.1) ----

describe("fixtures-state-machine: coup forfeit", () => {
  it("game_over carries forfeit_reason + forfeited_by + replay_url absent", () => {
    const t = loadTranscript("edge_cases/coup_3player_forfeit_disconnect.jsonl");
    const { state, effects } = driveTranscript(t);

    // record_result effect fired
    expect(effects.some((e) => e.type === "record_result")).toBe(true);
    // game_over recorded with forfeit fields
    expect(state.lastGameOver).toBeDefined();
    const data = state.lastGameOver!.data as Record<string, unknown>;
    expect(typeof data.forfeit_reason).toBe("string");
    expect(typeof data.forfeited_by).toBe("string");
    // replay_url MUST be absent on forfeit (spec §5.1 / §7.1) — not
    // synthesized
    expect(data.replay_url).toBeUndefined();
  });
});

// ---- Group 5.7: match_confirm_timeout reason in notify message ----

describe("fixtures-state-machine: match_confirm_timeout", () => {
  it("notify message contains transcript reason substring", () => {
    const t = loadTranscript("edge_cases/match_confirm_timeout.jsonl");
    const { effects } = driveTranscript(t);
    const last = t.entries[t.entries.length - 1];
    const reason = (last.payload.data as { reason?: string }).reason;
    expect(reason).toBeDefined();
    const cancelNotify = effects.find(
      (e) => e.type === "notify" && e.code === "fsm.match_cancelled",
    );
    expect(cancelNotify).toBeDefined();
    if (cancelNotify && cancelNotify.type === "notify") {
      expect(cancelNotify.message).toContain(reason!);
    }
  });
});

// ---- Group 5.8: server_error_illegal_action mid-match recoverable ----

describe("fixtures-state-machine: server_error_illegal_action", () => {
  it("error mid-match is non-terminal — FSM consumes retry action_request after server.error notify", () => {
    const t = loadTranscript("edge_cases/server_error_illegal_action.jsonl");
    const { state, effects } = driveTranscript(t);

    // Both error AND retry action_request must have flowed through the
    // FSM. server.error notify fired
    expect(effects.some((e) => e.type === "notify" && e.code === "server.error")).toBe(true);
    // After error + retry action_request, FSM should be in
    // "deciding" (waiting for next decision) or in_match
    expect(["in_match", "deciding"]).toContain(state.phase);
  });
});

// ---- Group 5.9: game_over winner consistency (spec §5.1) ----

describe("fixtures-state-machine: game_over winner consistency", () => {
  test.each(
    ALL.filter(
      (t) => t.entries[t.entries.length - 1].payload.type === "game_over",
    ).map((t) => [t.name, t] as const),
  )(
    "%s: if result.winner non-empty, winner ∈ players + payoff[winner] = max(payoffs)",
    (_name, t: LoadedTranscript) => {
      const { state } = driveTranscript(t);
      const data = state.lastGameOver!.data as {
        result?: {
          winner?: string;
          is_draw?: boolean;
          payoffs?: Record<string, number>;
        };
        players?: Array<{ player_id?: string }>;
      };
      const winner = data.result?.winner;
      if (!winner) return; // multi-winner / draw — relaxed per spec §5.1
      // winner ∈ players
      const playerIds = (data.players ?? []).map((p) => p.player_id).filter((id): id is string => !!id);
      expect(playerIds).toContain(winner);
      // payoff[winner] = max
      const payoffs = data.result?.payoffs ?? {};
      const winnerPayoff = payoffs[winner];
      expect(typeof winnerPayoff).toBe("number");
      const maxPayoff = Math.max(...Object.values(payoffs));
      expect(winnerPayoff).toBe(maxPayoff);
    },
  );
});
