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

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ExternalLink, RotateCw } from "lucide-react";

import { runCli } from "../useBridge";
import { buildReplayFromExport, replayPathOf, type SessionReplay } from "../sessionReplay";
import { appendFinalEvents } from "../liveMatch";
import { isStaleLiveSession } from "../staleSession";
import { Chip, PageHeader } from "../components/ui";
import { gameLabel } from "../../shared/games";
import { CockpitPanel } from "./CockpitPanel";
import { ReviewSection } from "./ReviewSection";

// The runtime returns the FULL session list (no server-side pagination), so we
// filter + page on the client. Real pages, 10 per page (owner ruling 2026-07-28
// — a growing history needs pagination, not an ever-longer load-more pile).
const PAGE_SIZE = 10;
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
  started_at?: string;
  ended_at?: string;
  updated_at?: string;
  result_label?: string;
  decision_count?: number;
  player_count?: number;
  /** Opponent names from game_over (server-masked); absent on old sessions. */
  opponents?: string[];
  real_match_id?: string;
  replay_url?: string;
}

function fmtDate(iso: string | undefined, locale: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(locale);
}

/** Wall-clock length of the match, website-style compact ("29m16s"). */
function fmtDuration(startISO: string | undefined, endISO: string | undefined): string | null {
  if (!startISO || !endISO) return null;
  const ms = new Date(endISO).getTime() - new Date(startISO).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 > 0 ? `${s % 60}s` : ""}`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

/** "/replay/<publicID>" (path or full URL) → publicID; null when unusable. */
function publicReplayIdOf(replayUrl: string | undefined): string | null {
  const path = replayPathOf(replayUrl);
  if (path === null) return null;
  const m = /^\/replay\/([^/?#]+)/.exec(path);
  return m === null ? null : m[1];
}

/**
 * 对局强度 per public replay id, from the OWN agent's public profile
 * (recent_matches[].avg_player_rating — the pre-match rating average across
 * ALL seats, the same number the website's agent page shows). Best-effort:
 * the profile covers the recent window only, older local sessions simply
 * show no strength.
 */
function readStrengthMap(profile: Record<string, unknown> | null): Map<string, number> {
  const map = new Map<string, number>();
  const rows = (profile as { recent_matches?: unknown })?.recent_matches;
  if (!Array.isArray(rows)) return map;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as { public_replay_id?: unknown; id?: unknown; avg_player_rating?: unknown };
    const id = typeof r.public_replay_id === "string" ? r.public_replay_id : typeof r.id === "string" ? r.id : null;
    if (id !== null && typeof r.avg_player_rating === "number") map.set(id, r.avg_player_rating);
  }
  return map;
}

/**
 * The store keeps result_label in English ("3rd place", "draw", "forfeit"…) —
 * localize the known shapes for zh readers, pass anything unknown through, and
 * leave English UI on the original wording.
 */
function localizeResult(label: string | undefined, lang: string, t: (k: string, o?: Record<string, unknown>) => string): string | undefined {
  if (label === undefined || label === "" || !lang.startsWith("zh")) return label;
  const place = /^(\d+)(?:st|nd|rd|th) place$/.exec(label);
  if (place !== null) return t("history.placeN", { n: place[1] });
  switch (label.toLowerCase()) {
    case "win":
      return t("history.resultWin");
    case "loss":
      return t("history.resultLoss");
    case "draw":
      return t("history.resultDraw");
    case "forfeit":
      return t("history.resultForfeit");
    case "opponent forfeit":
      return t("history.resultOppForfeit");
    case "completed":
      return t("history.resultCompleted");
    default:
      return label;
  }
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
  const [page, setPage] = useState(0);
  // Back to page 1 whenever a filter changes — a kept page index could point
  // past the shrunken filtered list.
  useEffect(() => setPage(0), [gameFilter, statusFilter, modeFilter]);

  // Opening / closing a detail swaps the whole page content inside the app
  // shell's ONE scroller — reset it, or the list's scroll position leaks into
  // the detail (opened mid-page, header off screen) and vice versa. The App
  // shell only resets on nav-view switches; this transition stays in "history".
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let p: HTMLElement | null | undefined = rootRef.current?.parentElement;
    while (p) {
      const oy = getComputedStyle(p).overflowY;
      if (oy === "auto" || oy === "scroll") {
        p.scrollTo({ top: 0 });
        break;
      }
      p = p.parentElement;
    }
  }, [selected]);

  // 对局强度 joined from the own public profile (see readStrengthMap).
  const [strengthMap, setStrengthMap] = useState<Map<string, number>>(() => new Map());

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
    if (typeof window.aifight?.getOwnProfileRaw === "function") {
      void window.aifight
        .getOwnProfileRaw()
        .then((profile) => setStrengthMap(readStrengthMap(profile)))
        .catch(() => {});
    }
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
      // Same gap as the live stream and the dashboard-opened replay: stored
      // inbound frames end at this player's LAST decision, so the closing
      // stretch (opponents' final moves, showdown, result) only exists in the
      // finished match's public replay. Best-effort — on failure the replay
      // stays as stored. (The dashboard path got this in 9ef8fa53; this History
      // entry point was missed then.)
      const tailPath = replayPathOf(item.replay_url);
      if (tailPath !== null && typeof window.aifight?.getReplayTail === "function") {
        void window.aifight
          .getReplayTail(tailPath)
          .then((frames) => {
            if (frames === null || frames.length === 0) return;
            setSelected((cur) => {
              if (cur === null || cur.item.session_id !== item.session_id) return cur;
              const state = appendFinalEvents(cur.replay.state, frames);
              if (state === cur.replay.state) return cur;
              return { item: cur.item, replay: { state, traces: cur.replay.traces } };
            });
          })
          .catch(() => {});
      }
    });
  };

  if (selected !== null) {
    return (
      <div ref={rootRef}>
        <HistoryDetail item={selected.item} replay={selected.replay} onBack={() => setSelected(null)} />
      </div>
    );
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
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  return (
    <div ref={rootRef} className="mx-auto max-w-3xl">
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
                        {s.result_label && <Chip tone="neutral">{localizeResult(s.result_label, i18n.language, t)}</Chip>}
                        {s.status === "active" &&
                          (isStaleLiveSession(s.status, s.updated_at, Date.now()) ? (
                            <Chip tone="neutral">{t("history.interrupted")}</Chip>
                          ) : (
                            <Chip tone="live">{t("history.active")}</Chip>
                          ))}
                        {s.mode === "friendly" && <Chip tone="accent">{t("history.friendly")}</Chip>}
                      </div>
                      <div className="mt-1 truncate font-mono text-[11px] text-[var(--text-faint)]">
                        {(() => {
                          const rid = publicReplayIdOf(s.replay_url);
                          const strength = rid !== null ? strengthMap.get(rid) : undefined;
                          return [
                            fmtDate(s.updated_at, i18n.language),
                            typeof s.player_count === "number" && s.player_count > 0
                              ? t("history.playersN", { n: s.player_count })
                              : null,
                            fmtDuration(s.started_at, s.ended_at),
                            strength !== undefined ? t("history.strengthN", { n: strength }) : null,
                            t("history.decisions", { n: s.decision_count ?? 0 }),
                          ]
                            .filter(Boolean)
                            .join(" · ");
                        })()}
                      </div>
                      {s.opponents !== undefined && s.opponents.length > 0 && (
                        <div className="mt-0.5 truncate font-mono text-[11px] text-[var(--text-faint)]">
                          vs {s.opponents.join(" · ")}
                        </div>
                      )}
                    </div>
                    <span className="shrink-0 font-mono text-[11px] text-[var(--text-muted)]">
                      {opening === s.session_id ? t("history.opening") : t("history.open")}
                    </span>
                  </button>
                ))}
              </div>
              {pageCount > 1 && (
                <div className="mt-3 flex items-center justify-center gap-3">
                  <button
                    onClick={() => setPage(Math.max(0, safePage - 1))}
                    disabled={safePage === 0}
                    className="v3-dv-btn v3-dv-btn--ghost v3-dv-btn--sm disabled:opacity-40"
                  >
                    {t("common.prev")}
                  </button>
                  <span className="font-mono text-[11px] text-[var(--text-muted)]">
                    {t("history.pageOf", { x: safePage + 1, y: pageCount })}
                  </span>
                  <button
                    onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))}
                    disabled={safePage >= pageCount - 1}
                    className="v3-dv-btn v3-dv-btn--ghost v3-dv-btn--sm disabled:opacity-40"
                  >
                    {t("common.next")}
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
      {item.result_label && <span className="v3-dv-chip">{localizeResult(item.result_label, i18n.language, t)}</span>}
      {isStaleLiveSession(item.status, item.updated_at, Date.now()) && (
        <span className="v3-dv-chip">{t("history.interrupted")}</span>
      )}
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
    // Document flow, NOT h-full: the review card stacks below the cockpit and
    // the page scrolls. fill={false} sizes the cockpit by its content — with the
    // old h-full pair, a board taller than the viewport painted over the review
    // card (Generate button floating on the hand ledger, owner 2026-07-28).
    <div className="pb-4">
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
        fill={false}
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
