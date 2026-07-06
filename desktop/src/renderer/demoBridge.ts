// Browser demo mode — a self-contained mock of window.aifight so the FULL
// configured dashboard renders in a plain `vite dev` browser tab (no Electron,
// no bridge, no network). Activated by main.tsx ONLY when the preload API is
// absent AND the URL carries ?demo — i.e. never inside the packaged app, where
// the real preload owns window.aifight. Used for UI work and screenshots.

import type {
  AgentPolicy,
  AifightBridgeApi,
  BridgeStatus,
  CliRunResult,
  UsageOverview,
} from "../shared/ipc";

const STATUS: BridgeStatus = {
  phase: "running",
  config: {
    agentId: "00000000-0000-4000-8000-00000000demo",
    agentName: "Demo Strategist",
    baseUrl: "https://aifight.ai",
    runtimeType: "direct-llm",
    directAgentSlug: "default",
    autoDailyLimit: 2,
    autoGames: ["texas_holdem", "liars_dice", "coup"],
  },
};

let demoPolicy: AgentPolicy = {
  maxGamesPerDay: 2,
  maxGamesPerHour: 2,
  cooldownSeconds: 60,
  isClaimed: true,
  termsPending: false,
  gamesToday: 1,
  name: "Demo Strategist",
  publicNo: 1024384756,
};

// 30 days of gently-rising rating history across three games.
function ratingHistory(): Array<{ game: string; rating: number; recorded_at: string }> {
  const out: Array<{ game: string; rating: number; recorded_at: string }> = [];
  const now = Date.now();
  const base: Record<string, number> = { texas_holdem: 1480, liars_dice: 1510, coup: 1465 };
  const drift: Record<string, number> = { texas_holdem: 9, liars_dice: 4, coup: 6.5 };
  for (let day = 30; day >= 0; day -= 2) {
    for (const game of Object.keys(base)) {
      const wobble = Math.sin((day / 30) * Math.PI * 2 + game.length) * 18;
      out.push({
        game,
        rating: Math.round(base[game]! + (30 - day) * drift[game]! + wobble),
        recorded_at: new Date(now - day * 86_400_000).toISOString(),
      });
    }
  }
  return out;
}

const RAW_PROFILE = {
  agent: {
    id: STATUS.config!.agentId,
    name: "Demo Strategist",
    model: "claude-opus-4-6",
    description: "Demo data — every number on this page is synthetic.",
    is_active: true,
    is_claimed: true,
    identity_status: "official",
    created_at: new Date(Date.now() - 45 * 86_400_000).toISOString(),
  },
  summary: { leaderboard_eligible: true, leaderboard_games_needed: 0, global_rank: 7, total_games: 132 },
  ratings: [
    { game: "texas_holdem", rating: 1742, display_rating: 1689, performance_rating: 1758, deviation: 62, games_played: 58, wins: 33, losses: 22, draws: 3, win_rate: 0.569, avg_opponent_rating: 1655, upset_wins: 6, unique_opponents: 24, best_streak: 7, current_streak: 3, peak_rating: 1801 },
    { game: "liars_dice", rating: 1633, display_rating: 1571, performance_rating: 1644, deviation: 71, games_played: 41, wins: 22, losses: 17, draws: 2, win_rate: 0.537, avg_opponent_rating: 1602, upset_wins: 4, unique_opponents: 19, best_streak: 5, current_streak: -1, peak_rating: 1666 },
    { game: "coup", rating: 1668, display_rating: 1597, performance_rating: 1671, deviation: 78, games_played: 33, wins: 18, losses: 14, draws: 1, win_rate: 0.545, avg_opponent_rating: 1631, upset_wins: 3, unique_opponents: 17, best_streak: 4, current_streak: 2, peak_rating: 1694 },
  ],
  recent_matches: [],
  rating_history: ratingHistory(),
  achievements: [
    {
      id: "demo-a1", key: "tournament_champion", game: "texas_holdem", category: "match", tier: "epic",
      title: "Final Table Closer", description: "Won a 6-max tournament after entering the final hand short-stacked.",
      evidence: {}, unlocked_at: new Date(Date.now() - 6 * 86_400_000).toISOString(), shareable_label: "Final Table Closer",
    },
    {
      id: "demo-a2", key: "bluff_master", game: "liars_dice", category: "poker_moment", tier: "rare",
      title: "Cold-Blooded Bid", description: "Survived three challenges in a row on pure-bluff bids.",
      evidence: {}, unlocked_at: new Date(Date.now() - 12 * 86_400_000).toISOString(), shareable_label: "Cold-Blooded Bid",
    },
    {
      id: "demo-a3", key: "win_streak_5", game: "coup", category: "streak", tier: "common",
      title: "Momentum", description: "Five ranked wins in a row across any game.",
      evidence: {}, unlocked_at: new Date(Date.now() - 20 * 86_400_000).toISOString(), shareable_label: "Momentum",
    },
  ],
};

const USAGE: UsageOverview = {
  month: {
    total: { key: "total", calls: 1184, inputTokens: 6_421_337, outputTokens: 412_220, reasoningTokens: 1_280_450, cachedTokens: 3_200_145, estimatedCost: 14.62, unpricedCalls: 121, matches: 96 },
    byModel: [
      { key: "claude-opus-4-6", calls: 803, inputTokens: 4_421_337, outputTokens: 282_220, reasoningTokens: 1_280_450, cachedTokens: 2_500_145, estimatedCost: 12.4, unpricedCalls: 0, matches: 64 },
      { key: "deepseek-v4-pro", calls: 381, inputTokens: 2_000_000, outputTokens: 130_000, reasoningTokens: 0, cachedTokens: 700_000, estimatedCost: 2.22, unpricedCalls: 121, matches: 32 },
    ],
  },
  today: {
    total: { key: "total", calls: 38, inputTokens: 240_551, outputTokens: 14_380, reasoningTokens: 41_200, cachedTokens: 130_002, estimatedCost: 0.52, unpricedCalls: 0, matches: 3 },
  },
  currency: "$",
  hasPrices: true,
};

const SESSIONS = [
  { session_id: "demo-s1", game: "texas_holdem", status: "completed", result_label: "win", updated_at: new Date(Date.now() - 2 * 3_600_000).toISOString(), decision_count: 41, player_count: 4, event_count: 164 },
  { session_id: "demo-s2", game: "coup", status: "completed", result_label: "loss", updated_at: new Date(Date.now() - 7 * 3_600_000).toISOString(), decision_count: 18, player_count: 3, event_count: 57 },
  { session_id: "demo-s3", game: "liars_dice", status: "completed", result_label: "win", updated_at: new Date(Date.now() - 26 * 3_600_000).toISOString(), decision_count: 22, player_count: 2, event_count: 48 },
  { session_id: "demo-s4", game: "texas_holdem", status: "completed", result_label: "win", updated_at: new Date(Date.now() - 49 * 3_600_000).toISOString(), decision_count: 37, player_count: 4, event_count: 171 },
  { session_id: "demo-s5", game: "coup", status: "completed", result_label: "draw", updated_at: new Date(Date.now() - 70 * 3_600_000).toISOString(), decision_count: 12, player_count: 4, event_count: 44 },
  { session_id: "demo-s6", game: "liars_dice", status: "completed", result_label: "loss", updated_at: new Date(Date.now() - 76 * 3_600_000).toISOString(), decision_count: 19, player_count: 3, event_count: 63 },
  { session_id: "demo-s7", game: "texas_holdem", status: "completed", result_label: "win", updated_at: new Date(Date.now() - 98 * 3_600_000).toISOString(), decision_count: 44, player_count: 2, event_count: 132 },
  { session_id: "demo-s8", game: "coup", status: "completed", result_label: "win", updated_at: new Date(Date.now() - 121 * 3_600_000).toISOString(), decision_count: 15, player_count: 3, event_count: 49 },
  { session_id: "demo-s9", game: "liars_dice", status: "completed", result_label: "win", updated_at: new Date(Date.now() - 144 * 3_600_000).toISOString(), decision_count: 27, player_count: 2, event_count: 57 },
  { session_id: "demo-s10", game: "texas_holdem", status: "completed", result_label: "loss", updated_at: new Date(Date.now() - 170 * 3_600_000).toISOString(), decision_count: 33, player_count: 4, event_count: 149 },
];

function cliResult(json: unknown): CliRunResult {
  return { exitCode: 0, stdout: JSON.stringify(json), stderr: "", json };
}

const noopOff = (): (() => void) => () => {};

/** Install the demo mock. Call ONLY when window.aifight is absent (plain browser). */
export function installDemoBridge(): void {
  const api: AifightBridgeApi = {
    version: "0.0.0-demo",
    platform: "demo",
    getStatus: () => Promise.resolve(STATUS),
    start: () => Promise.resolve(STATUS),
    stop: () => Promise.resolve(STATUS),
    requestMatches: () => Promise.resolve({ ok: true }),
    getLiveGames: () => Promise.resolve(["texas_holdem", "liars_dice", "coup"]),
    getConnectionHealth: () =>
      Promise.resolve({ phase: "running", connectedAt: Date.now() - 3_600_000, reconnects: 0, lastActivityAt: Date.now() - 30_000 }),
    openClaim: () => Promise.resolve({ ok: true }),
    openDashboard: () => Promise.resolve({ ok: true }),
    acceptLegal: () => Promise.resolve({ ok: true }),
    openLegal: () => Promise.resolve({ ok: true }),
    getAgentProfile: () =>
      Promise.resolve({
        name: "Demo Strategist",
        stats: { totalGames: 132, wins: 73, losses: 53, draws: 6, winRate: 0.553, rating: 1619, rank: 7, leaderboardEligible: true },
      }),
    getOwnProfileRaw: () => Promise.resolve(RAW_PROFILE as unknown as Record<string, unknown>),
    getOwnRadar: (game?: string) =>
      Promise.resolve({
        enabled: true,
        board: "community",
        game,
        dimensions:
          game === undefined || game === ""
            ? { bluff: 72, aggression: 58, execution: 44, survival: 66, insight: 81, versatility: 61 }
            : { bluff: 64, aggression: 52, execution: null, survival: 70, insight: 77, versatility: null },
        samples: { bluff: 120, aggression: 300, execution: 24, survival: 40, insight: 90, versatility: 40 },
        rates: { bluff: 0.41, aggression: 0.33, insight: 0.52 },
      }),
    getAgentPolicy: () => Promise.resolve(demoPolicy),
    setAgentPolicy: (patch) => {
      demoPolicy = { ...demoPolicy, maxGamesPerDay: patch.maxGamesPerDay };
      return Promise.resolve({ ok: true });
    },
    setAgentName: (patch) => {
      demoPolicy = { ...demoPolicy, name: patch.name };
      return Promise.resolve({ ok: true, name: patch.name, publicNo: demoPolicy.publicNo });
    },
    setAgentAvatar: () => Promise.resolve({ ok: true }),
    clearAgentAvatar: () => Promise.resolve({ ok: true }),
    uploadAgentAvatar: () => Promise.resolve({ ok: true, avatar_url: "" }),
    getLeaderboard: () => Promise.resolve(null),
    getEvents: () => Promise.resolve(null),
    setMatchingPaused: () => Promise.resolve({ ok: true }),
    openConfigDir: () => Promise.resolve(""),
    getLaunchAtLogin: () => Promise.resolve(false),
    setLaunchAtLogin: () => Promise.resolve({ ok: true }),
    focusWindow: () => Promise.resolve(),
    cliRun: (args: string[]) => {
      if (args[0] === "sessions" && args[1] === "list") return Promise.resolve(cliResult({ sessions: SESSIONS }));
      if (args[0] === "status") return Promise.resolve(cliResult({ platformAgentStatus: { kind: "ok", isClaimed: true } }));
      if (args[0] === "challenge") return Promise.resolve(cliResult({ join_url: "https://aifight.ai/challenge/demo-token" }));
      // Self-review settings (Settings tri-state reads autoMode).
      if (args[0] === "config" && args[1] === "review")
        return Promise.resolve(cliResult({ agentSlug: "default", selfReview: { autoMode: "off", model: "", maxTurns: null } }));
      // Post-match self-review — a lively populated review for both the read-only
      // check (--no-generate) and the explicit generate, so screenshots are useful.
      if (args[0] === "review")
        return Promise.resolve(
          cliResult({
            review: {
              schema: 1,
              generated_at: new Date(Date.now() - 3_600_000).toISOString(),
              trigger: "manual",
              model: "claude-opus-4-6",
              locale: "en",
              prompt_version: "sr-v1",
              report_text:
                "You played a disciplined game — folding marginal hands preflop paid off. The key spot was the turn check-raise on board X, which maximized value.",
              suggestion: {
                scope: "texas_holdem",
                text: "Add a note to 3-bet more from the button vs late-position opens.",
              },
              token_usage: { input: 1840, output: 220 },
              source_strategy_hashes: ["demo"],
            },
          }),
        );
      return Promise.resolve(cliResult({ status: "ok" }));
    },
    readStrategy: () => Promise.resolve({ docs: [], maxBytes: 65536, error: "demo" }),
    writeStrategy: () => Promise.resolve({ ok: false, error: "demo" }),
    getLLMConfig: () =>
      Promise.resolve({ configured: true, slug: "default", activeProfile: "demo", routing: { default: "demo" }, profiles: [] }),
    llmRecommendMaxTokens: () => Promise.resolve(null),
    saveLLMProfile: () => Promise.resolve({ ok: false, error: "demo" }),
    setLLMKey: () => Promise.resolve({ ok: false, error: "demo" }),
    clearLLMKey: () => Promise.resolve({ ok: false, error: "demo" }),
    setLLMActive: () => Promise.resolve({ ok: false, error: "demo" }),
    setLLMRoute: () => Promise.resolve({ ok: false, error: "demo" }),
    deleteLLMProfile: () => Promise.resolve({ ok: false, error: "demo" }),
    onStatus: noopOff,
    onLog: noopOff,
    onTrace: noopOff,
    onServerMessage: noopOff,
    onNavigate: noopOff,
    getUsageOverview: () => Promise.resolve(USAGE),
    checkForUpdates: () => Promise.resolve(),
    installUpdate: () => Promise.resolve(),
    onUpdateStatus: noopOff,
  };
  Object.defineProperty(window, "aifight", { value: api, configurable: true });
}
