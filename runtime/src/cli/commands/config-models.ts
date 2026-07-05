// `aifight config models [profile] [agent-slug]` — list the models a configured
// profile's provider exposes, so a headless user can pick one for
// `config update <profile> --model <name>`.
//
// Reuses the SAME discovery the interactive wizard uses (onboard-io
// discoverModels). Gemini has no list endpoint of this shape, so it is reported
// explicitly rather than as a silent empty result (D11).

import type { HandlerArgs, HandlerEnv } from "../shared.js";
import { expectArity } from "../shared.js";
import { resolveSecret, SecretResolutionError } from "../../profile/secret-ref.js";
import { protocolDefaultBaseURL } from "../../llm/resolve-profile.js";
import { discoverModels } from "./onboard-io.js";
import { readExistingConfig } from "./config-edit.js";
import { configError } from "./config-shared.js";
import type { Protocol } from "../../profile/config-schema.js";

const USAGE = "usage: aifight config models [profile] [agent-slug]";

export async function runConfigModels(args: HandlerArgs, env: HandlerEnv): Promise<number> {
  expectArity(args, 0, 2, USAGE);
  const profileArg = args.positional[0] as string | undefined;
  const slug = (args.positional[1] as string | undefined) ?? "default";

  const config = await readExistingConfig(slug);
  if (!config) {
    throw configError("config_models_no_config", {
      problem: "no LLM config on this machine yet",
      next: "Create one first: `aifight config add <profile> --protocol … --env …`, or run `aifight config`.",
    });
  }
  const profileId = profileArg ?? config.activeProfile;
  const profile = config.profiles[profileId];
  if (!profile) {
    throw configError("config_models_unknown_profile", {
      problem: `unknown profile "${profileId}"`,
      valid: `Available profiles: ${Object.keys(config.profiles).join(", ") || "(none)"}`,
      example: "aifight config models",
    });
  }

  // Gemini's generateContent API has no OpenAI-style /models list — say so
  // clearly instead of returning an empty list (D11).
  if (isGeminiProtocol(profile.protocol)) {
    if (args.jsonMode) {
      env.stdout(JSON.stringify({ profile: profileId, protocol: profile.protocol, models: null, supported: false }) + "\n");
      return 0;
    }
    env.stdout(
      [
        `Model listing is not available for ${profile.protocol}.`,
        `Set the model directly: aifight config update ${profileId} --model <name>`,
        "Find current model ids on Google's Gemini API docs.",
        "",
      ].join("\n"),
    );
    return 0;
  }

  let apiKey: string;
  try {
    apiKey = await resolveSecret(profile.apiKeyRef);
  } catch (cause) {
    const message = cause instanceof SecretResolutionError || cause instanceof Error ? cause.message : String(cause);
    throw configError("config_models_secret", {
      problem: `cannot resolve the API key for "${profileId}": ${message}`,
      next: `Fix the key source, then retry. Inspect it with \`aifight config show\`.`,
    });
  }

  const baseURL = profile.baseURL && profile.baseURL.length > 0 ? profile.baseURL : protocolDefaultBaseURL(profile.protocol);
  const models = await discoverModels(env, { protocol: profile.protocol as Protocol, baseURL, apiKey });

  if (args.jsonMode) {
    env.stdout(JSON.stringify({ profile: profileId, protocol: profile.protocol, models: models ?? [], supported: true }) + "\n");
    return 0;
  }

  if (!models || models.length === 0) {
    env.stdout(
      [
        `Could not list models for "${profileId}" (${profile.protocol}).`,
        "The provider may not expose a model list, or the key/base URL may be wrong.",
        `Set the model directly: aifight config update ${profileId} --model <name>`,
        "",
      ].join("\n"),
    );
    return 0;
  }

  env.stdout(`Models available to "${profileId}" (${profile.protocol}):\n`);
  models.slice(0, 50).forEach((m, i) => env.stdout(`  ${String(i + 1).padStart(2)}) ${m}\n`));
  if (models.length > 50) env.stdout(`  … and ${models.length - 50} more\n`);
  env.stdout(`\nSelect one with: aifight config update ${profileId} --model <name>\n\n`);
  return 0;
}

function isGeminiProtocol(protocol: string): boolean {
  return protocol === "gemini_generate_content";
}
