// Rich agent-profile visualizations for the home, REPLICATED from the website's
// agent profile (web/src/pages/AgentDetailPage.tsx). The website's charts are
// hand-rolled SVG / CSS with NO charting library, so we reproduce the same look
// locally using the desktop's shared design tokens — identical to aifight.ai,
// zero risk to the website (we don't import or refactor its source).

import { Award, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { gameLabel } from "../../shared/games";
import type { AgentAchievement, AgentRating, AgentRatingHistory } from "@aifight/api-types";

// Per-game line colors (≤3 games) — three DISTINCT hues that hold up in both
// themes: brand orange, the website's teal tertiary, and a muted ink. (Avoid
// --accent + --accent-text together: they're the same orange in dark mode.)
const LINE_COLORS = ["var(--accent)", "var(--color-tertiary)", "var(--text-muted)"];

/**
 * Rating-history line chart — one polyline per game over a shared time axis.
 * Pure SVG; scales to its container. Mirrors the website's RatingChart.
 */
export function RatingChart({ history }: { history: readonly AgentRatingHistory[] }) {
  const { t } = useTranslation();
  const W = 700;
  const H = 200;
  const padL = 44;
  const padR = 16;
  const padT = 16;
  const padB = 28;

  const pts = history.filter((h) => typeof h.rating === "number" && Number.isFinite(h.rating));
  if (pts.length < 2) {
    return (
      <div className="flex h-[180px] items-center justify-center text-[12px] text-[var(--text-faint)]">
        {t("home.chartEmpty")}
      </div>
    );
  }

  const times = pts.map((p) => Date.parse(p.recorded_at)).map((n) => (Number.isFinite(n) ? n : 0));
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const ratings = pts.map((p) => p.rating);
  let minR = Math.min(...ratings);
  let maxR = Math.max(...ratings);
  if (minR === maxR) {
    minR -= 20;
    maxR += 20;
  }
  const pad = (maxR - minR) * 0.12;
  minR -= pad;
  maxR += pad;

  const xOf = (t: number) => (maxT === minT ? (padL + W - padR) / 2 : padL + ((t - minT) / (maxT - minT)) * (W - padL - padR));
  const yOf = (r: number) => padT + (1 - (r - minR) / (maxR - minR)) * (H - padT - padB);

  // Group points by game, ordered by time.
  const byGame = new Map<string, { t: number; r: number }[]>();
  pts.forEach((p, i) => {
    const arr = byGame.get(p.game) ?? [];
    arr.push({ t: times[i], r: p.rating });
    byGame.set(p.game, arr);
  });
  for (const arr of byGame.values()) arr.sort((a, b) => a.t - b.t);
  const games = [...byGame.keys()];

  const yTicks = Array.from({ length: 5 }, (_, i) => minR + ((maxR - minR) * i) / 4);

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" preserveAspectRatio="xMidYMid meet">
        {yTicks.map((val, i) => {
          const y = yOf(val);
          return (
            <g key={i}>
              <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="var(--border)" strokeWidth={1} />
              <text x={padL - 8} y={y + 3} textAnchor="end" fontSize={10} fill="var(--text-faint)" fontFamily="var(--font-mono)">
                {Math.round(val)}
              </text>
            </g>
          );
        })}
        {games.map((game, gi) => {
          const arr = byGame.get(game) ?? [];
          const color = LINE_COLORS[gi % LINE_COLORS.length];
          const d = arr.map((p, i) => `${i === 0 ? "M" : "L"}${xOf(p.t).toFixed(1)},${yOf(p.r).toFixed(1)}`).join(" ");
          return (
            <g key={game}>
              <path d={d} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
              {arr.map((p, i) => (
                <circle key={i} cx={xOf(p.t)} cy={yOf(p.r)} r={2.5} fill={color} />
              ))}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
        {games.map((game, gi) => (
          <span key={game} className="flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.06em] text-[var(--text-muted)]">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: LINE_COLORS[gi % LINE_COLORS.length] }} />
            {gameLabel(game)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Per-game rating cards — display rating + games + W/L/D + win rate, one card per game. */
export function PerGameCards({ ratings }: { ratings: readonly AgentRating[] }) {
  const { t } = useTranslation();
  const rated = ratings.filter((r) => (r.games_played ?? 0) > 0);
  if (rated.length === 0) {
    return <div className="px-1 py-4 text-[12px] text-[var(--text-faint)]">{t("home.perGameEmpty")}</div>;
  }
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      {rated.map((r) => {
        // Extra detail (peak / performance / best streak) is already in the
        // fetched profile but was previously discarded. Surface it on a thin
        // secondary line with hover tooltips explaining each metric. Render the
        // line only when at least one value is meaningful.
        const peak = Math.round(r.peak_rating ?? 0);
        const perf = Math.round(r.performance_rating ?? 0);
        const streak = r.best_streak ?? 0;
        const hasDetail = peak > 0 || perf > 0 || streak > 0;
        return (
          <div key={r.game} className="v3-dv-inset px-4 py-3">
            <div className="v3-dv-display text-[14px] text-[var(--text)]">{gameLabel(r.game)}</div>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="font-mono text-[20px] font-semibold tabular-nums text-[var(--v3-acc-deep)]">
                {Math.round(r.display_rating ?? r.rating ?? 0)}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--text-faint)]">{t("home.rating")}</span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-[var(--text-muted)]">
              <span>{r.games_played} {t("home.games")}</span>
              <span className="tabular-nums">
                {r.wins}-{r.losses}-{r.draws}
              </span>
              <span className="tabular-nums">{Math.round((r.win_rate ?? 0) * 100)}%</span>
            </div>
            {hasDetail && (
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-[var(--v3-hairline)] pt-2 font-mono text-[10.5px] text-[var(--text-faint)]">
                {peak > 0 && (
                  <span className="tabular-nums" title={t("home.peakTip")}>
                    {t("home.peakLabel")} {peak}
                  </span>
                )}
                {perf > 0 && (
                  <span className="tabular-nums" title={t("home.perfTip")}>
                    {t("home.perfLabel")} {perf}
                  </span>
                )}
                {streak > 0 && (
                  <span className="tabular-nums" title={t("home.streakTip")}>
                    {t("home.streakLabel")} {streak}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Achievement tier → label key + accent colour. Colours are theme-safe (hold up
// in both light and dark): brand orange, a fixed amber, the teal tertiary, and
// muted ink — NO light gradients (which would wash out on a dark surface).
const ACH_TIER: Record<string, { labelKey: string; color: string }> = {
  legendary: { labelKey: "achievements.tierLegendary", color: "var(--accent-text)" },
  epic: { labelKey: "achievements.tierEpic", color: "#b8823c" },
  rare: { labelKey: "achievements.tierRare", color: "var(--color-tertiary)" },
  common: { labelKey: "achievements.tierCommon", color: "var(--text-muted)" },
};
function achTier(tier: string) {
  return ACH_TIER[tier] ?? ACH_TIER.common;
}

/**
 * Achievement shelf — verified profile badges. Mirrors the website's
 * AchievementShelf (web/src/pages/AgentDetailPage.tsx) but in the desktop's
 * native card idiom. Data (`raw.achievements`) is already in the profile the
 * Play view fetches; this just renders what was previously discarded.
 */
export function AchievementShelf({ achievements }: { achievements: readonly AgentAchievement[] }) {
  const { t } = useTranslation();
  const featured = achievements.slice(0, 8);
  return (
    <div className="v3-dv-card px-5 py-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="v3-dv-hd">{t("achievements.title")}</div>
        {achievements.length > 0 && (
          <span className="v3-dv-hnote">
            {t("achievements.unlocked", { count: achievements.length })}
          </span>
        )}
      </div>
      {featured.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--v3-hairline-2)] px-4 py-5 text-[12px] leading-relaxed text-[var(--text-faint)]">
          {t("achievements.emptyCopy")}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {featured.map((a) => {
            const tier = achTier(a.tier);
            const isMoment = a.category === "poker_moment";
            return (
              <div key={a.id} className="v3-dv-inset px-3.5 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className="flex h-7 w-7 items-center justify-center rounded-md border"
                    style={{ borderColor: tier.color, color: tier.color }}
                  >
                    {isMoment ? <Sparkles size={14} /> : <Award size={14} />}
                  </span>
                  <span className="font-mono text-[9.5px] uppercase tracking-[0.1em]" style={{ color: tier.color }}>
                    {t(tier.labelKey)}
                  </span>
                </div>
                <div className="v3-dv-display mt-2 text-[13px] leading-snug text-[var(--text)]">
                  {a.title}
                </div>
                {a.description && (
                  <div className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-muted)]">{a.description}</div>
                )}
                {a.game && (
                  <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--text-faint)]">
                    {gameLabel(a.game)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
