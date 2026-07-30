// D6 — reasoning-trace ROW renderers: how one BridgeDecisionTrace reads as a
// "what my agent is thinking" line. Driven by the live bridge stream
// (window.aifight.onTrace) during a real match, or by the demo synthesizer
// offline — same shape, same rendering.
//
// Since D11 (2026-07-30) these rows render INSIDE EventLogPanel, embedded in
// the full match event log at the step each decision was taken; the standalone
// ReasoningTracePanel (own-agent-only stream) was replaced by that panel.

import { useTranslation } from "react-i18next";
import { Brain, ArrowRight, AlertTriangle } from "lucide-react";

import type { TraceAction } from "../../shared/ipc";
import type { StampedTrace } from "../liveStore";

export function actionLabel(action: TraceAction, t: (k: string, o?: Record<string, unknown>) => string): string {
  const d = action.data ?? {};
  // Localize the verb (fold/raise/bid/…); unknown action types fall back to the
  // raw type so a new game's actions still render.
  const verb = t(`cockpit.act.${action.type}`, { defaultValue: action.type });
  if (action.type === "bid" && d.quantity !== undefined) return `${verb} ${d.quantity}×${d.face}`;
  if (d.amount !== undefined) return `${verb} ${d.amount}`;
  return verb;
}

export function TraceRow({
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
          {/* Owner ruling 2026-07-30: no content hash on screen — the 64-char
              hex overflowed the card and carried no in-app meaning. */}
          <div className="v3-tr-meta">{trace.raw.bytes}B</div>
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
    case "illegal_retry":
      // The corrective retry is implied by the group staying "in flight" (the
      // thinking placeholder holds until a real outcome lands) — no row of its
      // own, same as the pre-D11 panel.
      return null;
  }
}

export type TraceBadge = "live" | "demo" | "replay";
