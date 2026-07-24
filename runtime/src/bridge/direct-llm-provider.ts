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
  BridgeDecisionReasoning,
  BridgeRuntimeDecisionRequest,
  BridgeRuntimeDecisionResult,
  BridgeRuntimeProvider,
} from "./provider.js";
import type { BridgeMatchContext, MatchEventRecord } from "./match-context-tracker.js";
import {
  formatTexasHoldemState,
  formatTexasHoldemEventLine,
} from "../games/texas_holdem/state-formatter.js";
import type {
  Event,
  PlayerInfo,
  TexasHoldemRules,
  TexasHoldemState,
} from "../protocol/types.js";

/** Minimum turn budget (ms) left before a self-heal retry is worth issuing: a
 *  retry is a full model call, so with less than this we skip it and let the
 *  deterministic fallback play in time rather than risk a timeout loss. */
const MIN_SELF_HEAL_BUDGET_MS = 10_000;

// R13-F06 wall-time bounds for a single decision call.
const GLOBAL_DECISION_HARD_CAP_MS = 600_000; // 10 min absolute ceiling per call
const MIN_DECISION_TIMEOUT_MS = 1_000; // floor so a call always gets some time

// Local storage cap for captured reasoning text (config.captureReasoning).
// DeepSeek returns the FULL chain of thought; bound it before it reaches the
// session log so a single decisions.jsonl line stays small.
const REASONING_CAPTURE_MAX_CHARS = 4_000;

// Match-history block bounds: enough for several Texas hands of step-by-step
// detail while keeping the added prompt cost flat late in a long match. The
// aggregate standings always live in `state` regardless (e.g. per-player net).
const HISTORY_MAX_EVENTS = 80;
const HISTORY_MAX_LINE_CHARS = 200;
const HISTORY_MAX_BLOCK_CHARS = 10_000;
// Rules-summary bounds (defensive caps on server-provided text).
const RULES_SUMMARY_MAX_CHARS = 2_000;
const RULES_MAX_KEY_RULES = 12;
const RULES_KEY_RULE_MAX_CHARS = 200;

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

      // Opt-in reasoning capture (config.captureReasoning): where the profile
      // already has a reasoning config, ask the provider to return a thinking
      // summary (Anthropic thinking display, OpenAI Responses reasoning.summary).
      // Never forces thinking ON for a profile that has it off/unset.
      const captureReasoning = config.captureReasoning === true;
      const reasoningOverride =
        captureReasoning && resolved.reasoning !== undefined
          ? {
              ...resolved.reasoning,
              display: "summarized" as const,
              summary:
                resolved.reasoning.summary != null && resolved.reasoning.summary !== "off"
                  ? resolved.reasoning.summary
                  : ("auto" as const),
            }
          : undefined;

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
            ...(reasoningOverride !== undefined ? { reasoning: reasoningOverride } : {}),
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
      // maxTokens is the sole authority on decision output length: the FIRST
      // call requests it, bounded only by the model's real output ceiling (to
      // avoid a provider 400). No hidden per-decision or per-match budget
      // silently shrinks it.
      const budget = effectiveDecisionBudget(resolved, ceiling);
      // Self-heal raises toward the model's ceiling (or a generous bump when the
      // ceiling is unknown) — never past what the model can actually emit.
      const raiseTarget = (cur: number): number | undefined => {
        const to = ceiling ?? Math.max(65536, cur * 2);
        return to > cur ? to : undefined;
      };
      // R13-F06 wall-time: a single decision call may run no longer than the
      // smallest of the server turn deadline (when set), the profile's request
      // timeout, and a global hard cap — never unbounded — with a floor so a
      // tiny/zero config can't starve the call to nothing.
      const effectiveTimeoutMs = clampDecisionTimeout(req.timeoutMs, resolved.timeouts.requestMs);
      // A near-deadline retry can clamp below a usable call length (this only happens
      // when a positive server deadline is nearly up — clampDecisionTimeout floors the
      // no-server case at MIN). The platform has effectively already timed this turn
      // out; paying for a call whose answer it will discard is pure waste — skip it and
      // let the turn resolve server-side.
      if (effectiveTimeoutMs < MIN_DECISION_TIMEOUT_MS) {
        throw tagProfile(
          new Error(
            `decision wall-time ${effectiveTimeoutMs}ms is below the ${MIN_DECISION_TIMEOUT_MS}ms minimum (server turn nearly expired) — skipping a doomed paid call`,
          ),
          resolved.profileId,
        );
      }
      const startedAtMs = Date.now();
      const remainingMs = (): number => effectiveTimeoutMs - (Date.now() - startedAtMs);

      let selfHealed: { from: number; to: number } | undefined;
      let output: Awaited<ReturnType<typeof callWith>> | undefined;
      let firstError: unknown;
      try {
        output = await callWith(budget, effectiveTimeoutMs);
      } catch (err) {
        // R13-F02: a supersede-abort is not a token-limit; bubble it so the
        // decision is discarded WITHOUT a self-heal retry (the result is unused).
        if (req.signal?.aborted === true) throw tagProfile(err, resolved.profileId);
        if (!isTokenLimitError(err)) throw tagProfile(err, resolved.profileId); // non-token → fallback
        firstError = err; // token-limit throw (e.g. empty-because-truncated)
      }

      // Self-heal exactly once, only when the first call was cut off by the cap
      // and the decision has not been superseded (no point paying for a retry
      // whose answer will be thrown away).
      if (
        (output?.truncated === true || firstError !== undefined) &&
        req.signal?.aborted !== true
      ) {
        const to = raiseTarget(budget);
        // Enough of the (clamped) wall-time budget left for a second full call?
        const budgetOk = remainingMs() >= MIN_SELF_HEAL_BUDGET_MS;
        if (to !== undefined && budgetOk) {
          selfHealed = { from: budget, to };
          try {
            output = await callWith(to, remainingMs()); // the one and only retry
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

      // Reasoning capture is gated here (not at the adapter): with the switch
      // off, an adapter that always returns reasoning (DeepSeek) still writes
      // nothing to disk — exactly today's behavior.
      const capturedReasoning = captureReasoning ? capReasoningText(output.reasoningSummary) : undefined;

      // §7A: hand the adapter-parsed token counts up with the text, so the
      // runner can append the local usage ledger. Counts only — never the
      // prompt or the raw response. Also forward the truncation signal + which
      // profile produced this decision (token-budget guard).
      return {
        raw: output.text,
        ...(output.stopReason !== undefined ? { stopReason: output.stopReason } : {}),
        ...(output.truncated ? { truncated: true } : {}),
        ...(selfHealed !== undefined ? { selfHealed } : {}),
        ...(capturedReasoning !== undefined ? { reasoning: capturedReasoning } : {}),
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

/** Trim + cap the adapter's reasoning text for the local session log. */
function capReasoningText(text: string | undefined): BridgeDecisionReasoning | undefined {
  const trimmed = text?.trim();
  if (trimmed === undefined || trimmed === "") return undefined;
  if (trimmed.length <= REASONING_CAPTURE_MAX_CHARS) return { text: trimmed };
  return { text: `${trimmed.slice(0, REASONING_CAPTURE_MAX_CHARS)}…[truncated]`, truncated: true };
}

/** Minimal view of the resolved profile fields the decision-budget clamp reads. */
interface BudgetedProfile {
  readonly maxTokens: number;
}

/** A finite, positive number or `Infinity` (the "no cap" identity for min). */
function positiveOrInfinity(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : Infinity;
}

/**
 * The max output tokens the FIRST decision call may request: the profile's
 * configured maxTokens (the sole authority), bounded only by the model's own
 * output ceiling so an over-large value can't trigger a provider 400. An
 * unknown ceiling is not clamped.
 */
export function effectiveDecisionBudget(
  resolved: BudgetedProfile,
  modelCeiling: number | undefined,
): number {
  return Math.min(
    positiveOrInfinity(resolved.maxTokens),
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
 * Wall-time bound for a single decision call: min(server turn deadline, client
 * requestMs), then clamped to [MIN_DECISION_TIMEOUT_MS, GLOBAL_DECISION_HARD_CAP_MS]
 * so a missing or absurd value can never run unbounded. `requestMs` is the
 * client's own per-call budget — set it shorter than the turn to fit several
 * calls inside one turn; the platform only requires a legal decision within the
 * turn deadline and never reads requestMs itself. Whichever bound is absent
 * drops out (server 0 = "no deadline" → requestMs governs; no requestMs → the
 * server deadline governs). Floored so a zero/tiny input never starves the
 * call. Exported for unit testing.
 */
export function clampDecisionTimeout(serverMs: number, profileRequestMs: number | undefined): number {
  const hasServer = typeof serverMs === "number" && Number.isFinite(serverMs) && serverMs > 0;
  const hasReq =
    typeof profileRequestMs === "number" && Number.isFinite(profileRequestMs) && profileRequestMs > 0;
  if (hasServer) {
    // A positive server deadline is authoritative. Bound the call by
    // min(server, requestMs) and only CAP it — never round it UP to the floor:
    // flooring a near-deadline retry back to MIN_DECISION_TIMEOUT_MS would spend a
    // paid call the platform has already timed out. min(requestMs, server) exactly
    // (spec §1/§3). The caller skips the call when this is too small to be useful.
    const base = hasReq ? Math.min(serverMs, profileRequestMs!) : serverMs;
    return Math.min(base, GLOBAL_DECISION_HARD_CAP_MS);
  }
  // No server deadline (server 0 = "no deadline"): requestMs governs, or the hard
  // cap if it too is absent. Floor so a zero/tiny requestMs never starves the call.
  const base = hasReq ? profileRequestMs! : GLOBAL_DECISION_HARD_CAP_MS;
  return Math.max(Math.min(base, GLOBAL_DECISION_HARD_CAP_MS), MIN_DECISION_TIMEOUT_MS);
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
  // Platform rules summary (game_start) before the user's strategy: facts
  // first, then how the owner wants to play them.
  const rulesBlock = renderRulesBlock(req.matchContext);
  if (rulesBlock !== "") system.push("", rulesBlock);
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
  const parts: string[] = [];
  // Texas plays from the same narrated view the platform's house bots decide
  // on (owner 拍板 2026-07-22: 信息呈现拉平); every other game keeps the
  // legacy JSON dump, byte-identical.
  const texas = renderTexasTurn(req);
  // Match history (accumulated player-view events, rendered fresh each turn):
  // completed hands/rounds + this round's step-by-step actions — so the model
  // reasons over the match, not just the current snapshot.
  const historyBlock = texas !== undefined ? texas.historyText : renderHistoryBlock(req.matchContext);
  if (texas !== undefined) {
    if (historyBlock !== "") parts.push(historyBlock);
    parts.push(
      `CURRENT TURN — Texas Hold'em, narrated view of the live state:\n${texas.stateText}\n\n` +
        `Your legal actions — reply with EXACTLY one, using the exact JSON shape listed:\n${JSON.stringify(req.legalActions)}`,
    );
  } else if (historyBlock !== "") {
    parts.push(historyBlock);
    parts.push(`CURRENT TURN (state + legal actions):\n${base}`);
  } else {
    parts.push(base);
  }
  // §3 Phase A corrective retry: surface what was wrong with the previous
  // reply as plain text after the JSON payload — explicit instructions beat
  // a field buried in the state dump.
  const feedback = req.illegalFeedback;
  if (feedback !== undefined) {
    parts.push(
      `RETRY ${feedback.attempt}: ${feedback.message}\nYour previous invalid reply was:\n${feedback.priorRaw}`,
    );
  }
  return { systemPrompt: system.join("\n"), userPrompt: parts.join("\n\n") };
}

function renderRulesBlock(context: BridgeMatchContext | undefined): string {
  const rules = context?.rules;
  if (rules === undefined) return "";
  const lines: string[] = ["Game rules (from the platform):"];
  if (rules.summary !== undefined && rules.summary !== "") {
    lines.push(hardCap(rules.summary, RULES_SUMMARY_MAX_CHARS));
  }
  for (const rule of (rules.keyRules ?? []).slice(0, RULES_MAX_KEY_RULES)) {
    lines.push(`- ${hardCap(rule, RULES_KEY_RULE_MAX_CHARS)}`);
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

/**
 * Render the accumulated player-view event log, oldest first, newest always
 * kept. Pure function of the raw events — no cross-turn render state.
 */
function renderHistoryBlock(context: BridgeMatchContext | undefined): string {
  const events = context?.events ?? [];
  if (events.length === 0) return "";
  const kept = events.slice(-HISTORY_MAX_EVENTS);
  let lines = kept.map(renderEventLine);
  // Char budget: drop oldest lines first — the tail (current round) matters most.
  while (lines.length > 1 && lines.join("\n").length > HISTORY_MAX_BLOCK_CHARS) {
    lines = lines.slice(1);
  }
  const omitted = events.length - lines.length;
  const header =
    omitted > 0
      ? `MATCH HISTORY — your view, oldest first (${omitted} earlier events omitted):`
      : "MATCH HISTORY — your view, oldest first:";
  return [header, ...lines].join("\n");
}

function renderEventLine(event: MatchEventRecord): string {
  const actor = event.playerId !== undefined ? ` ${event.playerId}` : "";
  const data = event.data === undefined ? "" : ` ${safeCompactJSON(event.data)}`;
  return hardCap(`#${event.seq}${actor} ${event.type}${data}`, HISTORY_MAX_LINE_CHARS);
}

// ─── Texas Hold'em narrated turn (2026-07-22) ────────────────────────
//
// For texas the raw-JSON state dump is replaced with the same narrated view
// the platform's house bots decide on (hand X of Y, board, position, stacks,
// cash running results), and match history renders hand starts / results /
// match result as sentences instead of compact JSON. legal_actions stay
// verbatim JSON — they are the response-shape contract. Defensive: any shape
// surprise falls back to the generic JSON path unchanged.

const TEXAS_SETTLEMENT_TYPES = new Set(["new_hand", "hand_result", "match_result"]);

interface TexasTurnBlocks {
  stateText: string;
  historyText: string;
}

function renderTexasTurn(req: BridgeRuntimeDecisionRequest): TexasTurnBlocks | undefined {
  if (req.game !== "texas_holdem") return undefined;
  const raw = req.publicState;
  if (typeof raw !== "object" || raw === null) return undefined;
  const publicState = raw as TexasHoldemState;
  const statePid = (publicState as { your_player_id?: unknown }).your_player_id;
  const yourPlayerId = req.playerId ?? (typeof statePid === "string" ? statePid : "");
  const players = synthesizeTexasPlayerInfos(publicState);
  const { stateBlock } = formatTexasHoldemState({
    publicState,
    // stateBlock never reads rules — the platform rules render separately in
    // the system prompt; the formatter input merely requires the field.
    rules: undefined as unknown as TexasHoldemRules,
    players,
    recentEvents: [],
    yourPlayerId,
  });
  if (stateBlock === "") return undefined;
  return {
    stateText: stateBlock,
    historyText: renderTexasHistoryBlock(req.matchContext, players, yourPlayerId),
  };
}

// The per-turn state's players[] entries carry id/status/chips/bet (wire
// schema); lift them into the PlayerInfo shape the formatter's opponent lines
// read. Anonymized by construction — only public seat data is present.
function synthesizeTexasPlayerInfos(state: TexasHoldemState): PlayerInfo[] {
  const seats = (state as { players?: unknown }).players;
  if (!Array.isArray(seats)) return [];
  const out: PlayerInfo[] = [];
  for (const seat of seats) {
    if (typeof seat !== "object" || seat === null) continue;
    const p = seat as { id?: unknown; status?: unknown; chips?: unknown; bet?: unknown };
    if (typeof p.id !== "string") continue;
    out.push({
      id: p.id,
      status: (typeof p.status === "string" ? p.status : "active") as PlayerInfo["status"],
      data: { chips: p.chips, bet: p.bet },
    } as PlayerInfo);
  }
  return out;
}

/**
 * Texas match history: same budgets as the generic renderer, but settlement
 * lines (hand starts, hand results, match result) are dropped LAST — the
 * hand-by-hand ledger is what lets the model reason about the whole match
 * (who is ahead, how many hands remain), and it is tiny (≤ ~21 lines per
 * 10-hand match) while per-street actions dominate the event count.
 */
function renderTexasHistoryBlock(
  context: BridgeMatchContext | undefined,
  players: readonly PlayerInfo[],
  yourPlayerId: string,
): string {
  const events = context?.events ?? [];
  if (events.length === 0) return "";
  const entries = events.map((ev) => {
    const wireEvent = {
      type: ev.type,
      seq: ev.seq,
      ts: 0,
      ...(ev.playerId !== undefined ? { player: ev.playerId } : {}),
      ...(ev.data !== undefined ? { data: ev.data } : {}),
    } as unknown as Event;
    return {
      line: hardCap(formatTexasHoldemEventLine(wireEvent, players, yourPlayerId), HISTORY_MAX_LINE_CHARS),
      settlement: TEXAS_SETTLEMENT_TYPES.has(ev.type),
    };
  });
  // Event-count budget: keep every settlement line, fill the rest of the
  // budget with the newest non-settlement lines.
  const settlementCount = entries.reduce((n, e) => (e.settlement ? n + 1 : n), 0);
  const keep = entries.map((e) => e.settlement);
  let budget = Math.max(0, HISTORY_MAX_EVENTS - settlementCount);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!entries[i]!.settlement && budget > 0) {
      keep[i] = true;
      budget--;
    }
  }
  let kept = entries.filter((_, i) => keep[i]);
  // Char budget: drop oldest non-settlement lines first; only if settlements
  // alone still bust the budget do they start dropping oldest-first too.
  const totalChars = () => kept.reduce((n, e) => n + e.line.length + 1, 0);
  while (kept.length > 1 && totalChars() > HISTORY_MAX_BLOCK_CHARS) {
    const idx = kept.findIndex((e) => !e.settlement);
    kept.splice(idx >= 0 ? idx : 0, 1);
  }
  const omitted = events.length - kept.length;
  const header =
    omitted > 0
      ? `MATCH HISTORY — your view, oldest first (${omitted} earlier events omitted):`
      : "MATCH HISTORY — your view, oldest first:";
  return [header, ...kept.map((e) => e.line)].join("\n");
}

function safeCompactJSON(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function hardCap(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
