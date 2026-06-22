// Pure decision logic for the Play-view "ranked-progress" hint.
//
// Claim (email-verified ownership) is the ONLY ranked gate now (owner ruling
// 2026-06-18); the display name is a free-form label and is never required. So
// the only states left are:
//   - not claimed → agent cannot play ranked until the owner claims it.
//   - claimed but short of the per-game minimum → N more matches to qualify.
//   - claimed + eligible → null (the Rank KPI already shows the position).
//
// (The retired "needName" state — bootstrap-claimed agents being blocked until a
// Dashboard rename — is gone.) Kept free of React/i18n so it is trivially
// unit-testable; the component maps the returned `kind` to localized copy.

export interface RankedHintAgent {
  identity_status?: string;
  is_claimed?: boolean;
}

export interface RankedHintSummary {
  leaderboard_eligible?: boolean;
  leaderboard_games_needed?: number;
}

export type RankedHint =
  | { kind: "needClaim"; href: string }
  | { kind: "gamesNeeded"; count: number }
  | null;

/**
 * @param agent          raw.agent (claim state); undefined while loading.
 * @param summary        raw.summary (leaderboard eligibility); undefined while loading.
 * @param dashboardHref  absolute URL to open the Dashboard claim flow.
 *
 * Returns null while the profile is still loading (agent undefined) so the
 * blocking warning never flashes.
 */
export function computeRankedHint(
  agent: RankedHintAgent | null | undefined,
  summary: RankedHintSummary | null | undefined,
  dashboardHref: string,
): RankedHint {
  if (agent == null) return null; // still loading
  if (agent.is_claimed !== true) {
    return { kind: "needClaim", href: dashboardHref };
  }
  if (
    summary != null &&
    summary.leaderboard_eligible === false &&
    (summary.leaderboard_games_needed ?? 0) > 0
  ) {
    return { kind: "gamesNeeded", count: summary.leaderboard_games_needed ?? 0 };
  }
  return null;
}
