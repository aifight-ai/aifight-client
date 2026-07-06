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

      const callWith = (maxTokens: number, timeoutMs: number) =>
        adapter.generateDecision(
          {
            systemPrompt,
            userPrompt,
            maxTokens,
            temperature: resolved.temperature,
            responseFormat: "json",
            ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
          },
          resolved,
        );

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
      const raiseTarget = (cur: number): number | undefined => {
        const to = ceiling ?? Math.max(65536, cur * 2);
        return to > cur ? to : undefined;
      };
      const startedAtMs = Date.now();
      const remainingMs = (): number =>
        req.timeoutMs > 0 ? req.timeoutMs - (Date.now() - startedAtMs) : 0;

      let selfHealed: { from: number; to: number } | undefined;
      let output: Awaited<ReturnType<typeof callWith>> | undefined;
      let firstError: unknown;
      try {
        output = await callWith(resolved.maxTokens, req.timeoutMs);
      } catch (err) {
        if (!isTokenLimitError(err)) throw tagProfile(err, resolved.profileId); // non-token → fallback
        firstError = err; // token-limit throw (e.g. empty-because-truncated)
      }

      // Self-heal exactly once, only when the first call was cut off by the cap.
      if (output?.truncated === true || firstError !== undefined) {
        const to = raiseTarget(resolved.maxTokens);
        // timeoutMs === 0 means "no turn deadline" → always allowed.
        const budgetOk = req.timeoutMs === 0 || remainingMs() >= MIN_SELF_HEAL_BUDGET_MS;
        if (to !== undefined && budgetOk) {
          selfHealed = { from: resolved.maxTokens, to };
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
