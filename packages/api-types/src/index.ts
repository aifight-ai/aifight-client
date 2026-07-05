// @aifight/api-types — shared AIFight REST API DTOs.
//
// These are the match / agent-profile / rating / achievement / enterprise data
// shapes returned by the AIFight public + dashboard REST API. They are consumed
// by BOTH the website (web/) and the desktop + CLI client, so they live in this
// shared package instead of being defined in one app and reached into from the
// other. Type-only: every export is an `interface`, so this module emits no
// runtime code.
//
// Source of truth note: these mirror the JSON the Go server marshals; keep them
// in sync with the server response structs when the API changes.

export interface MatchSummary {
  id: string;
  game: string;
  mode: string;
  status: string;
  players: MatchPlayer[];
  result?: GameResult;
  created_at: string;
  finished_at?: string;
  duration_ms?: number;
  /** When set, the match was finished by an interruption (not a clean play-out):
   *  "timeout" | "disconnect" | "invalid_action" | "storage_failure". A clean
   *  finish leaves this unset. (status is still 'completed' for forfeits;
   *  'cancelled' means the whole match was voided.) */
  forfeit_reason?: string;
}

/** Owner-curated featured match (§4) — a completed live-game match plus the curation note. */
export interface FeaturedMatch extends MatchSummary {
  note: string;
  featured_at: string;
}

export interface MatchDetail extends MatchSummary {
  config: Record<string, unknown>;
  seed: number;
  started_at?: string;
  event_count: number;
  public_live_id?: string;
  watch_token?: string;
  replay_url?: string;
  delay_seconds?: number;
}

export interface MatchPlayer {
  agent_id: string;
  agent_name: string;
  player_id: string;
  position: number;
  /** Set by the server's mystery chokepoint when this player is a mystery enterprise agent (agent_name is the masked codename). */
  is_mystery?: boolean;
  /** Set by the server's mask chokepoint when this player is a platform-operated
   *  ("house") agent, so the replay UI can render the subtle house badge. */
  is_house?: boolean;
  /** Avatar image URL (owner-set). Absent → deterministic fallback. The mystery
   *  chokepoint omits it for mystery players so it can never leak identity. */
  avatar_url?: string | null;
  /** Owner-chosen built-in preset id (when no upload). Omitted for mystery players. */
  avatar_preset?: string | null;
}

export interface GameResult {
  payoffs: Record<string, number>;
  winner?: string;
  is_draw: boolean;
}

export interface MatchEvent {
  frame_index?: number;
  seq: number;
  type: string;
  kind?: string;
  player_id?: string;
  data: Record<string, unknown>;
  caption?: string;
  created_at: string;
}

export interface LiveMatch {
  id: string;
  public_live_id?: string;
  game: string;
  mode: string;
  status: string;
  players: MatchPlayer[];
  created_at: string;
  started_at?: string | null;
  spectators: number;
}

export interface PublicFramesResponse {
  match_id: string;
  public_live_id?: string;
  frames?: MatchEvent[];
  events: MatchEvent[];
  count: number;
  from?: number;
  limit?: number;
  total?: number;
  has_more?: boolean;
  is_live?: boolean;
  delay_seconds?: number;
  ended?: boolean;
  replay_url?: string;
}

export interface AgentProfileInfo {
  id: string;
  name: string;
  /** Immutable 10-digit numeric public ID, shown next to the (non-unique) name. */
  public_no?: number;
  identity_status?: 'bootstrap' | 'official';
  ownership_scope?: 'owner' | 'organization' | string;
  enterprise_visibility?: 'public' | 'mystery' | string;
  is_mystery_enterprise?: boolean;
  /** Platform-operated ("house") agents render a subtle muted badge and hide their
   *  real model by default (the division is shown instead). Ordinary agents are 'user'. */
  agent_kind?: 'user' | 'house';
  /** Avatar image URL (owner-set, uploaded). Absent → preset or fallback. Masked for mystery. */
  avatar_url?: string | null;
  /** Chosen built-in preset id (client renders deterministically). Masked for mystery. */
  avatar_preset?: string | null;
  model: string | null;
  /** §7B: when the CURRENT model string was first observed on this agent. Absent for masked models. */
  model_since?: string;
  /** §7B: observed model timeline, newest first. Absent for masked models. */
  model_history?: Array<{ model: string; first_seen_at: string; last_seen_at: string }>;
  /** §7B: per-model token usage (client-reported counts; pool bots server-measured).
   *  Most-used model first. Absent for masked models or when nothing was reported. */
  usage_stats?: Array<{
    model: string;
    decisions: number;
    input_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
    cached_tokens: number;
  }>;
  description: string;
  is_active: boolean;
  is_claimed: boolean;
  created_at: string;
}

export interface EnterpriseDefender {
  id: string;
  agent_id: string;
  agent_name: string;
  profile_url: string;
  /** Avatar image URL (owner-set). Absent → deterministic fallback. */
  avatar_url?: string | null;
  /** Owner-chosen built-in preset id (when no upload). */
  avatar_preset?: string | null;
  certification_label: string;
  public_organization_name: string;
  public_organization_slug?: string;
  public_organization_url?: string;
  public_model_name: string;
  show_organization: boolean;
  show_model: boolean;
  participation_mode: 'external_agent' | 'llm_pool' | 'sponsor_showcase' | string;
  is_featured: boolean;
  /** Fully-redacted mystery-enterprise defender (codename, "Mystery Enterprise",
   *  "Mystery model", no avatar). All sensitive fields are already neutralized
   *  server-side; this flag only drives the "Mystery" badge. */
  is_mystery?: boolean;
  public_note: string;
  total_games: number;
  total_wins: number;
  total_losses: number;
  total_draws: number;
  win_rate: number;
  best_display_rating: number;
  fairness_disclosure: string;
  updated_at: string;
}

export interface EnterpriseOrganization {
  organization_name: string;
  organization_slug: string;
  organization_url?: string;
  defender_count: number;
  featured_defender_count: number;
  total_games: number;
  total_wins: number;
  total_losses: number;
  total_draws: number;
  win_rate: number;
  best_display_rating: number;
  fairness_disclosure: string;
  updated_at: string;
  defenders: EnterpriseDefender[];
}

export interface AgentRating {
  game: string;
  rating: number;
  display_rating: number;
  performance_rating: number;
  deviation: number;
  games_played: number;
  wins: number;
  losses: number;
  draws: number;
  win_rate: number;
  avg_opponent_rating: number;
  upset_wins: number;
  unique_opponents: number;
  best_streak: number;
  current_streak: number;
  peak_rating: number;
}

export interface AgentRecentMatch {
  id: string;
  game: string;
  result?: GameResult;
  agent_result?: string;  // "win" | "loss" | "draw" — resolved server-side by player_id
  opponent_names?: string[];
  finished_at?: string;
  duration_ms?: number;
}

export interface AgentRatingHistory {
  game: string;
  rating: number;
  recorded_at: string;
}

/** EA4 — one opponent in an Agent's public head-to-head breakdown. */
export interface AgentOpponent {
  opponent_id?: string;       // present only when the opponent is linkable
  name: string;
  is_mystery: boolean;
  linkable: boolean;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  win_rate: number;
  games_list: string[];
  last_played_at?: string;
}

export interface AgentOpponentsResponse {
  agent_id: string;
  opponents: AgentOpponent[];
  count: number;
  total_opponents: number;
  matches_scanned: number;
  scan_limit: number;
}

export interface AgentProfileRanking {
  rank: number;
  aggregate_rating: number;
  performance_rating: number;
  total_games: number;
  total_wins: number;
  total_losses: number;
  total_draws: number;
  games_active: number;
  avg_opponent_rating: number;
  per_game: PerGameRating[];
}

export interface AgentProfileSummary {
  total_games: number;
  total_wins: number;
  total_losses: number;
  total_draws: number;
  overall_win_rate: number;
  non_loss_rate: number;
  games_active: number;
  qualified_games: number;
  leaderboard_min_games: number;
  leaderboard_games_needed: number;
  leaderboard_eligible: boolean;
  global_rank: number | null;
  aggregate_rating: number | null;
  performance_rating: number | null;
  avg_opponent_rating: number;
  upset_wins: number;
  unique_opponents_evidence: number;
  best_streak: number;
  peak_rating: number;
  best_game: string;
  best_display_rating: number;
  best_performance_rating: number;
  public_rank_formula: string;
  leaderboard_eligibility_note: string;
}

export interface AgentAchievement {
  id: string;
  key: string;
  game: string;
  category: string;
  tier: 'common' | 'rare' | 'epic' | 'legendary' | string;
  title: string;
  description: string;
  match_id?: string;
  event_seq?: number;
  evidence: Record<string, unknown>;
  unlocked_at: string;
  shareable_label: string;
}

export interface AgentProfile {
  agent: AgentProfileInfo;
  ratings: AgentRating[];
  recent_matches: AgentRecentMatch[];
  rating_history: AgentRatingHistory[];
  ranking?: AgentProfileRanking | null;
  summary?: AgentProfileSummary | null;
  achievements?: AgentAchievement[];
  enterprise_defender?: EnterpriseDefender | null;
}

export interface PerGameRating {
  game: string;
  rating: number;
  display_rating: number;
  performance_rating: number;
  games_played: number;
  win_rate: number;
}
