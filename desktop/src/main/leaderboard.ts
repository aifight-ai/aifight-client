// Normalize the platform's two differently-shaped leaderboard payloads into one
// renderer-ready row shape. Pure (no Electron / no network) so it is unit-tested.
// Field semantics deliberately mirror the WEBSITE leaderboard (web/src/pages/
// LeaderboardPage.tsx) — same data, same algorithm, same columns.
//
//   per-game  (/api/leaderboard/{game}) → { game, leaderboard: [{ rating, display_rating,
//                                            deviation, games_played, wins, losses, draws,
//                                            win_rate, recent_form, is_house, … }] }
//   cross-game(/api/leaderboard)        → { leaderboard: [{ aggregate_rating, total_games,
//                                            total_wins, total_losses, total_draws,
//                                            recent_form, is_house, … }], count }

import type { LeaderboardRow, LeaderboardScope } from "../shared/ipc";

interface RawEntry {
  readonly rank?: unknown;
  readonly agent_id?: unknown;
  readonly agent_name?: unknown;
  readonly model?: unknown;
  readonly recent_form?: unknown;
  readonly is_house?: unknown;
  // per-game
  readonly display_rating?: unknown;
  readonly rating?: unknown;
  readonly deviation?: unknown;
  readonly games_played?: unknown;
  readonly wins?: unknown;
  readonly losses?: unknown;
  readonly draws?: unknown;
  readonly win_rate?: unknown;
  // cross-game
  readonly aggregate_rating?: unknown;
  readonly total_games?: unknown;
  readonly total_wins?: unknown;
  readonly total_losses?: unknown;
  readonly total_draws?: unknown;
}

const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

const formStrip = (v: unknown): readonly string[] | null =>
  Array.isArray(v) && v.length > 0 && v.every((r) => typeof r === "string")
    ? (v as string[])
    : null;

/** Map a raw server leaderboard response to normalized rows. Never throws; bad input → []. */
export function normalizeLeaderboard(scope: LeaderboardScope, json: unknown): LeaderboardRow[] {
  const arr = (json as { leaderboard?: unknown } | null)?.leaderboard;
  if (!Array.isArray(arr)) return [];
  const cross = scope === "all";
  const rows = arr.map((raw: RawEntry): LeaderboardRow => {
    const wins = num(cross ? raw.total_wins : raw.wins);
    const losses = num(cross ? raw.total_losses : raw.losses);
    const draws = num(cross ? raw.total_draws : raw.draws);
    const games = num(cross ? raw.total_games : raw.games_played, wins + losses + draws);
    // Per-game win_rate is percentage points (72.2); normalize to a 0-1
    // fraction at the boundary — the exact rule the website applies.
    const winRate = cross ? (games > 0 ? wins / games : 0) : num(raw.win_rate) / 100;
    const rating = cross ? num(raw.aggregate_rating) : num(raw.display_rating, num(raw.rating));
    const rd = cross ? null : typeof raw.deviation === "number" && Number.isFinite(raw.deviation) ? raw.deviation : null;
    return {
      rank: 0, // assigned below — landmarks take no number, same as the website
      agentId: str(raw.agent_id),
      agentName: str(raw.agent_name, "—"),
      model: typeof raw.model === "string" ? raw.model : null,
      rating: Math.round(rating),
      games,
      wins,
      losses,
      draws,
      winRate,
      rd,
      recentForm: formStrip(raw.recent_form),
      isLandmark: raw.is_house === true,
    };
  });
  // Community-board rank rule (website P4): landmark house rows interleave by
  // score but consume no rank number; real agents are numbered in order.
  let human = 0;
  return rows.map((r) => (r.isLandmark ? r : { ...r, rank: ++human }));
}
