// D6 — the reasoning-trace panel: renders the BridgeDecisionTrace stream as a
// readable "what my agent is thinking" log. Driven by the live bridge stream
// (window.aifight.onTrace) during a real match, or by the demo synthesizer
// offline — same shape, same rendering. This view is the desktop's unique value:
// the website never exposes the model's per-step reasoning.

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Brain, ArrowRight, AlertTriangle } from "lucide-react";

import type { BridgeDecisionTrace, TraceAction } from "../../shared/ipc";

function actionLabel(action: TraceAction, t: (k: string, o?: Record<string, unknown>) => string): string {
  const d = action.data ?? {};
  // Localize the verb (fold/raise/bid/…); unknown action types fall back to the
  // raw type so a new game's actions still render.
  const verb = t(`cockpit.act.${action.type}`, { defaultValue: action.type });
  if (action.type === "bid" && d.quantity !== undefined) return `${verb} ${d.quantity}×${d.face}`;
  if (d.amount !== undefined) return `${verb} ${d.amount}`;
  return verb;
}

function TraceRow({ trace }: { trace: BridgeDecisionTrace }) {
  const { t } = useTranslation();
  switch (trace.type) {
    case "decision_request":
      return (
        <div className="v3-tr-row v3-tr-decision">
          <Brain size={13} className="shrink-0 text-[var(--v3-acc)]" />
          <span>
            <b>{t("cockpit.decision")}</b>
            {` · ${trace.legalActionCount} ${t("cockpit.legalActions")}`}
          </span>
        </div>
      );
    case "runtime_success":
      return (
        <div className="v3-tr-card">
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
        <div className="v3-tr-row v3-tr-final">
          <ArrowRight size={13} className="shrink-0 text-[var(--v3-t3)]" />
          <b>{actionLabel(trace.action, t)}</b>
          <span className="v3-tr-src" data-kind={trace.source === "runtime" ? "runtime" : "fallback"}>
            {trace.source === "runtime" ? t("cockpit.fromRuntime") : t("cockpit.fromFallback")}
          </span>
        </div>
      );
    case "runtime_failure":
      return (
        <div className="v3-tr-row v3-tr-err">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>
            {t("cockpit.runtimeFailed")} #{trace.attempt}
            {trace.errorClass ? ` (${trace.errorClass})` : ""}: {trace.error}
          </span>
        </div>
      );
    case "strategy_error":
      return (
        <div className="v3-tr-row v3-tr-warn">
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
}: {
  traces: BridgeDecisionTrace[];
  badge: TraceBadge;
  /** Override for the empty-state text (e.g. "waiting for first decision" when live). */
  emptyHint?: string;
}) {
  const { t } = useTranslation();
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [traces.length]);

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
          traces.map((tr, i) => <TraceRow key={i} trace={tr} />)
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
