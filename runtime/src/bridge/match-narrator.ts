// The CLI's in-match narrator. A terminal user running `aifight run` used to
// see NOTHING between "queue joined" and the final "Match complete" block —
// the decision traces went to decisions.jsonl, the desktop app, and Telegram,
// while the terminal in front of the user stayed silent for the whole match
// (owner report, 2026-07-28). This folds the same two streams the runner
// already exposes (server messages + decision traces) into compact one-line
// updates: match start, one line per decision (action · author · elapsed),
// and warnings when the model call failed, retried, or was truncated.
//
// Pure and stateful-per-match only: no I/O here — the caller decides where
// lines go. The desktop app does NOT use this (it has the cockpit).

import type { ServerMessageEnvelope } from "../wsclient/frame-handler";
import type { BridgeDecisionTrace } from "./provider";
import type { MsgGameStart, MsgGameOver } from "../protocol/types";

export interface NarratorLine {
  readonly level: "info" | "warning";
  readonly message: string;
  /** Start a new visual block (blank line before) — set on match start. */
  readonly blockStart?: boolean;
}

/** Human name for an engine game key (single source for runner + narrator). */
export function displayGameName(game: string | undefined): string {
  switch (game) {
    case "texas_holdem":
      return "Texas Hold'em";
    case "liars_dice":
      return "Liar's Dice";
    case "coup":
      return "Coup";
    default:
      return "AIFight match";
  }
}

interface MatchState {
  game: string | undefined;
  decisionCount: number;
  /** player_id → anonymized table name ("Player 3"), for naming action targets. */
  roster: Map<string, string>;
  /** Wall-clock when the current decision window opened (decision_request). */
  decisionStartedMs: number | undefined;
  truncationWarned: boolean;
}

/** Bound the per-match map in service mode; game_over cleans up normally. */
const MAX_TRACKED_MATCHES = 8;
const MAX_ERROR_CHARS = 140;

function freshMatch(game: string | undefined): MatchState {
  return { game, decisionCount: 0, roster: new Map(), decisionStartedMs: undefined, truncationWarned: false };
}

function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > MAX_ERROR_CHARS ? `${flat.slice(0, MAX_ERROR_CHARS - 1)}…` : flat;
}

export class MatchNarrator {
  readonly #now: () => number;
  readonly #matches = new Map<string, MatchState>();

  constructor(opts?: { now?: () => number }) {
    this.#now = opts?.now ?? Date.now;
  }

  /** Feed every server frame; returns a line to print, or null. */
  observeServerMessage(msg: ServerMessageEnvelope): NarratorLine | null {
    if (msg.type === "game_start") {
      const data = (msg as unknown as MsgGameStart).data;
      if (data === undefined || data === null || typeof data.match_id !== "string") return null;
      const state = freshMatch((data as { game?: string }).game);
      for (const p of data.players ?? []) state.roster.set(p.player_id, p.name);
      this.#remember(data.match_id, state);
      const seat = state.roster.get(data.your_player_id) ?? data.your_player_id;
      const n = data.players?.length ?? 0;
      return {
        level: "info",
        blockStart: true,
        message: `Match started: ${displayGameName(state.game)} · ${n} players · your seat: ${seat}`,
      };
    }
    if (msg.type === "game_over") {
      const data = (msg as unknown as MsgGameOver).data;
      const sid = data?.session_id;
      if (typeof sid === "string") this.#matches.delete(sid);
      // The runner's own match_complete block covers the result — no line here.
      return null;
    }
    return null;
  }

  /** Feed every decision trace; returns a line to print, or null. */
  observeTrace(trace: BridgeDecisionTrace): NarratorLine | null {
    const m = this.#matches.get(trace.matchId) ?? this.#remember(trace.matchId, freshMatch(undefined));
    switch (trace.type) {
      case "decision_request":
        m.decisionStartedMs = this.#now();
        return null;
      case "final_action": {
        m.decisionCount += 1;
        const elapsed = m.decisionStartedMs !== undefined ? (this.#now() - m.decisionStartedMs) / 1000 : undefined;
        m.decisionStartedMs = undefined;
        const parts = [`Decision #${m.decisionCount}: ${this.#actionLabel(m, trace.action)}`, this.#sourceLabel(trace)];
        if (elapsed !== undefined) parts.push(`${elapsed.toFixed(1)}s`);
        return { level: "info", message: parts.join(" · ") };
      }
      case "runtime_failure": {
        const cls = trace.errorClass !== undefined ? `, ${trace.errorClass}` : "";
        return {
          level: "warning",
          message: `model call failed (attempt ${trace.attempt}${cls}): ${oneLine(trace.error)}`,
        };
      }
      case "illegal_retry": {
        const what =
          trace.reason === "unparseable_runtime_text"
            ? "model output could not be parsed as an action"
            : "model output was not a legal action";
        return { level: "warning", message: `${what} — asking the model to correct (attempt ${trace.attempt})` };
      }
      case "runtime_success": {
        if (trace.selfHealed !== undefined) {
          return {
            level: "info",
            message: `auto-raised max tokens ${trace.selfHealed.from}→${trace.selfHealed.to} to finish this decision`,
          };
        }
        if (trace.truncated === true && !m.truncationWarned) {
          m.truncationWarned = true; // once per match — every further decision would repeat it
          return {
            level: "warning",
            message: "model output hit the max-tokens limit; decisions may be degraded (raise maxTokens in your model profile)",
          };
        }
        return null;
      }
      default:
        return null;
    }
  }

  #remember(matchId: string, state: MatchState): MatchState {
    this.#matches.set(matchId, state);
    // Evict oldest beyond the cap (insertion order) so an ever-running service
    // that somehow misses game_over frames cannot grow without bound.
    while (this.#matches.size > MAX_TRACKED_MATCHES) {
      const oldest = this.#matches.keys().next().value;
      if (oldest === undefined) break;
      this.#matches.delete(oldest);
    }
    return state;
  }

  #actionLabel(m: MatchState, action: { type: string; data?: Record<string, unknown> }): string {
    const d = action.data ?? {};
    if (action.type === "bid" && d.quantity !== undefined && d.face !== undefined) {
      return `bid ${d.quantity}×${d.face}`;
    }
    let label = action.type;
    if (typeof d.amount === "number") label += ` ${d.amount}`;
    if (typeof d.role === "string") label += ` (${d.role})`;
    if (typeof d.target === "string") {
      label += ` → ${m.roster.get(d.target) ?? d.target}`;
    }
    return label;
  }

  #sourceLabel(trace: Extract<BridgeDecisionTrace, { type: "final_action" }>): string {
    const src = trace.decisionSource ?? (trace.source === "runtime" ? "model" : "fallback");
    if (src === "model") return "model";
    if (src === "model_retry") return "model (after retry)";
    return trace.reason !== undefined ? `fallback (${trace.reason})` : "fallback";
  }
}
