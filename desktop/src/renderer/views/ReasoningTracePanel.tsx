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
        <div className="flex items-center gap-2 px-1 pt-1.5 text-[11px] text-[var(--text-muted)]">
          <Brain size={13} className="shrink-0 text-[var(--accent)]" />
          <span className="font-medium text-[var(--text)]">{t("cockpit.decision")}</span>
          <span>· {trace.legalActionCount} {t("cockpit.legalActions")}</span>
        </div>
      );
    case "runtime_success":
      return (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2.5">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-faint)]">
            {t("cockpit.modelOutput")}
          </div>
          <div className="whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-[var(--text)]">
            {trace.raw.preview}
          </div>
          <div className="mt-1.5 text-[10px] text-[var(--text-faint)]">
            {trace.raw.bytes}B · sha {trace.raw.sha256}
          </div>
        </div>
      );
    case "final_action":
      return (
        <div className="flex items-center gap-2 px-1 pb-1.5 text-[12px]">
          <ArrowRight size={13} className="shrink-0 text-[var(--text-muted)]" />
          <span className="font-mono font-medium text-[var(--text)]">{actionLabel(trace.action, t)}</span>
          <span
            className={
              "rounded px-1.5 py-0.5 text-[10px] " +
              (trace.source === "runtime"
                ? "bg-emerald-500/15 text-emerald-400"
                : "bg-amber-500/15 text-amber-400")
            }
          >
            {trace.source === "runtime" ? t("cockpit.fromRuntime") : t("cockpit.fromFallback")}
          </span>
        </div>
      );
    case "runtime_failure":
      return (
        <div className="flex items-start gap-2 px-1 text-[11px] text-red-400">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>
            {t("cockpit.runtimeFailed")} #{trace.attempt}
            {trace.errorClass ? ` (${trace.errorClass})` : ""}: {trace.error}
          </span>
        </div>
      );
    case "strategy_error":
      return (
        <div className="flex items-start gap-2 px-1 text-[11px] text-amber-400">
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

  const badgeColor =
    badge === "live" ? "text-emerald-400" : badge === "replay" ? "text-[var(--accent)]" : "text-[var(--text-faint)]";
  const dotColor =
    badge === "live" ? "bg-emerald-400" : badge === "replay" ? "bg-[var(--accent)]" : "bg-[var(--text-faint)]";
  const badgeLabel = badge === "live" ? t("cockpit.live") : badge === "replay" ? t("cockpit.replay") : t("cockpit.demo");

  return (
    <div className="flex h-full min-h-0 flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)]">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
        <div>
          <div className="text-[13px] font-medium text-[var(--text)]">{t("cockpit.reasoning")}</div>
          <div className="text-[11px] text-[var(--text-muted)]">{t("cockpit.reasoningHint")}</div>
        </div>
        <span className={"flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] " + badgeColor}>
          <span className={"inline-block h-1.5 w-1.5 rounded-full " + dotColor} />
          {badgeLabel}
        </span>
      </div>
      <div className="flex-1 space-y-1.5 overflow-auto p-3">
        {traces.length === 0 ? (
          <div className="px-2 py-10 text-center text-[12px] text-[var(--text-faint)]">{emptyHint ?? t("cockpit.noTraces")}</div>
        ) : (
          traces.map((tr, i) => <TraceRow key={i} trace={tr} />)
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
