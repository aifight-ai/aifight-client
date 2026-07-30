// D11 — the cockpit event log: the FULL match event stream (every player's
// moves with amounts, hand/round separators, emphasized results) with the
// owner's own reasoning trace embedded INLINE at the step each decision was
// taken. Replaces the own-agent-only ReasoningTracePanel at the cockpit's
// right rail (owner ask 2026-07-30: "the web replay's event log, but better").
//
// Both live and replay flow through here (same panel, same rows):
//  - LIVE: all arrived rows render (arrival order IS the live experience);
//    while the transport follows, the log pins to the bottom as rows append;
//    a user who scrubbed back (following=false) is never force-scrolled.
//  - REPLAY: rows cut at the transport step, a decision's trace appears once
//    the transport reaches its step (same contract as the old panel), the
//    current row (index step-1) is highlighted and kept in view, and clicking
//    any row jumps the transport to just after it (onJumpToStep(index + 1)).
//
// Row/trace correlation + formatting live in ../eventLog.ts (pure, tested) —
// the binding rule: a trace group stamped with step S embeds BEFORE the row at
// array index S. Everything is recomputed from the current props each render
// (useMemo on identity): events[] can shrink/rebuild (F2 rollback, reconnect
// full rebuild), so no derived index may be cached across renders.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Hourglass, Loader2 } from "lucide-react";

import type { MatchEvent, MatchPlayer } from "@aifight/api-types";
import type { Game } from "../liveMatch";
import type { StampedTrace } from "../liveStore";
import {
  anchorTraceGroups,
  describeEvent,
  displayName,
  groupsByPosition,
  playerNameColor,
  type AnchoredTraceGroup,
  type LogContext,
  type LogRowModel,
} from "../eventLog";
import { TraceRow, type TraceBadge } from "./ReasoningTracePanel";

export interface EventLogPanelProps {
  readonly game: Game;
  readonly events: readonly MatchEvent[];
  readonly traces: readonly StampedTrace[];
  /** match.players — player_id → display name (anonymized "Player N" live). */
  readonly players: readonly MatchPlayer[];
  readonly ownerPlayerId: string;
  readonly badge: TraceBadge;
  readonly isLive: boolean;
  /** The cockpit transport's current step (board position, an events count). */
  readonly transportStep: number;
  /** Live follow-the-tip state; the log only auto-scrolls while this holds. */
  readonly following: boolean;
  /** Scrub the board (wired to the cockpit transport). */
  readonly onJumpToStep: (step: number) => void;
  /** Live: our last decision settled and no action_request of ours is open. */
  readonly waitingForOthers?: boolean;
  /** Empty-state override (e.g. "waiting for first decision" when live). */
  readonly emptyHint?: string;
}

export function EventLogPanel({
  game,
  events,
  traces,
  players,
  ownerPlayerId,
  badge,
  isLive,
  transportStep,
  following,
  onJumpToStep,
  waitingForOthers,
  emptyHint,
}: EventLogPanelProps) {
  const { t } = useTranslation();
  const ctx: LogContext = useMemo(
    () => ({ game, players, ownerPlayerId, t }),
    [game, players, ownerPlayerId, t],
  );

  // Live renders every arrived row; replay cuts the log at the transport.
  const visibleCount = isLive ? events.length : Math.max(0, Math.min(transportStep, events.length));

  const rows = useMemo(
    () =>
      events.slice(0, visibleCount).map((ev, index) => ({ index, row: describeEvent(ev, ctx) })),
    [events, visibleCount, ctx],
  );

  // Trace visibility, unchanged from the old reasoning panel: live keeps the
  // full arrival-ordered stream; replay reveals a decision once the transport
  // reaches the step it was taken at (unstamped = older sessions, always shown).
  const shownTraces = useMemo(
    () => (isLive ? traces : traces.filter((tr) => tr.step === undefined || tr.step <= transportStep)),
    [isLive, traces, transportStep],
  );

  // Embed positions: group at step S renders BEFORE the visible row at index S.
  const groupsAt = useMemo(
    () => groupsByPosition(anchorTraceGroups(shownTraces), rows.length),
    [shownTraces, rows.length],
  );

  // F3 "current" marking, ported from the old panel: the LAST decision-led
  // group anchored at or before the transport step (unstamped groups are always
  // eligible). Its rows get v3-tr-cur so the reasoning that produced the board
  // at THIS step is visually picked out while scrubbing.
  const currentGroup = useMemo(() => {
    let cur: AnchoredTraceGroup | null = null;
    for (const gs of groupsAt.values()) {
      for (const g of gs) {
        if (g.traces[0]?.type !== "decision_request") continue; // preamble group
        if (g.anchor === undefined || g.anchor <= transportStep) cur = g;
      }
    }
    return cur;
  }, [groupsAt, transportStep]);

  // F4 "thinking" placeholder (live/demo only): the trailing decision group
  // with no outcome row yet IS the agent's in-flight LLM call. Rendered as a
  // spinner + elapsed seconds at the end of that group; the result trace
  // replaces it naturally. Replay is exempt — a stored session is complete.
  const thinking = useMemo(() => {
    if (badge === "replay") return null;
    const lastDecisionIdx = shownTraces.reduce((acc, tr, i) => (tr.type === "decision_request" ? i : acc), -1);
    if (lastDecisionIdx === -1) return null;
    const settled = shownTraces
      .slice(lastDecisionIdx + 1)
      .some(
        (tr) =>
          tr.type === "runtime_success" ||
          tr.type === "runtime_failure" ||
          tr.type === "final_action" ||
          tr.type === "strategy_error",
      );
    return settled ? null : shownTraces[lastDecisionIdx]!;
  }, [badge, shownTraces]);

  // 1s ticker for the elapsed counter; mounted only while the placeholder shows.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (thinking === null) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [thinking]);
  const thinkingElapsedSec =
    thinking?.at === undefined ? null : Math.max(0, Math.floor((nowTick - thinking.at) / 1000));

  const bodyRef = useRef<HTMLDivElement>(null);

  // Live follow: pin the log to the bottom as rows/traces append. Only the
  // panel's OWN scroller moves, and only while the transport is following —
  // a parked user (scrubbed back mid-live) is never disturbed.
  useEffect(() => {
    if (!isLive || !following) return;
    const el = bodyRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [isLive, following, rows.length, shownTraces.length]);

  // Replay: keep the current row (index step-1) inside the visible window —
  // the website ReplayEventLog's behavior, scoped to the panel's own scroller
  // so the surrounding page never moves.
  useEffect(() => {
    if (isLive) return;
    const c = bodyRef.current;
    if (c === null) return;
    const el = c.querySelector(`[data-idx="${transportStep - 1}"]`);
    if (!(el instanceof HTMLElement)) return;
    const er = el.getBoundingClientRect();
    const cr = c.getBoundingClientRect();
    if (er.top < cr.top || er.bottom > cr.bottom) {
      c.scrollTop += er.top - cr.top - c.clientHeight / 2;
    }
  }, [isLive, transportStep, rows.length]);

  const badgeLabel = badge === "live" ? t("cockpit.live") : badge === "replay" ? t("cockpit.replay") : t("cockpit.demo");

  // Assemble the flow: for each position 0..rows.length, the trace groups
  // embedded there, then the row at that index (skipped events render nothing
  // but still occupy a position so anchors stay exact). Keys are positional
  // (`tg{pos}.{n}`), so appends at the tip never re-mount earlier groups.
  const items: ReactNode[] = [];
  for (let pos = 0; pos <= rows.length; pos++) {
    const gs = groupsAt.get(pos);
    if (gs !== undefined) {
      gs.forEach((g, j) => {
        const isThinkingGroup = thinking !== null && g.traces.includes(thinking);
        items.push(
          <div className="v3-el-trace" key={`tg${pos}.${j}`}>
            <div className="v3-tr-group">
              {g.traces.map((tr, i) => (
                <TraceRow key={i} trace={tr} current={g === currentGroup} onJumpToStep={onJumpToStep} />
              ))}
            </div>
            {isThinkingGroup && (
              <div className={"v3-tr-row v3-tr-decision v3-tr-pending" + (g === currentGroup ? " v3-tr-cur" : "")}>
                <Loader2 size={13} className="shrink-0 animate-spin text-[var(--v3-acc)]" />
                <span>
                  <b>
                    {thinkingElapsedSec === null
                      ? t("cockpit.thinking")
                      : t("cockpit.thinkingFor", { s: thinkingElapsedSec })}
                  </b>
                </span>
              </div>
            )}
          </div>,
        );
      });
    }
    if (pos < rows.length) {
      const { index, row } = rows[pos]!;
      if (row !== null) {
        items.push(
          <EventLogRow
            key={`ev${index}`}
            index={index}
            row={row}
            ctx={ctx}
            current={index === transportStep - 1}
            onJumpToStep={onJumpToStep}
          />,
        );
      }
    }
  }

  return (
    <div className="v3-trace">
      <div className="v3-tr-hd">
        <span className="v3-tr-sq" />
        <div className="v3-tr-titles">
          <div className="v3-tr-title">{t("cockpit.log.title")}</div>
          <div className="v3-tr-sub">{t("cockpit.log.hint")}</div>
        </div>
        <span className="v3-tr-badge" data-kind={badge}>
          <i />
          {badgeLabel}
        </span>
      </div>
      <div className="v3-el-body" ref={bodyRef}>
        {items.length === 0 ? (
          <div className="v3-tr-empty">{emptyHint ?? t("cockpit.log.empty")}</div>
        ) : (
          items
        )}
        {/* Waiting placeholder (live): our last decision settled and no open
            action_request — opponents are deciding. Static, deliberately NOT
            the thinking placeholder's spinner + elapsed. */}
        {waitingForOthers === true && thinking === null && shownTraces.length > 0 && (
          <div className="v3-tr-row v3-tr-waiting">
            <Hourglass size={13} className="shrink-0" />
            <span>{t("cockpit.waitingOthers")}</span>
            <span className="v3-dots" aria-hidden>
              <i />
              <i />
              <i />
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function EventLogRow({
  index,
  row,
  ctx,
  current,
  onJumpToStep,
}: {
  index: number;
  row: LogRowModel;
  ctx: LogContext;
  current: boolean;
  onJumpToStep: (step: number) => void;
}) {
  const name = row.playerId !== null ? displayName(row.playerId, ctx) : null;
  // undefined = the owner's own row → the cockpit's owner-accent class wins.
  const color = row.playerId !== null ? playerNameColor(row.playerId, ctx) : undefined;
  return (
    <button
      type="button"
      className={`v3-el-row v3-el-row--${row.kind}` + (current ? " v3-el-cur" : "")}
      data-idx={index}
      data-jump={index + 1}
      title={ctx.t("cockpit.seek")}
      onClick={() => onJumpToStep(index + 1)}
    >
      <span className="v3-el-ln">#{index + 1}</span>
      {name !== null && (
        <span
          className={"v3-el-name" + (color === undefined ? " v3-el-you" : "")}
          style={color !== undefined ? { color } : undefined}
        >
          {name}
        </span>
      )}
      <span className="v3-el-text">
        {name !== null ? ": " : ""}
        {row.tail}
      </span>
    </button>
  );
}
