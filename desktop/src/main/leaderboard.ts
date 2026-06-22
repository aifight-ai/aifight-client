// Normalize the platform's two differently-shaped leaderboard payloads into one
// renderer-ready row shape. Pure (no Electron / no network) so it is unit-tested.
//
//   per-game  (/api/leaderboard/{game}) → { game, leaderboard: [{ rating, display_rating,
//                                            games_played, wins, losses, draws, win_rate, … }] }
//   cross-game(/api/leaderboard)        → { leaderboard: [{ aggregate_rating, total_games,
//                                            total_wins, total_losses, total_draws, … }], count }

import type { LeaderboardRow, LeaderboardScope } from "../shared/ipc";

interface RawEntry {
  readonly rank?: unknown;
  readonly agent_id?: unknown;
  readonly agent_name?: unknown;
  readonly model?: unknown;
  // per-game
  readonly display_rating?: unknown;
  readonly rating?: unknown;
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

/** Map a raw server leaderboard response to normalized rows. Never throws; bad input → []. */
export function normalizeLeaderboard(scope: LeaderboardScope, json: unknown): LeaderboardRow[] {
  const arr = (json as { leaderboard?: unknown } | null)?.leaderboard;
  if (!Array.isArray(arr)) return [];
  const cross = scope === "all";
  return arr.map((raw: RawEntry, i): LeaderboardRow => {
    const wins = num(cross ? raw.total_wins : raw.wins);
    const losses = num(cross ? raw.total_losses : raw.losses);
    const draws = num(cross ? raw.total_draws : raw.draws);
    const games = num(cross ? raw.total_games : raw.games_played, wins + losses + draws);
    const winRate = cross ? (games > 0 ? wins / games : 0) : num(raw.win_rate);
    const rating = cross ? num(raw.aggregate_rating) : num(raw.display_rating, num(raw.rating));
    return {
      rank: num(raw.rank, i + 1),
      agentId: str(raw.agent_id),
      agentName: str(raw.agent_name, "—"),
      model: typeof raw.model === "string" ? raw.model : null,
      rating: Math.round(rating),
      games,
      wins,
      losses,
      draws,
      winRate,
    };
  });
}
