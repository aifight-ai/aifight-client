import crypto from "node:crypto";

import type {
  AgentDecisionContext,
  AgentDecisionOutput,
  AgentDecisionProvider,
  AgentDecisionWireUsage,
} from "../agents/agent";
import type { GameType, LegalAction } from "../decision/types";
import { parseCoupAction } from "../games/coup/action-parser";
import { fallbackCoup } from "../games/coup/fallback";
import { parseLiarsDiceAction } from "../games/liars_dice/action-parser";
import { fallbackLiarsDice } from "../games/liars_dice/fallback";
import { parseTexasHoldemAction } from "../games/texas_holdem/action-parser";
import { fallbackTexasHoldem } from "../games/texas_holdem/fallback";
import { classifyDecisionError, type DecisionErrorClass } from "../llm/adapters/error-class.js";

export interface BridgeRuntimeDecisionRequest {
  readonly game: GameType;
  readonly matchId: string;
  readonly playerId?: string;
  readonly legalActions: readonly LegalAction[];
  readonly publicState: unknown;
  readonly timeoutMs: number;
  readonly strategy?: BridgeDecisionStrategy;
  /**
   * Present only on an illegal-output retry (§3 Phase A): tells the provider
   * what was wrong with the model's previous reply so it can ask the model to
   * correct itself instead of the bridge silently substituting a fallback.
   */
  readonly illegalFeedback?: BridgeIllegalFeedback;
}

export interface BridgeIllegalFeedback {
  /** 1-based retry attempt (1 = first corrective retry). */
  readonly attempt: number;
  readonly reason: "unparseable_runtime_text" | "illegal_runtime_action";
  /** The model's prior invalid reply, truncated. */
  readonly priorRaw: string;
  /** Ready-to-send corrective instruction for the model. */
  readonly message: string;
}

export interface BridgeRuntimeProvider {
  readonly name: string;
  decide(req: BridgeRuntimeDecisionRequest): Promise<BridgeRuntimeDecideOutput>;
  healthCheck?(): Promise<boolean>;
}

/**
 * What a runtime provider may return: the raw text/action (legacy shape), or
 * a result object that additionally carries per-call token usage (§7A). The
 * decision pipeline unwraps both transparently, so existing providers keep
 * returning plain strings.
 */
export type BridgeRuntimeDecideOutput = string | LegalAction | BridgeRuntimeDecisionResult;

export interface BridgeRuntimeDecisionResult {
  readonly raw: string | LegalAction;
  readonly usage?: BridgeRuntimeDecisionUsage;
  /** Normalized stop signal from the adapter (token-budget guard). */
  readonly stopReason?: "stop" | "max_tokens" | "other";
  /** True when the model output was cut short by the token limit. */
  readonly truncated?: boolean;
  /** The profile that produced this decision (for the "raise max tokens" hint). */
  readonly profileId?: string;
  /** Set when the provider auto-retried this decision at a higher maxTokens. */
  readonly selfHealed?: { readonly from: number; readonly to: number };
}

export interface BridgeRuntimeDecisionUsage {
  /** Adapter protocol, e.g. "anthropic_messages". */
  readonly provider: string;
  readonly model: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly cachedTokens?: number;
  readonly latencyMs?: number;
}

/** Per-model-call usage event surfaced to the runner for local stats (§7A). */
export interface BridgeDecisionUsageEvent {
  readonly matchId: string;
  readonly game: GameType;
  /** "model" = a decision's first call; "model_retry" = a §3 corrective retry. */
  readonly decisionSource: "model" | "model_retry";
  readonly usage: BridgeRuntimeDecisionUsage;
}

function unwrapDecideOutput(out: BridgeRuntimeDecideOutput): {
  raw: string | LegalAction;
  usage?: BridgeRuntimeDecisionUsage;
  stopReason?: "stop" | "max_tokens" | "other";
  truncated?: boolean;
  profileId?: string;
  selfHealed?: { from: number; to: number };
} {
  if (typeof out === "object" && out !== null && "raw" in out) {
    const result = out as BridgeRuntimeDecisionResult;
    return {
      raw: result.raw,
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
      ...(result.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
      ...(result.truncated ? { truncated: true } : {}),
      ...(result.profileId !== undefined ? { profileId: result.profileId } : {}),
      ...(result.selfHealed !== undefined ? { selfHealed: result.selfHealed } : {}),
    };
  }
  return { raw: out as string | LegalAction };
}

/**
 * Aggregate the decision's per-call usage into the wire `usage` object for
 * the outgoing action message (protocol v1.1): one record per decision, a
 * retry adds to the same record. Sanitized so a malformed value can never
 * fail outbound schema validation and block the action itself: a missing or
 * empty model name drops the whole record, counts are truncated to
 * non-negative integers, and a count field is only present when at least
 * one call reported it.
 */
function toWireUsage(calls: readonly BridgeRuntimeDecisionUsage[]): AgentDecisionWireUsage | undefined {
  if (calls.length === 0) return undefined;
  const model = (calls[calls.length - 1]?.model ?? "").trim().slice(0, 100);
  if (model === "") return undefined;
  const sum = (select: (c: BridgeRuntimeDecisionUsage) => number | undefined): number | undefined => {
    let total: number | undefined;
    for (const call of calls) {
      const value = select(call);
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
      total = (total ?? 0) + Math.trunc(value);
    }
    return total;
  };
  const inputTokens = sum((c) => c.inputTokens);
  const outputTokens = sum((c) => c.outputTokens);
  const reasoningTokens = sum((c) => c.reasoningTokens);
  const cachedTokens = sum((c) => c.cachedTokens);
  return {
    model,
    ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
    ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoning_tokens: reasoningTokens } : {}),
    ...(cachedTokens !== undefined ? { cached_tokens: cachedTokens } : {}),
  };
}

export interface BridgeDecisionStrategySection {
  readonly scope: "global" | "game";
  readonly game?: GameType;
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mtimeMs: number;
  readonly truncated?: boolean;
}

export interface BridgeDecisionStrategy {
  readonly sections: readonly BridgeDecisionStrategySection[];
}

export type BridgeDecisionSource = "model" | "model_retry" | "fallback";

export type BridgeDecisionTrace =
  | {
      readonly type: "decision_request";
      readonly matchId: string;
      readonly game: GameType;
      readonly playerId?: string;
      readonly legalActionCount: number;
      readonly timeoutMs: number;
      readonly strategy: readonly BridgeDecisionStrategyTraceSection[];
    }
  | {
      readonly type: "runtime_success";
      readonly matchId: string;
      readonly attempt: number;
      readonly raw: RuntimeRawTrace;
      /** True when the model output was cut short by the token limit. */
      readonly truncated?: boolean;
      /** Profile that produced this decision (for the "raise max tokens" hint). */
      readonly profileId?: string;
      /** Set when the provider auto-raised maxTokens and retried this decision. */
      readonly selfHealed?: { readonly from: number; readonly to: number };
    }
  | {
      readonly type: "runtime_failure";
      readonly matchId: string;
      readonly attempt: number;
      readonly error: string;
      /** True when the failure was a max_tokens / reasoning-budget 4xx. */
      readonly tokenLimit?: boolean;
      /** Profile that failed (so the "raise max tokens" fix targets it, not the
       *  active profile — they differ under per-game routing). */
      readonly profileId?: string;
      /** Coarse classification of the failure (auth / rate_limit / server / …)
       *  so the CLI and cockpit can show an actionable reminder. */
      readonly errorClass?: DecisionErrorClass;
    }
  | {
      readonly type: "strategy_error";
      readonly matchId: string;
      readonly error: string;
    }
  | {
      // Emitted right before each corrective retry of an unparseable/illegal
      // model output (§3 Phase A).
      readonly type: "illegal_retry";
      readonly matchId: string;
      readonly attempt: number;
      readonly reason: "unparseable_runtime_text" | "illegal_runtime_action";
      readonly priorPreview: string;
    }
  | {
      readonly type: "final_action";
      readonly matchId: string;
      readonly source: "runtime" | "fallback";
      /**
       * Who actually authored this action: the model first try, the model
       * after corrective feedback, or the bridge's deterministic fallback.
       * "model" | "model_retry" collapse to source="runtime" for backward
       * compatibility.
       */
      readonly decisionSource?: BridgeDecisionSource;
      readonly reason?: string;
      readonly action: LegalAction;
    };

export interface BridgeDecisionStrategyTraceSection {
  readonly scope: "global" | "game";
  readonly game?: GameType;
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mtimeMs: number;
  readonly truncated?: boolean;
}

export interface RuntimeRawTrace {
  readonly kind: "text" | "action";
  readonly sha256: string;
  readonly bytes: number;
  readonly preview: string;
}

export interface BuildBridgeDecisionProviderOptions {
  readonly loadStrategy?: (input: {
    readonly game: GameType;
    readonly matchId: string;
    readonly playerId?: string;
  }) => BridgeDecisionStrategy | undefined;
  readonly onTrace?: (trace: BridgeDecisionTrace) => void;
  /**
   * Corrective retries for unparseable/illegal model output before falling
   * back (§3 Phase A). Each retry costs one extra model call on the user's
   * own key, so it is clamped to [0, 2]. Default 1.
   */
  readonly illegalRetryCount?: number;
  /**
   * Extra attempts for a TRANSIENT API failure (rate_limit / server / timeout /
   * network) before falling back, each after a budget-bounded backoff. Only
   * retryable classes consume these — auth / config / quota / content_filter
   * fall back immediately. Clamped to [0, 4]. Default 2.
   */
  readonly transientRetryCount?: number;
  /** Called once per model call that reported token usage (§7A local stats). */
  readonly onUsage?: (event: BridgeDecisionUsageEvent) => void;
}

// A corrective retry is only attempted when at least this much of the turn
// budget remains — the retry call needs real time to produce an answer, and
// running into the platform turn timeout (3 minutes on the hub today) would
// forfeit the match, which is strictly worse than a deterministic fallback.
const MIN_ILLEGAL_RETRY_BUDGET_MS = 10_000;

function clampIllegalRetryCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(2, Math.trunc(value)));
}

function clampTransientRetryCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 2;
  return Math.max(0, Math.min(4, Math.trunc(value)));
}

// Transient-retry backoff: exponential with full jitter, capped. Same rationale
// as the WS reconnect curve, but self-contained (a decision retry is a one-shot
// within the turn, not a long-lived reconnect loop). Every wait is additionally
// bounded by the turn budget — see MIN_TRANSIENT_RETRY_BUDGET_MS.
const TRANSIENT_BACKOFF_BASE_MS = 500;
const TRANSIENT_BACKOFF_FACTOR = 2;
const TRANSIENT_BACKOFF_CAP_MS = 8_000;
// A transient retry needs the backoff wait PLUS real time for the model to
// answer; if less than this remains after the wait, skip it and fall back —
// running into the platform turn timeout would forfeit, strictly worse than a
// deterministic fallback (same reasoning as MIN_ILLEGAL_RETRY_BUDGET_MS).
const MIN_TRANSIENT_RETRY_BUDGET_MS = 10_000;

/** Backoff before the NEXT transient attempt. `failedAttempt` is 1-based (the
 *  attempt that just failed). Honors a provider Retry-After when it asks for
 *  longer than our own backoff. */
function transientBackoffMs(failedAttempt: number, retryAfterMs: number | undefined): number {
  const base = Math.min(
    TRANSIENT_BACKOFF_BASE_MS * Math.pow(TRANSIENT_BACKOFF_FACTOR, Math.max(0, failedAttempt - 1)),
    TRANSIENT_BACKOFF_CAP_MS,
  );
  const jittered = Math.floor(Math.random() * base); // full jitter
  return retryAfterMs !== undefined ? Math.max(jittered, retryAfterMs) : jittered;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildBridgeDecisionProvider(
  runtimeProvider: BridgeRuntimeProvider,
  opts: BuildBridgeDecisionProviderOptions = {},
): AgentDecisionProvider {
  return {
    async decide(ctx: AgentDecisionContext): Promise<unknown> {
      const game = asGameType(ctx.game);
      const ar = ctx.actionRequest.data;
      const legalActions = (ar.legal_actions ?? []) as readonly LegalAction[];
      if (legalActions.length === 0) {
        throw new Error("action_request had no legal actions");
      }

      const request: BridgeRuntimeDecisionRequest = {
        game,
        matchId: ctx.matchId,
        playerId: extractPlayerId(ar.state),
        legalActions,
        publicState: ar.state,
        timeoutMs: typeof ar.timeout_ms === "number" ? ar.timeout_ms : 0,
      };

      const strategy = loadStrategySafely(opts, {
        game,
        matchId: ctx.matchId,
        playerId: request.playerId,
      });
      const requestWithStrategy: BridgeRuntimeDecisionRequest = {
        ...request,
        ...(strategy !== undefined && strategy.sections.length > 0 ? { strategy } : {}),
      };

      opts.onTrace?.({
        type: "decision_request",
        matchId: ctx.matchId,
        game,
        ...(request.playerId !== undefined ? { playerId: request.playerId } : {}),
        legalActionCount: legalActions.length,
        timeoutMs: request.timeoutMs,
        strategy: strategy?.sections.map(strategyTraceSection) ?? [],
      });

      const startedAtMs = Date.now();
      const deadlineMs = request.timeoutMs > 0 ? startedAtMs + request.timeoutMs : undefined;

      const reportedUsage: BridgeRuntimeDecisionUsage[] = [];
      const emitUsage = (usage: BridgeRuntimeDecisionUsage | undefined, retry: boolean) => {
        if (usage === undefined) return;
        reportedUsage.push(usage);
        opts.onUsage?.({
          matchId: ctx.matchId,
          game,
          decisionSource: retry ? "model_retry" : "model",
          usage,
        });
      };

      const maxAttempts = 1 + clampTransientRetryCount(opts.transientRetryCount);
      let callIndex = 0;
      let raw: string | LegalAction | undefined;
      while (callIndex < maxAttempts) {
        callIndex++;
        try {
          const out = unwrapDecideOutput(await runtimeProvider.decide(requestWithStrategy));
          raw = out.raw;
          emitUsage(out.usage, false);
          opts.onTrace?.({
            type: "runtime_success",
            matchId: ctx.matchId,
            attempt: callIndex,
            raw: summarizeRuntimeRaw(raw),
            ...(out.truncated ? { truncated: true } : {}),
            ...(out.profileId !== undefined ? { profileId: out.profileId } : {}),
            ...(out.selfHealed !== undefined ? { selfHealed: out.selfHealed } : {}),
          });
          break;
        } catch (cause) {
          const profileId = profileIdFromCause(cause);
          const errClass = classifyDecisionError(cause);
          opts.onTrace?.({
            type: "runtime_failure",
            matchId: ctx.matchId,
            attempt: callIndex,
            error: stringifyCause(cause),
            ...(isTokenLimitCause(cause) ? { tokenLimit: true } : {}),
            ...(profileId !== undefined ? { profileId } : {}),
            errorClass: errClass.class,
          });
          // Type-aware, budget-bounded transient retry. Only a retryable class
          // (rate_limit / server / timeout / network / unknown) earns another
          // attempt, after a backoff that never eats into the turn deadline.
          // auth / config / quota / content_filter / token_limit fall straight
          // through to the deterministic fallback — retrying them can't help.
          if (!errClass.retryable || callIndex >= maxAttempts) break;
          const delay = transientBackoffMs(callIndex, errClass.retryAfterMs);
          const remainingMs = deadlineMs === undefined ? undefined : deadlineMs - Date.now();
          if (remainingMs !== undefined && remainingMs < delay + MIN_TRANSIENT_RETRY_BUDGET_MS) {
            break; // not enough turn budget left for a backoff plus a fresh call
          }
          if (delay > 0) await sleep(delay);
        }
      }

      if (raw === undefined) {
        const action = fallbackAction(game, legalActions, ar.state);
        opts.onTrace?.({
          type: "final_action",
          matchId: ctx.matchId,
          source: "fallback",
          decisionSource: "fallback",
          reason: "runtime_failure",
          action,
        });
        return {
          action,
          // F09: tell the platform the local fallback played this turn —
          // the ladder should know how much of a record is fallback policy.
          decision: { source: "fallback", illegal_retries: 0, fallback_reason: "runtime_failure" },
        } satisfies AgentDecisionOutput;
      }

      let coerced = coerceRuntimeOutput({
        game,
        raw,
        legalActions,
        publicState: ar.state,
      });

      // §3 Phase A: an unparseable/illegal model output gets corrective
      // feedback and a bounded number of retries before the deterministic
      // fallback "plays for" the agent. The ladder should measure the
      // agent, not our fallback policy.
      const retryBudget = clampIllegalRetryCount(opts.illegalRetryCount);
      let illegalAttempt = 0;
      while (coerced.source === "fallback" && coerced.reason !== undefined && illegalAttempt < retryBudget) {
        const remainingMs = deadlineMs === undefined ? undefined : deadlineMs - Date.now();
        if (remainingMs !== undefined && remainingMs < MIN_ILLEGAL_RETRY_BUDGET_MS) {
          break; // not enough turn budget left for another model call
        }
        illegalAttempt++;
        const reason = coerced.reason;
        const feedback = buildIllegalFeedback(illegalAttempt, reason, raw, legalActions);
        opts.onTrace?.({
          type: "illegal_retry",
          matchId: ctx.matchId,
          attempt: illegalAttempt,
          reason,
          priorPreview: truncate(feedback.priorRaw, 500),
        });

        callIndex++;
        try {
          const out = unwrapDecideOutput(
            await runtimeProvider.decide({
              ...requestWithStrategy,
              ...(remainingMs !== undefined ? { timeoutMs: remainingMs } : {}),
              illegalFeedback: feedback,
            }),
          );
          raw = out.raw;
          emitUsage(out.usage, true);
          opts.onTrace?.({
            type: "runtime_success",
            matchId: ctx.matchId,
            attempt: callIndex,
            raw: summarizeRuntimeRaw(raw),
          });
        } catch (cause) {
          const profileId = profileIdFromCause(cause);
          opts.onTrace?.({
            type: "runtime_failure",
            matchId: ctx.matchId,
            attempt: callIndex,
            error: stringifyCause(cause),
            ...(isTokenLimitCause(cause) ? { tokenLimit: true } : {}),
            ...(profileId !== undefined ? { profileId } : {}),
            errorClass: classifyDecisionError(cause).class,
          });
          break; // transport error on a corrective retry → fallback
        }

        coerced = coerceRuntimeOutput({
          game,
          raw,
          legalActions,
          publicState: ar.state,
        });
      }

      const decisionSource: BridgeDecisionSource =
        coerced.source === "fallback" ? "fallback" : illegalAttempt > 0 ? "model_retry" : "model";

      opts.onTrace?.({
        type: "final_action",
        matchId: ctx.matchId,
        source: coerced.source,
        decisionSource,
        ...(coerced.reason !== undefined ? { reason: coerced.reason } : {}),
        action: coerced.action,
      });
      // Usage rides the action message even when the final action is the
      // deterministic fallback: the model calls that failed to produce a
      // legal action still consumed the user's tokens.
      const wireUsage = toWireUsage(reportedUsage);
      return {
        action: coerced.action,
        ...(wireUsage !== undefined ? { usage: wireUsage } : {}),
        // F09 (protocol v1.2): decision provenance — model / model_retry /
        // fallback plus how many corrective retries were burned.
        decision: {
          source: decisionSource,
          illegal_retries: illegalAttempt,
          ...(decisionSource === "fallback" && coerced.reason !== undefined
            ? { fallback_reason: coerced.reason }
            : {}),
        },
      } satisfies AgentDecisionOutput;
    },
  };
}

function buildIllegalFeedback(
  attempt: number,
  reason: BridgeIllegalFeedback["reason"],
  priorRaw: string | LegalAction,
  legalActions: readonly LegalAction[],
): BridgeIllegalFeedback {
  const priorText = typeof priorRaw === "string" ? priorRaw : JSON.stringify(priorRaw);
  const typeList = [...new Set(legalActions.map((a) => a.type))].join(", ");
  const problem =
    reason === "unparseable_runtime_text"
      ? "Your previous reply could not be parsed into an action."
      : "Your previous reply did not match any currently legal action.";
  return {
    attempt,
    reason,
    priorRaw: truncate(priorText, 2_000),
    message:
      `${problem} Legal action types right now: ${typeList}. ` +
      'Reply with ONLY one JSON object shaped {"action":"<type>","data":{...},"summary":"short reason"} ' +
      "that exactly matches one entry in legal_actions.",
  };
}

export function createMockRuntimeProvider(): BridgeRuntimeProvider {
  return {
    name: "mock",
    async decide(req) {
      return fallbackAction(req.game, req.legalActions, req.publicState);
    },
    async healthCheck() {
      return true;
    },
  };
}

export function createUnavailableRuntimeProvider(name: string): BridgeRuntimeProvider {
  return {
    name,
    async decide() {
      throw new Error(`${name} provider is not implemented yet`);
    },
    async healthCheck() {
      return false;
    },
  };
}

function coerceRuntimeOutput(input: {
  readonly game: GameType;
  readonly raw: string | LegalAction;
  readonly legalActions: readonly LegalAction[];
  readonly publicState: unknown;
}): {
  readonly action: LegalAction;
  readonly source: "runtime" | "fallback";
  readonly reason?: "unparseable_runtime_text" | "illegal_runtime_action";
} {
  if (typeof input.raw !== "string") {
    const matched = matchLegalAction(input.raw, input.legalActions);
    if (matched) return { action: matched, source: "runtime" };
    return {
      action: fallbackAction(input.game, input.legalActions, input.publicState),
      source: "fallback",
      reason: "illegal_runtime_action",
    };
  }

  const parsed = parseRuntimeText(input.game, input.raw, input.legalActions);
  if (parsed !== null) return { action: parsed, source: "runtime" };
  return {
    action: fallbackAction(input.game, input.legalActions, input.publicState),
    source: "fallback",
    reason: "unparseable_runtime_text",
  };
}

function parseRuntimeText(
  game: GameType,
  text: string,
  legalActions: readonly LegalAction[],
): LegalAction | null {
  const normalized = normalizeRuntimeText(text);
  const result =
    game === "texas_holdem"
      ? parseTexasHoldemAction(normalized, legalActions)
      : game === "liars_dice"
        ? parseLiarsDiceAction(normalized, legalActions)
        : parseCoupAction(normalized, legalActions);
  return result.kind === "ok" ? result.action : null;
}

function normalizeRuntimeText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const direct = trimmed.toLowerCase();
  return JSON.stringify({ action: direct });
}

function matchLegalAction(
  action: LegalAction,
  legalActions: readonly LegalAction[],
): LegalAction | null {
  const exact = legalActions.find((candidate) => deepEqual(candidate, action));
  if (exact) return exact;
  const sameType = legalActions.find((candidate) => candidate.type === action.type);
  if (!action.data && sameType) return sameType;
  return null;
}

function fallbackAction(
  game: GameType,
  legalActions: readonly LegalAction[],
  publicState: unknown,
): LegalAction {
  if (game === "texas_holdem") {
    return fallbackTexasHoldem({
      publicState: publicState as Parameters<typeof fallbackTexasHoldem>[0]["publicState"],
      legalActions,
      yourPlayerId: "p0",
    });
  }
  if (game === "liars_dice") {
    return fallbackLiarsDice({
      publicState: publicState as Parameters<typeof fallbackLiarsDice>[0]["publicState"],
      legalActions,
      yourPlayerId: "p0",
    });
  }
  return fallbackCoup({
    publicState: publicState as Parameters<typeof fallbackCoup>[0]["publicState"],
    legalActions,
    yourPlayerId: "p0",
  });
}

function asGameType(game: string | undefined): GameType {
  if (game === "texas_holdem" || game === "liars_dice" || game === "coup") {
    return game;
  }
  throw new Error(`unsupported game: ${String(game)}`);
}

function extractPlayerId(state: unknown): string | undefined {
  if (!state || typeof state !== "object") return undefined;
  const value = (state as Record<string, unknown>).your_player_id;
  return typeof value === "string" ? value : undefined;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function loadStrategySafely(
  opts: BuildBridgeDecisionProviderOptions,
  input: {
    readonly game: GameType;
    readonly matchId: string;
    readonly playerId?: string;
  },
): BridgeDecisionStrategy | undefined {
  if (!opts.loadStrategy) return undefined;
  try {
    return opts.loadStrategy(input);
  } catch (cause) {
    opts.onTrace?.({
      type: "strategy_error",
      matchId: input.matchId,
      error: stringifyCause(cause),
    });
    return undefined;
  }
}

function strategyTraceSection(section: BridgeDecisionStrategySection): BridgeDecisionStrategyTraceSection {
  return {
    scope: section.scope,
    ...(section.game !== undefined ? { game: section.game } : {}),
    path: section.path,
    content: section.content,
    sha256: section.sha256,
    bytes: section.bytes,
    mtimeMs: section.mtimeMs,
    ...(section.truncated === true ? { truncated: true } : {}),
  };
}

function summarizeRuntimeRaw(raw: string | LegalAction): RuntimeRawTrace {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  return {
    kind: typeof raw === "string" ? "text" : "action",
    sha256: hashText(text),
    bytes: Buffer.byteLength(text, "utf8"),
    preview: truncate(text, 8_192),
  };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n...[truncated]`;
}

function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stringifyCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

/** Duck-typed AdapterError.tokenLimit check (avoids importing the adapter layer). */
function isTokenLimitCause(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as { tokenLimit?: unknown }).tokenLimit === true;
}

/** Duck-typed profile id tagged onto a thrown decision error by the direct-LLM
 *  provider, so a failure trace can point the "raise max tokens" fix at the
 *  profile that actually failed. */
function profileIdFromCause(cause: unknown): string | undefined {
  const p = typeof cause === "object" && cause !== null ? (cause as { profileId?: unknown }).profileId : undefined;
  return typeof p === "string" && p !== "" ? p : undefined;
}
