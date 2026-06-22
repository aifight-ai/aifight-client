// D6 — synthesize a decision-trace stream for the demo/replay cockpit.
//
// A real bridge match emits BridgeDecisionTrace events live (D3: window.aifight
// .onTrace). For the offline demo we derive an equivalent stream from a
// fixture's decision events, so the cockpit's reasoning panel is populated and
// demoable without being online. Same shape as the live stream, so the panel
// renders both identically.

import type { MatchDetail, MatchEvent } from "@aifight/api-types";
import type { BridgeDecisionTrace, TraceAction } from "../shared/ipc";

const DECISION_TYPES = new Set(["player_action", "bid", "challenge"]);

/** Legal-action counts are illustrative for the demo (real matches report the true count). */
function legalCountFor(game: string): number {
  if (game === "texas_holdem") return 4;
  if (game === "liars_dice") return 3;
  return 6;
}

function actionFromEvent(ev: MatchEvent): TraceAction {
  const d = ev.data ?? {};
  if (ev.type === "player_action") {
    const type = String(d.action ?? "action");
    return d.amount !== undefined ? { type, data: { amount: d.amount } } : { type };
  }
  if (ev.type === "bid") return { type: "bid", data: { quantity: d.quantity, face: d.face } };
  if (ev.type === "challenge") return { type: "challenge" };
  return { type: ev.type };
}

function previewFor(game: string, ev: MatchEvent): string {
  const d = ev.data ?? {};
  if (ev.type === "bid") {
    return `I'll raise to ${d.quantity}×${d.face}s. Across 10 dice the field very likely holds at least ${Math.max(0, Number(d.quantity) - 1)} of these, so the bid stays credible while pressuring the opponent.`;
  }
  if (ev.type === "challenge") {
    return "Calling the bluff — the standing bid exceeds the count I can justify given my own dice. Expected value favors the challenge.";
  }
  const action = String(d.action ?? "");
  switch (action) {
    case "call":
      return "Pot odds favor calling: top pair with a backdoor draw, and the opponent's sizing reads more like a semi-bluff than a made hand.";
    case "check":
      return "Pot control on a dry board. My range is capped here; betting only folds out worse and gets called by better.";
    case "raise":
    case "bet":
      return "Value-raise: I hold the nut draw plus two overcards, fold equity is high, and I'm happy to get it in.";
    case "fold":
      return "I'm behind the range being represented. Preserve the stack and wait for a higher-EV spot.";
    default:
      return `Chose to ${action || ev.type}.`;
  }
}

// Small deterministic hash → 12 hex chars. Stands in for the real sha256 of the
// model output in the demo (avoids hashing libs; live matches carry the real one).
function shortHash(s: string): string {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h1 ^= s.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  const hex = (h1 >>> 0).toString(16).padStart(8, "0");
  return (hex + hex).slice(0, 12);
}

/**
 * Derive a trace stream from the currently-visible fixture events. Pure.
 *
 * Only the OWNER's decisions get a reasoning trace — the local bridge only sees
 * its own agent's reasoning, never an opponent's. Opponent moves still appear on
 * the board (public actions), but never with reasoning here.
 */
export function synthesizeTraces(
  match: MatchDetail,
  events: readonly MatchEvent[],
  ownerPlayerId: string,
): BridgeDecisionTrace[] {
  const out: BridgeDecisionTrace[] = [];
  let attempt = 0;
  for (const ev of events) {
    if (!DECISION_TYPES.has(ev.type)) continue;
    if (ev.player_id !== ownerPlayerId) continue;
    const matchId = match.id;
    const preview = previewFor(match.game, ev);
    out.push({
      type: "decision_request",
      matchId,
      game: match.game,
      ...(ev.player_id !== undefined ? { playerId: ev.player_id } : {}),
      legalActionCount: legalCountFor(match.game),
      timeoutMs: 300_000,
    });
    attempt += 1;
    out.push({
      type: "runtime_success",
      matchId,
      attempt,
      raw: { kind: "text", sha256: shortHash(preview), bytes: preview.length, preview },
    });
    out.push({ type: "final_action", matchId, source: "runtime", action: actionFromEvent(ev) });
  }
  return out;
}
