// Token-budget guard banner (TOKEN_BUDGET_SAFETY_SPEC B2). Shown in the LIVE
// cockpit only, when one or more decisions this match were cut short by a
// too-small max_tokens. Offers a one-click raise that bumps the responsible
// profile's maxTokens (its API key is preserved). Never shown in replay.

import { useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { BridgeDecisionTrace, ConfigProfileView, ProfileInput } from "../../shared/ipc";
import { getLLMConfig, saveLLMProfile, llmRecommendMaxTokens } from "../useBridge";

/** Truncated-decision count + which profile, and whether any decision was
 *  auto-healed (retried at a higher cap) this match. */
function summarize(traces: readonly BridgeDecisionTrace[]): { count: number; profileId?: string; healedTo?: number } {
  let count = 0;
  let profileId: string | undefined;
  let healedTo: number | undefined;
  for (const t of traces) {
    if (t.type === "runtime_success") {
      if (t.truncated) {
        count++;
        if (t.profileId) profileId = t.profileId;
      }
      if (t.selfHealed) {
        healedTo = t.selfHealed.to;
        if (t.profileId) profileId = t.profileId;
      }
    } else if (t.type === "runtime_failure" && t.tokenLimit) {
      count++;
      if (t.profileId) profileId = t.profileId;
    }
  }
  return { count, ...(profileId ? { profileId } : {}), ...(healedTo !== undefined ? { healedTo } : {}) };
}

function toProfileInput(p: ConfigProfileView, maxTokens: number): ProfileInput {
  return {
    profileId: p.id,
    displayName: p.displayName,
    family: p.family,
    model: p.model,
    ...(p.baseURL ? { baseURL: p.baseURL } : {}),
    thinkingEnabled: p.thinkingEnabled,
    ...(p.effort ? { effort: p.effort } : {}),
    temperature: p.temperature,
    maxTokens,
    stream: p.stream,
    ...(p.verbosity ? { verbosity: p.verbosity } : {}),
    features: p.features,
  };
}

export function TruncationBanner({ traces, isLive }: { traces: readonly BridgeDecisionTrace[]; isLive: boolean }) {
  const { t } = useTranslation();
  const { count, profileId, healedTo } = useMemo(() => summarize(traces), [traces]);
  const [busy, setBusy] = useState(false);
  const [raisedTo, setRaisedTo] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const raise = async () => {
    setBusy(true);
    setError(null);
    try {
      const cfg = await getLLMConfig();
      const prof = cfg.profiles.find((p) => p.id === (profileId ?? cfg.activeProfile));
      if (!prof) {
        setError(t("cockpit.truncNoProfile"));
        return;
      }
      const rec = await llmRecommendMaxTokens({
        family: prof.family,
        model: prof.model,
        ...(prof.effort ? { effort: prof.effort } : {}),
        thinkingEnabled: prof.thinkingEnabled,
      });
      const target = rec?.recommended ?? Math.max(prof.maxTokens * 2, 65536);
      const r = await saveLLMProfile(toProfileInput(prof, target));
      if (r.ok) setRaisedTo(target);
      else setError(r.error ?? "error");
    } finally {
      setBusy(false);
    }
  };

  // Nothing to show unless live AND (some decision truncated OR one auto-healed).
  if (!isLive || (count === 0 && healedTo === undefined)) return null;

  if (raisedTo !== null) {
    return (
      <div className="v3-dv-banner" data-tone="accent">
        {t("cockpit.truncFixed", { n: raisedTo })}
      </div>
    );
  }

  // Auto-healed and nothing still truncated: gentle "we bumped it this match —
  // save it permanently?" with the same one-click persist.
  if (count === 0 && healedTo !== undefined) {
    return (
      <div className="v3-dv-banner" data-tone="accent">
        <span className="min-w-0 flex-1">{t("cockpit.truncHealed", { n: healedTo })}</span>
        <button type="button" onClick={raise} disabled={busy} className="v3-dv-btn v3-dv-btn--oline v3-dv-btn--xs shrink-0">
          {busy ? t("cockpit.truncRaising") : t("cockpit.truncSave")}
        </button>
        {error && <span className="v3-dv-err w-full text-[11px]">{error}</span>}
      </div>
    );
  }

  return (
    <div className="v3-dv-banner" data-tone="warn">
      <AlertTriangle size={15} className="v3-dv-warn shrink-0" />
      <span className="min-w-0 flex-1">{t("cockpit.truncWarn", { n: count })}</span>
      <button type="button" onClick={raise} disabled={busy} className="v3-dv-btn v3-dv-btn--oline v3-dv-btn--xs shrink-0">
        {busy ? t("cockpit.truncRaising") : t("cockpit.truncRaise")}
      </button>
      {error && <span className="v3-dv-err w-full text-[11px]">{error}</span>}
    </div>
  );
}
