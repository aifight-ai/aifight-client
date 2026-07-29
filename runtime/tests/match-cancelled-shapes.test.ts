// Every match_cancelled shape the SERVER actually emits must survive inbound
// validation and reach the state machine.
//
// It did not. server_match_cancelled.schema.json listed three reason/action
// pairs; the server emits five reasons, and any of them can arrive with
// action='removed_from_queue' (the re-queue runs the full join gate first, so a
// banned/capped/suspended agent is dropped instead of re-queued). Frames outside
// the three listed pairs failed ajv, and the client's inbound handler reports
// frame errors and keeps going — so the cancellation was DISCARDED and the agent
// went on believing it was still queued, with nothing in the UI to say otherwise.
//
// The list below is the server's real surface. Grep it against:
//   internal/hub/confirmation.go   confirmation_timeout / opponent_not_ready / capacity_changed
//   internal/hub/hub.go            opponent_disconnected
//   internal/matchmaking/matchmaking.go  maintenance
// If a new reason is added server-side, add it here and to the schema.

import { describe, expect, it } from "vitest";

import { createInitialAgentFSM, transitionAgentFSM } from "../src/agents/state-machine";
import type { AgentFSMState } from "../src/agents/state-machine";
import type { MsgMatchCancelled } from "../src/protocol/types";
import type { WSWelcome } from "../src/wsclient/client";
import { parseServerFrame } from "../src/wsclient/frame-handler";

const REASONS = [
  "confirmation_timeout",
  "opponent_not_ready",
  "capacity_changed",
  "maintenance",
] as const;
const ACTIONS = ["removed_from_queue", "re_queued"] as const;

function frame(data: Record<string, unknown>): string {
  return JSON.stringify({ type: "match_cancelled", data });
}

const welcome: WSWelcome = {
  type: "welcome",
  data: {
    server_protocol_version: "v1.0.0",
    agent_id: "agent-1",
    agent_name: "Cancel Shapes Agent",
    server_time: "2026-07-29T00:00:00Z",
    games: ["texas_holdem", "liars_dice", "coup"],
  },
};

function queuedState(): AgentFSMState {
  return {
    ...createInitialAgentFSM({ welcome }),
    phase: "queuing",
    queue: { game: "coup", mode: "ranked" },
  };
}

describe("match_cancelled — every shape the server emits", () => {
  it("accepts all four non-disconnect reasons with either action", () => {
    for (const reason of REASONS) {
      for (const action of ACTIONS) {
        const parsed = parseServerFrame(frame({ reason, action }));
        expect(parsed.type, `${reason}/${action}`).toBe("match_cancelled");
      }
    }
  });

  it("accepts opponent_disconnected with either action, game and mode present", () => {
    for (const action of ACTIONS) {
      const parsed = parseServerFrame(
        frame({ reason: "opponent_disconnected", action, game: "liars_dice", mode: "ranked" }),
      );
      expect(parsed.type, action).toBe("match_cancelled");
    }
  });

  it("still rejects an unknown reason and a missing game on opponent_disconnected", () => {
    // The widening must not turn the message into a free-for-all: an unknown
    // reason is a genuine protocol drift the client should surface.
    expect(() => parseServerFrame(frame({ reason: "the_dog_ate_it", action: "re_queued" }))).toThrow()
    expect(() =>
      parseServerFrame(frame({ reason: "opponent_disconnected", action: "re_queued", game: "coup" })),
    ).toThrow()
  })

  it("clears the queue for every removed_from_queue variant", () => {
    // The point of the fix: these used to be dropped, so the agent kept a queue
    // it was no longer in.
    for (const reason of REASONS) {
      const msg = { type: "match_cancelled", data: { reason, action: "removed_from_queue" } } as MsgMatchCancelled
      const out = transitionAgentFSM(queuedState(), { type: "ws.message", message: msg })
      expect(out.state.queue, reason).toBeUndefined()
    }
    const disc = {
      type: "match_cancelled",
      data: {
        reason: "opponent_disconnected",
        action: "removed_from_queue",
        game: "liars_dice",
        mode: "ranked",
      },
    } as MsgMatchCancelled
    const out = transitionAgentFSM(queuedState(), { type: "ws.message", message: disc })
    expect(out.state.queue).toBeUndefined()
  })

  it("keeps re-queuing behaviour for the re_queued variants", () => {
    for (const reason of REASONS) {
      const msg = { type: "match_cancelled", data: { reason, action: "re_queued" } } as MsgMatchCancelled
      const out = transitionAgentFSM(queuedState(), { type: "ws.message", message: msg })
      // No server-supplied game/mode on these reasons → the client keeps the
      // queue it already believed it was in.
      expect(out.state.queue, reason).toEqual({ game: "coup", mode: "ranked" })
    }
  })
})
