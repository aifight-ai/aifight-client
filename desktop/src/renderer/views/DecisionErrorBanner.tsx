// Fatal-class decision-error banner (API_ERROR_CLASSIFICATION_SPEC D9). Shown in
// the LIVE cockpit only, when one or more decisions this match fell back because
// of a FATAL API error a retry can't fix — a rejected key, an exhausted quota, a
// bad request, or a content-filter block. Points the user at the fix. Transient
// classes (rate_limit / server / timeout / network) are omitted: they usually
// auto-recover and aren't actionable.

import { useMemo } from "react";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { BridgeDecisionTrace, DecisionErrorClass } from "../../shared/ipc";

const FATAL: ReadonlySet<DecisionErrorClass> = new Set(["auth", "quota", "config", "content_filter"]);

const MESSAGE_KEY: Record<string, string> = {
  auth: "cockpit.decErrAuth",
  quota: "cockpit.decErrQuota",
  config: "cockpit.decErrConfig",
  content_filter: "cockpit.decErrContentFilter",
};

/** The most recent fatal-class failure this match, and how many there were. */
function summarizeFatal(traces: readonly BridgeDecisionTrace[]): { cls: DecisionErrorClass; profileId?: string; count: number } | null {
  let latest: { cls: DecisionErrorClass; profileId?: string } | null = null;
  let count = 0;
  for (const t of traces) {
    if (t.type === "runtime_failure" && t.errorClass && FATAL.has(t.errorClass)) {
      count++;
      latest = { cls: t.errorClass, ...(t.profileId ? { profileId: t.profileId } : {}) };
    }
  }
  return latest ? { ...latest, count } : null;
}

export function DecisionErrorBanner({ traces, isLive }: { traces: readonly BridgeDecisionTrace[]; isLive: boolean }) {
  const { t } = useTranslation();
  const fatal = useMemo(() => summarizeFatal(traces), [traces]);

  if (!isLive || !fatal) return null;

  const prof = fatal.profileId ? ` (${fatal.profileId})` : "";
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-[var(--text)]">
      <AlertTriangle size={15} className="shrink-0 text-red-500" />
      <span className="min-w-0 flex-1">
        {t(MESSAGE_KEY[fatal.cls] ?? "cockpit.decErrConfig", { n: fatal.count })}
        {prof}
      </span>
    </div>
  );
}
