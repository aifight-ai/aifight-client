// D8 — rebuild a past match from a stored session export. The bridge persists
// every raw server frame it received (LocalMatchSessionStore.recordServerMessage
// → inbound.jsonl), so we replay a session by folding those SAME frames through
// the SAME reducer the live cockpit uses. That means:
//   - the board reconstructs identically to live, and
//   - 🔒 information hiding is inherited for free: the stored frames only ever
//     contained the owner's own private info (the bridge never received an
//     opponent's secret), so a replay can never leak one either.
//
// The decision traces (the agent's own reasoning) are read from decisions.jsonl
// (already redacted for storage by the runtime) and flattened in order.

import { emptyLiveMatch, reduceServerMessage, type LiveMatchState } from "./liveMatch";
import type { BridgeDecisionTrace, ServerMessage } from "../shared/ipc";

export interface SessionReplay {
  readonly state: LiveMatchState;
  readonly traces: BridgeDecisionTrace[];
}

function isMessage(x: unknown): x is ServerMessage {
  return Boolean(x) && typeof x === "object" && typeof (x as { type?: unknown }).type === "string";
}

/**
 * Build a replayable cockpit state from a `LocalSessionExport` (the parsed JSON
 * of `aifight sessions export <id>`). Tolerant of shape drift: anything it can't
 * recognize is skipped, never thrown.
 */
export function buildReplayFromExport(exp: unknown): SessionReplay {
  const e = (exp ?? {}) as { inbound?: unknown; decisions?: unknown };

  let state = emptyLiveMatch();
  const inbound = Array.isArray(e.inbound) ? e.inbound : [];
  for (const rec of inbound) {
    const msg = (rec as { message?: unknown })?.message;
    if (isMessage(msg)) state = reduceServerMessage(state, msg);
  }

  const traces: BridgeDecisionTrace[] = [];
  const decisions = Array.isArray(e.decisions) ? e.decisions : [];
  for (const d of decisions) {
    const ts = (d as { traces?: unknown })?.traces;
    if (!Array.isArray(ts)) continue;
    for (const tr of ts) {
      if (tr && typeof tr === "object" && typeof (tr as { type?: unknown }).type === "string") {
        traces.push(tr as BridgeDecisionTrace);
      }
    }
  }

  return { state, traces };
}
