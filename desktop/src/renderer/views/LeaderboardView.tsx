// Feature 2 — the ranking board. Reads the platform's PUBLIC Glicko-2 leaderboard
// (no auth) for the cross-game aggregate or a single game, normalized by the main
// process (leaderboard.ts). Styled to mirror the website's editorial table.
//
// The board shows up to the top 100 (server-clamped via ?limit=100), paged through
// client-side a page at a time. Most agents never reach the top 100, so when the
// user's own agent isn't in the returned rows we fetch its own public profile and
// pin a "you" row with its real global rank — or, if it has no rank yet, show an
// honest "not ranked yet" note. Clicking any agent deep-links to its web profile.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCw, ExternalLink, ChevronLeft, ChevronRight } from "lucide-react";

import { getLeaderboard, getAgentProfile, useBridgeStatus } from "../useBridge";
import { webOrigin } from "../webOrigin";
import { Card, PageHeader } from "../components/ui";
import { AgentAvatar } from "@aifight/ui";
import { useLiveGames } from "../liveGames";
import { gameLabel } from "../../shared/games";
import type { AgentProfileData, LeaderboardRow, LeaderboardScope } from "../../shared/ipc";
// The server returns up to the top 100; we show ONE page at a time (true paging,
// not an ever-growing list). Most agents never reach the top 100 — if you're
// outside it, your own row is pinned below the table on every page.
const PAGE_SIZE = 20;

type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; rows: LeaderboardRow[] };

/** Rank cell — like the website: #1 in brand serif italic, #2–3 muted serif, #4+ mono. */
function RankCell({ rank }: { rank: number }) {
  if (rank <= 3) {
    const color = rank === 1 ? "text-[var(--accent-text)]" : "text-[var(--text-muted)]";
    return <span className={"font-display text-[20px] italic " + color}>{rank}</span>;
  }
  return <span className="font-mono text-[13px] text-[var(--text-faint)]">{rank}</span>;
}

/** One leaderboard row. `mine` highlights it; `agentHref` (when set) makes the name a web deep-link. */
function Row({ r, mine, agentHref, youLabel }: { r: LeaderboardRow; mine: boolean; agentHref: string | null; youLabel: string }) {
  return (
    <tr
      className={
        "border-b border-[var(--border)] last:border-0 transition-colors " +
        (mine ? "bg-[var(--accent-soft)]" : "hover:bg-[var(--surface-2)]")
      }
    >
      <td className="py-3 pl-5 text-left tabular-nums">
        <RankCell rank={r.rank} />
      </td>
      <td className="py-3 pl-2">
        <div className="flex items-center gap-2.5">
          <AgentAvatar name={r.agentName} agentId={r.agentId} size={26} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {agentHref !== null ? (
                <a
                  href={agentHref}
                  target="_blank"
                  rel="noreferrer"
                  title={r.agentName}
                  className="inline-flex items-center gap-1 font-medium text-[var(--text)] decoration-[var(--accent)]/40 hover:text-[var(--accent-text)] hover:underline"
                >
                  {r.agentName}
                  <ExternalLink size={11} className="opacity-50" />
                </a>
              ) : (
                <span className="font-medium text-[var(--text)]">{r.agentName}</span>
              )}
              {mine && (
                <span className="rounded-full bg-[var(--accent)] px-2 py-0.5 font-mono text-[9px] font-medium uppercase tracking-[0.08em] text-white">
                  {youLabel}
                </span>
              )}
            </div>
            {r.model !== null && r.model !== "" && <div className="mt-0.5 text-[11px] text-[var(--text-faint)]">{r.model}</div>}
          </div>
        </div>
      </td>
      <td className="px-3 py-3 text-right font-mono font-semibold tabular-nums text-[var(--text)]">{r.rating}</td>
      <td className="px-3 py-3 text-right font-mono tabular-nums text-[var(--text-muted)]">{r.games}</td>
      <td className="px-3 py-3 text-right font-mono tabular-nums text-[var(--text-muted)]">
        {r.wins}-{r.losses}-{r.draws}
      </td>
      <td className="py-3 pr-5 text-right font-mono tabular-nums text-[var(--text-muted)]">{(r.winRate * 100).toFixed(0)}%</td>
    </tr>
  );
}

export function LeaderboardView() {
  const { t } = useTranslation();
  const status = useBridgeStatus();
  const ownId = status?.config?.agentId ?? null;
  const origin = webOrigin(status?.config?.baseUrl);
  const [scope, setScope] = useState<LeaderboardScope>("all");
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [profile, setProfile] = useState<AgentProfileData | null>(null);
  const [nonce, setNonce] = useState(0); // bumped by the refresh button
  const [page, setPage] = useState(0); // 0-based page over the top 100 (PAGE_SIZE each)
  const [fetching, setFetching] = useState(false); // drives the refresh-icon spin
  // Per-scope row cache so switching tabs shows the last-seen table instantly
  // instead of a full spinner + reset on every tap.
  const cacheRef = useRef<Record<string, LeaderboardRow[]>>({});

  // Own profile (for the self-row fallback when we're outside the top 100). Loaded
  // once; it's the same public endpoint the cockpit uses.
  useEffect(() => {
    let alive = true;
    void getAgentProfile().then((p) => {
      if (alive) setProfile(p);
    });
    return () => {
      alive = false;
    };
  }, [nonce]);

  useEffect(() => {
    let alive = true;
    setPage(0); // back to page 1 when the scope changes or on refresh
    const cached = cacheRef.current[scope];
    // Show this scope's last-seen rows immediately; only fall back to the loading
    // state the first time a scope is opened (no cache to keep on screen).
    setState(cached !== undefined ? { kind: "ready", rows: cached } : { kind: "loading" });
    setFetching(true);
    void getLeaderboard(scope)
      .then((data) => {
        if (!alive) return;
        if (data !== null) {
          cacheRef.current[scope] = data.rows;
          setState({ kind: "ready", rows: data.rows });
        } else if (cacheRef.current[scope] === undefined) {
          setState({ kind: "error" }); // only error when there's nothing cached to keep showing
        }
      })
      .catch(() => {
        if (alive && cacheRef.current[scope] === undefined) setState({ kind: "error" });
      })
      .finally(() => {
        if (alive) setFetching(false);
      });
    return () => {
      alive = false;
    };
  }, [scope, nonce]);

  // Scope tabs = "all" + whatever the PLATFORM says is live (backend-fed list).
  const scopes: ReadonlyArray<LeaderboardScope> = ["all", ...useLiveGames()];
  const scopeLabel = (s: LeaderboardScope): string => (s === "all" ? t("leaderboard.allGames") : gameLabel(s));
  const agentHref = (agentId: string): string | null => (agentId ? `${origin}/agents/${encodeURIComponent(agentId)}` : null);

  const rows = state.kind === "ready" ? state.rows : [];
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = rows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const selfInRows = ownId !== null && rows.some((r) => r.agentId === ownId);
  const stats = profile?.stats ?? null;
  // Self-row fallback (only when we have a concrete global rank — the cross-game scope).
  const showSelfRow = !selfInRows && ownId !== null && scope === "all" && stats?.rank != null;
  // Honest note when the agent has no rank to show here (outside top 100 / not eligible).
  const selfNote: string | null = (() => {
    // `stats` is the cross-game profile — don't show a cross-game "play 5 ranked"
    // note under a single-game board (it's misleading there).
    if (scope !== "all") return null;
    if (selfInRows || ownId === null || showSelfRow) return null;
    if (state.kind !== "ready") return null;
    if (stats === null || !stats.leaderboardEligible) return t("leaderboard.selfUnranked");
    return t("leaderboard.selfOutsideTop");
  })();

  const right = (
    <div className="flex items-center gap-2">
      <div className="inline-flex gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-0.5">
        {scopes.map((s) => (
          <button
            key={s}
            onClick={() => setScope(s)}
            className={
              "rounded-md px-3 py-1.5 text-[13px] transition-colors " +
              (scope === s ? "bg-[var(--surface)] text-[var(--text)] shadow-sm" : "text-[var(--text-muted)] hover:text-[var(--text)]")
            }
          >
            {scopeLabel(s)}
          </button>
        ))}
      </div>
      <button
        onClick={() => setNonce((n) => n + 1)}
        title={t("common.refresh")}
        className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2 text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
      >
        <RotateCw size={14} className={fetching ? "animate-spin" : ""} />
      </button>
    </div>
  );

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader eyebrow={t("eyebrow.leaderboard")} title={t("nav.leaderboard")} subtitle={t("hint.leaderboard")} right={right} />

      <Card className="overflow-hidden">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-[var(--border)] font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--text-faint)]">
              <th className="w-12 py-2.5 pl-5 text-left font-medium">{t("leaderboard.rank")}</th>
              <th className="py-2.5 pl-2 text-left font-medium">{t("leaderboard.agent")}</th>
              <th className="px-3 py-2.5 text-right font-medium">{t("leaderboard.rating")}</th>
              <th className="px-3 py-2.5 text-right font-medium">{t("leaderboard.games")}</th>
              <th className="px-3 py-2.5 text-right font-medium">{t("leaderboard.record")}</th>
              <th className="py-2.5 pr-5 text-right font-medium">{t("leaderboard.winRate")}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <Row
                key={r.agentId || String(r.rank)}
                r={r}
                mine={ownId !== null && r.agentId === ownId}
                agentHref={agentHref(r.agentId)}
                youLabel={t("leaderboard.you")}
              />
            ))}
            {showSelfRow && stats !== null && (
              <Row
                r={{
                  rank: stats.rank as number,
                  agentId: ownId as string,
                  agentName: profile?.name ?? status?.config?.agentName ?? "—",
                  model: null,
                  rating: stats.rating ?? 0,
                  games: stats.totalGames,
                  wins: stats.wins,
                  losses: stats.losses,
                  draws: stats.draws,
                  winRate: stats.winRate,
                }}
                mine
                agentHref={agentHref(ownId as string)}
                youLabel={t("leaderboard.you")}
              />
            )}
          </tbody>
        </table>

        {state.kind === "loading" && (
          <div className="px-4 py-12 text-center text-[13px] text-[var(--text-muted)]">{t("leaderboard.loading")}</div>
        )}
        {state.kind === "error" && (
          <div className="px-4 py-12 text-center text-[13px] text-[var(--text-muted)]">{t("leaderboard.errorLoad")}</div>
        )}
        {state.kind === "ready" && rows.length === 0 && (
          <div className="px-4 py-14 text-center">
            <div className="font-display text-[40px] italic leading-none text-[var(--border)]">—</div>
            <div className="mt-3 text-[13px] text-[var(--text-muted)]">{t("leaderboard.empty")}</div>
          </div>
        )}
        {state.kind === "ready" && pageCount > 1 && (
          <div className="flex items-center justify-between border-t border-[var(--border)] px-3 py-2.5">
            <button
              disabled={safePage === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)] disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <ChevronLeft size={14} />
              {t("common.prev")}
            </button>
            <span className="font-mono text-[11px] tabular-nums text-[var(--text-muted)]">
              {safePage + 1} / {pageCount}
            </span>
            <button
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)] disabled:opacity-40 disabled:hover:bg-transparent"
            >
              {t("common.next")}
              <ChevronRight size={14} />
            </button>
          </div>
        )}
      </Card>

      {selfNote !== null && (
        <p className="mt-3 text-center text-[12px] text-[var(--text-muted)]">{selfNote}</p>
      )}
    </div>
  );
}
