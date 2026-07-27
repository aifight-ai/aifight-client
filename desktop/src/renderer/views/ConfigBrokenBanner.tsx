// E2 (windows-loop, 2026-07-26). ConfigView.error was produced by the main
// process (R12) and read by nobody: a present-but-corrupt config.json made
// `configured` false, so the Models page looked exactly like a fresh install and
// walked the user all the way through add-a-model — where saveProfile then
// refused, because R12 will not let it overwrite a real file it could not parse.
//
// Split out of ModelsView so the decision and its rendering are testable without
// a DOM: the page's whole effect-driven load path is not SSR-reachable, and the
// invariant worth pinning is small and pure — a broken config must never be
// mistaken for a fresh one.

import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { ConfigView } from "../../shared/ipc";

export type ConfigPageState =
  /** The view has not loaded yet. */
  | "loading"
  /** config.json is on disk but unreadable/corrupt: warn, offer no setup. */
  | "broken"
  /** No config at all: the genuine first run. */
  | "fresh"
  /** A usable config. */
  | "ready";

/**
 * `broken` deliberately outranks everything below it. getConfig only ever sets
 * `error` alongside configured:false today, but the ordering is the invariant —
 * a config we could not parse must never be offered the fresh-setup flow, whose
 * next save is the thing that would destroy it.
 */
export function configPageState(view: ConfigView | null): ConfigPageState {
  if (view === null) return "loading";
  if (view.error !== undefined) return "broken";
  return view.configured ? "ready" : "fresh";
}

/** Renders nothing unless the config is broken, so callers can drop it in flat. */
export function ConfigBrokenBanner({ view }: { view: ConfigView | null }) {
  const { t } = useTranslation();
  if (configPageState(view) !== "broken" || view === null) return null;
  return (
    <div className="v3-dv-banner v3-dv-err space-y-1" data-tone="err" data-testid="config-broken">
      <div className="flex items-center gap-1.5 font-medium">
        <AlertTriangle size={14} />
        {t("models.brokenTitle")}
      </div>
      <div className="text-[12px]">{t("models.brokenHint")}</div>
      {/* The path comes from the main process: it varies with AIFIGHT_HOME and
          platform, and sending the user to the wrong file is worse than none. */}
      {view.configPath !== undefined && (
        <div className="break-all font-mono text-[11px] opacity-80">{view.configPath}</div>
      )}
      <div className="break-all text-[11px] opacity-80">{view.error}</div>
    </div>
  );
}
