// build-review-context.ts
//
// Folds a finished match's local session files (the LocalSessionExport produced
// by LocalMatchSessionStore.exportSession) into a compact, agent-centric review
// context — the input to the self-review prompt (SELF_REVIEW_DESIGN.md §5.1).
//
// Pure data transform: no file IO, no network. The caller passes the already-
// read export; this module only reshapes it. Opponent secrets are physically
// absent from the source (the store redacts hidden info at write time, §3.2),
// so nothing sensitive can leak through here.

import type { LocalSessionExport } from "../session/local-match-session-store.js";

/** One agent decision, compressed to the highest-signal fields. */
export interface ReviewContextTurn {
  /** 1-based decision index within the match. */
  readonly index: number;
  /** Truncated public-state snapshot at decision time. */
  readonly stateSummary: string;
  /** The legal action types the agent could pick from. */
  readonly legal: readonly string[];
  /** The action the agent actually chose (compact form). */
  readonly chose: string;
  /** The model's own short reason for the choice (truncated), if any. */
  readonly reasoning: string;
}

export type ReviewOutcome = "win" | "loss" | "draw" | "unknown";

export interface ReviewContext {
  readonly game: string;
  readonly resultLabel: string;
  readonly outcome: ReviewOutcome;
  /** De-anonymized opponent display names (already public; no secrets). */
  readonly opponents: readonly string[];
  /** The global strategy file content in effect for this match (may be ""). */
  readonly strategyGlobal: string;
  /** The per-game strategy file content in effect for this match (may be ""). */
  readonly strategyGame: string;
  /** sha256 of every strategy section that drove this match (for staleness). */
  readonly strategyHashes: readonly string[];
  /** Agent decision turns, oldest → newest, after sampling. */
  readonly turns: readonly ReviewContextTurn[];
  /** How many turns were dropped by sampling (0 when none). */
  readonly omittedTurns: number;
}

const DEFAULT_MAX_TURNS = 40;
const STATE_SUMMARY_MAX = 320;
const REASONING_MAX = 360;

/**
 * Build the compressed review context. `maxTurns` caps how many agent decisions
 * are kept; longer matches keep the first 2 turns (the opening) plus the most
 * recent (decisive) turns, and report the dropped count.
 */
export function buildReviewContext(
  exported: LocalSessionExport,
  opts: { readonly maxTurns?: number } = {},
): ReviewContext {
  const maxTurns = clampMaxTurns(opts.maxTurns);
  const game = exported.summary.game ?? readGameFromInbound(exported.inbound) ?? "unknown";
  const resultLabel = exported.summary.result_label ?? "completed";

  const allTurns = exported.decisions
    .map((d, i) => toTurn(d, i))
    .filter((t): t is ReviewContextTurn => t !== null);
  const { turns, omittedTurns } = sampleTurns(allTurns, maxTurns);

  const strategy = pickStrategy(exported.strategySnapshot, game);

  return {
    game,
    resultLabel,
    outcome: deriveOutcome(resultLabel),
    opponents: readOpponents(exported.inbound, exported.summary.player_id),
    strategyGlobal: strategy.global,
    strategyGame: strategy.game,
    strategyHashes: [...exported.summary.strategy_hashes],
    turns,
    omittedTurns,
  };
}

function clampMaxTurns(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_MAX_TURNS;
  return Math.max(2, Math.min(200, Math.floor(raw)));
}

/** Keep the opening (first 2) + the most recent turns when over the cap. */
function sampleTurns(
  turns: readonly ReviewContextTurn[],
  maxTurns: number,
): { turns: ReviewContextTurn[]; omittedTurns: number } {
  if (turns.length <= maxTurns) return { turns: [...turns], omittedTurns: 0 };
  const head = turns.slice(0, 2);
  const tail = turns.slice(turns.length - (maxTurns - 2));
  return { turns: [...head, ...tail], omittedTurns: turns.length - maxTurns };
}

function toTurn(decision: unknown, index: number): ReviewContextTurn | null {
  if (!isObject(decision)) return null;
  const req = isObject(decision.action_request) ? decision.action_request : {};
  const legal = Array.isArray(req.legal_actions)
    ? req.legal_actions.map(actionType).filter((s): s is string => s.length > 0)
    : [];
  return {
    index: index + 1,
    stateSummary: truncate(compactJSON(req.state), STATE_SUMMARY_MAX),
    legal,
    chose: choseSummary(decision.final_action),
    reasoning: truncate(extractReasoning(decision), REASONING_MAX),
  };
}

/** A legal action can be a bare string or an object with a `type`/`action`. */
function actionType(a: unknown): string {
  if (typeof a === "string") return a;
  if (isObject(a)) {
    const t = a.type ?? a.action ?? a.name;
    if (typeof t === "string") return t;
  }
  return "";
}

function choseSummary(finalAction: unknown): string {
  if (finalAction === undefined || finalAction === null) return "(no action)";
  if (typeof finalAction === "string") return finalAction;
  if (isObject(finalAction)) {
    const type = actionType(finalAction);
    const data = finalAction.data;
    const dataStr = data !== undefined && data !== null ? compactJSON(data) : "";
    const base = type !== "" ? type : compactJSON(finalAction);
    return truncate(dataStr !== "" && dataStr !== "{}" ? `${base} ${dataStr}` : base, 160);
  }
  return truncate(compactJSON(finalAction), 160);
}

/**
 * Reason text, in priority order: the action's own `summary`, then a trace
 * `final_action.reason`, then a `runtime_success` raw preview. All are the
 * model's own words (already local, no secrets).
 */
function extractReasoning(decision: Record<string, unknown>): string {
  const fa = decision.final_action;
  if (isObject(fa) && typeof fa.summary === "string" && fa.summary.trim() !== "") {
    return fa.summary.trim();
  }
  const traces = Array.isArray(decision.traces) ? decision.traces : [];
  for (const tr of traces) {
    if (isObject(tr) && tr.type === "final_action" && typeof tr.reason === "string" && tr.reason.trim() !== "") {
      return tr.reason.trim();
    }
  }
  for (const tr of traces) {
    if (
      isObject(tr) &&
      tr.type === "runtime_success" &&
      isObject(tr.raw) &&
      typeof tr.raw.preview === "string" &&
      tr.raw.preview.trim() !== ""
    ) {
      return tr.raw.preview.trim();
    }
  }
  return "";
}

function deriveOutcome(resultLabel: string): ReviewOutcome {
  const label = resultLabel.toLowerCase();
  if (label === "draw") return "draw";
  if (label === "opponent forfeit") return "win";
  if (label === "forfeit") return "loss";
  if (label.startsWith("1st")) return "win";
  if (/^\d+(st|nd|rd|th)\b/.test(label)) return "loss";
  return "unknown";
}

function readGameFromInbound(inbound: readonly unknown[]): string | undefined {
  for (const entry of inbound) {
    const msg = innerMessage(entry);
    if (msg && msg.type === "game_start" && isObject(msg.data) && typeof msg.data.game === "string") {
      return msg.data.game;
    }
  }
  return undefined;
}

/** Opponent display names from game_start.players, excluding our own seat. */
function readOpponents(inbound: readonly unknown[], ownPlayerId: string | undefined): string[] {
  for (const entry of inbound) {
    const msg = innerMessage(entry);
    if (!msg || msg.type !== "game_start" || !isObject(msg.data)) continue;
    const players = Array.isArray(msg.data.players) ? msg.data.players : [];
    const yourId = typeof msg.data.your_player_id === "string" ? msg.data.your_player_id : ownPlayerId;
    const names: string[] = [];
    for (const p of players) {
      if (!isObject(p)) continue;
      if (typeof p.player_id === "string" && p.player_id === yourId) continue;
      if (typeof p.name === "string" && p.name.trim() !== "") names.push(p.name.trim());
    }
    if (names.length > 0) return names;
  }
  return [];
}

/** An inbound.jsonl row is { at, direction, type, message }; unwrap message. */
function innerMessage(entry: unknown): Record<string, unknown> | null {
  if (!isObject(entry)) return null;
  const msg = entry.message;
  return isObject(msg) ? msg : null;
}

function pickStrategy(snapshot: unknown, game: string): { global: string; game: string } {
  const out = { global: "", game: "" };
  if (!isObject(snapshot)) return out;
  const sections = snapshot.sections;
  if (!isObject(sections)) return out;
  for (const value of Object.values(sections)) {
    if (!isObject(value) || typeof value.content !== "string") continue;
    if (value.scope === "global") out.global = value.content;
    else if (value.scope === "game" && value.game === game) out.game = value.content;
  }
  return out;
}

// ── small helpers ───────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function compactJSON(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…(+${s.length - max} chars)`;
}
