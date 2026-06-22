import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Swords, MonitorPlay, Trophy, CalendarDays, Cpu, ScrollText, History, Settings, PanelLeft, Sun, Moon, Monitor, FolderOpen, LayoutDashboard } from "lucide-react";

import { useTheme, type ThemeMode } from "./theme";
import { getLangPref, setLangPref, type LangPref } from "./i18n";
import { getLaunchAtLogin, setLaunchAtLogin, openConfigDir, openDashboard, cliRun, useBridgeStatus } from "./useBridge";
import { webOrigin } from "./webOrigin";
import { useLiveStore } from "./liveStore";
import { detectMatchAlert } from "./matchNotify";
import { emptyLiveMatch, type LiveMatchState } from "./liveMatch";
import { gameLabel } from "../shared/games";
import type { BridgeHostPhase, BridgeStatus, UpdateStatus } from "../shared/ipc";
import { PageHeader } from "./components/ui";
import { WatchView } from "./views/WatchView";
import { LeaderboardView } from "./views/LeaderboardView";
import { EventsView } from "./views/EventsView";
import { PlayView } from "./views/PlayView";
import { HistoryView } from "./views/HistoryView";
import { ModelsView } from "./views/ModelsView";
import { StrategyView } from "./views/StrategyView";
import { DiagnosticsCard } from "./views/DiagnosticsCard";

type ViewId = "play" | "watch" | "leaderboard" | "events" | "models" | "strategy" | "history" | "settings";
type SelfReviewMode = "off" | "all" | "losses_only";

const NAV: ReadonlyArray<{ id: ViewId; icon: ComponentType<{ size?: number }> }> = [
  { id: "play", icon: Swords },
  { id: "watch", icon: MonitorPlay },
  { id: "leaderboard", icon: Trophy },
  { id: "events", icon: CalendarDays },
  { id: "models", icon: Cpu },
  { id: "strategy", icon: ScrollText },
  { id: "history", icon: History },
  { id: "settings", icon: Settings },
];

const SIDEBAR_KEY = "aifight.sidebar.collapsed";
const NOTIFY_KEY = "aifight.notifications";

// The real app version, injected into preload at build time (package.json).
const APP_VERSION = window.aifight?.version ?? "0.1.0";

/** Match notifications are on unless the user explicitly turned them off. */
function notificationsEnabled(): boolean {
  return localStorage.getItem(NOTIFY_KEY) !== "0";
}


export function App() {
  const { t } = useTranslation();
  const [active, setActive] = useState<ViewId>("play");
  const [collapsed, setCollapsed] = useState<boolean>(() => localStorage.getItem(SIDEBAR_KEY) === "1");
  const live = useLiveStore();
  const prevMatchRef = useRef<LiveMatchState>(emptyLiveMatch());

  // OS-level prompt when YOUR agent starts or finishes a match — even if the app is
  // backgrounded or you're on another view. The in-app banner below is the always-
  // visible counterpart; this adds a clickable system notification. prevMatchRef
  // guards against duplicate fires (e.g. a language re-render): an unchanged match
  // yields no alert.
  useEffect(() => {
    const alert = detectMatchAlert(prevMatchRef.current, live.match);
    prevMatchRef.current = live.match;
    if (alert === null) return;
    if (!notificationsEnabled()) return;
    // Fire unless the user has explicitly denied OS notifications. (At "default"
    // Electron still shows them; the try/catch below is the safety net.)
    if (typeof Notification === "undefined" || Notification.permission === "denied") return;
    const game = gameLabel(alert.game);
    const outcome =
      alert.outcome === "win"
        ? t("cockpit.outcomeWin")
        : alert.outcome === "loss"
          ? t("cockpit.outcomeLoss")
          : alert.outcome === "draw"
            ? t("cockpit.outcomeDraw")
            : "";
    const title = alert.kind === "start" ? t("notify.startTitle") : t("notify.overTitle");
    const body =
      alert.kind === "start" ? t("notify.startBody", { game }) : t("notify.overBody", { game, outcome });
    try {
      const note = new Notification(title, { body });
      note.onclick = () => {
        void window.aifight?.focusWindow();
        setActive("watch");
      };
    } catch {
      // OS notifications unavailable (e.g. permission revoked) — the banner still shows.
    }
  }, [live.match, t]);

  // Ask for OS notification permission once, on first run, so match alerts can
  // fire. Without this the permission stays "default" and (on some platforms)
  // every Notification silently no-ops. The OS only ever prompts once.
  useEffect(() => {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") void Notification.requestPermission().catch(() => {});
  }, []);

  // The app menu (Preferences ⌘,, Help) asks main to switch views via this channel.
  useEffect(() => {
    const api = window.aifight;
    if (api === undefined) return;
    return api.onNavigate((view) => setActive(view as ViewId));
  }, []);

  const toggleSidebar = () => {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
      return next;
    });
  };

  // On macOS the window uses hiddenInset, so the traffic-light buttons float over
  // the top-left. Reserve a draggable strip at the top of each column (matching
  // main.ts trafficLightPosition) so the logo + toolbar sit clear of them.
  const isMac = window.aifight?.platform === "darwin";

  return (
    <div className="flex h-full w-full overflow-hidden bg-[var(--bg)] text-[var(--text)]">
      <aside
        className={
          "flex shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] transition-[width] duration-150 " +
          (collapsed ? "w-[60px]" : "w-56")
        }
      >
        {isMac && <div className="app-drag h-[30px] shrink-0" />}
        <div className="app-drag flex h-14 items-center gap-2.5 px-3.5">
          {/* Brand AIF mark — matches the live web favicon (web/public/favicon.svg):
              light tile, "AI" ink + "F" brand orange. Replaces the old gradient placeholder. */}
          <svg viewBox="0 0 120 120" className="h-7 w-7 shrink-0 rounded-lg shadow-[var(--shadow-paper-1)]" aria-hidden="true">
            <rect x="2" y="2" width="116" height="116" rx="24" fill="#F4F6FA" stroke="#D8DCE3" strokeWidth="2.5" />
            <g transform="translate(23.02 77.64) scale(0.2451)">
              <path d="M32 0L4 0L48-144L88.60-144L132.60 0L104.60 0L95.30-30L41.10-30L32 0M48.80-55.40L87.50-55.40L68-118.50L48.80-55.40M179.80 0L152.60 0L152.60-144L179.80-144" fill="#0B0E14" />
              <path d="M237 0L209.80 0L209.80-144L297.80-144L297.80-116.80L237-116.80L237-85.60L285.80-85.60L285.80-58.40L237-58.40" fill="#FF700A" />
            </g>
          </svg>
          {!collapsed && (
            <span className="font-display text-[16px] tracking-tight">
              AI<span style={{ color: "var(--accent)" }}>Fight</span>
            </span>
          )}
        </div>
        <nav className="flex-1 space-y-0.5 p-2">
          {NAV.map((n) => {
            const Icon = n.icon;
            const label = t(`nav.${n.id}`);
            const isActive = active === n.id;
            return (
              <button
                key={n.id}
                onClick={() => setActive(n.id)}
                title={collapsed ? label : undefined}
                className={
                  "flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-[13px] transition-colors " +
                  (collapsed ? "justify-center" : "") +
                  " " +
                  (isActive
                    ? "bg-[var(--active)] text-[var(--text)]"
                    : "text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]")
                }
              >
                <Icon size={17} />
                {!collapsed && <span>{label}</span>}
              </button>
            );
          })}
        </nav>
        <div className="border-t border-[var(--border)] px-3 py-3 text-[11px] text-[var(--text-faint)]">
          {collapsed ? `v${APP_VERSION}` : `v${APP_VERSION} · ${t("app.tagline")}`}
        </div>
      </aside>

      <main className="flex flex-1 flex-col">
        {isMac && <div className="app-drag h-[30px] shrink-0" />}
        <header className="app-drag flex h-12 items-center justify-between gap-3 border-b border-[var(--border)] px-4">
          <button
            onClick={toggleSidebar}
            title={collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
            className="app-no-drag rounded-md p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text)]"
          >
            <PanelLeft size={16} />
          </button>
          <div className="app-no-drag flex items-center gap-1.5">
            <ThemeToggle />
            <StatusPill />
          </div>
        </header>
        <DeviceMismatchBanner />
        <BridgeErrorBanner />
        <MatchBanner live={live.match} onWatch={() => setActive("watch")} />
        <section className="flex-1 overflow-auto p-6">
          {active === "settings" ? (
            <SettingsView />
          ) : active === "watch" ? (
            <WatchView />
          ) : active === "leaderboard" ? (
            <LeaderboardView />
          ) : active === "events" ? (
            <EventsView />
          ) : active === "play" ? (
            <PlayView onNavigate={(view) => setActive(view as ViewId)} />
          ) : active === "history" ? (
            <HistoryView />
          ) : active === "models" ? (
            <ModelsView />
          ) : active === "strategy" ? (
            <StrategyView />
          ) : (
            <Placeholder view={active} />
          )}
        </section>
      </main>
    </div>
  );
}

// Surfaces the server's device-binding rejection (a copied credential used from
// another machine) as a clear, actionable banner — driven by the structured
// "bridge.device_mismatch" log code, cleared once the bridge connects.
function DeviceMismatchBanner() {
  const { t } = useTranslation();
  const [message, setMessage] = useState<string | null>(null);
  const [origin, setOrigin] = useState<string | undefined>(undefined);

  useEffect(() => {
    const api = window.aifight;
    if (api === undefined) return;
    const offLog = api.onLog((e) => {
      if (e.code === "bridge.device_mismatch") setMessage(e.message);
    });
    const offStatus = api.onStatus((s) => {
      setOrigin(webOrigin(s.config?.baseUrl));
      if (s.phase === "running" || s.phase === "starting") setMessage(null);
    });
    return () => {
      offLog();
      offStatus();
    };
  }, []);

  if (message === null) return null;
  return (
    <div className="border-b border-[var(--border)] bg-red-500/10 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-red-400">{t("deviceMismatch.title")}</div>
          <div className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--text-muted)]">
            {message}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {origin !== undefined && (
            <a
              href={`${origin}/dashboard`}
              target="_blank"
              rel="noreferrer"
              className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
            >
              {t("deviceMismatch.openDashboard")}
            </a>
          )}
          <button
            onClick={() => setMessage(null)}
            className="rounded-md px-2.5 py-1 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover)]"
          >
            {t("match.dismiss")}
          </button>
        </div>
      </div>
    </div>
  );
}

// A slim, always-visible prompt above the content: pulsing "match in progress"
// (click anywhere → watch) while YOUR agent plays, then a "match finished" bar
// with the outcome + a review/dismiss pair. Dismissal is keyed by match id, so a
// new match re-shows it automatically. Hidden when there is no current match.
function MatchBanner({ live, onWatch }: { live: LiveMatchState; onWatch: () => void }) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState<string | null>(null);

  if (live.sessionId === null || live.match === null) return null;
  const game = live.game !== null ? gameLabel(live.game) : "";

  if (live.finished) {
    if (dismissed === live.sessionId) return null;
    const outcome =
      live.outcome === "win"
        ? t("cockpit.outcomeWin")
        : live.outcome === "loss"
          ? t("cockpit.outcomeLoss")
          : live.outcome === "draw"
            ? t("cockpit.outcomeDraw")
            : "";
    return (
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface-2)] px-4 py-2">
        <div className="flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
          <span className="font-medium text-[var(--text)]">{t("match.over.title")}</span>
          <span className="text-[var(--text-faint)]">·</span>
          <span>{game}</span>
          {outcome !== "" && (
            <>
              <span className="text-[var(--text-faint)]">·</span>
              <span className="text-[var(--accent)]">{outcome}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={onWatch}
            className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
          >
            {t("match.over.watch")}
          </button>
          <button
            onClick={() => setDismissed(live.sessionId)}
            className="rounded-md px-2.5 py-1 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover)]"
          >
            {t("match.dismiss")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      onClick={onWatch}
      className="flex w-full items-center justify-between gap-3 border-b border-[var(--border)] bg-emerald-500/10 px-4 py-2 text-left transition-colors hover:bg-emerald-500/15"
    >
      <div className="flex items-center gap-2 text-[12px]">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
        <span className="font-medium text-emerald-400">{t("match.live.title")}</span>
        <span className="text-[var(--text-faint)]">·</span>
        <span className="text-[var(--text-muted)]">{game}</span>
      </div>
      <span className="rounded-md bg-emerald-500/20 px-2.5 py-1 text-[12px] font-medium text-emerald-300">
        {t("match.live.watch")}
      </span>
    </button>
  );
}

function ThemeToggle() {
  const { mode, setMode } = useTheme();
  const { t } = useTranslation();
  const next: ThemeMode = mode === "system" ? "light" : mode === "light" ? "dark" : "system";
  const Icon = mode === "system" ? Monitor : mode === "light" ? Sun : Moon;
  return (
    <button
      onClick={() => setMode(next)}
      title={`${t("theme.label")}: ${mode}`}
      className="rounded-md p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text)]"
    >
      <Icon size={16} />
    </button>
  );
}

const PHASE_DOT: Record<BridgeHostPhase, string> = {
  idle: "bg-[var(--text-faint)]",
  unconfigured: "bg-amber-400",
  starting: "bg-amber-400 animate-pulse",
  running: "bg-emerald-400",
  stopped: "bg-[var(--text-faint)]",
  error: "bg-red-400",
};

// A thin global banner for the "error" phase — a connection failure used to be a
// dead-end (just a red dot + a hover title), with the only retry button buried in
// the Play hero. This surfaces the failure on every view with a localized message
// + a 重连 button. Cleared automatically once the bridge reconnects (phase leaves
// "error").
function BridgeErrorBanner() {
  const { t } = useTranslation();
  const status = useBridgeStatus();
  const [retrying, setRetrying] = useState(false);
  if (status?.phase !== "error") return null;
  const retry = () => {
    setRetrying(true);
    void window.aifight?.start().finally(() => setRetrying(false));
  };
  return (
    <div className="border-b border-[var(--border)] bg-red-500/10 px-4 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-[13px] font-medium text-red-400">{t("play.status.error")}</span>
          {typeof status.message === "string" && status.message !== "" && (
            <span className="truncate text-[12px] text-[var(--text-muted)]">{status.message}</span>
          )}
        </div>
        <button
          onClick={retry}
          disabled={retrying}
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--accent)] px-2.5 py-1 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {t("play.status.retry")}
        </button>
      </div>
    </div>
  );
}

// Read-only presence indicator (D11): opening the app IS being online — there is
// no manual online/offline toggle. main.ts auto-connects on launch; this just
// reflects the live phase. Pausing matchmaking lives in the Play view.
function StatusPill() {
  const { t } = useTranslation();
  const status = useBridgeStatus();
  const phase: BridgeHostPhase = status?.phase ?? "idle";
  return (
    <span
      title={status?.message ?? undefined}
      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-[var(--text-muted)]"
    >
      <span className={"inline-block h-1.5 w-1.5 rounded-full " + PHASE_DOT[phase]} />
      {t(`bridge.phase.${phase}`)}
    </span>
  );
}

function Placeholder({ view }: { view: ViewId }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-md text-center">
        <div className="mb-1.5 text-lg font-medium text-[var(--text)]">{t(`nav.${view}`)}</div>
        <div className="text-sm text-[var(--text-muted)]">{t(`hint.${view}`)}</div>
        <div className="mt-6 text-xs text-[var(--text-faint)]">{t("scaffold")} · P3</div>
      </div>
    </div>
  );
}

function SettingsView() {
  const { t } = useTranslation();
  const { mode, setMode } = useTheme();
  const status = useBridgeStatus();
  const origin = webOrigin(status?.config?.baseUrl);
  const [langPref, setLangPrefState] = useState<LangPref>(() => getLangPref());
  const [launchAtLogin, setLaunchAtLoginState] = useState(false);
  const [notify, setNotify] = useState<boolean>(() => notificationsEnabled());
  // Auto self-review mode (off | all | losses_only) — read/written via the same
  // `aifight config review` the CLI uses, so app and CLI stay in sync.
  const [selfReviewMode, setSelfReviewMode] = useState<SelfReviewMode>("off");

  useEffect(() => {
    void getLaunchAtLogin().then(setLaunchAtLoginState);
  }, []);

  useEffect(() => {
    void cliRun(["config", "review", "--json"]).then((r) => {
      if (r.exitCode !== 0) return;
      const mode = (r.json as { selfReview?: { autoMode?: string } } | undefined)?.selfReview?.autoMode;
      if (mode === "off" || mode === "all" || mode === "losses_only") setSelfReviewMode(mode);
    });
  }, []);

  const onLang = (pref: LangPref) => {
    setLangPref(pref);
    setLangPrefState(pref);
  };

  const onLaunchAtLogin = (v: "on" | "off") => {
    const enabled = v === "on";
    setLaunchAtLoginState(enabled);
    void setLaunchAtLogin(enabled);
  };

  const onNotify = (v: "on" | "off") => {
    const enabled = v === "on";
    setNotify(enabled);
    localStorage.setItem(NOTIFY_KEY, enabled ? "1" : "0");
    // Turning alerts on for the first time — make sure we have OS permission.
    if (enabled && typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission().catch(() => {});
    }
  };

  const onSelfReview = (mode: SelfReviewMode) => {
    setSelfReviewMode(mode); // optimistic — the CLI write is the source of truth
    void cliRun(["config", "review", "auto", mode]);
  };

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader eyebrow={t("eyebrow.settings")} title={t("nav.settings")} subtitle={t("hint.settings")} />
      <div className="space-y-4">
      <SettingRow title={t("language.label")} hint={t("language.hint")}>
        <Segmented
          value={langPref}
          onChange={onLang}
          options={[
            { value: "auto", label: t("language.auto") },
            { value: "en", label: t("language.english") },
            { value: "zh", label: t("language.chinese") },
          ]}
        />
      </SettingRow>
      <SettingRow title={t("theme.label")} hint={t("theme.hint")}>
        <Segmented
          value={mode}
          onChange={(m) => setMode(m)}
          options={[
            { value: "system", label: t("theme.system") },
            { value: "light", label: t("theme.light") },
            { value: "dark", label: t("theme.dark") },
          ]}
        />
      </SettingRow>
      <SettingRow title={t("launchAtLogin.label")} hint={t("launchAtLogin.hint")}>
        <Segmented
          value={launchAtLogin ? "on" : "off"}
          onChange={onLaunchAtLogin}
          options={[
            { value: "off", label: t("launchAtLogin.off") },
            { value: "on", label: t("launchAtLogin.on") },
          ]}
        />
      </SettingRow>
      <SettingRow title={t("notifications.label")} hint={t("notifications.hint")}>
        <Segmented
          value={notify ? "on" : "off"}
          onChange={onNotify}
          options={[
            { value: "off", label: t("notifications.off") },
            { value: "on", label: t("notifications.on") },
          ]}
        />
      </SettingRow>
      <SettingRow title={t("settings.selfReview.label")} hint={t("settings.selfReview.hint")}>
        <Segmented
          value={selfReviewMode}
          onChange={onSelfReview}
          options={[
            { value: "off", label: t("settings.selfReview.off") },
            { value: "all", label: t("settings.selfReview.all") },
            { value: "losses_only", label: t("settings.selfReview.lossesOnly") },
          ]}
        />
      </SettingRow>

      {/* Account + local files. Account actions (rename / rotate key / billing /
          deactivate) live on the Dashboard — the desktop deep-links there. */}
      <div className="app-card px-5 py-4">
        <div className="text-[14px] font-medium text-[var(--text)]">{t("settings.account.title")}</div>
        <div className="mt-0.5 text-[12px] text-[var(--text-muted)]">{t("settings.account.hint")}</div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={() => void openDashboard()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3.5 py-2 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
          >
            <LayoutDashboard size={14} />
            {t("settings.account.dashboard")}
          </button>
          <button
            onClick={() => void openConfigDir()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2 text-[12px] text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
          >
            <FolderOpen size={14} />
            {t("settings.account.configDir")}
          </button>
        </div>
      </div>

      <AboutCard />

      <DiagnosticsCard />
      </div>
    </div>
  );
}

// Version + auto-update. The "Check for updates" button drives electron-updater
// (main process); status arrives via onUpdateStatus. In dev / unpackaged runs a
// check reports "up to date" (there is no publish feed). When an update finishes
// downloading the button becomes "Restart & update".
function AboutCard() {
  const { t } = useTranslation();
  const [update, setUpdate] = useState<UpdateStatus>({ state: "idle" });
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const api = window.aifight;
    if (api === undefined) return;
    return api.onUpdateStatus((s) => {
      setUpdate(s);
      if (s.state !== "checking") setChecking(false);
    });
  }, []);

  const onCheck = () => {
    setChecking(true);
    setUpdate({ state: "checking" });
    void window.aifight?.checkForUpdates().catch(() => {
      setChecking(false);
      setUpdate({ state: "error", message: "" }); // surface a rejection instead of silently swallowing it
    });
  };

  const statusText = (): string | null => {
    switch (update.state) {
      case "checking":
        return t("about.checking");
      case "available":
        return t("about.available", { version: update.version });
      case "downloading":
        return t("about.downloading", { percent: update.percent });
      case "downloaded":
        return t("about.downloaded");
      case "not-available":
        return t("about.upToDate");
      case "error":
        return t("about.failed");
      default:
        return null;
    }
  };

  const text = statusText();

  return (
    <div className="app-card px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[14px] font-medium text-[var(--text)]">{t("about.title")}</div>
          <div className="mt-0.5 text-[12px] text-[var(--text-muted)]">AIFight · v{APP_VERSION}</div>
        </div>
        {update.state === "downloaded" ? (
          <button
            onClick={() => void window.aifight?.installUpdate()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3.5 py-2 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
          >
            {t("about.restart")}
          </button>
        ) : (
          <button
            onClick={onCheck}
            disabled={checking || update.state === "downloading"}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2 text-[12px] text-[var(--text-muted)] transition-colors hover:text-[var(--text)] disabled:opacity-50"
          >
            {checking ? t("about.checking") : t("about.checkUpdates")}
          </button>
        )}
      </div>
      {text !== null && update.state !== "idle" && (
        <div
          className={"mt-2 text-[12px] " + (update.state === "error" ? "text-red-400" : "text-[var(--text-muted)]")}
        >
          {text}
        </div>
      )}
    </div>
  );
}

function SettingRow({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="app-card flex flex-wrap items-center justify-between gap-4 px-5 py-4">
      <div>
        <div className="text-[14px] font-medium text-[var(--text)]">{title}</div>
        <div className="text-[12px] text-[var(--text-muted)]">{hint}</div>
      </div>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={
            "rounded-md px-3 py-1.5 text-[13px] transition-colors " +
            (value === o.value
              ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
              : "text-[var(--text-muted)] hover:text-[var(--text)]")
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
