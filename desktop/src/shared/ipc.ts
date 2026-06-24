// D3 — the typed IPC contract shared by the three worlds: main (ipc.ts),
// preload (preload.ts), and renderer (window.aifight). It is deliberately
// SELF-CONTAINED: no electron and no runtime imports. That keeps the renderer's
// type program free of the runtime engine source (which would otherwise be
// pulled in by a type-only import and trip the renderer's strict tsconfig).
//
// IPC payloads are plain JSON crossing a structured-clone boundary. Each side
// declares its own view of the shape; the types here are the renderer-facing
// contract. Engine-specific payloads that the renderer does not render yet
// (decision traces, raw server messages) are typed `unknown` until the cockpit
// (D6) gives them concrete renderer-side types.

export type BridgeHostPhase =
  | "idle"
  | "unconfigured"
  | "starting"
  | "running"
  | "stopped"
  | "error";

/** Secret-free projection of bridge.json. NEVER carries apiKey / tokens. */
export interface BridgeConfigSummary {
  readonly agentId: string;
  readonly agentName: string;
  readonly baseUrl: string;
  readonly runtimeType: string;
  readonly directAgentSlug?: string;
  readonly autoDailyLimit?: number;
  readonly autoGames?: readonly string[];
}

export interface BridgeStatus {
  readonly phase: BridgeHostPhase;
  readonly message?: string;
  readonly config?: BridgeConfigSummary;
}

/**
 * Live health of the outbound long-lived WebSocket (D11.1) — proof the connection
 * is alive. All epoch-ms timestamps are from the main process; the renderer ticks
 * "online for …" locally. reconnects = count of reconnect attempts this session.
 */
export interface ConnectionHealth {
  readonly phase: BridgeHostPhase;
  readonly connectedAt: number | null;
  readonly reconnects: number;
  readonly lastActivityAt: number | null;
}

/**
 * The agent's rate policy as the SERVER holds it (source of truth; reflects
 * Dashboard edits). The desktop reads this to stay consistent and writes changes
 * back via setAgentPolicy (last-write-wins). cap 0 = auto-match disabled.
 */
export interface AgentPolicy {
  readonly maxGamesPerDay: number;
  readonly maxGamesPerHour: number;
  readonly cooldownSeconds: number;
  readonly isClaimed: boolean;
  /** True when the claimed owner must accept the current Terms/Privacy (server terms_pending). Accept on the dashboard; agent play continues meanwhile. */
  readonly termsPending: boolean;
  /** Matches played in the current 24h window. undefined on older servers (pre games_today). */
  readonly gamesToday?: number;
  /** Server-authoritative display name (reflects a rename from any device). undefined on older servers. */
  readonly name?: string;
  /** Immutable 10-digit numeric public ID. undefined/0 when unassigned or on older servers. */
  readonly publicNo?: number;
  /** Current Terms version the server expects acceptance of. undefined on older servers. */
  readonly currentTermsVersion?: string;
  /** Current Privacy Policy version the server expects acceptance of. undefined on older servers. */
  readonly currentPrivacyVersion?: string;
}

/** Public win/loss record + rating for the user's own agent (from the public profile). */
export interface AgentStats {
  readonly totalGames: number;
  readonly wins: number;
  readonly losses: number;
  readonly draws: number;
  /** 0..1 fraction. */
  readonly winRate: number;
  /** Aggregate Glicko-2 rating; null until enough rated games. */
  readonly rating: number | null;
  /** Global cross-game rank; null until leaderboard-eligible. */
  readonly rank: number | null;
  readonly leaderboardEligible: boolean;
}

/** The agent's public identity + record. name is null while unclaimed (no public profile yet). */
export interface AgentProfileData {
  readonly name: string | null;
  readonly stats: AgentStats | null;
}

export interface BridgeLogEvent {
  readonly level: "info" | "warning" | "error";
  readonly code: string;
  readonly message: string;
}

/** A legal/chosen action as it appears in a trace (structural mirror of the runtime's LegalAction). */
export interface TraceAction {
  readonly type: string;
  readonly data?: Record<string, unknown>;
}

/**
 * Renderer-side mirror of the runtime's BridgeDecisionTrace (bridge/provider.ts).
 * The cockpit (D6) renders this stream as "what my agent is thinking": how many
 * legal actions it faced, the model's raw output preview, and the final action
 * it took (from the runtime, or a safety fallback).
 */
export type BridgeDecisionTrace =
  | {
      readonly type: "decision_request";
      readonly matchId: string;
      readonly game: string;
      readonly playerId?: string;
      readonly legalActionCount: number;
      readonly timeoutMs: number;
    }
  | {
      readonly type: "runtime_success";
      readonly matchId: string;
      readonly attempt: number;
      readonly raw: { readonly kind: string; readonly sha256: string; readonly bytes: number; readonly preview: string };
    }
  | { readonly type: "runtime_failure"; readonly matchId: string; readonly attempt: number; readonly error: string }
  | { readonly type: "strategy_error"; readonly matchId: string; readonly error: string }
  | {
      readonly type: "final_action";
      readonly matchId: string;
      readonly source: "runtime" | "fallback";
      readonly reason?: string;
      readonly action: TraceAction;
    };

/** Result of running an `aifight` CLI command in-process (main wraps the CLI's run()). */
export interface CliRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Parsed JSON when the command emitted a JSON envelope (run with --json). */
  readonly json?: unknown;
  /** Set when the desktop rejected the call before running (e.g. command not allowed). */
  readonly error?: string;
}

/**
 * The games THIS BUILD knows how to RENDER (board / own-hand / private-state
 * views). NOT the live-game allow-list — that comes from the backend at runtime
 * (shared/games.ts → bridge-host cache → games:get). A live game outside this
 * union still plays and lists fine; it just degrades to the generic cockpit.
 * Widen only when the desktop gains rendering support for a new game.
 */
export type Game = "texas_holdem" | "liars_dice" | "coup";

// ── Leaderboard (ranking board) ──────────────────────────────────────────────
// Public, no-auth read of the platform's Glicko-2 ranking. "all" = the cross-game
// aggregate board; a game name = that game's board. The main process fetches the
// public endpoint and normalizes the two differently-shaped server payloads into
// these rows, so the renderer just renders.

/** "all" or any live game name (the scope list follows the backend's live list). */
export type LeaderboardScope = "all" | Game | (string & {});

export interface LeaderboardRow {
  readonly rank: number;
  readonly agentId: string;
  readonly agentName: string;
  readonly model: string | null;
  /** Display rating (per-game display_rating, or cross-game aggregate_rating), rounded. */
  readonly rating: number;
  readonly games: number;
  readonly wins: number;
  readonly losses: number;
  readonly draws: number;
  /** 0..1 fraction. */
  readonly winRate: number;
}

export interface LeaderboardData {
  readonly scope: LeaderboardScope;
  readonly rows: LeaderboardRow[];
}

// ── Events (赛事活动) ─────────────────────────────────────────────────────────
// Public, no-auth read of the platform's events. The desktop lists them; viewing
// full standings + registering happens on the web (event registration is an
// account-level / owner-JWT action, so the desktop deep-links to the web event
// page rather than carrying the owner session — consistent with the cockpit's
// "account actions live on the Dashboard" boundary).

export interface EventCard {
  readonly slug: string;
  readonly title: string;
  readonly subtitle: string;
  /** Activity kind (grand_prix / season / ladder / …). Renderer maps to a localized label. */
  readonly eventType: string;
  /** Raw lifecycle status (draft/published/active/settling/completed/archived/cancelled). */
  readonly status: string;
  readonly games: readonly string[];
  readonly prizeSummary: string;
  readonly participantCount: number;
  readonly registrationEndsAt: string | null;
  readonly playStartsAt: string | null;
  readonly playEndsAt: string | null;
}

export interface EventsData {
  readonly events: EventCard[];
}

// ── Strategy editor (D8.5) ───────────────────────────────────────────────────
// The agent's own free-text strategy guidance (Markdown). The runtime injects
// these files into the LLM prompt during real matches (decision_request.strategy
// sections), so editing them here changes how YOUR agent plays. Files live under
// the unified AIFight home via the runtime's resolveLocalStrategyPaths — the
// desktop never hardcodes paths. Empty files are skipped during matches.

/** "global" applies to every game; each LIVE game (backend-fed list) overrides per-game. */
export type StrategyScope = "global" | Game | (string & {});

export interface StrategyDoc {
  readonly scope: StrategyScope;
  readonly path: string;
  readonly content: string;
  readonly bytes: number;
  readonly exists: boolean;
}

export interface StrategyReadResult {
  readonly agentId?: string;
  readonly docs: StrategyDoc[];
  /** Max bytes per file (writes beyond this are rejected). */
  readonly maxBytes: number;
  /** Set when the bridge isn't configured yet (no agent to resolve paths for). */
  readonly error?: string;
}

export interface StrategyWriteResult {
  readonly ok: boolean;
  readonly bytes?: number;
  readonly error?: string;
}

// ── Graphical LLM config editor (D8.6) ───────────────────────────────────────
// The desktop edits the SAME agent config the CLI uses (agents/<slug>/config.json)
// so the app is fully standalone — no CLI needed. Keys are never returned (only
// their SOURCE + resolvability); pasted keys are written to a 0600 file in main.

/**
 * The 4 API protocol families the UI organizes around. DeepSeek and other
 * OpenAI-compatible providers live under "openai_chat"; config-host resolves a
 * family + model/endpoint to the concrete runtime adapter.
 */
export type ProtocolFamily = "anthropic" | "openai_chat" | "openai_responses" | "gemini";

/** One LLM provider profile, secret-free (for display/editing). */
export interface ConfigProfileView {
  readonly id: string;
  readonly displayName: string;
  /** The 4-family bucket (what the UI shows). */
  readonly family: ProtocolFamily;
  /** The concrete runtime adapter protocol (detail, e.g. deepseek_chat_completions). */
  readonly protocol: string;
  readonly model: string;
  readonly baseURL: string | null;
  /** e.g. "file:/…/keys/x.key" or "env:ANTHROPIC_API_KEY" — never the value. */
  readonly keySource: string;
  readonly keyResolvable: boolean;
  readonly thinkingEnabled: boolean;
  readonly effort: string | null;
  readonly temperature: number | null;
  readonly maxTokens: number;
  readonly stream: "auto" | "always" | "never";
  readonly verbosity: string | null;
  /** Model-specific opt-in feature flags (e.g. { jsonObjectMode: true } for DeepSeek V4). */
  readonly features: Record<string, boolean>;
}

export interface ConfigView {
  readonly configured: boolean;
  readonly slug: string;
  readonly activeProfile: string;
  readonly routing: { readonly default: string; readonly byGame?: Record<string, string> };
  readonly profiles: ConfigProfileView[];
}

/** Editable profile fields (everything except the API key, which has its own call). */
export interface ProfileInput {
  readonly profileId: string;
  readonly displayName?: string;
  /** Protocol family; config-host resolves it + model/endpoint to a concrete adapter. */
  readonly family: ProtocolFamily;
  readonly model: string;
  readonly baseURL?: string;
  readonly thinkingEnabled: boolean;
  readonly effort?: string;
  readonly temperature?: number | null;
  readonly maxTokens?: number;
  readonly stream?: "auto" | "always" | "never";
  readonly verbosity?: string;
  /** Model-specific opt-in feature flags (e.g. { jsonObjectMode: true }). */
  readonly features?: Record<string, boolean>;
}

export interface ConfigMutResult {
  readonly ok: boolean;
  readonly error?: string;
}

// ── Raw protocol server messages (D6.5) ──────────────────────────────────────
// Minimal, renderer-facing mirrors of the bridge WebSocket protocol — only the
// fields the cockpit reads. Kept structural and self-contained (no runtime
// import). The runtime has already ajv-validated every server frame against
// protocol/schema/messages/* BEFORE forwarding it here, so liveMatch.ts may
// switch on `type` and cast the envelope's `data` to the matching interface.

/**
 * One engine event, as it arrives in action_request.new_events / event_history.
 * Mirrors common/event.schema.json — note the field is `player` (not player_id)
 * and the timestamp is `ts` (not created_at); liveMatch.ts maps both to the
 * renderer's MatchEvent shape.
 */
export interface ProtocolEvent {
  readonly type: string;
  readonly player?: string;
  readonly data?: Record<string, unknown>;
  readonly seq?: number;
  readonly ts?: string;
}

/** Public, anonymized per-player view (common/player_info.schema.json). */
export interface ProtocolPlayerInfo {
  readonly id: string;
  readonly name?: string;
  readonly status?: string;
  readonly data?: Record<string, unknown>;
}

/** game_start.data — a match begins: your seat + the anonymized roster. */
export interface GameStartData {
  /** Per-player session id (opaque UUID). NOT the server's real match id. */
  readonly match_id: string;
  readonly game: Game;
  readonly your_position: number;
  readonly your_player_id: string;
  readonly strategy_prompt?: string;
  readonly players: ReadonlyArray<{
    readonly position: number;
    readonly name: string;
    readonly player_id: string;
  }>;
}

/**
 * action_request.data — your turn. `state` carries public + private-to-you
 * fields (your_hand / your_dice / your_cards); `new_events` is the incremental
 * event log since your last turn (full history in `event_history` on reconnect).
 */
export interface ActionRequestData {
  readonly match_id: string;
  readonly state: Record<string, unknown>;
  readonly players?: ReadonlyArray<ProtocolPlayerInfo>;
  readonly new_events?: ReadonlyArray<ProtocolEvent> | null;
  readonly event_history?: ReadonlyArray<ProtocolEvent>;
  readonly is_reconnect?: boolean;
}

/** game_state.data — reconnect snapshot delivered when it is NOT your turn. */
export interface GameStateData {
  readonly match_id: string;
  readonly state: Record<string, unknown>;
  readonly players?: ReadonlyArray<ProtocolPlayerInfo>;
}

/** game_over.data — match end. Real identities + canonical result disclosed here. */
export interface GameOverData {
  readonly match_id: string;
  readonly session_id: string;
  readonly result?: {
    readonly payoffs?: Record<string, number>;
    readonly winner?: string;
    readonly is_draw?: boolean;
  };
  readonly players?: ReadonlyArray<{
    readonly player_id: string;
    readonly position: number;
    readonly agent_id: string;
    readonly agent_name: string;
  }>;
  readonly replay_url?: string;
}

/**
 * The raw protocol envelope forwarded over IPC (mirror of the runtime's
 * ServerMessageEnvelope). `data` is `unknown`; liveMatch.ts narrows on `type`
 * then casts to the matching *Data interface above.
 */
export interface ServerMessage {
  readonly type: string;
  readonly data?: unknown;
  readonly match_id?: string;
}

// ── Local token usage (§7A) ──────────────────────────────────────────────────
// Read-only aggregation of the LOCAL usage ledger (~/.aifight/usage/YYYY-MM.jsonl,
// written by the bridge during matches). Costs are estimated from the user's own
// price table (aifight prices) and NEVER leave the machine — the desktop only
// renders them.

/** One aggregation bucket, IPC-safe (the runtime's Set of match ids → a count). */
export interface UsageBucketDTO {
  /** Model name, or "total". */
  readonly key: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cachedTokens: number;
  /** Estimated cost over PRICED calls only; undefined when no call was priced. */
  readonly estimatedCost?: number;
  readonly unpricedCalls: number;
  /** Distinct matches contributing to this bucket. */
  readonly matches: number;
}

export interface UsageOverview {
  /** Current calendar month (local time). */
  readonly month: { readonly total: UsageBucketDTO; readonly byModel: readonly UsageBucketDTO[] };
  /** Today, since local midnight. */
  readonly today: { readonly total: UsageBucketDTO };
  /** Currency symbol from the local price table (default "$"). */
  readonly currency: string;
  /** True when at least one model has a configured price (costs displayable). */
  readonly hasPrices: boolean;
}

// ── Auto-update (electron-updater) ───────────────────────────────────────────
// The updater's lifecycle, flattened into one status the renderer renders in
// Settings → About. Only live in packaged builds with a publish feed; in dev a
// check reports "not-available" rather than erroring.
export type UpdateStatus =
  | { readonly state: "idle" }
  | { readonly state: "checking" }
  | { readonly state: "available"; readonly version: string }
  | { readonly state: "not-available" }
  | { readonly state: "downloading"; readonly percent: number }
  | { readonly state: "downloaded"; readonly version: string }
  | { readonly state: "error"; readonly message: string };

/** Channel names. Renderer→main are `invoke` (request/response); main→renderer are `send` (events). */
export const IPC = {
  // renderer → main (invoke)
  getStatus: "bridge:get-status",
  start: "bridge:start",
  stop: "bridge:stop",
  requestMatches: "bridge:request-matches",
  gamesGet: "games:get",
  getConnection: "bridge:get-connection",
  getProfile: "bridge:get-profile",
  getProfileRaw: "bridge:get-profile-raw",
  getPolicy: "bridge:get-policy",
  setPolicy: "bridge:set-policy",
  setAgentName: "bridge:set-agent-name",
  avatarSet: "avatar:set",
  avatarClear: "avatar:clear",
  avatarUpload: "avatar:upload",
  leaderboardGet: "leaderboard:get",
  eventsGet: "events:get",
  openClaim: "bridge:open-claim",
  openDashboard: "app:open-dashboard",
  acceptLegal: "bridge:accept-legal",
  openLegal: "app:open-legal",
  setMatchingPaused: "matching:set-paused",
  loginItemGet: "login-item:get",
  loginItemSet: "login-item:set",
  focusWindow: "app:focus",
  openConfigDir: "app:open-config-dir",
  cliRun: "cli:run",
  strategyRead: "strategy:read",
  strategyWrite: "strategy:write",
  configGet: "config:get",
  configSaveProfile: "config:save-profile",
  configSetKey: "config:set-key",
  configClearKey: "config:clear-key",
  configSetActive: "config:set-active",
  configSetRoute: "config:set-route",
  configDeleteProfile: "config:delete-profile",
  usageGet: "usage:get",
  updateCheck: "update:check",
  updateInstall: "update:install",
  // main → renderer (send)
  status: "bridge:status",
  log: "bridge:log",
  trace: "bridge:trace",
  serverMessage: "bridge:server-message",
  navigate: "app:navigate",
  updateStatus: "update:status",
} as const;

/**
 * The minimal, typed surface preload exposes on `window.aifight`. The renderer
 * may ONLY touch the main process through this — never Node, never ipcRenderer
 * directly. Each `on*` returns an unsubscribe function.
 */
export interface AifightBridgeApi {
  readonly version: string;
  /** Host OS (process.platform, e.g. "darwin"). Static, non-sensitive — lets the
   *  renderer reserve space for the macOS traffic-light buttons. */
  readonly platform: string;
  getStatus(): Promise<BridgeStatus>;
  start(): Promise<BridgeStatus>;
  stop(): Promise<BridgeStatus>;
  /** Request N manual ranked matches through the in-process bridge (must be online). Manual = unlimited (not subject to the daily cap). The SERVER validates that the game is live. */
  requestMatches(game: string, count: number): Promise<{ ok: boolean; error?: string }>;
  /** The platform's CURRENT live games, in canonical order (backend is the single
   * source; cached in main from the welcome frame / GET /api/games; falls back to
   * the last-resort local list only while the platform hasn't answered). */
  getLiveGames(): Promise<readonly string[]>;
  /** Live connection-health for the diagnostics panel (uptime / last activity / reconnects). */
  getConnectionHealth(): Promise<ConnectionHealth>;
  /** Open this agent's claim page in the browser (to claim it + set a public name). */
  openClaim(): Promise<{ ok: boolean }>;
  /** Open the owner Dashboard in the system browser already logged in (passwordless
   * SSO via a one-time agent-key handoff token). Falls back to the bare dashboard
   * (login page) when the agent isn't claimed or the handoff fails. */
  openDashboard(): Promise<{ ok: boolean; error?: string }>;
  /** Record the owner's acceptance of the current Terms/Privacy in-app (no browser),
   * via the agent key. The server consents for the agent's own owner. */
  acceptLegal(): Promise<{ ok: boolean; error?: string }>;
  /** Open the public Terms or Privacy Policy page on the paired host in the browser,
   * so the user can read the full document before accepting in-app. */
  openLegal(kind: "terms" | "privacy"): Promise<{ ok: boolean }>;
  /** The agent's public identity + record (post-claim). name null while unclaimed; stats null without a public profile. */
  getAgentProfile(): Promise<AgentProfileData>;
  /** The OWN agent's FULL public profile JSON (ratings[], rating_history[], summary,
   * ranking, …) for the rich home view. Returned verbatim (renderer casts to the
   * @aifight/api-types AgentProfile). Null when unclaimed / on error. No auth. */
  getOwnProfileRaw(): Promise<Record<string, unknown> | null>;
  /** Read the agent's current rate policy from the server (source of truth). Null on error. */
  getAgentPolicy(): Promise<AgentPolicy | null>;
  /** Write the daily auto-match cap to the server (last-write-wins). The desktop's
   * only rate knob — hourly cap is gone; cooldown is a server default (Dashboard-set). */
  setAgentPolicy(patch: { maxGamesPerDay: number }): Promise<{ ok: boolean; error?: string }>;
  /** Change the agent's free-form display name (agent-key PATCH /api/agents/me/name).
   * Server is the source of truth; returns the reconciled name + numeric public ID.
   * On the rename cooldown it returns ok:false with the server message + nextRenameAllowedAt. */
  setAgentName(patch: { name: string }): Promise<{ ok: boolean; error?: string; name?: string; publicNo?: number; nextRenameAllowedAt?: string }>;
  /** Set the agent's avatar to a built-in preset id (or pass null to clear). Bridge-key auth. */
  setAgentAvatar(presetId: string | null): Promise<{ ok: boolean; error?: string }>;
  /** Clear the agent's avatar (preset or upload) back to the deterministic default. */
  clearAgentAvatar(): Promise<{ ok: boolean; error?: string }>;
  /** Upload a custom avatar image (server center-crops + resizes). Returns the resolved URL. */
  uploadAgentAvatar(bytes: ArrayBuffer, contentType: string): Promise<{ ok: boolean; avatar_url?: string; error?: string }>;
  /** Public ranking board for a scope ("all" = cross-game). Null on error. No auth. */
  getLeaderboard(scope: LeaderboardScope): Promise<LeaderboardData | null>;
  /** Public list of events (赛事). Null on error. No auth; registration is deep-linked to the web. */
  getEvents(): Promise<EventsData | null>;
  /** Pause/resume automatic matchmaking without going offline. Session-only (resets to un-paused each launch). */
  setMatchingPaused(paused: boolean): Promise<{ ok: boolean; error?: string }>;
  /** Open the shared AIFight config folder (~/.aifight) in the OS file manager. Returns "" on success. */
  openConfigDir(): Promise<string>;
  /** Whether the app is set to launch at OS login. */
  getLaunchAtLogin(): Promise<boolean>;
  /** Enable/disable launching the app at OS login (default off). */
  setLaunchAtLogin(enabled: boolean): Promise<{ ok: boolean; error?: string }>;
  /** Bring the app window to the foreground (used when an OS match notification is clicked). */
  focusWindow(): Promise<void>;
  /** Run an `aifight` CLI command in-process (register/connect/config/set/challenge/accept/status/…). */
  cliRun(args: string[]): Promise<CliRunResult>;
  /** Read the agent's own strategy docs (global + per-game). Reads the SAME files the runtime injects in matches. */
  readStrategy(): Promise<StrategyReadResult>;
  /** Write one strategy doc (Markdown). Local file only; rejected if not configured or over the size cap. */
  writeStrategy(scope: StrategyScope, content: string): Promise<StrategyWriteResult>;
  // Graphical LLM config (standalone — no CLI). Keys never returned; setKey takes
  // the raw key over IPC (structured clone, not argv) and stores it 0600.
  getLLMConfig(): Promise<ConfigView>;
  saveLLMProfile(input: ProfileInput): Promise<ConfigMutResult>;
  setLLMKey(profileId: string, apiKey: string): Promise<ConfigMutResult>;
  /** Remove a profile's stored API key (deletes the 0600 key file, resets the ref). */
  clearLLMKey(profileId: string): Promise<ConfigMutResult>;
  setLLMActive(profileId: string): Promise<ConfigMutResult>;
  setLLMRoute(game: string, profileId: string): Promise<ConfigMutResult>;
  deleteLLMProfile(profileId: string): Promise<ConfigMutResult>;
  onStatus(listener: (status: BridgeStatus) => void): () => void;
  onLog(listener: (event: BridgeLogEvent) => void): () => void;
  onTrace(listener: (trace: BridgeDecisionTrace) => void): () => void;
  // Raw protocol server frames (game_start / action_request / game_state /
  // game_over / …). liveMatch.ts (D6.5) folds these into the renderer's match
  // model, surfacing ONLY the owner's own private info.
  onServerMessage(listener: (message: ServerMessage) => void): () => void;
  /** Main asks the renderer to switch to a view (from the app menu — e.g. Preferences ⌘,). */
  onNavigate(listener: (view: string) => void): () => void;
  /** Aggregated LOCAL token usage (month + today) from the §7A ledger. Costs come
   * from the user's own price table and never leave this machine. Null on error. */
  getUsageOverview(): Promise<UsageOverview | null>;
  /** Manually check for an app update (electron-updater). Progress arrives via onUpdateStatus. */
  checkForUpdates(): Promise<void>;
  /** Quit and install a downloaded update (after onUpdateStatus reports "downloaded"). */
  installUpdate(): Promise<void>;
  /** Subscribe to the auto-update lifecycle (checking / available / downloading / downloaded / error). */
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void;
}
