// M1-12 prompt-builder — pure function from DecisionRequest to
// (systemPrompt, userPrompt) strings ready for the M1-11 direct-model
// HTTP client.
//
// Internal-only — not re-exported from runtime/src/index.ts. M1-14
// decision/provider.ts wraps buildPrompt + direct-model client + parser
// + retry into the package public surface.
//
// Contracts (M1-12 TED rev3):
// - 拍板点 #2: pure function, no class, no IO, no logging
// - 拍板点 #3: dispatch on req.game to texas_holdem / liars_dice / coup
//             state-formatter (each returns {stateBlock, recentEventsBlock})
// - 拍板点 #6: prompt strictly describes JSON output contract
//             {"action", "data", "summary"};no markdown wrap;parse is M1-14
// - 拍板点 #7: systemPrompt = strategy.systemPrompt + Game Rules block +
//             gameSpecific.extraPrompt? + Output format block + Constraints
// - 拍板点 #8: userPrompt = Match context + Recent events + Current state +
//             Legal actions + Reminder
// - 拍板点 #9: real hard cap on userPrompt.length <= userPromptCharCap;
//             minimum core (Match + Legal actions + Reminder) preserved
//             when possible;trim priority (a) events head + marker
//             (b) state non-core fields (c) state tail force-truncate
//             with marker
// - 拍板点 #11: prompt-builder wrapping text English;strategy /
//              extraPrompt user-controlled (any language) pass-through
// - 拍板点 #12: temperature / maxTokens NOT consumed (透 by M1-14)
// - 拍板点 #14: tests use real formatters + contains-string;no vi.fn
//              dispatch injection

import { formatCoupState } from "../games/coup/state-formatter";
import { formatLiarsDiceState } from "../games/liars_dice/state-formatter";
import { formatTexasHoldemState } from "../games/texas_holdem/state-formatter";
import type {
  CoupRules,
  CoupState,
  LiarsDiceRules,
  LiarsDiceState,
  TexasHoldemRules,
  TexasHoldemState,
} from "../protocol/types";
import type { DecisionRequest, GameType, LegalAction } from "./types";

export interface PromptBuilderOptions {
  /** Hard cap on assembled userPrompt length (chars). Default 16384. */
  readonly userPromptCharCap?: number;
}

export interface BuiltPrompt {
  readonly systemPrompt: string;
  readonly userPrompt: string;
}

const DEFAULT_USER_PROMPT_CHAR_CAP = 16384;
const EVENTS_TRUNC_MARKER = "[... older events truncated to fit prompt budget ...]";
const STATE_TRUNC_MARKER = "[... state truncated ...]";

const OUTPUT_FORMAT_BLOCK = `Output format:
Respond with a single JSON object exactly matching this schema:
{"action": "<one of the legal action types>", "data": {<action-specific parameters>}, "summary": "<short reasoning, max 200 chars>"}
Do not wrap in markdown code blocks. Do not output any text outside the JSON object.`;

const CONSTRAINTS_BLOCK = `Constraints:
- Choose only from the legal_actions listed in the user message.
- Do not include chain-of-thought reasoning; the summary field is brief.
- The match is anonymous; do not assume opponent identities.`;

const REMINDER_LINE =
  "Reminder: respond with a single JSON object as specified in the system prompt.";

const EVENTS_HEADER = "Recent events (incremental since your last turn):";
const STATE_HEADER = "Current state:";
const LEGAL_ACTIONS_HEADER = "Legal actions:";
const NO_LEGAL_ACTIONS_LINE = "(none — no action required this turn)";

export function buildPrompt(
  req: DecisionRequest,
  options?: PromptBuilderOptions,
): BuiltPrompt {
  const cap = options?.userPromptCharCap ?? DEFAULT_USER_PROMPT_CHAR_CAP;
  const formatted = dispatchFormatter(req);
  const systemPrompt = buildSystemPrompt(req);
  const userPrompt = buildUserPrompt(
    req,
    formatted.stateBlock,
    formatted.recentEventsBlock,
    cap,
  );
  return { systemPrompt, userPrompt };
}

// ─── dispatch ───────────────────────────────────────────────────────

function dispatchFormatter(
  req: DecisionRequest,
): { stateBlock: string; recentEventsBlock: string } {
  switch (req.game) {
    case "texas_holdem":
      return formatTexasHoldemState({
        publicState: req.publicState as TexasHoldemState,
        privateState: req.privateState,
        rules: req.rules as TexasHoldemRules,
        players: req.players,
        recentEvents: req.recentEvents,
        yourPlayerId: req.playerId,
      });
    case "liars_dice":
      return formatLiarsDiceState({
        publicState: req.publicState as LiarsDiceState,
        privateState: req.privateState,
        rules: req.rules as LiarsDiceRules,
        players: req.players,
        recentEvents: req.recentEvents,
        yourPlayerId: req.playerId,
      });
    case "coup":
      return formatCoupState({
        publicState: req.publicState as CoupState,
        privateState: req.privateState,
        rules: req.rules as CoupRules,
        players: req.players,
        recentEvents: req.recentEvents,
        yourPlayerId: req.playerId,
      });
    default: {
      // Defensive — caller bug (M1-14 must validate req.game enum first).
      // Per TED Error Contract: throw, do not silently dispatch.
      const game = (req as { game: string }).game;
      throw new Error(`buildPrompt: unsupported game: ${game}`);
    }
  }
}

// ─── systemPrompt ───────────────────────────────────────────────────

function buildSystemPrompt(req: DecisionRequest): string {
  const sections: string[] = [];

  if (req.strategyProfile.systemPrompt.length > 0) {
    sections.push(req.strategyProfile.systemPrompt);
  }

  sections.push(buildGameRulesBlock(req.rules));

  const extra = req.strategyProfile.gameSpecific?.[req.game]?.extraPrompt;
  if (extra && extra.length > 0) {
    sections.push(extra);
  }

  sections.push(OUTPUT_FORMAT_BLOCK);
  sections.push(CONSTRAINTS_BLOCK);

  return sections.join("\n\n");
}

function buildGameRulesBlock(rules: unknown): string {
  if (rules === null || typeof rules !== "object") {
    return "Game Rules — (unknown game)";
  }
  const r = rules as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name : "(unknown game)";
  const summary = typeof r.summary === "string" ? r.summary : "";
  const keyRules = Array.isArray(r.key_rules)
    ? (r.key_rules as unknown[]).filter((k): k is string => typeof k === "string")
    : [];

  const lines: string[] = [`Game Rules — ${name}:`];
  if (summary.length > 0) lines.push(summary);

  if (keyRules.length > 0) {
    lines.push("");
    lines.push("Key rules:");
    for (const k of keyRules) lines.push(`- ${k}`);
  }

  const aa = r.available_actions;
  if (aa && typeof aa === "object" && !Array.isArray(aa)) {
    const entries = Object.entries(aa as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    if (entries.length > 0) {
      lines.push("");
      lines.push("Available actions:");
      for (const [k, v] of entries) lines.push(`- ${k}: ${v}`);
    }
  }

  return lines.join("\n");
}

// ─── userPrompt + truncation ────────────────────────────────────────

function buildUserPrompt(
  req: DecisionRequest,
  stateBlock: string,
  recentEventsBlock: string,
  cap: number,
): string {
  const matchContext = `Match: ${req.game} | match_id: ${req.matchId} | you are ${req.playerId}`;
  const legalActionsBlock = buildLegalActionsBlock(req.game, req.legalActions);
  const legalActionsSection = `${LEGAL_ACTIONS_HEADER}\n${legalActionsBlock}`;

  const assemble = (events: string, state: string): string => {
    const parts: string[] = [matchContext];
    if (events.length > 0) parts.push(`${EVENTS_HEADER}\n${events}`);
    if (state.length > 0) parts.push(`${STATE_HEADER}\n${state}`);
    parts.push(legalActionsSection, REMINDER_LINE);
    return parts.join("\n\n");
  };

  // Initial assembly with full events + full state
  let prompt = assemble(recentEventsBlock, stateBlock);
  if (prompt.length <= cap) return prompt;

  // Level (a): trim events from head linearly, prepending marker
  let trimmedEvents = recentEventsBlock;
  const eventLines = recentEventsBlock.split("\n");
  for (let dropCount = 1; dropCount <= eventLines.length; dropCount++) {
    const remaining = eventLines.slice(dropCount);
    trimmedEvents =
      remaining.length > 0
        ? `${EVENTS_TRUNC_MARKER}\n${remaining.join("\n")}`
        : EVENTS_TRUNC_MARKER;
    prompt = assemble(trimmedEvents, stateBlock);
    if (prompt.length <= cap) return prompt;
  }
  // After loop: trimmedEvents = EVENTS_TRUNC_MARKER (all events dropped)

  // Level (b): strip non-core state fields
  const strippedState = stripNonCoreState(req.game, stateBlock);
  prompt = assemble(trimmedEvents, strippedState);
  if (prompt.length <= cap) return prompt;

  // Level (c): force-truncate stripped state from tail with marker
  // (only when there's budget to fit the state truncate marker;otherwise
  // fall through to (d)/(e)/(f) — Step 3b bugfix:不能直接 hard slice,
  // 必须先尝试丢弃 events marker 让真正 minimum core 试装).
  const overheadWithoutState = assemble(trimmedEvents, "").length;
  const stateSectionPrefix = `\n\n${STATE_HEADER}\n`;
  const stateContentBudget = cap - overheadWithoutState - stateSectionPrefix.length;

  if (stateContentBudget >= STATE_TRUNC_MARKER.length) {
    const fitChars = Math.max(
      0,
      stateContentBudget - STATE_TRUNC_MARKER.length - 1, // -1 for "\n" before marker
    );
    const truncatedContent =
      fitChars > 0
        ? `${strippedState.slice(0, fitChars)}\n${STATE_TRUNC_MARKER}`
        : STATE_TRUNC_MARKER;
    prompt = assemble(trimmedEvents, truncatedContent);
    if (prompt.length <= cap) return prompt;
    // Defensive — fall through if construction overshot for some reason
  }

  // Level (d): drop state entirely;keep events marker (Step 3b)
  prompt = assemble(trimmedEvents, "");
  if (prompt.length <= cap) return prompt;

  // Level (e): drop events marker too;true minimum core =
  // Match context + Legal actions + Reminder (Step 3b — Roy's specific
  // fix:events marker 不在拍板点 #9 minimum core 定义内,可裁).
  prompt = assemble("", "");
  if (prompt.length <= cap) return prompt;

  // Level (f): pathological — even minimum core > cap. Hard slice to
  // honor hard cap contract;loses minimum-core invariant by necessity.
  return prompt.slice(0, cap);
}

// ─── legal actions block ────────────────────────────────────────────

function buildLegalActionsBlock(
  _game: GameType,
  legalActions: readonly LegalAction[],
): string {
  if (legalActions.length === 0) return NO_LEGAL_ACTIONS_LINE;
  return legalActions
    .map((action, i) => `${i + 1}. ${formatLegalActionLine(action)}`)
    .join("\n");
}

function formatLegalActionLine(action: LegalAction): string {
  const type = typeof action.type === "string" ? action.type : "(unknown)";
  const dataHint = formatLegalActionDataHint(action.data);
  if (dataHint.length === 0) return `${type} — no parameters`;
  return `${type} — ${dataHint}`;
}

function formatLegalActionDataHint(data: unknown): string {
  if (data === undefined || data === null || typeof data !== "object") return "";
  const d = data as Record<string, unknown>;
  const keys = Object.keys(d);
  if (keys.length === 0) return "";

  const parts: string[] = [];
  for (const k of keys) {
    const v = d[k];
    if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") {
      parts.push(`${k}=${v}`);
    } else if (Array.isArray(v)) {
      const flat = v
        .filter((x) => typeof x === "number" || typeof x === "string")
        .map((x) => String(x))
        .join(",");
      parts.push(`${k}=[${flat}]`);
    }
  }
  if (parts.length === 0) return "";
  return `data: {${parts.join(", ")}}`;
}

// ─── state stripping (Level b) ──────────────────────────────────────

// Per TED rev3 拍板点 #9 — minimum-state core preserved at level (b):
//   Texas Hold'em: phase / Hand X / Your hand / Board / Your chips / Pot
//   Liar's Dice:   phase / Round / Your dice / Current bid
//   Coup:          phase / Your unrevealed cards / Your coins / Pending action
function stripNonCoreState(game: GameType, stateBlock: string): string {
  const corePrefixes = corePrefixesForGame(game);
  const lines = stateBlock.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trimStart();
    for (const prefix of corePrefixes) {
      if (trimmed.startsWith(prefix)) {
        kept.push(line);
        break;
      }
    }
  }
  return kept.join("\n");
}

function corePrefixesForGame(game: GameType): readonly string[] {
  switch (game) {
    case "texas_holdem":
      return ["Phase:", "Hand ", "Your hand:", "Board:", "Your chips:", "Pot:"];
    case "liars_dice":
      return ["Phase:", "Round ", "Your dice:", "Current bid:"];
    case "coup":
      return ["Phase:", "Your unrevealed cards:", "Your coins:", "Pending action:"];
  }
}
