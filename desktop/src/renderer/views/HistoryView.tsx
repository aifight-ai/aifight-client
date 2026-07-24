// D8 — match history. Obeys the session-isolation + lazy-load rule:
//   - on mount, load only the session LIST (metadata) via `aifight sessions list`,
//   - load a session's FULL detail (events + traces) only when the user opens it,
//     via `aifight sessions export <id>`, folded through sessionReplay.
// Each open is an isolated, independent fold — no global merge across matches.
//
// Everything runs through the enumerated in-process `cli:op`, so the desktop and
// CLI read the exact same local store; no new IPC surface.
//
// 🔒 Replays inherit the live cockpit's information hiding (see sessionReplay).

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ExternalLink, RotateCw } from "lucide-react";

import { runCli } from "../useBridge";
import { buildReplayFromExport, type SessionReplay } from "../sessionReplay";
import { Chip, PageHeader } from "../components/ui";
import { gameLabel } from "../../shared/games";
import { CockpitPanel } from "./CockpitPanel";
import { ReviewSection } from "./ReviewSection";

// The runtime returns the FULL session list (no server-side pagination), so we
// filter + page on the client. PAGE_SIZE rows show first; "load more" reveals more.
const PAGE_SIZE = 20;
type StatusFilter = "all" | "active" | "completed";
// Match mode filter: friendly = a 约战 (challenge), everything else is ranked/manual.
type ModeFilter = "all" | "ranked" | "friendly";

/** The list-row metadata we render (subset of the runtime's LocalMatchSessionListItem). */
interface SessionListItem {
  session_id: string;
  agent_name?: string;
  status?: string;
  game?: string;
  /** Match mode from game_start ("ranked" | "friendly"); friendly = a 约战. */
  mode?: string;
  updated_at?: string;
  result_label?: string;
  decision_count?: number;
  real_match_id?: string;
  replay_url?: string;
}

function fmtDate(iso: string | undefined, locale: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(locale);
}

type ListState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; sessions: SessionListItem[] };

export function HistoryView() {
  const { t, i18n } = useTranslation();
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [selected, setSelected] = useState<{ item: SessionListItem; replay: SessionReplay } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [gameFilter, setGameFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [modeFilter, setModeFilter] = useState<ModeFilter>("all");
  const [shown, setShown] = useState(PAGE_SIZE);
  // Reset pagination whenever a filter changes so "load more" starts from the top.
  useEffect(() => setShown(PAGE_SIZE), [gameFilter, statusFilter, modeFilter]);

  const loadList = () => {
    setList({ kind: "loading" });
    void runCli({ kind: "sessionsList" }).then((r) => {
      if (r.error !== undefined || r.exitCode !== 0) {
        setList({ kind: "error", message: r.error ?? r.stderr ?? `exit ${r.exitCode}` });
        return;
      }
      const sessions = (r.json as { sessions?: unknown })?.sessions;
      setList({ kind: "ready", sessions: Array.isArray(sessions) ? (sessions as SessionListItem[]) : [] });
    });
  };

  // Lazy: load ONLY the list (metadata) on mount.
  useEffect(loadList, []);

  const openSession = (item: SessionListItem) => {
    setOpening(item.session_id);
    // Lazy: fetch this one session's full detail only now.
    void runCli({ kind: "sessionsExport", sessionId: item.session_id }).then((r) => {
      setOpening(null);
      if (r.error !== undefined || r.exitCode !== 0 || r.json === undefined) return;
      setSelected({ item, replay: buildReplayFromExport(r.json) });
    });
  };

  if (selected !== null) {
    return <HistoryDetail item={selected.item} replay={selected.replay} onBack={() => setSelected(null)} />;
  }

  const refreshBtn = (
    <button onClick={loadList} title={t("history.refresh")} className="v3-dv-btn v3-dv-btn--ghost v3-dv-btn--sm">
      <RotateCw size={13} />
      {t("history.refresh")}
    </button>
  );

  const sessions = list.kind === "ready" ? list.sessions : [];
  // Filter options come from the sessions themselves (the local store can hold
  // games beyond today's live list, e.g. retired ones) — nothing hardcoded.
  const gamesInList = [...new Set(sessions.map((s) => s.game).filter((g): g is string => typeof g === "string" && g !== ""))];
  const matchesMode = (s: SessionListItem) =>
    modeFilter === "all" || (modeFilter === "friendly" ? s.mode === "friendly" : s.mode !== "friendly");
  const filtered = sessions.filter(
    (s) =>
      (gameFilter === "all" || s.game === gameFilter) &&
      (statusFilter === "all" || s.status === statusFilter) &&
      matchesMode(s),
  );
  const visible = filtered.slice(0, shown);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        eyebrow={t("eyebrow.history")}
        title={t("nav.history")}
        subtitle={list.kind === "ready" ? t("history.count", { n: list.sessions.length }) : t("hint.history")}
        right={refreshBtn}
      />

      {list.kind === "loading" && (
        <div className="px-4 py-14 text-center text-[13px] text-[var(--text-muted)]">{t("history.loading")}</div>
      )}
      {list.kind === "error" && (
        <div className="px-4 py-12 text-center">
          <div className="text-[13px] text-[var(--text-muted)]">{t("errors.loadMatches")}</div>
          <div className="mx-auto mt-1.5 max-w-md font-mono text-[11px] text-[var(--text-faint)]">{list.message}</div>
        </div>
      )}
      {list.kind === "ready" && list.sessions.length === 0 && (
        <div className="px-4 py-14 text-center">
          <div className="v3-dv-display text-[40px] leading-none text-[var(--border)]">—</div>
          <div className="mt-3 text-[13px] text-[var(--text-muted)]">{t("history.empty")}</div>
        </div>
      )}
      {list.kind === "ready" && list.sessions.length > 0 && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Seg
              value={gameFilter}
              onChange={setGameFilter}
              options={[{ v: "all", l: t("common.all") }, ...gamesInList.map((g) => ({ v: g, l: gameLabel(g) }))]}
            />
            <Seg
              value={statusFilter}
              onChange={(v) => setStatusFilter(v as StatusFilter)}
              options={[
                { v: "all", l: t("common.all") },
                { v: "active", l: t("history.active") },
                { v: "completed", l: t("history.statusCompleted") },
              ]}
            />
            <Seg
              value={modeFilter}
              onChange={(v) => setModeFilter(v as ModeFilter)}
              options={[
                { v: "all", l: t("common.all") },
                { v: "ranked", l: t("history.ranked") },
                { v: "friendly", l: t("history.friendly") },
              ]}
            />
          </div>

          {filtered.length === 0 ? (
            <div className="px-4 py-12 text-center text-[13px] text-[var(--text-muted)]">{t("history.noMatch")}</div>
          ) : (
            <>
              <div className="v3-dv-list">
                {visible.map((s) => (
                  <button
                    key={s.session_id}
                    onClick={() => openSession(s)}
                    disabled={opening !== null}
                    className="v3-dv-row"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[13.5px] font-medium text-[var(--text)]">
                          {s.game ? gameLabel(s.game) : t("history.unknownGame")}
                        </span>
                        {s.result_label && <Chip tone="neutral">{s.result_label}</Chip>}
                        {s.status === "active" && <Chip tone="live">{t("history.active")}</Chip>}
                        {s.mode === "friendly" && <Chip tone="accent">{t("history.friendly")}</Chip>}
                      </div>
                      <div className="mt-1 truncate font-mono text-[11px] text-[var(--text-faint)]">
                        {fmtDate(s.updated_at, i18n.language)} · {t("history.decisions", { n: s.decision_count ?? 0 })}
                      </div>
                    </div>
                    <span className="shrink-0 font-mono text-[11px] text-[var(--text-muted)]">
                      {opening === s.session_id ? t("history.opening") : t("history.open")}
                    </span>
                  </button>
                ))}
              </div>
              {visible.length < filtered.length && (
                <div className="mt-3 flex justify-center">
                  <button onClick={() => setShown((n) => n + PAGE_SIZE)} className="v3-dv-btn v3-dv-btn--ghost">
                    {t("common.loadMore")} ({filtered.length - visible.length})
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Compact segmented filter (v3 .tabs/.tab:选中白底 + 橘小方). */
function Seg({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { v: string; l: string }[] }) {
  return (
    <div className="v3-dv-seg">
      {options.map((o) => (
        <button key={o.v} onClick={() => onChange(o.v)} className={"v3-dv-seg-btn" + (value === o.v ? " on" : "")}>
          {o.l}
        </button>
      ))}
    </div>
  );
}

function HistoryDetail({
  item,
  replay,
  onBack,
}: {
  item: SessionListItem;
  replay: SessionReplay;
  onBack: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { state, traces } = replay;

  const backBtn = (
    <button onClick={onBack} className="v3-dv-btn v3-dv-btn--ghost v3-dv-btn--sm">
      <ChevronLeft size={14} />
      {t("history.back")}
    </button>
  );

  if (state.game === null || state.match === null) {
    return (
      <div className="space-y-4">
        <div>{backBtn}</div>
        <Centered>{t("history.notRenderable")}</Centered>
      </div>
    );
  }

  const headerLeft = (
    <div className="flex flex-wrap items-center gap-2.5">
      {backBtn}
      <span className="text-[13px] font-medium text-[var(--text)]">{gameLabel(state.game)}</span>
      {item.result_label && <span className="v3-dv-chip">{item.result_label}</span>}
      <span className="font-mono text-[11px] text-[var(--text-faint)]">{fmtDate(item.updated_at, i18n.language)}</span>
      {item.replay_url && (
        <a href={item.replay_url} target="_blank" rel="noreferrer" className="v3-cp-link">
          <ExternalLink size={13} />
          {t("cockpit.openReplay")}
        </a>
      )}
    </div>
  );

  return (
    <div className="h-full">
      <CockpitPanel
        game={state.game}
        match={state.match}
        events={state.events}
        ownerPlayerId={state.ownerPlayerId ?? ""}
        ownerPrivate={state.ownerPrivate}
        traces={traces}
        isLive={false}
        badge="replay"
        note={t("history.replayNote")}
        headerLeft={headerLeft}
      />
      <ReviewSection sessionId={item.session_id} />
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-md text-center text-[13px] text-[var(--text-muted)]">{children}</div>
    </div>
  );
}
