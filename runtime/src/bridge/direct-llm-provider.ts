// Direct-LLM runtime provider (BridgeConfig.runtimeType === "direct").
//
// Lets a user play by configuring an LLM API key directly (Claude / GPT /
// DeepSeek / Gemini-compat / any custom OpenAI-compatible baseURL) WITHOUT
// running OpenClaw or Hermes. It implements the same BridgeRuntimeProvider
// contract as the OpenClaw/Hermes providers: build a prompt, ask the model,
// return the raw text. buildBridgeDecisionProvider (provider.ts) then parses,
// retries, traces, and falls back exactly as it does for the localhost
// runtimes — so all of that machinery is reused unchanged.
//
// P1 "simple prompt path": reuses the same crude prompt shape the
// OpenClaw/Hermes providers build today (a JSON state dump + an output
// contract), so decision quality matches the currently shipped experience.
// The richer decision/prompt-builder path is a later-phase quality upgrade.
//
// Config is read from the shared agent profile under
// <aifight-home>/agents/<slug>/config.json, so the CLI and the desktop app
// configure exactly the same files.

import { stat } from "node:fs/promises";
import { join } from "node:path";

import { registerBuiltinAdapters, requireAdapter } from "../llm/adapter-registry.js";
import { resolveLLMProfile } from "../llm/resolve-profile.js";
import { resolveModelCapabilities } from "../llm/capabilities/validate-capabilities.js";
import type { LLMConfig } from "../profile/config-schema.js";
import { loadAgentProfile, resolveAgentDir } from "../profile/profile-loader.js";
import { resolveSecret } from "../profile/secret-ref.js";
import type {
  BridgeRuntimeDecisionRequest,
  BridgeRuntimeDecisionResult,
  BridgeRuntimeProvider,
} from "./provider.js";

/** Minimum turn budget (ms) left before a self-heal retry is worth issuing: a
 *  retry is a full model call, so with less than this we skip it and let the
 *  deterministic fallback play in time rather than risk a timeout loss. */
const MIN_SELF_HEAL_BUDGET_MS = 10_000;

// R13-F06 wall-time bounds for a single decision call.
const GLOBAL_DECISION_HARD_CAP_MS = 600_000; // 10 min absolute ceiling per call
const MIN_DECISION_TIMEOUT_MS = 1_000; // floor so a call always gets some time

// R13-F06 per-match output-token guard bounds (a full USD ledger is a follow-up).
const MATCH_OUTPUT_TOKEN_GUARD_DECISIONS = 400; // generous decisions-per-match multiplier
const MATCH_OUTPUT_TOKEN_GUARD_ABSOLUTE = 8_000_000; // absolute per-match output-token ceiling
const MAX_TRACKED_MATCHES = 512; // cap on the per-match token map so it can't grow unbounded

export interface DirectLLMProviderOptions {
  /** Agent profile slug under <aifight-home>/agents/. Defaults to "default". */
  readonly agentSlug: string;
  /** Test seam: supply the LLMConfig directly instead of reading from disk. */
  readonly loadConfig?: (agentSlug: string) => Promise<LLMConfig>;
  /** Test seam: register adapters (defaults to the built-in registry). */
  readonly registerAdapters?: () => Promise<void>;
}

export function createDirectLLMRuntimeProvider(
  opts: DirectLLMProviderOptions,
): BridgeRuntimeProvider {
  let adaptersReady: Promise<void> | null = null;
  let configCache: LLMConfig | null = null;
  // F22/AIF-07: config edits must take effect on the NEXT decision, not on
  // the next bridge restart — a user who saves a cheaper model or replaces a
  // revoked key in the desktop/CLI expects the running bridge to follow. The
  // cache is keyed on config.json's mtime+size, so the steady state stays one
  // cheap stat() per decision and a save triggers exactly one re-load
  // (config writes are atomic tmp+rename, so we never read a half-written
  // file). The strategy file was already re-read per decision; this brings
  // provider/model/key to the same behavior.
  let configCacheStamp: { mtimeMs: number; size: number } | null = null;

  // R13-F06 lightweight per-match spend guard: cumulative model OUTPUT tokens
  // per match, so a pathological loop (a wedged model emitting max-token replies
  // turn after turn) can be stopped before it silently drains the user's balance.
  // Insertion-ordered and size-capped so it can never grow without bound over a
  // long-lived bridge's many matches (a full USD ledger is a follow-up).
  const matchOutputTokens = new Map<string, number>();
  const addMatchOutputTokens = (matchId: string, tokens: number | undefined): void => {
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return;
    if (!matchOutputTokens.has(matchId) && matchOutputTokens.size >= MAX_TRACKED_MATCHES) {
      const oldest = matchOutputTokens.keys().next().value;
      if (oldest !== undefined) matchOutputTokens.delete(oldest);
    }
    matchOutputTokens.set(matchId, (matchOutputTokens.get(matchId) ?? 0) + tokens);
  };

  const ensureAdapters = (): Promise<void> =>
    (adaptersReady ??= (opts.registerAdapters ?? registerBuiltinAdapters)());

  async function loadConfig(): Promise<LLMConfig> {
    if (opts.loadConfig) {
      // Test seam: static config, no disk — keep the load-once semantics.
      configCache ??= await opts.loadConfig(opts.agentSlug);
      return configCache;
    }
    const agentDir = resolveAgentDir(opts.agentSlug);
    let stamp: { mtimeMs: number; size: number } | null = null;
    try {
      const st = await stat(join(agentDir, "config.json"));
      stamp = { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      // Missing/unstatable file: fall through and let loadAgentProfile
      // produce its proper error (or succeed, on exotic setups) uncached.
    }
    if (
      configCache !== null &&
      stamp !== null &&
      configCacheStamp !== null &&
      stamp.mtimeMs === configCacheStamp.mtimeMs &&
      stamp.size === configCacheStamp.size
    ) {
      return configCache;
    }
    const { profile } = await loadAgentProfile(agentDir);
    configCache = profile.config;
    configCacheStamp = stamp;
    return configCache;
  }

  function pickProfileName(config: LLMConfig, game: string): string {
    const byGame = (config.routing.byGame ?? {}) as Record<string, string | undefined>;
    return byGame[game] ?? config.routing.default;
  }

  async function resolveForProfile(config: LLMConfig, profileName: string) {
    const def = config.profiles[profileName];
    if (!def) {
      throw new Error(`direct: routing points to unknown profile "${profileName}"`);
    }
    const apiKey = await resolveSecret(def.apiKeyRef);
    return resolveLLMProfile(profileName, def, apiKey);
  }

  return {
    name: "direct",

    async decide(req: BridgeRuntimeDecisionRequest): Promise<BridgeRuntimeDecisionResult> {
      await ensureAdapters();
      const config = await loadConfig();
      const resolved = await resolveForProfile(config, pickProfileName(config, req.game));
      const adapter = requireAdapter(resolved.protocol);
      const { systemPrompt, userPrompt } = buildDirectPrompt(req);

      const callWith = (maxTokens: number, timeoutMs: number) => {
        // R13-F02: cancel the paid HTTP call on EITHER the turn-deadline timeout
        // OR a supersede (a newer action_request replaced this decision). Same
        // AbortSignal.any pattern as account/registration.ts.
        const signal = combineDecisionSignals(timeoutMs, req.signal);
        return adapter.generateDecision(
          {
            systemPrompt,
            userPrompt,
            maxTokens,
            temperature: resolved.temperature,
            responseFormat: "json",
            ...(signal !== undefined ? { signal } : {}),
          },
          resolved,
        );
      };

      // Batch C — bounded self-heal: if the first call is cut off by the token
      // cap (truncated output, or a max_tokens 4xx), retry AT MOST ONCE at a
      // higher cap so the turn isn't wasted. Three guards keep the retry from
      // ever making things worse than the plain fallback would:
      //   • single — the retry is issued exactly once and is never itself retried;
      //   • time-bounded — it runs on the turn's REMAINING budget (not a fresh
      //     full timeout) and is skipped when too little time is left, so a slow
      //     first call can't let self-heal blow the turn deadline;
      //   • non-destructive — if the retry fails but the first call did return a
      //     (truncated) output, we keep that output for upstream coerce/fallback
      //     rather than throwing away a possibly-usable answer.
      // Target = the model ceiling when known, else a generous bump; only when it
      // actually exceeds the current cap. Cost is incurred only on an already-
      // wasted truncated turn.
      const ceiling = resolveModelCapabilities(resolved.protocol, resolved.model).maxOutputTokens;
      // R13-F06: enforce the declared per-decision output-token budget, not just
      // display it. `budget` is what the FIRST call actually requests — clamped
      // down when the profile's maxTokens exceeds budgets.maxOutputTokensPerDecision
      // or the model's own ceiling. `perDecisionCap` is the hard limit self-heal
      // may raise toward but never past (the ceiling and the declared budget,
      // WITHOUT the starting maxTokens term so a raise above maxTokens is allowed).
      const budget = effectiveDecisionBudget(resolved, ceiling);
      const perDecisionCap = perDecisionHardCap(resolved, ceiling);
      const raiseTarget = (cur: number): number | undefined => {
        const to = Math.min(ceiling ?? Math.max(65536, cur * 2), perDecisionCap);
        return to > cur ? to : undefined;
      };
      // R13-F06 wall-time: a single decision call may run no longer than the
      // smallest of the server turn deadline (when set), the profile's request
      // timeout, and a global hard cap — never unbounded — with a floor so a
      // tiny/zero config can't starve the call to nothing.
      const effectiveTimeoutMs = clampDecisionTimeout(req.timeoutMs, resolved.timeouts.requestMs);
      // R13-F06 per-match guard: refuse to spend once this match's cumulative
      // output tokens reach a generous ceiling — play the deterministic legal
      // fallback instead (non-retryable, so the decision loop does not retry).
      const matchCap = matchOutputTokenCap(resolved, ceiling);
      const startedAtMs = Date.now();
      const remainingMs = (): number => effectiveTimeoutMs - (Date.now() - startedAtMs);

      if ((matchOutputTokens.get(req.matchId) ?? 0) >= matchCap) {
        throw makeNonRetryableBudgetError(
          `direct: per-match output-token budget reached for ${req.matchId} (>= ${matchCap}); ` +
            "playing the legal fallback to protect your balance",
          resolved.profileId,
        );
      }

      let selfHealed: { from: number; to: number } | undefined;
      let output: Awaited<ReturnType<typeof callWith>> | undefined;
      let firstError: unknown;
      try {
        output = await callWith(budget, effectiveTimeoutMs);
        addMatchOutputTokens(req.matchId, output.outputTokens);
      } catch (err) {
        // R13-F02: a supersede-abort is not a token-limit; bubble it so the
        // decision is discarded WITHOUT a self-heal retry (the result is unused).
        if (req.signal?.aborted === true) throw tagProfile(err, resolved.profileId);
        if (!isTokenLimitError(err)) throw tagProfile(err, resolved.profileId); // non-token → fallback
        firstError = err; // token-limit throw (e.g. empty-because-truncated)
      }

      // Self-heal exactly once, only when the first call was cut off by the cap,
      // the decision has not been superseded (no point paying for a retry whose
      // answer will be thrown away), and the match is still within its token
      // guard (don't raise the cap on a match that has already overspent).
      if (
        (output?.truncated === true || firstError !== undefined) &&
        req.signal?.aborted !== true &&
        (matchOutputTokens.get(req.matchId) ?? 0) < matchCap
      ) {
        const to = raiseTarget(budget);
        // Enough of the (clamped) wall-time budget left for a second full call?
        const budgetOk = remainingMs() >= MIN_SELF_HEAL_BUDGET_MS;
        if (to !== undefined && budgetOk) {
          selfHealed = { from: budget, to };
          try {
            output = await callWith(to, remainingMs()); // the one and only retry
            addMatchOutputTokens(req.matchId, output.outputTokens);
          } catch (retryErr) {
            selfHealed = undefined; // the retry didn't land
            if (output === undefined) throw tagProfile(retryErr, resolved.profileId); // nothing usable
            // else: keep the first (truncated) output — better than a lost turn.
          }
        }
      }
      if (output === undefined) {
        throw tagProfile(firstError ?? new Error("direct: no decision output"), resolved.profileId);
      }

      // §7A: hand the adapter-parsed token counts up with the text, so the
      // runner can append the local usage ledger. Counts only — never the
      // prompt or the raw response. Also forward the truncation signal + which
      // profile produced this decision (token-budget guard).
      return {
        raw: output.text,
        ...(output.stopReason !== undefined ? { stopReason: output.stopReason } : {}),
        ...(output.truncated ? { truncated: true } : {}),
        ...(selfHealed !== undefined ? { selfHealed } : {}),
        profileId: resolved.profileId,
        usage: {
          provider: resolved.protocol,
          model: resolved.model,
          ...(output.inputTokens !== undefined ? { inputTokens: output.inputTokens } : {}),
          ...(output.outputTokens !== undefined ? { outputTokens: output.outputTokens } : {}),
          ...(output.reasoningTokens !== undefined ? { reasoningTokens: output.reasoningTokens } : {}),
          ...(output.cachedTokens !== undefined ? { cachedTokens: output.cachedTokens } : {}),
          ...(output.cacheWriteTokens !== undefined ? { cacheWriteTokens: output.cacheWriteTokens } : {}),
          latencyMs: output.latencyMs,
        },
      };
    },

    async healthCheck(): Promise<boolean> {
      try {
        await ensureAdapters();
        const config = await loadConfig();
        const resolved = await resolveForProfile(config, config.activeProfile);
        const result = await requireAdapter(resolved.protocol).probe(resolved);
        return result.success;
      } catch {
        return false;
      }
    },

    // R13-F06: surface the routed profile's retries.maxAttempts so the decision
    // loop honors the user's configured retry policy instead of its built-in
    // default. Reads the RAW config value (not the resolved default) and never
    // resolves the API key — a cheap cached config read. undefined → the loop
    // keeps its default; the loop clamps the value to [0, 4] regardless.
    async transientRetryCount(game): Promise<number | undefined> {
      try {
        const config = await loadConfig();
        return config.profiles[pickProfileName(config, game)]?.retries?.maxAttempts;
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * P1 simple prompt: an output contract + optional strategy sections as the
 * system prompt, and the game state / legal actions as the user prompt.
 * Mirrors the OpenClaw/Hermes prompt shape (same decision quality bar).
 */
/** Duck-typed AdapterError.tokenLimit check (avoids importing the adapter layer). */
function isTokenLimitError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { tokenLimit?: unknown }).tokenLimit === true;
}

/** Minimal view of the resolved profile fields the token/budget clamps read. */
interface BudgetedProfile {
  readonly maxTokens: number;
  readonly budgets?: { readonly maxOutputTokensPerDecision?: number };
}

/** A finite, positive number or `Infinity` (the "no cap" identity for min). */
function positiveOrInfinity(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : Infinity;
}

/**
 * R13-F06: the max output tokens the FIRST decision call may request — the
 * smallest of the profile's configured maxTokens, its declared per-decision
 * budget, and the model's own output ceiling. So a profile that sets a huge
 * maxTokens but a small budgets.maxOutputTokensPerDecision actually asks for the
 * budgeted amount, not the huge one.
 */
export function effectiveDecisionBudget(
  resolved: BudgetedProfile,
  modelCeiling: number | undefined,
): number {
  return Math.min(
    positiveOrInfinity(resolved.maxTokens),
    positiveOrInfinity(resolved.budgets?.maxOutputTokensPerDecision),
    positiveOrInfinity(modelCeiling),
  );
}

/**
 * R13-F06: the hard ceiling a self-heal retry may raise toward but never past —
 * the declared per-decision budget and the model ceiling, WITHOUT the starting
 * maxTokens (self-heal legitimately raises above maxTokens, just not above the
 * user's declared budget).
 */
function perDecisionHardCap(resolved: BudgetedProfile, modelCeiling: number | undefined): number {
  return Math.min(
    positiveOrInfinity(resolved.budgets?.maxOutputTokensPerDecision),
    positiveOrInfinity(modelCeiling),
  );
}

/**
 * R13-F02: combine the turn-deadline timeout (when > 0) with the supersede
 * signal (when present) into one signal for the adapter fetch. Either firing
 * cancels the paid HTTP call. Returns undefined when there is nothing to bind.
 */
function combineDecisionSignals(
  timeoutMs: number,
  supersede: AbortSignal | undefined,
): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  if (supersede !== undefined) signals.push(supersede);
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

/**
 * R13-F06 wall-time: bound the per-call timeout so a missing or absurd server
 * value can never run unbounded, WITHOUT undercutting a legitimate turn budget.
 * The server's `timeout_ms` is the authoritative per-turn deadline (a slow
 * reasoning model may legitimately need most of it), so when the server
 * specifies one we honor it, capped only by an absolute ceiling. The profile's
 * requestMs is the fallback used when the server does not send a deadline
 * (previously that path was unbounded). Floored so a zero/tiny input never
 * starves the call. Exported for unit testing.
 */
export function clampDecisionTimeout(serverMs: number, profileRequestMs: number | undefined): number {
  const hasServer = typeof serverMs === "number" && Number.isFinite(serverMs) && serverMs > 0;
  const base = hasServer
    ? serverMs
    : typeof profileRequestMs === "number" && Number.isFinite(profileRequestMs) && profileRequestMs > 0
      ? profileRequestMs
      : GLOBAL_DECISION_HARD_CAP_MS;
  return Math.max(Math.min(base, GLOBAL_DECISION_HARD_CAP_MS), MIN_DECISION_TIMEOUT_MS);
}

/**
 * R13-F06: a generous cumulative OUTPUT-token ceiling for one match — far above
 * any honest game, so it only trips on a pathological loop. Derived from the
 * declared per-decision budget (or the model ceiling) times a generous
 * decisions-per-match multiplier, capped by an absolute ceiling.
 */
function matchOutputTokenCap(resolved: BudgetedProfile, modelCeiling: number | undefined): number {
  const declared = resolved.budgets?.maxOutputTokensPerDecision;
  const perDecision =
    typeof declared === "number" && Number.isFinite(declared) && declared > 0
      ? declared
      : typeof modelCeiling === "number" && Number.isFinite(modelCeiling) && modelCeiling > 0
        ? modelCeiling
        : 32_000;
  return Math.min(MATCH_OUTPUT_TOKEN_GUARD_ABSOLUTE, perDecision * MATCH_OUTPUT_TOKEN_GUARD_DECISIONS);
}

/** A non-retryable decision error: the transient-retry loop treats
 *  `retryable === false` as terminal (classifyDecisionError), so the bridge
 *  takes the deterministic legal fallback instead of retrying. */
function makeNonRetryableBudgetError(message: string, profileId: string): Error {
  const err = Object.assign(new Error(message), { retryable: false });
  return tagProfile(err, profileId) as Error;
}

/**
 * Attach the responsible profile id to a thrown decision error so the upstream
 * runtime_failure trace can point the "raise max tokens" fix at the right
 * profile (a per-game route may differ from the active profile). Best-effort:
 * skips a frozen error or one that already carries a profileId.
 */
function tagProfile(err: unknown, profileId: string): unknown {
  if (typeof err === "object" && err !== null && (err as { profileId?: unknown }).profileId === undefined) {
    try {
      (err as { profileId?: string }).profileId = profileId;
    } catch {
      /* frozen error — leave as is */
    }
  }
  return err;
}

function buildDirectPrompt(req: BridgeRuntimeDecisionRequest): {
  systemPrompt: string;
  userPrompt: string;
} {
  const system = [
    "You are an AIFight game-playing agent.",
    "Choose exactly one legal action. Return ONLY JSON in this shape:",
    '{"action":"<type>","data":{},"summary":"short reason"}',
  ];
  for (const section of req.strategy?.sections ?? []) {
    system.push("", section.content);
  }
  const base = JSON.stringify({
    game: req.game,
    match_id: req.matchId,
    player_id: req.playerId ?? null,
    state: req.publicState,
    legal_actions: req.legalActions,
    timeout_ms: req.timeoutMs,
  });
  // §3 Phase A corrective retry: surface what was wrong with the previous
  // reply as plain text after the JSON payload — explicit instructions beat
  // a field buried in the state dump.
  const feedback = req.illegalFeedback;
  const userPrompt =
    feedback === undefined
      ? base
      : `${base}\n\nRETRY ${feedback.attempt}: ${feedback.message}\nYour previous invalid reply was:\n${feedback.priorRaw}`;
  return { systemPrompt: system.join("\n"), userPrompt };
}
