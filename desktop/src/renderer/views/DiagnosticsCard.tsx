// D8 — a read-only diagnostics / status card for Settings. Reads `aifight status
// --json` through the allowlisted in-process cli:run (the same status the CLI
// prints). 🔒 Secret-free: the runtime's redactBridgeConfig strips all secrets;
// only the key SOURCE-free summary (agent name, runtime, daily, games, version,
// update + claim status) is shown.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCw } from "lucide-react";

import { cliRun, getConnectionHealth } from "../useBridge";
import { useLiveGames } from "../liveGames";
import type { ConnectionHealth } from "../../shared/ipc";

interface StatusJson {
  status: "configured" | "not_configured";
  bridgeVersion?: string;
  // NOTE: `aifight status --json` also returns an `update` field — that is the npm
  // CLI's self-update check (`aifight update --yes`). The desktop updates via
  // electron-updater (P4a), NOT npm, so it is intentionally NOT shown here.
  platformAgentStatus?: { kind: "ok"; status: string; isClaimed: boolean } | { kind: "unavailable"; message: string };
  config?: {
    agentName?: string;
    runtimeType?: string;
    autoDailyLimit?: number;
    autoGames?: string[];
  };
}

type State = { kind: "loading" } | { kind: "browser" } | { kind: "ready"; data: StatusJson };

export function DiagnosticsCard() {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({ kind: "loading" });

  // `quiet` refetches in place without flashing the "Checking…" state — used for
  // the background refreshes (so the card doesn't flicker on every window focus).
  const load = (quiet = false) => {
    if (!quiet) setState({ kind: "loading" });
    void cliRun(["status", "--json"]).then((r) => {
      if (r.json !== undefined && (r.json as StatusJson).status !== undefined) {
        setState({ kind: "ready", data: r.json as StatusJson });
      } else if (!quiet) {
        setState({ kind: "browser" });
      }
    });
  };
  // Refresh on mount, on every bridge status change (register / connect / cap),
  // and when the window regains focus (e.g. after claiming in the browser) — so
  // the identity row isn't stale right after a claim.
  useEffect(() => {
    load();
    const offStatus = window.aifight?.onStatus(() => load(true));
    const onFocus = () => load(true);
    window.addEventListener("focus", onFocus);
    return () => {
      offStatus?.();
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app-card px-5 py-4">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <div className="text-[14px] font-medium text-[var(--text)]">{t("diagnostics.title")}</div>
          <div className="text-[12px] text-[var(--text-muted)]">{t("diagnostics.hint")}</div>
        </div>
        <button
          onClick={() => load()}
          title={t("diagnostics.refresh")}
          className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-1.5 text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
        >
          <RotateCw size={13} />
        </button>
      </div>

      {state.kind === "loading" && <div className="text-[12px] text-[var(--text-faint)]">{t("diagnostics.loading")}</div>}
      {state.kind === "browser" && <div className="text-[12px] text-[var(--text-faint)]">{t("diagnostics.browser")}</div>}
      {state.kind === "ready" && <Body data={state.data} />}
      <ConnectionSection />
    </div>
  );
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** Live proof the outbound WebSocket is alive: state + ticking uptime + last
 * activity + reconnect count. Polls the in-memory health every 2s; ticks 1s. */
function ConnectionSection() {
  const { t } = useTranslation();
  const [health, setHealth] = useState<ConnectionHealth | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    let alive = true;
    const poll = () => void getConnectionHealth().then((h) => { if (alive) setHealth(h); });
    poll();
    const pid = window.setInterval(poll, 2000);
    const tid = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { alive = false; window.clearInterval(pid); window.clearInterval(tid); };
  }, []);

  if (health === null) return null; // browser / no bridge
  const active = health.phase === "running" || health.phase === "starting" || health.phase === "error";
  if (!active) return null; // nothing connecting → hide (e.g. onboarding)

  const connected = health.phase === "running";
  const dot = connected ? "bg-emerald-400" : health.phase === "starting" ? "bg-amber-400 animate-pulse" : "bg-rose-400";
  const stateText = connected
    ? t("diagnostics.conn.online")
    : health.phase === "starting"
      ? t("diagnostics.conn.connecting")
      : t("diagnostics.conn.offline");
  const uptime = connected && health.connectedAt !== null ? fmtDuration(now - health.connectedAt) : "—";
  const lastBeat =
    health.lastActivityAt !== null
      ? t("diagnostics.conn.ago", { s: Math.max(0, Math.floor((now - health.lastActivityAt) / 1000)) })
      : "—";
  const rows: Array<[string, string]> = [
    [t("diagnostics.conn.state"), stateText],
    [t("diagnostics.conn.uptime"), uptime],
    [t("diagnostics.conn.lastBeat"), lastBeat],
    [t("diagnostics.conn.reconnects"), String(health.reconnects)],
  ];
  return (
    <div className="mt-3 border-t border-[var(--border)] pt-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[12px] text-[var(--text-muted)]">
        <span className={"inline-block h-1.5 w-1.5 rounded-full " + dot} />
        {t("diagnostics.conn.title")}
      </div>
      <div className="grid grid-cols-1 gap-1 text-[12px] sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center gap-1.5">
            <span className="shrink-0 text-[var(--text-faint)]">{k}:</span>
            <span className="truncate font-mono text-[var(--text)]">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Body({ data }: { data: StatusJson }) {
  const { t } = useTranslation();
  // autoGames unset = the agent matches across ALL live games — show that list
  // (backend-fed), not a hardcoded copy.
  const liveGames = useLiveGames();
  if (data.status === "not_configured") {
    return (
      <div className="text-[12px] text-[var(--text-muted)]">
        {t("diagnostics.notConfigured")}{" "}
        <span className="font-mono text-[var(--text-faint)]">v{data.bridgeVersion}</span>
      </div>
    );
  }
  // Localize the identity row: the server's raw status strings ("unclaimed",
  // "needs_official_name", "agent profile unavailable: 502") must not leak to the
  // user. Reuse 已认领/未认领, surface the claimed-but-unnamed state explicitly, and
  // collapse any fetch failure into a friendly "temporarily unavailable".
  const pa = data.platformAgentStatus;
  const claim =
    pa?.kind === "ok"
      ? pa.status === "needs_official_name"
        ? t("diagnostics.needsName")
        : pa.isClaimed
          ? t("home.hero.claimed")
          : t("home.hero.unclaimed")
      : pa?.kind === "unavailable"
        ? t("diagnostics.statusUnavailable")
        : "—";
  const daily =
    data.config?.autoDailyLimit === undefined
      ? t("diagnostics.daily.unset")
      : data.config.autoDailyLimit === 0
        ? t("diagnostics.daily.off")
        : String(data.config.autoDailyLimit);
  const rows: Array<[string, string]> = [
    [t("diagnostics.agent"), data.config?.agentName ?? "—"],
    [t("diagnostics.runtime"), data.config?.runtimeType ?? "—"],
    [t("diagnostics.claim"), claim],
    [t("diagnostics.dailyLabel"), daily],
    [t("diagnostics.games"), (data.config?.autoGames ?? liveGames).join(", ")],
    [t("diagnostics.version"), `v${data.bridgeVersion ?? "?"}`],
  ];
  return (
    <div className="grid grid-cols-1 gap-1 text-[12px] sm:grid-cols-2">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-center gap-1.5">
          <span className="shrink-0 text-[var(--text-faint)]">{k}:</span>
          <span className="truncate font-mono text-[var(--text)]">{v}</span>
        </div>
      ))}
    </div>
  );
}
