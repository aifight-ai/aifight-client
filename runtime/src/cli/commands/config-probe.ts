// `aifight config probe [agent-slug] [--profile name]` — Test LLM connectivity.
//
// Loads the agent's config.json, resolves the target profile (default
// or --profile <name>), resolves the API key via SecretRef, and calls
// the adapter's probe() method. Prints latency, JSON validity, and any
// error.
//
// Behavior:
//   1. Resolve agent slug (positional arg or "default").
//   2. loadAgentProfile — reads and validates config.json (and other files).
//   3. Select target profile: --profile flag or config.activeProfile.
//   4. resolveSecret — obtain the raw API key from the SecretRef.
//   5. registerBuiltinAdapters + requireAdapter for the profile's protocol.
//   6. Run faithfulProbe — a real decision call using the profile's actual
//      reasoning + max tokens (thinking on by default), not a stripped ping.
//   7. Print ProbeResult (latency, jsonValid, error if any).
//
// Errors:
//   - ProfileLoadError / unknown profile / secret resolution failure →
//     print message + exit 1.
//   - extra positional → UsageError → exit 2 via main.ts funnel.

import type { HandlerArgs, HandlerEnv } from "../shared.js";
import { expectArity } from "../shared.js";
import {
  loadAgentProfile,
  resolveAgentDir,
  ProfileLoadError,
} from "../../profile/profile-loader.js";
import {
  resolveSecret,
  SecretResolutionError,
} from "../../profile/secret-ref.js";
import {
  requireAdapter,
  registerBuiltinAdapters,
} from "../../llm/adapter-registry.js";
import type { LLMAdapter, LLMProfile, ProbeResult } from "../../llm/adapters/types.js";
import { resolveLLMProfile } from "../../llm/resolve-profile.js";

const USAGE = "usage: aifight config probe [agent-slug] [--profile name]";

/**
 * Run a FAITHFUL test of a profile: a real decision call using the profile's
 * actual reasoning settings (thinking on by default) and max tokens, so a
 * reasoning model is exercised the way it will actually play. This is what
 * `aifight config test` and the setup wizard use — unlike the lightweight
 * `adapter.probe()` (kept cheap for health monitoring), this never disables
 * thinking and never caps tokens, and it explains the reasoning-ate-the-budget
 * failure so the user can raise max tokens or lower effort.
 */
export async function faithfulProbe(
  adapter: Pick<LLMAdapter, "generateDecision">,
  profile: LLMProfile,
): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const output = await adapter.generateDecision(
      {
        systemPrompt: "You are a connectivity probe for AIFight. Answer with one tiny JSON object only.",
        userPrompt: 'Reply with EXACTLY this JSON and nothing else: {"ok":true}',
        maxTokens: profile.maxTokens,
        temperature: profile.temperature,
        ...(profile.reasoning !== undefined ? { reasoning: profile.reasoning } : {}),
        ...(profile.responseFormat !== undefined
          ? { responseFormat: profile.responseFormat as "json" | "json_object" | "json_schema" | "text" }
          : {}),
      },
      profile,
    );
    const text = (output.text ?? "").trim();
    if (text === "") {
      return {
        success: false,
        latencyMs: output.latencyMs ?? Date.now() - t0,
        model: profile.model,
        protocol: profile.protocol,
        error:
          "the model returned no text — its token budget was likely spent on reasoning. Raise max tokens or lower the reasoning effort, then test again.",
      };
    }
    let jsonValid = false;
    try {
      const parsed = JSON.parse(text) as unknown;
      jsonValid = typeof parsed === "object" && parsed !== null;
    } catch {
      jsonValid = false;
    }
    return {
      success: true,
      latencyMs: output.latencyMs ?? Date.now() - t0,
      model: profile.model,
      protocol: profile.protocol,
      jsonValid,
    };
  } catch (err) {
    return {
      success: false,
      latencyMs: Date.now() - t0,
      model: profile.model,
      protocol: profile.protocol,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runConfigProbe(
  args: HandlerArgs,
  env: HandlerEnv,
): Promise<number> {
  expectArity(args, 0, 1, USAGE);

  const slug = (args.positional[0] as string | undefined) ?? "default";
  const profileFlag =
    typeof args.flags["profile"] === "string" ? args.flags["profile"] : undefined;

  const agentDir = resolveAgentDir(slug);

  // Step 1: Load and validate the agent profile.
  let agentProfile: Awaited<ReturnType<typeof loadAgentProfile>>;
  try {
    agentProfile = await loadAgentProfile(agentDir);
  } catch (cause) {
    const msg =
      cause instanceof ProfileLoadError || cause instanceof Error
        ? cause.message
        : String(cause);
    if (args.jsonMode) {
      env.stderr(
        JSON.stringify({ error: { code: "config_probe_load_failed", message: msg } }) + "\n",
      );
    } else {
      env.stderr(`aifight: config probe: failed to load profile: ${msg}\n`);
    }
    return 1;
  }

  const { config } = agentProfile.profile;

  // Step 2: Resolve target profile name.
  const targetProfileName = profileFlag ?? config.activeProfile;
  const profileDef = config.profiles[targetProfileName];
  if (!profileDef) {
    const available = Object.keys(config.profiles).join(", ");
    const msg = `unknown profile "${targetProfileName}". Available: ${available}`;
    if (args.jsonMode) {
      env.stderr(
        JSON.stringify({ error: { code: "config_probe_unknown_profile", message: msg } }) + "\n",
      );
    } else {
      env.stderr(`aifight: config probe: ${msg}\n`);
    }
    return 1;
  }

  // Step 3: Resolve the API key.
  let apiKey: string;
  try {
    apiKey = await resolveSecret(profileDef.apiKeyRef);
  } catch (cause) {
    const msg =
      cause instanceof SecretResolutionError || cause instanceof Error
        ? cause.message
        : String(cause);
    if (args.jsonMode) {
      env.stderr(
        JSON.stringify({ error: { code: "config_probe_secret_failed", message: msg } }) + "\n",
      );
    } else {
      env.stderr(`aifight: config probe: cannot resolve API key: ${msg}\n`);
    }
    return 1;
  }

  // Step 4: Register adapters and get the one for this profile's protocol.
  await registerBuiltinAdapters();
  let adapter: ReturnType<typeof requireAdapter>;
  try {
    adapter = requireAdapter(profileDef.protocol);
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    if (args.jsonMode) {
      env.stderr(
        JSON.stringify({ error: { code: "config_probe_no_adapter", message: msg } }) + "\n",
      );
    } else {
      env.stderr(`aifight: config probe: ${msg}\n`);
    }
    return 1;
  }

  // Step 5: Build the resolved LLMProfile. The shared mapper applies a
  // protocol-default baseURL when the profile omits one (every adapter
  // requires baseURL).
  const resolvedProfile = resolveLLMProfile(targetProfileName, profileDef, apiKey);

  // Step 6: Run a FAITHFUL test — a real decision call using the profile's
  // actual reasoning + max tokens (see faithfulProbe), not a stripped-down ping.
  if (!args.jsonMode) {
    const r = resolvedProfile.reasoning;
    const thinkingOn = r !== undefined && r.enabled !== false && r.mode !== "disabled";
    env.stdout(
      `aifight config test: testing profile "${targetProfileName}" (${profileDef.protocol}, ${profileDef.model})` +
        `${thinkingOn ? " with reasoning — this may take a few seconds" : ""}...\n`,
    );
  }

  const probeResult = await faithfulProbe(adapter, resolvedProfile);

  if (args.jsonMode) {
    env.stdout(
      JSON.stringify({
        agentSlug: slug,
        profile: targetProfileName,
        protocol: probeResult.protocol,
        model: probeResult.model,
        success: probeResult.success,
        latencyMs: probeResult.latencyMs,
        jsonValid: probeResult.jsonValid ?? null,
        error: probeResult.error ?? null,
      }) + "\n",
    );
    return probeResult.success ? 0 : 1;
  }

  if (probeResult.success) {
    env.stdout(`  result      : OK\n`);
    env.stdout(`  latency     : ${probeResult.latencyMs} ms\n`);
    if (probeResult.jsonValid !== undefined) {
      env.stdout(`  json valid  : ${probeResult.jsonValid ? "yes" : "no"}\n`);
    }
    env.stdout(`  model       : ${probeResult.model}\n`);
    env.stdout(`  protocol    : ${probeResult.protocol}\n`);
    env.stdout("\n");
  } else {
    env.stdout(`  result      : FAILED\n`);
    env.stdout(`  latency     : ${probeResult.latencyMs} ms\n`);
    env.stdout(`  error       : ${probeResult.error ?? "(unknown)"}\n`);
    env.stdout(`  model       : ${probeResult.model}\n`);
    env.stdout(`  protocol    : ${probeResult.protocol}\n`);
    env.stdout("\n");
  }

  return probeResult.success ? 0 : 1;
}
