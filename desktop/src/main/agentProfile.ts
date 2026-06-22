// Normalize the platform's public /api/agents/{id}/profile payload into the
// cockpit's name + record shape. Pure (no Electron / no network) so it is
// unit-tested. The profile is public and 404s while the agent is unclaimed; the
// fetch layer maps that to { name: null, stats: null }.
//
//   profile → { agent: { name, … }, summary?: { total_games, total_wins, …,
//               overall_win_rate, aggregate_rating, global_rank, leaderboard_eligible },
//               ranking?: { rank, aggregate_rating, total_games, total_wins, … } }

import type { AgentProfileData, AgentStats } from "../shared/ipc";

const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const optNum = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Map a raw profile response to { name, stats }. Never throws; bad input → nulls. */
export function normalizeAgentProfile(json: unknown): AgentProfileData {
  const j = (json ?? {}) as {
    agent?: { name?: unknown } | null;
    summary?: Record<string, unknown> | null;
    ranking?: Record<string, unknown> | null;
  };
  const rawName = j.agent?.name;
  const name = typeof rawName === "string" && rawName.length > 0 ? rawName : null;

  const s = j.summary ?? null;
  const r = j.ranking ?? null;
  if (s === null && r === null) return { name, stats: null };

  const totalGames = num(s?.total_games ?? r?.total_games);
  const wins = num(s?.total_wins ?? r?.total_wins);
  const losses = num(s?.total_losses ?? r?.total_losses);
  const draws = num(s?.total_draws ?? r?.total_draws);
  const winRate =
    s !== null && typeof s.overall_win_rate === "number"
      ? s.overall_win_rate
      : totalGames > 0
        ? wins / totalGames
        : 0;
  const stats: AgentStats = {
    totalGames,
    wins,
    losses,
    draws,
    winRate,
    rating: optNum(s?.aggregate_rating ?? r?.aggregate_rating),
    rank: optNum(s?.global_rank ?? r?.rank),
    leaderboardEligible: typeof s?.leaderboard_eligible === "boolean" ? s.leaderboard_eligible : false,
  };
  return { name, stats };
}
