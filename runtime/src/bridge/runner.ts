import { AgentInstance, type AgentInstanceSnapshot } from "../agents/agent";
import { getDeviceId } from "../account/device-id";
import { WSDeviceMismatchError } from "../wsclient/errors";
import type { ReconnectingWSClientOptions } from "../wsclient/reconnect";
import type { ServerMessageEnvelope } from "../wsclient/frame-handler";
import { PROTOCOL_VERSION } from "../index";
import type { MsgGameOver } from "../protocol/types";
import { loadLocalStrategy } from "../strategy/local-strategy";
import {
  createLocalMatchSessionStore,
  type LocalMatchSessionStore,
} from "../session/local-match-session-store";
import type { AgentDecisionProvider } from "../agents/agent";
import type { BridgeConfig } from "./config";
import {
  buildBridgeDecisionProvider,
  createMockRuntimeProvider,
  type BridgeDecisionTrace,
  type BridgeRuntimeProvider,
} from "./provider";
import { createDirectLLMRuntimeProvider } from "./direct-llm-provider";
import { appendUsageRecord } from "../usage/usage-log";
import { loadAgentProfile, resolveAgentDir } from "../profile/profile-loader";
import { runSelfReview } from "../review/self-review";
import type { LLMConfig } from "../profile/config-schema";

export interface BridgeRunnerOptions {
  readonly config: BridgeConfig;
  readonly runtimeProvider?: BridgeRuntimeProvider;
  readonly autoJoinGame?: "texas_holdem" | "liars_dice" | "coup";
  readonly autoJoinMode?: string;
  readonly autoJoinOneShot?: boolean;
  readonly connect?: ConstructorParameters<typeof AgentInstance>[0]["connect"];
  readonly onLog?: (event: BridgeRunnerLogEvent) => void;
  /** Optional live forward of decision traces (e.g. the desktop cockpit). Session persistence is unaffected. */
  readonly onTrace?: (trace: BridgeDecisionTrace) => void;
  /** Optional live forward of raw server messages (match events, lifecycle) for the desktop cockpit. Session persistence is unaffected. */
  readonly onServerMessage?: (message: ServerMessageEnvelope) => void;
  readonly sessionStore?: LocalMatchSessionStore | false;
}

export interface BridgeRunnerLogEvent {
  readonly level: "info" | "warning" | "error";
  readonly code: string;
  readonly message: string;
}

/** Thrown by BridgeRunner.start() when the server rejects this device — the
 *  agent's credential is bound to a different machine. Carries an actionable
 *  message that the desktop ("error" status) and CLI surface verbatim. */
export class BridgeDeviceMismatchError extends Error {
  readonly code = "device_mismatch" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "BridgeDeviceMismatchError";
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

const DEVICE_MISMATCH_MESSAGE = [
  "This agent is locked to a different machine.",
  "For your security, an AIFight agent can only be controlled from the machine it was set up on.",
  "",
  'To control it from this machine: open the Dashboard, go to your agent → "Connect Bridge",',
  "copy the pairing code, then run:",
  "  aifight connect <PAIRING_CODE>",
  "",
  "This moves the agent here and signs the old machine out.",
  "(If this agent isn't claimed yet, claim it from its claim link first, then pair.)",
].join("\n");

/** Walk an error's `cause` chain looking for a device-mismatch (403) rejection. */
function isDeviceMismatchError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 8 && cur != null; depth++) {
    if (cur instanceof WSDeviceMismatchError) return true;
    if (cur instanceof Error && cur.message.includes("device_mismatch")) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

export class BridgeRunner {
  readonly #opts: BridgeRunnerOptions;
  #agent: AgentInstance | null = null;
  #manualSeries: {
    readonly game: "texas_holdem" | "liars_dice" | "coup";
    readonly mode?: string;
    remainingAfterCurrent: number;
  } | null = null;

  constructor(opts: BridgeRunnerOptions) {
    this.#opts = opts;
  }

  async start(): Promise<AgentInstanceSnapshot> {
    if (this.#agent !== null) return this.#agent.snapshot();

    const provider = this.#opts.runtimeProvider ?? providerForConfig(this.#opts.config);
    const sessionStore = this.#createSessionStore();
    const ws: ReconnectingWSClientOptions = {
      url: this.#opts.config.wsUrl,
      apiKey: this.#opts.config.apiKey,
      deviceId: getDeviceId(),
      expectedProtocolVersion: PROTOCOL_VERSION,
    };

    const agent = new AgentInstance({
      name: this.#opts.config.agentName,
      ws,
      autoConfirmMatches: true,
      decisionProvider: this.#buildDecisionProvider(provider, sessionStore),
      ...(this.#opts.connect !== undefined ? { connect: this.#opts.connect } : {}),
      onServerMessage: (message) => {
        this.#opts.onServerMessage?.(message);
        if (sessionStore === null) return;
        this.#recordSession(() => sessionStore.recordServerMessage(this.#opts.config, message));
      },
      onClientMessage: (message) => {
        if (sessionStore === null) return;
        this.#recordSession(() => sessionStore.recordClientMessage(this.#opts.config, message));
      },
      onReadinessCheck: async (data) => this.#buildRuntimeStatus(provider, data),
      onNotify: (event) => {
        this.#log(event.level, event.code, event.message);
      },
      onResult: (gameOver, context) => {
        this.#log(
          "info",
          "bridge.match_complete",
          formatMatchComplete(this.#opts.config, gameOver, context.game),
        );
        this.#continueManualSeries();
        this.#maybeAutoReview(gameOver, sessionStore);
      },
      onFallbackRequired: (effect) => {
        this.#log(
          "warning",
          "bridge.fallback_required",
          `No action sent for match ${effect.actionRequest.data.match_id}; runtime decision failed`,
        );
      },
    });

    this.#agent = agent;
    let snapshot: AgentInstanceSnapshot;
    try {
      snapshot = await agent.start();
    } catch (err) {
      if (isDeviceMismatchError(err)) {
        // Reset so a re-pair (`aifight connect`) + restart can succeed.
        this.#agent = null;
        this.#log("error", "bridge.device_mismatch", DEVICE_MISMATCH_MESSAGE);
        throw new BridgeDeviceMismatchError(DEVICE_MISMATCH_MESSAGE, { cause: err });
      }
      throw err;
    }
    this.#log("info", "bridge.connected", `Connected ${this.#opts.config.agentName}`);
    void this.#warnIfTermsPending();
    if (this.#opts.autoJoinGame) {
      const oneShot = this.#opts.autoJoinOneShot === true;
      agent.joinQueue(this.#opts.autoJoinGame, this.#opts.autoJoinMode, { oneShot });
      this.#log(
        "info",
        "bridge.queue_joined",
        oneShot
          ? `Joined ${this.#opts.autoJoinGame} for one manual match`
          : `Joined ${this.#opts.autoJoinGame} for daily automatic matching`,
      );
    }
    return snapshot;
  }

  /**
   * One-shot, non-blocking check at connect: if the claimed owner still needs to
   * accept the current Terms/Privacy (server terms_pending), surface a gentle
   * notice pointing at the browser dashboard. Agent play is unaffected; the call
   * is best-effort and never throws or blocks the run.
   */
  async #warnIfTermsPending(): Promise<void> {
    try {
      const base = this.#opts.config.baseUrl.replace(/\/+$/, "");
      const res = await fetch(`${base}/api/agents/me/status`, {
        headers: { "X-API-Key": this.#opts.config.apiKey },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return;
      const body = (await res.json().catch(() => null)) as { terms_pending?: unknown } | null;
      if (body !== null && body.terms_pending === true) {
        this.#log(
          "warning",
          "bridge.terms_pending",
          `Updated Terms/Privacy must be accepted to keep your agent active. Accept in the CLI: \`aifight accept-terms\` (or in the browser: ${base}/dashboard).`,
        );
      }
    } catch {
      // Best-effort: never block or fail the run on this notice.
    }
  }

  async stop(): Promise<void> {
    if (this.#agent === null) return;
    await this.#agent.stop("bridge stop");
    this.#agent = null;
    this.#manualSeries = null;
  }

  snapshot(): AgentInstanceSnapshot | null {
    return this.#agent?.snapshot() ?? null;
  }

  joinQueue(
    game: "texas_holdem" | "liars_dice" | "coup",
    mode?: string,
    opts: { readonly oneShot?: boolean; readonly count?: number } = {},
  ): void {
    if (opts.oneShot === true || (opts.count ?? 1) > 1) {
      this.requestManualMatches(game, mode, opts.count ?? 1);
      return;
    }
    const agent = this.#requireAgent();
    agent.joinQueue(game, mode);
    this.#log(
      "info",
      "bridge.queue_joined",
      `Joined ${game} for ${mode ?? "default"} matching`,
    );
  }

  leaveQueue(): void {
    const agent = this.#requireAgent();
    this.#manualSeries = null;
    agent.leaveQueue();
  }

  requestManualMatches(
    game: "texas_holdem" | "liars_dice" | "coup",
    mode = "ranked",
    count = 1,
  ): void {
    if (!Number.isInteger(count) || count < 1 || count > 20) {
      throw new Error("manual match count must be an integer between 1 and 20");
    }
    const agent = this.#requireAgent();
    const phase = agent.snapshot().state?.phase;
    if (
      phase === "confirming" ||
      phase === "matching" ||
      phase === "in_match" ||
      phase === "deciding" ||
      phase === "reporting"
    ) {
      throw new Error("agent is already in or entering a match; try again after the current match completes");
    }
    this.#manualSeries = count > 1
      ? { game, mode, remainingAfterCurrent: count - 1 }
      : null;
    agent.joinQueue(game, mode, { oneShot: true });
    this.#log(
      "info",
      "bridge.queue_joined",
      count === 1
        ? `Joined ${game} for one manual match`
        : `Joined ${game} for ${count} manual matches`,
    );
  }

  #log(level: BridgeRunnerLogEvent["level"], code: string, message: string): void {
    this.#opts.onLog?.({ level, code, message });
  }

  #createSessionStore(): LocalMatchSessionStore | null {
    if (this.#opts.sessionStore === false) return null;
    if (this.#opts.sessionStore !== undefined) return this.#opts.sessionStore;
    try {
      return createLocalMatchSessionStore();
    } catch (cause) {
      this.#log(
        "warning",
        "bridge.session_store_unavailable",
        `Local match session ledger is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return null;
    }
  }

  #buildDecisionProvider(
    provider: BridgeRuntimeProvider,
    sessionStore: LocalMatchSessionStore | null,
  ): AgentDecisionProvider {
    return {
      decide: async (ctx) => {
        const traces: BridgeDecisionTrace[] = [];
        const startedAt = new Date();
        const decisionProvider = buildBridgeDecisionProvider(provider, {
          loadStrategy: ({ game }) => loadLocalStrategy(this.#opts.config.agentId, game),
          onTrace: (trace) => {
            traces.push(trace);
            this.#opts.onTrace?.(trace);
          },
          ...(this.#opts.config.illegalRetryCount !== undefined
            ? { illegalRetryCount: this.#opts.config.illegalRetryCount }
            : {}),
          // §7A local usage ledger: one JSONL line per model call, written on
          // the user's machine only. appendUsageRecord is silent on failure —
          // stats must never affect play.
          onUsage: (e) => {
            appendUsageRecord({
              ts: new Date().toISOString(),
              match_id: e.matchId,
              game: e.game,
              provider: e.usage.provider,
              model: e.usage.model,
              ...(e.usage.inputTokens !== undefined ? { input_tokens: e.usage.inputTokens } : {}),
              ...(e.usage.outputTokens !== undefined ? { output_tokens: e.usage.outputTokens } : {}),
              ...(e.usage.reasoningTokens !== undefined
                ? { reasoning_tokens: e.usage.reasoningTokens }
                : {}),
              ...(e.usage.cachedTokens !== undefined ? { cached_tokens: e.usage.cachedTokens } : {}),
              ...(e.usage.latencyMs !== undefined ? { latency_ms: e.usage.latencyMs } : {}),
              decision_source: e.decisionSource,
            });
          },
        });
        try {
          const action = await decisionProvider.decide(ctx);
          if (sessionStore !== null) {
            const completedAt = new Date();
            this.#recordSession(() =>
              sessionStore.recordDecision({
                config: this.#opts.config,
                context: ctx,
                startedAt,
                completedAt,
                traces,
                action,
              }),
            );
          }
          return action;
        } catch (error) {
          if (sessionStore !== null) {
            const completedAt = new Date();
            this.#recordSession(() =>
              sessionStore.recordDecision({
                config: this.#opts.config,
                context: ctx,
                startedAt,
                completedAt,
                traces,
                error,
              }),
            );
          }
          throw error;
        }
      },
    };
  }

  #recordSession(fn: () => void): void {
    try {
      fn();
    } catch (cause) {
      this.#log(
        "warning",
        "bridge.session_record_failed",
        `Could not update local match session ledger: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  #requireAgent(): AgentInstance {
    if (this.#agent === null) {
      throw new Error("bridge runner is not started");
    }
    return this.#agent;
  }

  #continueManualSeries(): void {
    const series = this.#manualSeries;
    const agent = this.#agent;
    if (series === null || agent === null) return;
    if (series.remainingAfterCurrent <= 0) {
      this.#manualSeries = null;
      return;
    }
    try {
      agent.joinQueue(series.game, series.mode, { oneShot: true });
      series.remainingAfterCurrent -= 1;
      this.#log(
        "info",
        "bridge.queue_joined",
        series.remainingAfterCurrent === 0
          ? `Joined ${series.game} for the final manual match in this request`
          : `Joined ${series.game} for the next manual match; ${series.remainingAfterCurrent} remaining after this one`,
      );
    } catch (cause) {
      this.#manualSeries = null;
      this.#log(
        "error",
        "bridge.manual_requeue_failed",
        `Could not request the next manual match: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  /**
   * Post-match self-review trigger (SELF_REVIEW_DESIGN.md §4). Fire-and-forget:
   * it must never block the agent loop or throw into it. A no-op unless the
   * owner opted in (selfReview.autoMode != "off"); default is off.
   */
  #maybeAutoReview(gameOver: MsgGameOver, store: LocalMatchSessionStore | null): void {
    if (store === null) return;
    if (this.#opts.config.runtimeType !== "direct") return;
    const sessionId = gameOver.data.session_id;
    if (typeof sessionId !== "string" || sessionId === "") return;
    void this.#runAutoReview(sessionId, gameOver, store).catch((cause) => {
      this.#log(
        "warning",
        "bridge.self_review_failed",
        `auto self-review failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    });
  }

  async #runAutoReview(
    sessionId: string,
    gameOver: MsgGameOver,
    store: LocalMatchSessionStore,
  ): Promise<void> {
    const slug = this.#opts.config.directAgentSlug ?? "default";
    let config: LLMConfig | undefined;
    try {
      const { profile } = await loadAgentProfile(resolveAgentDir(slug));
      config = profile.config;
    } catch {
      return; // no usable LLM config → nothing to review with
    }
    if (!config) return;
    const mode = config.selfReview?.autoMode ?? "off";
    if (mode === "off") return;
    if (mode === "losses_only" && !agentLostMatch(this.#opts.config.agentId, gameOver)) return;
    if (store.readSelfReview(sessionId)) return; // already reviewed (reconnect/replay)
    const exported = store.exportSession(sessionId);
    if (!exported) return;
    const review = await runSelfReview({
      exported,
      config,
      trigger: "auto",
      locale: envReviewLocale(),
    });
    store.writeSelfReview(sessionId, review);
    this.#log("info", "bridge.self_review", `Saved auto self-review for ${sessionId}`);
  }

  async #buildRuntimeStatus(provider: BridgeRuntimeProvider, data: unknown): Promise<Record<string, unknown>> {
    const requestId = readRequestId(data);
    const checkedAt = new Date().toISOString();
    // Phase 1B readiness handshake — a pure connection/state self-check that NEVER
    // calls the LLM (zero user tokens). Reaching this handler already means the
    // bridge is online (it received the server's readiness_check); we report ready
    // when it also has spare match capacity (idle). Balance/key validity is
    // intentionally NOT probed here — a real match failure is the backstop for that.
    // (Mirrors the server-side contract in internal/hub/readiness_wait.go: the
    // client never spends tokens to answer a readiness probe.)
    const base = {
      request_id: requestId,
      runtime_type: this.#opts.config.runtimeType,
      runtime_name: provider.name,
      checked_at: checkedAt,
    };
    // Generous cap: catches a stuck pile-up, not normal concurrent play. A local
    // "is the user accepting matches?" pause toggle can refine this later.
    const maxConcurrent = 8;
    const activeMatches = this.#agent?.activeMatchCount ?? 0;
    if (activeMatches >= maxConcurrent) {
      return {
        ...base,
        ready: false,
        active_matches: activeMatches,
        max_concurrent: maxConcurrent,
        detail: `busy: ${activeMatches}/${maxConcurrent} matches in flight`,
      };
    }
    return {
      ...base,
      ready: true,
      active_matches: activeMatches,
      max_concurrent: maxConcurrent,
      detail: "ready",
    };
  }
}

function readRequestId(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const value = (data as Record<string, unknown>).request_id;
  return typeof value === "string" ? value : "";
}

function formatMatchComplete(config: BridgeConfig, gameOver: MsgGameOver, game?: string): string {
  const lines = [
    `Match complete: ${displayGameName(game)}`,
    `Result: ${resultLabel(config.agentId, gameOver)}`,
  ];
  const replay = fullReplayURL(config.baseUrl, gameOver.data.replay_url);
  if (replay !== undefined) {
    lines.push(`Replay: ${replay}`);
  } else if (gameOver.data.forfeit_reason !== undefined) {
    lines.push(`Forfeit reason: ${gameOver.data.forfeit_reason}`);
  }
  if ((config.autoDailyLimit ?? 0) === 2) {
    lines.push(
      "",
      "Your Agent is set to 2 automatic ranked matches per day.",
      "To compete more often:",
      "  aifight set daily 4",
    );
  }
  return lines.join("\n");
}

function resultLabel(agentId: string, gameOver: MsgGameOver): string {
  const player = gameOver.data.players.find((p) => p.agent_id === agentId);
  if (player === undefined) return "completed";

  if (gameOver.data.forfeited_by === player.player_id) {
    return "forfeit";
  }
  if (gameOver.data.forfeit_reason !== undefined) {
    return "opponent forfeit";
  }
  if (gameOver.data.result.is_draw) return "draw";

  const ownPayoff = gameOver.data.result.payoffs[player.player_id];
  if (typeof ownPayoff !== "number") {
    return gameOver.data.result.winner === player.player_id ? "1st place" : "completed";
  }
  const higher = Object.values(gameOver.data.result.payoffs).filter((payoff) => payoff > ownPayoff).length;
  return `${ordinal(higher + 1)} place`;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** True when the agent clearly lost (for selfReview autoMode "losses_only").
 *  Reuses resultLabel so the win/draw/forfeit logic stays in one place; an
 *  ambiguous "completed" is treated as not-a-loss to avoid spurious reviews. */
function agentLostMatch(agentId: string, gameOver: MsgGameOver): boolean {
  const label = resultLabel(agentId, gameOver);
  if (label === "forfeit") return true;
  return /^([2-9]|\d{2,})(st|nd|rd|th) place$/.test(label);
}

/** Locale for an auto-triggered review (the headless bridge has no UI locale).
 *  Honors AIFIGHT_LOCALE/LC_ALL/LANG; defaults to English. */
function envReviewLocale(): string {
  const v = process.env.AIFIGHT_LOCALE ?? process.env.LC_ALL ?? process.env.LANG ?? "";
  return /^zh/i.test(v) ? "zh" : "en";
}

function fullReplayURL(baseUrl: string, replayPath: string | undefined): string | undefined {
  if (replayPath === undefined || replayPath.trim() === "") return undefined;
  try {
    return new URL(replayPath, `${baseUrl.replace(/\/+$/, "")}/`).toString();
  } catch {
    return replayPath;
  }
}

function displayGameName(game: string | undefined): string {
  switch (game) {
    case "texas_holdem":
      return "Texas Hold'em";
    case "liars_dice":
      return "Liar's Dice";
    case "coup":
      return "Coup";
    default:
      return "AIFight match";
  }
}

function providerForConfig(config: BridgeConfig): BridgeRuntimeProvider {
  if (config.runtimeType === "mock") return createMockRuntimeProvider();
  return createDirectLLMRuntimeProvider({ agentSlug: config.directAgentSlug ?? "default" });
}
