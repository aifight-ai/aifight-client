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
import { resolveLocale, t } from "../i18n.js";
import { createOutput, type KvRow } from "../output.js";
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
        truncated: true,
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
      ...(output.truncated ? { truncated: true } : {}),
    };
  } catch (err) {
    return {
      success: false,
      latencyMs: Date.now() - t0,
      model: profile.model,
      protocol: profile.protocol,
      ...(err instanceof Object && (err as { tokenLimit?: unknown }).tokenLimit === true ? { truncated: true } : {}),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The outcome of resolving a configured profile and running a faithful probe.
 * `ok: false` = a pre-probe resolution failure (config load / unknown profile /
 * secret / adapter); `ok: true` = the probe ran (see `result.success` for
 * whether the model actually responded).
 *
 * Shared by `config test` (runConfigProbe) and `config add`/`update`'s D7
 * auto-test so all three exercise the identical resolution + faithfulProbe path.
 */
export type ProbeOutcome =
  | { readonly ok: true; readonly profileName: string; readonly result: ProbeResult }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Info handed to the pre-probe callback so callers can print a "testing…" banner. */
export interface PreProbeInfo {
  readonly profileName: string;
  readonly protocol: string;
  readonly model: string;
  readonly thinkingOn: boolean;
}

export async function resolveAndProbe(
  slug: string,
  profileName: string | undefined,
  env: HandlerEnv,
  onBeforeProbe?: (info: PreProbeInfo) => void,
): Promise<ProbeOutcome> {
  const agentDir = resolveAgentDir(slug);

  // Step 1: Load and validate the agent profile.
  let agentProfile: Awaited<ReturnType<typeof loadAgentProfile>>;
  try {
    agentProfile = await loadAgentProfile(agentDir);
  } catch (cause) {
    const message =
      cause instanceof ProfileLoadError || cause instanceof Error ? cause.message : String(cause);
    return { ok: false, code: "config_probe_load_failed", message };
  }

  const { config } = agentProfile.profile;

  // Step 2: Resolve target profile name.
  const targetProfileName = profileName ?? config.activeProfile;
  const profileDef = config.profiles[targetProfileName];
  if (!profileDef) {
    const available = Object.keys(config.profiles).join(", ");
    return {
      ok: false,
      code: "config_probe_unknown_profile",
      message: `unknown profile "${targetProfileName}". Available: ${available}`,
    };
  }

  // Step 3: Resolve the API key.
  let apiKey: string;
  try {
    apiKey = await resolveSecret(profileDef.apiKeyRef);
  } catch (cause) {
    const message =
      cause instanceof SecretResolutionError || cause instanceof Error ? cause.message : String(cause);
    return { ok: false, code: "config_probe_secret_failed", message };
  }

  // Step 4: Register adapters and get the one for this profile's protocol.
  await registerBuiltinAdapters();
  let adapter: ReturnType<typeof requireAdapter>;
  try {
    adapter = requireAdapter(profileDef.protocol);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, code: "config_probe_no_adapter", message };
  }

  // Step 5: Build the resolved LLMProfile. The shared mapper applies a
  // protocol-default baseURL when the profile omits one (every adapter
  // requires baseURL).
  const resolvedProfile = resolveLLMProfile(targetProfileName, profileDef, apiKey);

  if (onBeforeProbe) {
    const r = resolvedProfile.reasoning;
    const thinkingOn = r !== undefined && r.enabled !== false && r.mode !== "disabled";
    onBeforeProbe({
      profileName: targetProfileName,
      protocol: profileDef.protocol,
      model: profileDef.model,
      thinkingOn,
    });
  }

  // Step 6: Run a FAITHFUL test — a real decision call using the profile's
  // actual reasoning + max tokens (see faithfulProbe), not a stripped-down ping.
  const result = await faithfulProbe(adapter, resolvedProfile);
  return { ok: true, profileName: targetProfileName, result };
}

export async function runConfigProbe(
  args: HandlerArgs,
  env: HandlerEnv,
): Promise<number> {
  expectArity(args, 0, 1, USAGE);

  const slug = (args.positional[0] as string | undefined) ?? "default";
  const profileFlag =
    typeof args.flags["profile"] === "string" ? args.flags["profile"] : undefined;

  // U7: the wait line and the result block below are what `aifight setup`
  // shows while the wizard's live test runs, so they speak the display
  // locale like the rest of the wizard. --json (built separately, below) and
  // every machine field stay English and byte-stable.
  const loc = env.locale?.() ?? resolveLocale();
  const out = createOutput();

  const outcome = await resolveAndProbe(slug, profileFlag, env, (info) => {
    if (!args.jsonMode) {
      env.stdout(
        t(loc, info.thinkingOn ? "llmhub.probe.testing.reasoning" : "llmhub.probe.testing", {
          profile: info.profileName,
          protocol: info.protocol,
          model: info.model,
        }) + "\n",
      );
    }
  });

  // Pre-probe resolution failure → same exit code as before, now through P6's
  // one failure shape instead of three hand-prefixed `aifight: …` lines.
  if (!outcome.ok) {
    if (args.jsonMode) {
      env.stderr(JSON.stringify({ error: { code: outcome.code, message: outcome.message } }) + "\n");
    } else {
      const key =
        outcome.code === "config_probe_load_failed"
          ? "llmhub.probe.fail.load"
          : outcome.code === "config_probe_secret_failed"
            ? "llmhub.probe.fail.secret"
            : "llmhub.probe.fail.other";
      env.stderr(out.fail(t(loc, key, { error: outcome.message })));
    }
    return 1;
  }

  const probeResult = outcome.result;

  if (args.jsonMode) {
    env.stdout(
      JSON.stringify({
        agentSlug: slug,
        profile: outcome.profileName,
        protocol: probeResult.protocol,
        model: probeResult.model,
        success: probeResult.success,
        latencyMs: probeResult.latencyMs,
        jsonValid: probeResult.jsonValid ?? null,
        truncated: probeResult.truncated ?? false,
        error: probeResult.error ?? null,
      }) + "\n",
    );
    return probeResult.success ? 0 : 1;
  }

  // The label column sizes itself, so zh labels never glue onto their values.
  const rows: KvRow[] = [
    // P6's colours: errors are red, warnings yellow. The kit's Tone has no
    // red (nothing else needs one), so the failed word is pre-styled and
    // passes through the "default" tone untouched.
    probeResult.success
      ? [t(loc, "llmhub.probe.label.result"), t(loc, "llmhub.probe.value.ok"), "green"]
      : [t(loc, "llmhub.probe.label.result"), out.ansi.red(t(loc, "llmhub.probe.value.failed"))],
    [t(loc, "llmhub.probe.label.latency"), t(loc, "llmhub.probe.value.latency", { ms: probeResult.latencyMs })],
  ];
  if (probeResult.success && probeResult.jsonValid !== undefined) {
    rows.push([
      t(loc, "llmhub.probe.label.json"),
      t(loc, probeResult.jsonValid ? "llmhub.probe.value.yes" : "llmhub.probe.value.no"),
    ]);
  }
  if (!probeResult.success) {
    rows.push([
      t(loc, "llmhub.probe.label.error"),
      probeResult.error ?? t(loc, "llmhub.probe.value.error_unknown"),
    ]);
  }
  rows.push([t(loc, "llmhub.probe.label.model"), probeResult.model]);
  rows.push([t(loc, "llmhub.probe.label.protocol"), probeResult.protocol]);
  env.stdout(out.kvRows(rows).join("\n") + "\n");
  if (probeResult.success && probeResult.truncated) {
    env.stdout(`  ${out.ansi.yellow(`⚠ ${t(loc, "llmhub.probe.truncated")}`)}\n`);
  }
  env.stdout("\n");

  return probeResult.success ? 0 : 1;
}
