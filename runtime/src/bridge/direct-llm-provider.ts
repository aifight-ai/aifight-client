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
import type { LLMConfig } from "../profile/config-schema.js";
import { loadAgentProfile, resolveAgentDir } from "../profile/profile-loader.js";
import { resolveSecret } from "../profile/secret-ref.js";
import type {
  BridgeRuntimeDecisionRequest,
  BridgeRuntimeDecisionResult,
  BridgeRuntimeProvider,
} from "./provider.js";

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
      const output = await adapter.generateDecision(
        {
          systemPrompt,
          userPrompt,
          maxTokens: resolved.maxTokens,
          temperature: resolved.temperature,
          responseFormat: "json",
          ...(req.timeoutMs > 0 ? { signal: AbortSignal.timeout(req.timeoutMs) } : {}),
        },
        resolved,
      );
      // §7A: hand the adapter-parsed token counts up with the text, so the
      // runner can append the local usage ledger. Counts only — never the
      // prompt or the raw response.
      return {
        raw: output.text,
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
