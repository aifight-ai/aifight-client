// Browser demo mode — a self-contained mock of window.aifight so the FULL
// configured dashboard renders in a plain `vite dev` browser tab (no Electron,
// no bridge, no network). Activated by main.tsx ONLY when the preload API is
// absent AND the URL carries ?demo — i.e. never inside the packaged app, where
// the real preload owns window.aifight. Used for UI work and screenshots.

import type {
  AgentPolicy,
  AifightBridgeApi,
  BridgeStatus,
  CliOp,
  CliRunResult,
  UsageOverview,
} from "../shared/ipc";
import type { MatchEvent } from "@aifight/api-types";
import { FIXTURES } from "./fixtures";
import { DECISION_TYPES, synthesizeTraces } from "./demoMatch";

// Mutable in demo mode so the 暂停匹配 toggle actually round-trips through the
// status push (连接审计 #13 made the main process the owner of that bit).
let STATUS: BridgeStatus = {
  phase: "running",
  config: {
    agentId: "00000000-0000-4000-8000-00000000demo",
    agentName: "Demo Strategist",
    baseUrl: "https://aifight.ai",
    runtimeType: "direct-llm",
    directAgentSlug: "default",
    autoDailyLimit: 2,
    autoGames: ["texas_holdem", "liars_dice", "coup"],
    // No declaredModel pin in the demo — the hero shows the profile-model
    // fallback, exactly like a real unpinned agent.
    profileModel: "claude-opus-5",
  },
  // 连接审计 #12/#8 — demo the queue-truth pill and give the conn field a
  // connected snapshot so the StatusPill code path runs. No one_shot: this is a
  // server-side enrollment echo, so the pill shows the game-agnostic 在线 · 候战
  // (owner ruling 2026-08-01 — only an explicit manual request names its game).
  queued: { game: "texas_holdem", mode: "ranked" },
  conn: { state: "connected", attempt: 0, nextRetryAt: null, authFailures: 0 },
};

const statusListeners = new Set<(s: BridgeStatus) => void>();

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

// 对局强度 rows the History list joins by public_replay_id — mirrors the real
// profile payload's recent_matches (avg_player_rating = pre-match table avg).
const RECENT_MATCH_STRENGTH = Array.from({ length: 12 }, (_, i) => ({
  id: `demo-r${i + 1}`,
  public_replay_id: `demo-r${i + 1}`,
  avg_player_rating: 1460 + ((i * 37) % 220),
}));

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
  recent_matches: RECENT_MATCH_STRENGTH,
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

// Demo history rows: realistic store shapes — result_label in the store's
// English forms ("1st place"…, exercising the zh localizer), started/ended
// pairs (duration), and game_over-style opponents. 12 completed rows so the
// 10-per-page pager shows a second page in the demo.
function demoSession(
  n: number,
  game: string,
  result: string,
  hoursAgo: number,
  minutes: number,
  decisions: number,
  events: number,
  opponents: readonly string[],
) {
  const ended = Date.now() - hoursAgo * 3_600_000;
  return {
    session_id: `demo-s${n}`,
    game,
    status: "completed",
    result_label: result,
    mode: n % 5 === 0 ? "friendly" : "ranked",
    started_at: new Date(ended - minutes * 60_000).toISOString(),
    ended_at: new Date(ended).toISOString(),
    updated_at: new Date(ended).toISOString(),
    decision_count: decisions,
    player_count: opponents.length + 1,
    event_count: events,
    opponents: opponents.slice(),
    replay_url: `https://aifight.ai/replay/demo-r${n}`,
  };
}

const SESSIONS = [
  // A zombie live session: the match died server-side (deploy restart / cancel)
  // while nothing was listening, so no game_over ever arrived and the store
  // still says "active". Old enough to trip isStaleLiveSession → the History
  // list must show 已中断, not a live chip (owner report 2026-07-28).
  { session_id: "demo-s0", game: "texas_holdem", status: "active", started_at: new Date(Date.now() - 3_900_000).toISOString(), updated_at: new Date(Date.now() - 3_600_000).toISOString(), decision_count: 7, player_count: 2, event_count: 36 },
  demoSession(1, "texas_holdem", "1st place", 2, 29, 41, 164, ["GPT-5", "Kimi K3", "Gemini 3.6 Flash"]),
  demoSession(2, "coup", "3rd place", 7, 14, 18, 57, ["GPT-5", "DeepSeek V4"]),
  demoSession(3, "liars_dice", "1st place", 26, 11, 22, 48, ["GPT-5"]),
  demoSession(4, "texas_holdem", "2nd place", 49, 33, 37, 171, ["Claude Opus", "GPT-5", "Grok 4.5"]),
  demoSession(5, "coup", "draw", 70, 9, 12, 44, ["GPT-5", "Kimi K3", "GLM-5.2"]),
  demoSession(6, "liars_dice", "opponent forfeit", 76, 6, 19, 63, ["DeepSeek V4", "GPT-5"]),
  demoSession(7, "texas_holdem", "1st place", 98, 41, 44, 132, ["GPT-5"]),
  demoSession(8, "coup", "1st place", 121, 12, 15, 49, ["Gemini 3.6 Flash", "GPT-5"]),
  demoSession(9, "liars_dice", "2nd place", 144, 8, 27, 57, ["Claude Opus"]),
  demoSession(10, "texas_holdem", "4th place", 170, 27, 33, 149, ["GPT-5", "Kimi K3", "GLM-5.2"]),
  demoSession(11, "coup", "forfeit", 190, 5, 6, 21, ["GPT-5", "DeepSeek V4"]),
  demoSession(12, "liars_dice", "1st place", 215, 10, 24, 52, ["Grok 4.5"]),
];

function cliResult(json: unknown): CliRunResult {
  return { exitCode: 0, stdout: JSON.stringify(json), stderr: "", json };
}

/**
 * Rebuild a `sessions export` payload from a game fixture so the History
 * detail is fully renderable in the ?demo preview (board + traces + review).
 * The inbound stream is chunked like a real bridge session: each owner
 * decision was provoked by an action_request whose new_events carried
 * everything since the previous request — the decision's own action event
 * arrives with the NEXT one. `interrupted` truncates mid-match and omits
 * game_over (the zombie-session shape).
 */
function demoSessionExport(sessionId: string, game: string, interrupted: boolean): unknown {
  const fx = FIXTURES[game as keyof typeof FIXTURES];
  if (fx === undefined) return { status: "ok" };
  const owner = fx.ownerPlayerId;
  const events = interrupted ? fx.events.slice(0, Math.max(1, Math.floor(fx.events.length * 0.6))) : fx.events;
  // renderer MatchEvent → protocol event (player_id→player, created_at→ts).
  const proto = (e: MatchEvent) => ({
    type: e.type,
    data: e.data,
    seq: e.seq,
    ts: e.created_at,
    ...(e.player_id !== undefined ? { player: e.player_id } : {}),
  });
  // The owner's own private view rides action_request.state in the protocol
  // shapes extractOwnerPrivate reads. Texas deliberately omits your_hand — the
  // fixture already carries a cards_dealt event, and providing it here too
  // would make the reducer inject a duplicate.
  const stateFor = (): Record<string, unknown> => {
    const own = fx.ownerPrivate;
    if (game === "texas_holdem") {
      return {
        ...(own.chips !== undefined ? { your_chips: own.chips } : {}),
        ...(own.position !== undefined ? { your_position: own.position } : {}),
        hand_num: 1,
      };
    }
    if (game === "liars_dice") return own.dice !== undefined ? { your_dice: own.dice.slice() } : {};
    if (game === "coup") {
      return {
        ...(own.influence !== undefined ? { your_cards: own.influence.slice() } : {}),
        ...(own.coins !== undefined ? { coins: own.coins } : {}),
      };
    }
    return {};
  };
  const actionRequest = (chunk: readonly MatchEvent[]) => ({
    at: "",
    direction: "inbound",
    type: "action_request",
    message: {
      type: "action_request",
      data: { match_id: sessionId, timeout_ms: 300_000, state: stateFor(), legal_actions: [], players: [], new_events: chunk.map(proto) },
    },
  });
  const inbound: unknown[] = [
    {
      at: "",
      direction: "inbound",
      type: "game_start",
      message: {
        type: "game_start",
        data: {
          match_id: sessionId,
          game,
          your_position: 0,
          your_player_id: owner,
          players: fx.match.players.map((p) => ({ position: p.position, name: p.agent_name, player_id: p.player_id })),
        },
      },
    },
  ];
  let cursor = 0;
  events.forEach((ev, i) => {
    if (!DECISION_TYPES.has(ev.type) || ev.player_id !== owner) return;
    inbound.push(actionRequest(events.slice(cursor, i)));
    cursor = i;
  });
  if (cursor < events.length) inbound.push(actionRequest(events.slice(cursor)));
  if (!interrupted) {
    inbound.push({
      at: "",
      direction: "inbound",
      type: "game_over",
      message: {
        type: "game_over",
        data: {
          match_id: `demo-real-${sessionId}`,
          session_id: sessionId,
          result: { winner: owner, payoffs: {}, is_draw: false },
          players: fx.match.players.map((p) => ({ player_id: p.player_id, position: p.position, agent_id: p.agent_id, agent_name: p.agent_name })),
          replay_url: "",
        },
      },
    });
  }
  // One decisions[] entry per decision — synthesizeTraces emits a triple
  // (request / runtime / final) per owner decision, in the same order as the
  // action_requests above, so buildReplayFromExport's step re-stamping aligns.
  const stamped = synthesizeTraces(fx.match, events, owner);
  const decisions: unknown[] = [];
  for (let i = 0; i < stamped.length; i += 3) decisions.push({ at: "", kind: "decision", traces: stamped.slice(i, i + 3) });
  return { summary: { session_id: sessionId, game }, inbound, outbound: [], decisions, strategySnapshot: null };
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
    removeLocalIdentity: () => Promise.resolve({ ok: true, status: STATUS }),
    requestMatches: () => Promise.resolve({ ok: true }),
    getLiveGames: () => Promise.resolve(["texas_holdem", "liars_dice", "coup"]),
    getConnectionHealth: () =>
      Promise.resolve({ phase: "running", connectedAt: Date.now() - 3_600_000, reconnects: 0, lastActivityAt: Date.now() - 30_000, lastInboundAt: Date.now() - 45_000 }),
    openClaim: () => Promise.resolve({ ok: true }),
    openDashboard: () => Promise.resolve({ ok: true }),
    acceptLegal: () => Promise.resolve({ ok: true }),
    openLegal: () => Promise.resolve({ ok: true }),
    getAgentProfile: () =>
      Promise.resolve({
        name: "Demo Strategist",
        stats: {
          totalGames: 132, wins: 73, losses: 53, draws: 6, winRate: 0.553,
          rating: 1619, trueRating: 1741, rd: 61, rank: 7, leaderboardEligible: true,
        },
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
    // Demo: the games selection round-trips through the status push like the
    // real host (bridge.json write → readConfigSummary broadcast).
    setAutoGames: (games) => {
      STATUS = { ...STATUS, config: { ...STATUS.config!, autoGames: [...games] } };
      for (const fn of statusListeners) fn(STATUS);
      return Promise.resolve({ ok: true });
    },
    setAgentName: (patch) => {
      demoPolicy = { ...demoPolicy, name: patch.name };
      return Promise.resolve({ ok: true, name: patch.name, publicNo: demoPolicy.publicNo });
    },
    // Demo: the pin round-trips through the status push like the real host does.
    setDeclaredModel: (patch) => {
      const pinned = patch.declaredModel.trim();
      const cfg = { ...STATUS.config! };
      if (pinned !== "") cfg.declaredModel = pinned;
      else delete cfg.declaredModel;
      STATUS = { ...STATUS, config: cfg };
      for (const fn of statusListeners) fn(STATUS);
      return Promise.resolve({ ok: true, effective: pinned !== "" ? pinned : (cfg.profileModel ?? "direct") });
    },
    setAgentAvatar: () => Promise.resolve({ ok: true }),
    clearAgentAvatar: () => Promise.resolve({ ok: true }),
    uploadAgentAvatar: () => Promise.resolve({ ok: true, avatar_url: "" }),
    getLeaderboard: () => Promise.resolve(null),
    getReplayTail: () => Promise.resolve(null),
    getEvents: () => Promise.resolve(null),
    // One open hosted duel so ?demo shows the polled 约战 list (the single
    // place a created challenge appears — owner ruling 2026-08-01).
    getChallenges: () =>
      Promise.resolve([
        {
          id: "demo-duel-1",
          game: "texas_holdem",
          status: "pending",
          isHost: true,
          opponentName: "",
          createdAt: new Date(Date.now() - 8 * 60_000).toISOString(),
          expiresAt: new Date(Date.now() + 22 * 3_600_000).toISOString(),
          maxPlayers: 2,
          seatedCount: 1,
        },
      ]),
    setMatchingPaused: (paused: boolean) => {
      STATUS = { ...STATUS, matchingPaused: paused };
      for (const fn of statusListeners) fn(STATUS);
      return Promise.resolve({ ok: true });
    },
    openConfigDir: () => Promise.resolve(""),
    getLaunchAtLogin: () => Promise.resolve(false),
    setLaunchAtLogin: () => Promise.resolve({ ok: true }),
    focusWindow: () => Promise.resolve(),
    runCli: (op: CliOp) => {
      if (op.kind === "sessionsList") return Promise.resolve(cliResult({ sessions: SESSIONS }));
      if (op.kind === "sessionsExport") {
        const s = SESSIONS.find((x) => x.session_id === op.sessionId);
        return Promise.resolve(cliResult(demoSessionExport(op.sessionId, s?.game ?? "texas_holdem", s?.status === "active")));
      }
      if (op.kind === "status") return Promise.resolve(cliResult({ platformAgentStatus: { kind: "ok", isClaimed: true } }));
      if (op.kind === "challenge") return Promise.resolve(cliResult({ join_url: "https://aifight.ai/challenge/demo-token" }));
      // Self-review settings (Settings tri-state reads autoMode).
      if (op.kind === "configReviewGet")
        return Promise.resolve(cliResult({ agentSlug: "default", selfReview: { autoMode: "off", model: "", maxTurns: null } }));
      // Reasoning-capture setting (Settings on/off toggle).
      if (op.kind === "configReasoningGet")
        return Promise.resolve(cliResult({ agentSlug: "default", captureReasoning: false }));
      if (op.kind === "configReasoningSet")
        return Promise.resolve(cliResult({ agentSlug: "default", captureReasoning: op.enabled }));
      // Post-match self-review — a lively populated review for both the read-only
      // check (no-generate) and the explicit generate, so screenshots are useful.
      if (op.kind === "review")
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
    // A representative current-flagship answer (what the registry returns for
    // claude-opus-5), rather than null — null makes the Models editor render as if
    // every model had no effort tiers, which is not a state the real app produces.
    llmModelCapabilities: () =>
      Promise.resolve({
        efforts: ["low", "medium", "high", "xhigh", "max"],
        protocolEfforts: ["low", "medium", "high", "xhigh", "max"],
        storableEfforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"],
        isKnownModel: true,
        defaultEffort: "high",
        thinkingModes: ["adaptive"],
        thinkingAlwaysOn: false,
        thinkingDefaultOn: true,
        maxOutputTokens: 128000,
      }),
    llmDiscoverModels: () => Promise.resolve(null),
    saveLLMProfile: () => Promise.resolve({ ok: false, error: "demo" }),
    setLLMKey: () => Promise.resolve({ ok: false, error: "demo" }),
    clearLLMKey: () => Promise.resolve({ ok: false, error: "demo" }),
    setLLMActive: () => Promise.resolve({ ok: false, error: "demo" }),
    setLLMRoute: () => Promise.resolve({ ok: false, error: "demo" }),
    deleteLLMProfile: () => Promise.resolve({ ok: false, error: "demo" }),
    onStatus: (fn: (s: BridgeStatus) => void) => {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
    onLog: noopOff,
    onTrace: noopOff,
    onServerMessage: noopOff,
    onMatchEvents: noopOff,
    onNavigate: noopOff,
    getUsageOverview: () => Promise.resolve(USAGE),
    checkForUpdates: () => Promise.resolve(),
    downloadUpdate: () => Promise.resolve(),
    installUpdate: () => Promise.resolve(),
    getAutoUpdate: () => Promise.resolve(false),
    setAutoUpdate: () => Promise.resolve({ ok: true }),
    onUpdateStatus: noopOff,
  };
  Object.defineProperty(window, "aifight", { value: api, configurable: true });
}
