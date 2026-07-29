// D6 — the reasoning-trace panel: renders the BridgeDecisionTrace stream as a
// readable "what my agent is thinking" log. Driven by the live bridge stream
// (window.aifight.onTrace) during a real match, or by the demo synthesizer
// offline — same shape, same rendering. This view is the desktop's unique value:
// the website never exposes the model's per-step reasoning.

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Brain, ArrowRight, AlertTriangle } from "lucide-react";

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
}: {
  traces: readonly StampedTrace[];
  badge: TraceBadge;
  /** Override for the empty-state text (e.g. "waiting for first decision" when live). */
  emptyHint?: string;
  /** Scrub the board to a trace's step (wired to the cockpit transport). */
  onJumpToStep?: (step: number) => void;
}) {
  const { t } = useTranslation();
  const endRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  // The trailing decision group (last decision_request → end) is the one the
  // board currently shows — its opening row is the scroll anchor.
  const lastDecisionIdx = traces.reduce((acc, tr, i) => (tr.type === "decision_request" ? i : acc), -1);
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
  }, [lastDecisionIdx, traces.length]);

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
              current={lastDecisionIdx !== -1 && i >= lastDecisionIdx}
              anchorRef={i === lastDecisionIdx ? anchorRef : undefined}
              onJumpToStep={onJumpToStep}
            />
          ))
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
