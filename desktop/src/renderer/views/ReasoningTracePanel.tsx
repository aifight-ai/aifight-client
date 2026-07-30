// D6 — the reasoning-trace panel: renders the BridgeDecisionTrace stream as a
// readable "what my agent is thinking" log. Driven by the live bridge stream
// (window.aifight.onTrace) during a real match, or by the demo synthesizer
// offline — same shape, same rendering. This view is the desktop's unique value:
// the website never exposes the model's per-step reasoning.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Brain, ArrowRight, AlertTriangle, Loader2 } from "lucide-react";

import type { TraceAction } from "../../shared/ipc";
import type { StampedTrace } from "../liveStore";

function actionLabel(action: TraceAction, t: (k: string, o?: Record<string, unknown>) => string): string {
  const d = action.data ?? {};
  // Localize the verb (fold/raise/bid/…); unknown action types fall back to the
  // raw type so a new game's actions still render.
  const verb = t(`cockpit.act.${action.type}`, { defaultValue: action.type });
  if (action.type === "bid" && d.quantity !== undefined) return `${verb} ${d.quantity}×${d.face}`;
  if (d.amount !== undefined) return `${verb} ${d.amount}`;
  return verb;
}

function TraceRow({
  trace,
  current,
  anchorRef,
  onJumpToStep,
}: {
  trace: StampedTrace;
  current?: boolean;
  /** Set on the CURRENT group's opening decision row — the auto-scroll target. */
  anchorRef?: React.Ref<HTMLDivElement>;
  onJumpToStep?: (step: number) => void;
}) {
  const { t } = useTranslation();
  // "current" = this row belongs to the decision group the transport is ON —
  // the panel's visual answer to "which reasoning does the board show now".
  const cur = current === true ? " v3-tr-cur" : "";
  switch (trace.type) {
    case "decision_request":
      return (
        <div ref={anchorRef} className={"v3-tr-row v3-tr-decision" + cur}>
          <Brain size={13} className="shrink-0 text-[var(--v3-acc)]" />
          <span>
            <b>{t("cockpit.decision")}</b>
            {` · ${trace.legalActionCount} ${t("cockpit.legalActions")}`}
          </span>
          {/* Which board step this decision belongs to — click to scrub there. */}
          {trace.step !== undefined && (
            <button
              className="v3-tr-step"
              title={t("cockpit.seek")}
              onClick={onJumpToStep === undefined ? undefined : () => onJumpToStep(trace.step!)}
              disabled={onJumpToStep === undefined}
            >
              {t("cockpit.step", { n: trace.step })}
            </button>
          )}
        </div>
      );
    case "runtime_success":
      return (
        <div className={"v3-tr-card" + cur}>
          {trace.reasoning !== undefined && (
            <div className="mb-2">
              <div className="v3-tr-label">{t("cockpit.modelThinking")}</div>
              <div className="v3-tr-thinking">{trace.reasoning.text}</div>
            </div>
          )}
          <div className="v3-tr-label v3-tr-label--dim">{t("cockpit.modelOutput")}</div>
          <div className="v3-tr-output">{trace.raw.preview}</div>
          <div className="v3-tr-meta">
            {trace.raw.bytes}B · sha {trace.raw.sha256}
          </div>
        </div>
      );
    case "final_action":
      return (
        <div className={"v3-tr-row v3-tr-final" + cur}>
          <ArrowRight size={13} className="shrink-0 text-[var(--v3-t3)]" />
          <b>{actionLabel(trace.action, t)}</b>
          <span className="v3-tr-src" data-kind={trace.source === "runtime" ? "runtime" : "fallback"}>
            {trace.source === "runtime" ? t("cockpit.fromRuntime") : t("cockpit.fromFallback")}
          </span>
        </div>
      );
    case "runtime_failure":
      return (
        <div className={"v3-tr-row v3-tr-err" + cur}>
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>
            {t("cockpit.runtimeFailed")} #{trace.attempt}
            {trace.errorClass ? ` (${trace.errorClass})` : ""}: {trace.error}
          </span>
        </div>
      );
    case "strategy_error":
      return (
        <div className={"v3-tr-row v3-tr-warn" + cur}>
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>
            {t("cockpit.strategyError")}: {trace.error}
          </span>
        </div>
      );
  }
}

export type TraceBadge = "live" | "demo" | "replay";

export function ReasoningTracePanel({
  traces,
  badge,
  emptyHint,
  onJumpToStep,
  transportStep,
}: {
  traces: readonly StampedTrace[];
  badge: TraceBadge;
  /** Override for the empty-state text (e.g. "waiting for first decision" when live). */
  emptyHint?: string;
  /** Scrub the board to a trace's step (wired to the cockpit transport). */
  onJumpToStep?: (step: number) => void;
  /**
   * F3: the cockpit transport's current step. The "current" anchor is the LAST
   * decision group taken at or before this step, so the panel follows the board
   * while scrubbing back and forth. Live-follow passes the tip (events.length),
   * which lands on the latest group — exactly the pre-F3 behavior. Undefined =
   * anchor the trailing group regardless of step (standalone use).
   */
  transportStep?: number;
}) {
  const { t } = useTranslation();
  const endRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  // F3: anchor = the last decision_request group at or before the transport
  // step (unstamped traces — older stored sessions — are always eligible).
  const anchorIdx = traces.reduce(
    (acc, tr, i) =>
      tr.type === "decision_request" &&
      (transportStep === undefined || tr.step === undefined || tr.step <= transportStep)
        ? i
        : acc,
    -1,
  );
  // The anchored group spans up to the NEXT decision_request: the "current"
  // highlight must not bleed into a later group the transport hasn't reached
  // (possible in live, where the trace stream is never filtered).
  const nextDecisionIdx = traces.findIndex((tr, i) => i > anchorIdx && tr.type === "decision_request");

  // F4: a trailing decision group with no outcome row yet IS the agent still
  // thinking (decision_request is emitted before the LLM call). Render a
  // spinner + elapsed seconds in the group's own card style; the result trace
  // replaces it naturally. Live/demo streams only — a stored replay is
  // complete, so a spinner there would spin forever over a settled decision.
  const lastDecisionIdx = traces.reduce((acc, tr, i) => (tr.type === "decision_request" ? i : acc), -1);
  const thinkingIdx =
    badge !== "replay" &&
    lastDecisionIdx !== -1 &&
    !traces
      .slice(lastDecisionIdx + 1)
      .some(
        (tr) =>
          tr.type === "runtime_success" ||
          tr.type === "runtime_failure" ||
          tr.type === "final_action" ||
          tr.type === "strategy_error",
      )
      ? lastDecisionIdx
      : -1;
  const thinkingAt = thinkingIdx !== -1 ? traces[thinkingIdx]?.at : undefined;
  // 1s ticker for the elapsed counter; mounted only while the placeholder shows.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (thinkingIdx === -1) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [thinkingIdx]);
  const thinkingElapsedSec =
    thinkingAt === undefined ? null : Math.max(0, Math.floor((nowTick - thinkingAt) / 1000));

  useEffect(() => {
    // Follow the transport: align the CURRENT decision group's opening row to
    // the top of the panel, so the user reads their agent's thinking summary →
    // final decision top-down for exactly the step on the board (owner ask
    // 2026-07-28). No group visible → pin to the bottom (tail of whatever is
    // there). Only the panel's OWN scroller moves — scrollIntoView walked every
    // scrollable ancestor and yanked the whole History page.
    const scroller = endRef.current?.parentElement;
    if (!(scroller instanceof HTMLElement)) return;
    const target = anchorRef.current;
    if (target !== null) {
      const delta = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTop = Math.max(0, scroller.scrollTop + delta - 8);
    } else {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, [anchorIdx, traces.length]);

  const badgeLabel = badge === "live" ? t("cockpit.live") : badge === "replay" ? t("cockpit.replay") : t("cockpit.demo");

  return (
    <div className="v3-trace">
      <div className="v3-tr-hd">
        <span className="v3-tr-sq" />
        <div className="v3-tr-titles">
          <div className="v3-tr-title">{t("cockpit.reasoning")}</div>
          <div className="v3-tr-sub">{t("cockpit.reasoningHint")}</div>
        </div>
        <span className="v3-tr-badge" data-kind={badge}>
          <i />
          {badgeLabel}
        </span>
      </div>
      <div className="v3-tr-body">
        {traces.length === 0 ? (
          <div className="v3-tr-empty">{emptyHint ?? t("cockpit.noTraces")}</div>
        ) : (
          traces.map((tr, i) => (
            <TraceRow
              key={i}
              trace={tr}
              current={anchorIdx !== -1 && i >= anchorIdx && (nextDecisionIdx === -1 || i < nextDecisionIdx)}
              anchorRef={i === anchorIdx ? anchorRef : undefined}
              onJumpToStep={onJumpToStep}
            />
          ))
        )}
        {thinkingIdx !== -1 && (
          <div className={"v3-tr-row v3-tr-decision v3-tr-pending" + (thinkingIdx === anchorIdx ? " v3-tr-cur" : "")}>
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
        <div ref={endRef} />
      </div>
    </div>
  );
}
