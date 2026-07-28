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
import type { StampedTrace } from "./liveStore";
import type { ServerMessage } from "../shared/ipc";

/**
 * Extract the path of a stored replay URL ("https://aifight.ai/replay/x?y" →
 * "/replay/x") so a History-opened replay can complete its final stretch from
 * the public replay — a stored session's inbound frames end at this player's
 * last decision, exactly like the live stream. Accepts a bare path unchanged;
 * null when there is nothing usable.
 */
export function replayPathOf(replayUrl: string | undefined): string | null {
  if (replayUrl === undefined || replayUrl === "") return null;
  try {
    return new URL(replayUrl).pathname;
  } catch {
    return replayUrl.startsWith("/") ? replayUrl : null;
  }
}

export interface SessionReplay {
  readonly state: LiveMatchState;
  readonly traces: StampedTrace[];
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
  // Board position at each decision: the k-th action_request provoked the k-th
  // decision, and its new_events land in the reducer BEFORE the agent decides —
  // so the event count right after folding it is the step that decision was
  // taken at (same anchoring the live store stamps). Best-effort: a reconnect
  // re-request shifts the pairing by one; traces then anchor a step early,
  // which still lands the click in the right neighbourhood.
  const stepAtDecision: number[] = [];
  for (const rec of inbound) {
    const msg = (rec as { message?: unknown })?.message;
    if (!isMessage(msg)) continue;
    state = reduceServerMessage(state, msg);
    if (msg.type === "action_request") stepAtDecision.push(state.events.length);
  }

  const traces: StampedTrace[] = [];
  const decisions = Array.isArray(e.decisions) ? e.decisions : [];
  decisions.forEach((d, i) => {
    const ts = (d as { traces?: unknown })?.traces;
    if (!Array.isArray(ts)) return;
    const step = stepAtDecision[Math.min(i, stepAtDecision.length - 1)];
    for (const tr of ts) {
      if (tr && typeof tr === "object" && typeof (tr as { type?: unknown }).type === "string") {
        traces.push(
          step === undefined
            ? (tr as StampedTrace)
            : ({ ...(tr as object), step } as StampedTrace),
        );
      }
    }
  });

  return { state, traces };
}
