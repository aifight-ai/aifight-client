// D11 — the cockpit event log: turn the merged ALL-players MatchEvent stream
// into formatted log rows (the website replay page's right rail, but better —
// with action AMOUNTS, per-player colors, and the owner's reasoning trace
// embedded inline). Live events carry no server caption, so every line is
// formatted client-side here; pure functions, unit-tested without a DOM.
//
// Row model: one event → at most one row (some engine events are deliberately
// skipped, see SKIPPED_TYPES). Rows keep their events[] ARRAY INDEX so the
// panel's click-to-jump (onJumpToStep(index + 1)) and the trace correlation
// stay exact even across skipped entries.
//
// 🔒 TRACE CORRELATION RULE (binding, mirrors liveStore's stamping): a trace
// group stamped with step S was decided while the board held events[0..S), so
// the group is embedded BEFORE the log row at array index S (after row S-1);
// S = 0 anchors at the very top. Unstamped traces (older stored sessions)
// anchor at the tip and stay visible at any transport position. Do NOT cache
// derived rows across renders — events[] can shrink/rebuild (F2 rollback,
// reconnect full rebuild), making array indices shift; always recompute from
// the current props (useMemo keyed on the events/traces identity).

import { agentGradient } from "@aifight/ui";
import type { MatchEvent, MatchPlayer } from "@aifight/api-types";
import type { Game } from "./liveMatch";
import type { StampedTrace } from "./liveStore";

/** i18next's t, narrowed to the call shape this module uses (same as ReasoningTracePanel). */
export type TFunc = (key: string, opts?: Record<string, unknown>) => string;

export interface LogContext {
  readonly game: Game;
  readonly players: readonly MatchPlayer[];
  readonly ownerPlayerId: string;
  readonly t: TFunc;
}

export type LogRowKind = "action" | "phase" | "result" | "info";

export interface LogRowModel {
  readonly kind: LogRowKind;
  /**
   * Subject player (actor / eliminated player): the panel renders their name
   * as a colored "{name}: " prefix — the web log's colon style, which also
   * dodges en 3rd-person verb agreement ("You: raise" / "GPT-5: raise").
   * null = the row is a full-line entry (phase separators, results, info).
   */
  readonly playerId: string | null;
  /** Text after the name prefix (or the whole line when playerId is null). */
  readonly tail: string;
}

/**
 * Events the log deliberately does NOT render:
 *  - game_start / game_setup: protocol markers with no content.
 *  - cards_dealt: the owner's SYNTHETIC hole-card injection (F2/liveMatch) — a
 *    board-render detail, not a match step (the web log has no equivalent).
 *  - action_resolved / exchange_draw / exchange_complete (coup): mechanical
 *    follow-through of the action row already shown (coin deltas live on the
 *    board); keeping them would double every coup/dice turn in the log.
 */
const SKIPPED_TYPES = new Set([
  "game_start",
  "game_setup",
  "cards_dealt",
  "action_resolved",
  "exchange_draw",
  "exchange_complete",
]);

/** Chips with thousands separators — the SeatCard "1,200" precedent, both locales. */
export function fmtChips(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function strList(v: unknown): readonly string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

/**
 * Display name for a player id: the owner's own seat is the localized
 * "You/我" (the reducer hardcodes "You" for live play — the log localizes it);
 * opponents come from match.players (anonymized "Player N" during live play,
 * real names after game_over — labels retroactively change, by design).
 */
export function displayName(playerId: string, ctx: LogContext): string {
  if (playerId === ctx.ownerPlayerId && ctx.ownerPlayerId !== "") return ctx.t("cockpit.log.you");
  const p = ctx.players.find((pl) => pl.player_id === playerId || pl.agent_id === playerId);
  const name = p?.agent_name?.trim();
  return name !== undefined && name !== "" ? name : playerId;
}

/**
 * Deterministic per-player color for log names: the deep end of the shared
 * agentGradient pair (seeded on player_id — same player, same color, forever).
 * The owner's own rows return undefined: they keep the cockpit's owner-accent
 * treatment (CSS class) instead of a gradient color.
 */
export function playerNameColor(playerId: string, ctx: Pick<LogContext, "ownerPlayerId">): string | undefined {
  if (playerId === ctx.ownerPlayerId && ctx.ownerPlayerId !== "") return undefined;
  return agentGradient(playerId)[1];
}

// ── per-event formatting ─────────────────────────────────────────────────────

/** Localized verb from the shared cockpit.act table; unknown verbs fall back to the raw type. */
function actVerb(action: string, t: TFunc): string {
  return t(`cockpit.act.${action}`, { defaultValue: action.replace(/_/g, " ") });
}

function pokerRow(ev: MatchEvent, ctx: LogContext): LogRowModel | null {
  const { t } = ctx;
  const d = ev.data;
  switch (ev.type) {
    case "new_hand": {
      const n = num(d.hand_num);
      return { kind: "phase", playerId: null, tail: t("cockpit.log.handBegins", { n: n ?? "?" }) };
    }
    case "player_action": {
      const action = str(d.action) ?? "";
      const verb = actVerb(action, t);
      const amount = num(d.amount);
      // Amount semantics (engine): call.amount = chips added THIS action;
      // raise/allin.amount = the raise-to TOTAL for the round; blinds = posted.
      let tail: string;
      if ((action === "raise" || action === "allin") && amount !== null) {
        tail = t("cockpit.log.actionTo", { verb, amount: fmtChips(amount) });
      } else if (amount !== null) {
        tail = t("cockpit.log.actionFor", { verb, amount: fmtChips(amount) });
      } else {
        tail = verb;
      }
      return { kind: "action", playerId: ev.player_id ?? null, tail };
    }
    case "community_cards": {
      const cards = strList(d.cards).join(" ");
      return { kind: "info", playerId: null, tail: t("cockpit.log.board", { cards }) };
    }
    case "hand_result": {
      const winners = strList(d.winners).map((id) => displayName(id, ctx));
      if (winners.length === 0) {
        return { kind: "result", playerId: null, tail: t("cockpit.log.handDone", { hand: num(d.hand) ?? "?" }) };
      }
      const reasonRaw = str(d.reason);
      const reason =
        reasonRaw === null
          ? ""
          : t("cockpit.log.reasonSuffix", {
              reason: t(`cockpit.log.reason.${reasonRaw}`, { defaultValue: reasonRaw.replace(/_/g, " ") }),
            });
      const pot = num(d.pot);
      const hand = num(d.hand) ?? "?";
      const key =
        pot !== null && pot > 0
          ? winners.length > 1
            ? "cockpit.log.handSplit"
            : "cockpit.log.handWin"
          : winners.length > 1
            ? "cockpit.log.handSplitNoPot"
            : "cockpit.log.handWinNoPot";
      return {
        kind: "result",
        playerId: null,
        tail: t(key, { hand, winners: winners.join(", "), pot: pot !== null ? fmtChips(pot) : "", reason }),
      };
    }
    case "match_result":
      return matchOverRow(d, ctx);
    default:
      return null;
  }
}

function diceRow(ev: MatchEvent, ctx: LogContext): LogRowModel | null {
  const { t } = ctx;
  const d = ev.data;
  switch (ev.type) {
    case "round_start": {
      const n = num(d.round);
      return { kind: "phase", playerId: null, tail: t("cockpit.log.roundBegins", { n: n ?? "?" }) };
    }
    case "bid": {
      const q = num(d.quantity);
      const f = num(d.face);
      const tail =
        q !== null && f !== null
          ? t("cockpit.log.bid", { q, f })
          : actVerb("bid", t);
      return { kind: "action", playerId: ev.player_id ?? null, tail };
    }
    case "challenge": {
      // The dice challenge event IS the round resolution (bluff caught / bid
      // stood + who lost the die), so the row carries the outcome inline. en
      // conjugates "loses/lose" — the owner-as-loser variant keeps "you lose".
      const actual = num(d.actual_count);
      const face = num(d.bid_face);
      const loser = str(d.loser);
      const met = d.bid_met === true;
      let tail = actVerb("challenge", t);
      if (actual !== null && face !== null && loser !== null) {
        const you = loser === ctx.ownerPlayerId && ctx.ownerPlayerId !== "";
        const key = `cockpit.log.${met ? "challengeStood" : "challengeCaught"}${you ? "You" : ""}`;
        tail = t(key, { actual, face, loser: displayName(loser, ctx) });
      }
      return { kind: "action", playerId: ev.player_id ?? null, tail };
    }
    case "player_eliminated":
      return { kind: "result", playerId: ev.player_id ?? null, tail: t("cockpit.log.eliminated") };
    case "game_over":
      return matchOverRow(d, ctx);
    default:
      return null;
  }
}

function coupRow(ev: MatchEvent, ctx: LogContext): LogRowModel | null {
  const { t } = ctx;
  const d = ev.data;
  const role = str(d.claimed_role);
  const claim = role !== null ? t("cockpit.log.claimSuffix", { role }) : "";
  const targetId = str(d.target);
  const target = targetId !== null ? t("cockpit.log.targetSuffix", { target: displayName(targetId, ctx) }) : "";
  switch (ev.type) {
    case "action": {
      const action = str(d.action) ?? "";
      return { kind: "action", playerId: ev.player_id ?? null, tail: `${actVerb(action, t)}${target}${claim}` };
    }
    case "challenge":
      return { kind: "action", playerId: ev.player_id ?? null, tail: `${actVerb("challenge", t)}${claim}` };
    case "challenge_block":
      return { kind: "action", playerId: ev.player_id ?? null, tail: t("cockpit.log.challengeBlock", { role: role ?? "?" }) };
    case "block":
      return { kind: "action", playerId: ev.player_id ?? null, tail: `${actVerb("block", t)}${claim}` };
    case "block_pass":
    case "challenge_pass":
    case "block_challenge_pass":
      // Passes are frequent and low-signal — a dim info line, not a full action row.
      return { kind: "info", playerId: ev.player_id ?? null, tail: actVerb("pass", t) };
    case "block_accepted":
      return { kind: "info", playerId: null, tail: t("cockpit.log.blockAccepted") };
    case "challenge_result":
    case "challenge_block_result": {
      // result "fail" = the challenge FAILED (the claim was true, revealed_card
      // proves it); "success" = the claim was a bluff and is caught.
      const failed = d.result === "fail";
      const subjectId = str(d.actor) ?? str(d.blocker);
      const subject = subjectId !== null ? displayName(subjectId, ctx) : "?";
      const revealed = str(d.revealed_card);
      const onBlock = ev.type === "challenge_block_result";
      const key = failed
        ? onBlock ? "cockpit.log.blockResultFail" : "cockpit.log.challengeResultFail"
        : onBlock ? "cockpit.log.blockResultSuccess" : "cockpit.log.challengeResultSuccess";
      return { kind: "result", playerId: null, tail: t(key, { subject, card: revealed ?? "" }) };
    }
    case "influence_lost": {
      const card = str(d.card);
      return {
        kind: "action",
        playerId: ev.player_id ?? null,
        tail: t("cockpit.log.influenceLost", { card: card ?? "?" }),
      };
    }
    case "player_eliminated":
      return { kind: "result", playerId: ev.player_id ?? null, tail: t("cockpit.log.eliminated") };
    case "game_over":
      return matchOverRow(d, ctx);
    default:
      return null;
  }
}

/** Shared terminal row for poker match_result and dice/coup game_over. */
function matchOverRow(d: Record<string, unknown>, ctx: LogContext): LogRowModel {
  const { t } = ctx;
  if (d.is_draw === true) return { kind: "result", playerId: null, tail: t("cockpit.log.matchOverDraw") };
  const winner = str(d.winner);
  if (winner !== null) {
    return { kind: "result", playerId: null, tail: t("cockpit.log.matchOverWinner", { winner: displayName(winner, ctx) }) };
  }
  return { kind: "result", playerId: null, tail: t("cockpit.log.matchOver") };
}

/**
 * Format one event as a log row. null = skipped (SKIPPED_TYPES). Unknown
 * types degrade to the web log's fallback: the type name with spaces.
 */
export function describeEvent(ev: MatchEvent, ctx: LogContext): LogRowModel | null {
  if (SKIPPED_TYPES.has(ev.type)) return null;
  const row =
    ctx.game === "texas_holdem" ? pokerRow(ev, ctx) : ctx.game === "liars_dice" ? diceRow(ev, ctx) : coupRow(ev, ctx);
  if (row !== null) return row;
  // Unhandled type within a known game: keep it visible, dimmed.
  return { kind: "info", playerId: ev.player_id ?? null, tail: ev.type.replace(/_/g, " ") };
}

// ── trace grouping + embedding ───────────────────────────────────────────────

/**
 * A decision group (decision_request → thinking → outcome) plus its embed
 * anchor. anchor = the group's board step (see the correlation rule at the
 * top); undefined = unstamped (older stored sessions) → renders at the tip.
 */
export interface AnchoredTraceGroup {
  readonly anchor: number | undefined;
  readonly traces: readonly StampedTrace[];
}

/**
 * Group the trace stream the way ReasoningTracePanel does (a new group opens
 * at each decision_request; traces before the first one form a preamble
 * group), then attach the embed anchor = the group's first STAMPED step.
 * Arrival order is preserved (Array.prototype.sort is stable, and steps are
 * non-decreasing in a healthy stream — a reconnect rebuild can stamp an
 * EARLIER step after a later one, so we sort defensively by anchor with
 * undefined last; equal anchors keep arrival order).
 */
export function anchorTraceGroups(traces: readonly StampedTrace[]): AnchoredTraceGroup[] {
  const groups: StampedTrace[][] = [];
  traces.forEach((tr) => {
    if (tr.type === "decision_request" || groups.length === 0) groups.push([]);
    groups[groups.length - 1]!.push(tr);
  });
  const anchored = groups.map((g) => {
    const stamped = g.find((tr) => tr.step !== undefined);
    return { anchor: stamped?.step, traces: g };
  });
  return anchored.slice().sort((a, b) => {
    if (a.anchor === undefined) return b.anchor === undefined ? 0 : 1;
    if (b.anchor === undefined) return -1;
    return a.anchor - b.anchor;
  });
}

/**
 * Bucket anchored groups by their render position in the visible log: a group
 * anchored at S renders BEFORE the visible row at index S (after row S-1);
 * positions run 0..rowCount inclusive (rowCount = at/after the last visible
 * row). Anchors past the visible end clamp to rowCount — events[] can shrink
 * (F2 rollback / reconnect rebuild) after a trace was stamped, and a clamped
 * group must still render, never vanish.
 */
export function groupsByPosition(
  groups: readonly AnchoredTraceGroup[],
  rowCount: number,
): Map<number, AnchoredTraceGroup[]> {
  const out = new Map<number, AnchoredTraceGroup[]>();
  for (const g of groups) {
    const pos = g.anchor === undefined ? rowCount : Math.max(0, Math.min(g.anchor, rowCount));
    const list = out.get(pos);
    if (list === undefined) out.set(pos, [g]);
    else list.push(g);
  }
  return out;
}
