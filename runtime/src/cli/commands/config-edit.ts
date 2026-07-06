// `aifight config add` / `aifight config update` — headless LLM profile
// configuration. These are the command-line equivalents of the interactive
// wizard: they build a profile through the SAME shared builder (buildLLMProfile)
// and write it to the SAME config.json the desktop app reads, then run the SAME
// faithful probe the wizard uses.
//
// Design authority: docs/agent-bridge/CLI_LLM_CONFIG_COMMANDS_SPEC.md
//   D3  required-flag minimization (compat needs base-url + model)
//   D4  key source: --env / --file / --key-stdin (raw key never in argv)
//   D5  defaults (model / maxTokens 32000 / stream auto / thinking on / temp omitted)
//   D6  add refuses to overwrite an existing profile
//   D7  auto-test after write (unless --no-test); config kept on test failure
//   D8  first resolvable profile becomes active; later adds don't steal unless --use
//   D9  update refuses --protocol
//   D12 verbosity / features gating

import fs from "node:fs/promises";
import path from "node:path";

import type { HandlerArgs, HandlerEnv } from "../shared.js";
import { CommandError, UsageError } from "../shared.js";
import { resolveAgentDir, ensureAgentDir } from "../../profile/profile-loader.js";
import {
  validateConfig,
  type LLMConfig,
  type LLMProfile,
  type Protocol,
  type ReasoningEffort,
  type SecretRef,
} from "../../profile/config-schema.js";
import { resolveModelCapabilities, recommendMaxTokens } from "../../llm/capabilities/validate-capabilities.js";
import { storeSecretFile, describeRef, checkSecretStatus } from "../../profile/secret-ref.js";
import { resolveAndProbe } from "./config-probe.js";
import { ONBOARD_PROVIDERS } from "./onboard-llm.js";
import {
  buildLLMProfile,
  configError,
  onOffFlag,
  parseFeatureFlags,
  protocolChoicesHint,
  protocolRequiresBaseURLAndModel,
  protocolSuggestionPool,
  resolveProtocol,
  stringFlag,
  numberFlag,
  boolFlag,
  suggestClosest,
  type ProfileBuildSettings,
} from "./config-shared.js";

const DEFAULT_MAX_TOKENS = 32000;
const MIN_MAX_TOKENS = 256;

const ADD_USAGE = [
  "usage: aifight config add <profile> --protocol <claude|gpt|compat|gemini> (--env NAME | --file PATH | --key-stdin)",
  "         [--base-url URL] [--model NAME] [--display-name S] [--max-tokens N]",
  "         [--stream auto|always|never] [--thinking on|off] [--effort LEVEL]",
  "         [--temperature T] [--verbosity low|medium|high] [--feature k=on|off ...]",
  "         [--use] [--no-test] [agent-slug]",
].join("\n");

const PROFILE_ID_RE = /^[a-zA-Z0-9_-]{1,40}$/;

// ─── add ─────────────────────────────────────────────────────────────

export async function runConfigAdd(args: HandlerArgs, env: HandlerEnv): Promise<number> {
  const profileId = args.positional[0];
  if (profileId === undefined || profileId.trim() === "") {
    throw new UsageError("config add requires a <profile> id", ADD_USAGE);
  }
  if (!PROFILE_ID_RE.test(profileId)) {
    throw configError("config_add_bad_id", {
      problem: `invalid profile id "${profileId}"`,
      valid: "A profile id is 1–40 chars of letters, numbers, _ or -.",
      example: "aifight config add deepseek --protocol compat --base-url https://api.deepseek.com/v1 --model deepseek-chat --env DEEPSEEK_API_KEY",
    });
  }
  const slug = (args.positional[1] as string | undefined) ?? "default";

  // ── protocol (required) ──
  const protocol = requireProtocolFlag(args);

  // ── existing config? (D6 overwrite guard) ──
  const existing = await readExistingConfig(slug);
  if (existing?.profiles[profileId]) {
    throw configError("config_add_exists", {
      problem: `profile "${profileId}" already exists`,
      valid: "`config add` never overwrites an existing profile.",
      example: `aifight config update ${profileId} --model <new-model>`,
      next: `To change it, use \`aifight config update ${profileId} …\`; to replace it, \`aifight config remove ${profileId}\` first.`,
    });
  }

  // ── base URL + model (D3) ──
  const { baseURL, model } = resolveBaseUrlAndModel(protocol, args);

  // ── key source (D4) ──
  const apiKeyRef = await resolveKeyRef({ slug, profileId, args, env });

  // ── settings (D5 defaults + capability-aware validation) ──
  const resolvedSettings = resolveProfileSettings(protocol, model, args.flags, undefined);
  // ── D4: reconcile maxTokens with reasoning effort ──
  const rec = applyEffortTokenRecommendation(resolvedSettings, protocol, model, numberFlag(args.flags, "max-tokens"));

  const displayName = stringFlag(args.flags, "display-name") ?? defaultDisplayName(protocol);
  const profile = buildLLMProfile({ displayName, protocol, ...(baseURL ? { baseURL } : {}), apiKeyRef, model, settings: rec.settings });

  // ── merge + D8 active selection ──
  const setActive = boolFlag(args.flags, "use") || (await shouldBecomeActive(existing));
  const config = mergeProfile(existing, profileId, profile, setActive);

  return finishEdit({ slug, profileId, config, action: "add", setActive, args, env, ...(rec.note ? { notes: [rec.note] } : {}) });
}

// ─── update ──────────────────────────────────────────────────────────

const UPDATE_USAGE = [
  "usage: aifight config update <profile> [--model NAME] [--base-url URL] [--display-name S]",
  "         [--env NAME | --file PATH | --key-stdin] [--max-tokens N] [--stream auto|always|never]",
  "         [--thinking on|off] [--effort LEVEL] [--temperature T] [--verbosity low|medium|high]",
  "         [--feature k=on|off ...] [--use] [--no-test] [agent-slug]",
  "  Change fields of an existing profile. To change the protocol, add a new",
  "  profile and remove the old one (a protocol change reshapes every other field).",
].join("\n");

export async function runConfigUpdate(args: HandlerArgs, env: HandlerEnv): Promise<number> {
  const profileId = args.positional[0];
  if (profileId === undefined || profileId.trim() === "") {
    throw new UsageError("config update requires a <profile> id", UPDATE_USAGE);
  }
  const slug = (args.positional[1] as string | undefined) ?? "default";

  // D9: refuse an in-place protocol change.
  if (stringFlag(args.flags, "protocol") !== undefined) {
    throw configError("config_update_protocol", {
      problem: "the protocol of an existing profile cannot be changed in place",
      valid: "A protocol change reshapes every other field (base URL, model, thinking, …).",
      example: `aifight config add ${profileId}-new --protocol <p> …   then   aifight config remove ${profileId}`,
    });
  }

  const existing = await readExistingConfig(slug);
  if (!existing) {
    throw configError("config_update_no_config", {
      problem: "no LLM config on this machine yet",
      next: "Create a profile first with `aifight config add …`, or run `aifight config`.",
    });
  }
  const current = existing.profiles[profileId];
  if (!current) {
    throw configError("config_update_unknown_profile", {
      problem: `unknown profile "${profileId}"`,
      valid: `Available profiles: ${Object.keys(existing.profiles).join(", ") || "(none)"}`,
      example: `aifight config update ${Object.keys(existing.profiles)[0] ?? "<profile>"} --model <name>`,
    });
  }

  const protocol = current.protocol;

  // model / baseURL: keep existing unless overridden.
  const newModel = stringFlag(args.flags, "model") ?? current.model;
  const baseURLFlag = stringFlag(args.flags, "base-url");
  const newBaseURL = baseURLFlag ?? current.baseURL;

  // key: keep existing unless a source flag is given.
  const keySourceGiven =
    stringFlag(args.flags, "env") !== undefined ||
    stringFlag(args.flags, "file") !== undefined ||
    boolFlag(args.flags, "key-stdin");
  const apiKeyRef = keySourceGiven
    ? await resolveKeyRef({ slug, profileId, args, env })
    : current.apiKeyRef;

  // settings: start from the current profile, override with passed flags.
  const base = settingsFromProfile(current);
  const settings = resolveProfileSettings(protocol, newModel, args.flags, base);
  // D4: reconcile maxTokens with reasoning effort (explicit iff --max-tokens this call).
  const rec = applyEffortTokenRecommendation(settings, protocol, newModel, numberFlag(args.flags, "max-tokens"));

  const displayName = stringFlag(args.flags, "display-name") ?? current.displayName ?? defaultDisplayName(protocol);
  const profile = buildLLMProfile({ displayName, protocol, ...(newBaseURL ? { baseURL: newBaseURL } : {}), apiKeyRef, model: newModel, settings: rec.settings });

  const setActive = boolFlag(args.flags, "use");
  const config = mergeProfile(existing, profileId, profile, setActive);

  // D7: re-test only when something connectivity-relevant changed.
  const changed = keySourceGiven || newModel !== current.model || newBaseURL !== current.baseURL;
  return finishEdit({ slug, profileId, config, action: "update", setActive, args, env, skipTest: !changed, ...(rec.note ? { notes: [rec.note] } : {}) });
}

/** Extract the editable settings from a stored profile (for update's base). */
export function settingsFromProfile(p: LLMProfile): ProfileBuildSettings {
  return {
    thinkingEnabled: p.thinking?.enabled ?? true,
    ...(p.thinking?.effort ? { effort: p.thinking.effort } : {}),
    maxTokens: p.request?.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: p.request?.stream ?? "auto",
    temperature: p.request?.temperature ?? null,
    ...(p.request?.verbosity ? { verbosity: p.request.verbosity } : {}),
    ...(p.request?.features ? { features: p.request.features } : {}),
  };
}

// ─── managed-key helpers (D10 / clear-key) ───────────────────────────

/** The path where add/wizard store a managed 0600 key for a profile. */
export function managedKeyPath(slug: string, profileId: string): string {
  return path.join(resolveAgentDir(slug), "keys", `${profileId}.key`);
}

/** True when a profile's key is a file AIFight created for it (safe to delete). */
export function isManagedKeyRef(slug: string, profileId: string, ref: SecretRef): boolean {
  return ref.type === "file" && path.resolve(ref.path) === path.resolve(managedKeyPath(slug, profileId));
}

// ─── shared helpers (also used by update in Batch C) ─────────────────

/** Read + validate an existing config.json; undefined when absent. Throws a
 *  CommandError (never clobbers) when the file is present but corrupt/invalid. */
export async function readExistingConfig(slug: string): Promise<LLMConfig | undefined> {
  const configPath = path.join(resolveAgentDir(slug), "config.json");
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CommandError("config_read_failed", `cannot read ${configPath}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CommandError("config_invalid_json", `${configPath} is not valid JSON: ${(e as Error).message}`);
  }
  const result = validateConfig(parsed);
  if (!result.ok) {
    throw new CommandError("config_invalid", `${configPath} is invalid: ${result.errors.join("; ")}`);
  }
  return result.config;
}

export function requireProtocolFlag(args: HandlerArgs): Protocol {
  const raw = stringFlag(args.flags, "protocol");
  if (raw === undefined) {
    throw configError("config_missing_protocol", {
      problem: "--protocol is required",
      valid: protocolChoicesHint(),
      example: "aifight config add claude --protocol claude --env ANTHROPIC_API_KEY",
    });
  }
  const protocol = resolveProtocol(raw);
  if (protocol === undefined) {
    const guess = suggestClosest(raw, protocolSuggestionPool());
    throw configError("config_bad_protocol", {
      problem: `unknown --protocol "${raw}"`,
      valid: protocolChoicesHint(),
      example: "aifight config add gpt --protocol gpt --env OPENAI_API_KEY",
      ...(guess !== undefined ? { next: `Did you mean --protocol ${guess}?` } : {}),
    });
  }
  return protocol;
}

/** D3: compat protocols require base-url + model; others default them. */
export function resolveBaseUrlAndModel(
  protocol: Protocol,
  args: HandlerArgs,
): { baseURL?: string; model: string } {
  const baseURL = stringFlag(args.flags, "base-url");
  const model = stringFlag(args.flags, "model");
  if (protocolRequiresBaseURLAndModel(protocol)) {
    const missing: string[] = [];
    if (baseURL === undefined) missing.push("--base-url");
    if (model === undefined) missing.push("--model");
    if (missing.length > 0) {
      throw configError("config_compat_requires", {
        problem: `${protocol} requires ${missing.join(" and ")} (no official default exists for OpenAI-compatible providers)`,
        valid: "Required for a compat provider: --protocol, --base-url, --model, and a key source (--env/--file/--key-stdin).",
        example: "aifight config add deepseek --protocol compat --base-url https://api.deepseek.com/v1 --model deepseek-chat --env DEEPSEEK_API_KEY",
      });
    }
    return { baseURL, model: model! };
  }
  // Official provider: base URL defaults to the protocol canonical; model
  // defaults to the wizard's per-protocol default.
  return { ...(baseURL ? { baseURL } : {}), model: model ?? defaultModelFor(protocol) };
}

/** D4: exactly one of --env / --file / --key-stdin. Never accepts a raw key in argv. */
export async function resolveKeyRef(input: {
  slug: string;
  profileId: string;
  args: HandlerArgs;
  env: HandlerEnv;
  /** When set, treated as the --key-stdin value instead of reading process.stdin (tests). */
  stdinValue?: string;
}): Promise<SecretRef> {
  const { slug, profileId, args } = input;
  const envName = stringFlag(args.flags, "env");
  const filePath = stringFlag(args.flags, "file");
  const keyStdin = boolFlag(args.flags, "key-stdin");
  const sources = [envName !== undefined, filePath !== undefined, keyStdin].filter(Boolean).length;
  if (sources !== 1) {
    throw configError("config_key_source", {
      problem:
        sources === 0
          ? "no API key source given"
          : "more than one API key source given",
      valid: "Provide exactly ONE of: --env NAME (read from an environment variable), --file PATH (read from a key file), or --key-stdin (pipe the key on stdin). The raw key is never passed on the command line.",
      example: "aifight config add claude --protocol claude --env ANTHROPIC_API_KEY",
    });
  }
  if (envName !== undefined) return { type: "env", name: envName };
  if (filePath !== undefined) return { type: "file", path: filePath };
  // --key-stdin: read one line, store it 0600 at the same path the wizard uses.
  const value = (input.stdinValue ?? (await readStdinAll())).split(/\r?\n/)[0]!.trim();
  if (value === "") {
    throw configError("config_key_stdin_empty", {
      problem: "--key-stdin was set but stdin was empty",
      valid: "Pipe the key, e.g.  printf %s \"$MY_KEY\" | aifight config add …",
      example: 'printf %s "$DEEPSEEK_API_KEY" | aifight config add deepseek --protocol compat --base-url https://api.deepseek.com/v1 --model deepseek-chat --key-stdin',
    });
  }
  const keyFilePath = path.join(resolveAgentDir(slug), "keys", `${profileId}.key`);
  await storeSecretFile(keyFilePath, value);
  return { type: "file", path: keyFilePath };
}

/** D5 defaults + capability-aware validation. `base` supplies starting values
 *  for `update`; undefined = fresh defaults for `add`. Throws configError on any
 *  invalid combination (nothing is written). */
export function resolveProfileSettings(
  protocol: Protocol,
  model: string,
  flags: Readonly<Record<string, string | number | boolean>>,
  base: ProfileBuildSettings | undefined,
): ProfileBuildSettings {
  const caps = resolveModelCapabilities(protocol, model);

  // ── thinking ──
  let thinkingEnabled = base?.thinkingEnabled ?? true; // D5: on by default
  const thinking = onOffFlag(flags, "thinking");
  if (!thinking.ok) {
    throw configError("config_bad_thinking", {
      problem: `--thinking ${thinking.error}`,
      valid: "Valid: --thinking on | off",
    });
  }
  if (thinking.value !== undefined) thinkingEnabled = thinking.value;
  if (!caps.supportsThinking) {
    thinkingEnabled = false; // model has no reasoning mode
  } else if (thinking.value === false && caps.thinkingAlwaysOn) {
    throw configError("config_thinking_required", {
      problem: `model "${model}" always reasons — thinking cannot be turned off`,
      next: "Omit --thinking (it stays on).",
    });
  }

  // ── effort ──
  let effort = base?.effort;
  const effortRaw = stringFlag(flags, "effort");
  if (effortRaw !== undefined) {
    if (!thinkingEnabled) {
      throw configError("config_effort_no_thinking", {
        problem: "--effort has no effect when thinking is off",
        next: "Enable thinking (omit --thinking or pass --thinking on), or drop --effort.",
      });
    }
    const norm = normalizeEffort(effortRaw.toLowerCase());
    const allowed = caps.efforts.map((e) => normalizeEffort(e));
    // Only the capability registry can authoritatively reject an effort, and
    // only for a model it actually knows. New models keep arriving with their
    // own effort vocabularies — for an unknown model, accept the value as given
    // and let the auto-test be the source of truth rather than blocking it.
    if (caps.isKnownModel && allowed.length > 0 && !allowed.includes(norm)) {
      throw configError("config_bad_effort", {
        problem: `effort "${effortRaw}" is not valid for model "${model}"`,
        valid: `Supported effort levels: ${allowed.join(", ")}`,
      });
    }
    effort = norm;
  }

  // ── max tokens ──
  let maxTokens = base?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const mt = numberFlag(flags, "max-tokens");
  if (mt !== undefined) {
    if (!Number.isInteger(mt) || mt < MIN_MAX_TOKENS) {
      throw configError("config_bad_maxtokens", {
        problem: `--max-tokens must be a whole number ≥ ${MIN_MAX_TOKENS} (got ${mt})`,
        valid: `Range: ${MIN_MAX_TOKENS} … model maximum${caps.maxOutputTokens ? ` (${caps.maxOutputTokens})` : ""}.`,
      });
    }
    maxTokens = mt;
  }
  if (caps.maxOutputTokens && maxTokens > caps.maxOutputTokens) maxTokens = caps.maxOutputTokens;

  // ── stream ──
  let stream: "auto" | "always" | "never" = base?.stream ?? "auto";
  const s = stringFlag(flags, "stream");
  if (s !== undefined) {
    const low = s.toLowerCase();
    if (low !== "auto" && low !== "always" && low !== "never") {
      throw configError("config_bad_stream", {
        problem: `--stream must be auto, always, or never (got "${s}")`,
        valid: "Valid: --stream auto | always | never",
      });
    }
    stream = low;
  }

  // ── temperature ──
  let temperature = base?.temperature ?? null;
  const t = numberFlag(flags, "temperature");
  if (t !== undefined) {
    if (t < 0 || t > 2) {
      throw configError("config_bad_temp", { problem: `--temperature must be in [0, 2] (got ${t})` });
    }
    if (thinkingEnabled) {
      throw configError("config_temp_thinking_on", {
        problem: "temperature is ignored while thinking is on",
        next: "Omit --temperature, or set --thinking off first.",
      });
    }
    if (!caps.temperatureUsableWhenThinkingOff) {
      throw configError("config_temp_unsupported", {
        problem: `model "${model}" ignores temperature`,
        next: "Omit --temperature.",
      });
    }
    temperature = t;
  }

  // ── verbosity (D12: openai_responses only) ──
  let verbosity = base?.verbosity;
  const vb = stringFlag(flags, "verbosity");
  if (vb !== undefined) {
    const low = vb.toLowerCase();
    if (low !== "low" && low !== "medium" && low !== "high") {
      throw configError("config_bad_verbosity", {
        problem: `--verbosity must be low, medium, or high (got "${vb}")`,
        valid: "Valid: --verbosity low | medium | high",
      });
    }
    if (protocol !== "openai_responses") {
      throw configError("config_verbosity_unsupported", {
        problem: `--verbosity applies only to GPT (openai_responses); this profile uses ${protocol}`,
        next: "Omit --verbosity.",
      });
    }
    verbosity = low;
  }

  // ── features (D12) ──
  let features = base?.features;
  const featRaw = stringFlag(flags, "feature");
  if (featRaw !== undefined) {
    const parsed = parseFeatureFlags(featRaw);
    if (!parsed.ok) {
      throw configError("config_bad_feature", {
        problem: `--feature ${parsed.error}`,
        valid: "Format: --feature key=on|off (repeatable, or comma-joined)",
      });
    }
    const allowed = allowedFeatureKeys(protocol, model);
    for (const k of Object.keys(parsed.features)) {
      if (!allowed.includes(k)) {
        throw configError("config_unknown_feature", {
          problem: `feature "${k}" is not available for model "${model}"`,
          valid: allowed.length > 0 ? `Available features: ${allowed.join(", ")}` : "This model has no special features.",
        });
      }
    }
    features = { ...(base?.features ?? {}), ...parsed.features };
  }

  return {
    thinkingEnabled,
    ...(effort ? { effort } : {}),
    maxTokens,
    stream,
    temperature,
    ...(verbosity ? { verbosity } : {}),
    ...(features && Object.keys(features).length > 0 ? { features } : {}),
  };
}

/**
 * D3/D4: after settings are resolved, reconcile maxTokens with the chosen
 * reasoning effort. When effort is high/xhigh/max and maxTokens is below the
 * recommended value (the model ceiling), either auto-raise it (no explicit
 * --max-tokens was given) or keep the user's explicit value and warn. Never
 * silently truncates. Returns possibly-adjusted settings + an optional note.
 */
export function applyEffortTokenRecommendation(
  settings: ProfileBuildSettings,
  protocol: Protocol,
  model: string,
  explicitMaxTokens: number | undefined,
): { settings: ProfileBuildSettings; note?: string } {
  const rec = recommendMaxTokens({
    protocol,
    model,
    ...(settings.effort ? { effort: settings.effort } : {}),
    thinkingEnabled: settings.thinkingEnabled,
  });
  if (!rec || settings.maxTokens >= rec.recommended) return { settings };

  const tier = settings.effort ?? "high";
  if (explicitMaxTokens === undefined) {
    // No explicit --max-tokens: auto-raise (you pay for tokens used, not the cap).
    return {
      settings: { ...settings, maxTokens: rec.recommended },
      note: `max tokens auto-raised to ${rec.recommended} for ${tier} reasoning effort${rec.ceilingKnown ? " (the model's ceiling)" : ""} — you pay for tokens used, not the cap. Override with --max-tokens.`,
    };
  }
  // Explicit value below the recommendation: respect it, but warn.
  return {
    settings,
    note: `warning: max tokens ${settings.maxTokens} is below the recommended ${rec.recommended} for ${tier} reasoning effort on ${model} — the model may be truncated mid-thought. Consider --max-tokens ${rec.recommended}.`,
  };
}

/** Merge a profile into a config (creating a base config if none exists). */
export function mergeProfile(
  existing: LLMConfig | undefined,
  profileId: string,
  profile: LLMProfile,
  setActive: boolean,
): LLMConfig {
  const config: LLMConfig = existing
    ? { ...existing, profiles: { ...existing.profiles } }
    : {
        schemaVersion: 1,
        activeProfile: profileId,
        profiles: {},
        routing: { default: profileId },
      };
  config.profiles[profileId] = profile;
  if (setActive || !existing) {
    config.activeProfile = profileId;
    config.routing = { ...config.routing, default: profileId };
  }
  return config;
}

/** D8: no working profile yet → the new one should become active. */
async function shouldBecomeActive(existing: LLMConfig | undefined): Promise<boolean> {
  if (!existing) return true;
  if (Object.keys(existing.profiles).length === 0) return true;
  const active = existing.profiles[existing.activeProfile];
  if (!active) return true;
  const status = await checkSecretStatus(active.apiKeyRef);
  return !status.available; // no currently-resolvable active profile → take over
}

/** Write config (validated) + D7 auto-test + output. Shared by add & update. */
export async function finishEdit(input: {
  slug: string;
  profileId: string;
  config: LLMConfig;
  action: "add" | "update";
  setActive: boolean;
  args: HandlerArgs;
  env: HandlerEnv;
  /** When true, skip the auto-test even without --no-test (update: nothing
   *  connectivity-relevant changed). */
  skipTest?: boolean;
  /** Advisory notes (e.g. the D4 maxTokens auto-raise / warning) to surface. */
  notes?: readonly string[];
}): Promise<number> {
  const { slug, profileId, config, action, args, env } = input;
  await writeValidatedConfig(slug, config);

  const profile = config.profiles[profileId]!;
  const active = config.activeProfile === profileId;
  const noTest = boolFlag(args.flags, "no-test") || input.skipTest === true;
  const notes = input.notes ?? [];

  if (!args.jsonMode) {
    env.stdout(
      `aifight config ${action}: profile "${profileId}" saved (${profile.protocol}, ${profile.model}).\n`,
    );
    env.stdout(`  key     : ${describeRef(profile.apiKeyRef)}\n`);
    env.stdout(`  active  : ${active ? "yes" : "no (use `aifight config use " + profileId + "` to switch)"}\n`);
    // Reassure the user that a not-yet-catalogued model is still supported: the
    // protocol handles it, only the reasoning knobs can't be pre-verified. New
    // models arrive constantly, so this is expected, not an error.
    const caps = resolveModelCapabilities(profile.protocol, profile.model);
    if (!caps.isKnownModel && caps.supportsThinking) {
      env.stdout(
        `  note    : "${profile.model}" isn't in the built-in model list yet — that's fine, the ${profile.protocol} protocol still runs it. Its reasoning options just can't be pre-checked; the test confirms it works.\n`,
      );
    }
    for (const n of notes) env.stdout(`  note    : ${n}\n`);
  }

  if (noTest) {
    if (args.jsonMode) {
      env.stdout(
        JSON.stringify({
          status: "saved",
          action,
          agentSlug: slug,
          profile: profileId,
          activeProfile: config.activeProfile,
          test: null,
          ...(notes.length > 0 ? { notes } : {}),
        }) + "\n",
      );
    } else {
      env.stdout(`  (test skipped — run \`aifight config test --profile ${profileId}\` when ready)\n\n`);
    }
    return 0;
  }

  const outcome = await resolveAndProbe(slug, profileId, env, (info) => {
    if (!args.jsonMode) {
      env.stdout(
        `Testing ${info.protocol} (${info.model})${info.thinkingOn ? " with reasoning — this may take a few seconds" : ""}…\n`,
      );
    }
  });

  if (args.jsonMode) {
    const test = outcome.ok
      ? {
          success: outcome.result.success,
          latencyMs: outcome.result.latencyMs,
          jsonValid: outcome.result.jsonValid ?? null,
          error: outcome.result.error ?? null,
        }
      : { success: false, error: outcome.message, code: outcome.code };
    env.stdout(
      JSON.stringify({
        status: "saved",
        action,
        agentSlug: slug,
        profile: profileId,
        activeProfile: config.activeProfile,
        test,
        ...(notes.length > 0 ? { notes } : {}),
      }) + "\n",
    );
    return outcome.ok && outcome.result.success ? 0 : 1;
  }

  if (!outcome.ok) {
    env.stdout(`  ✗ could not test: ${outcome.message}\n`);
    env.stdout(`  Your config is saved. Fix the key/model/base URL and run \`aifight config test --profile ${profileId}\`.\n\n`);
    return 1;
  }
  if (outcome.result.success) {
    env.stdout(`  ✓ model responded (${outcome.result.latencyMs} ms).\n\n`);
    return 0;
  }
  env.stdout(`  ✗ the model did not respond: ${outcome.result.error ?? "(unknown)"}\n`);
  env.stdout(`  Your config is saved. Adjust and run \`aifight config test --profile ${profileId}\`.\n\n`);
  return 1;
}

export async function writeValidatedConfig(slug: string, config: LLMConfig): Promise<void> {
  const result = validateConfig(config);
  if (!result.ok) {
    throw new CommandError("config_write_invalid", `refusing to write invalid config: ${result.errors.join("; ")}`);
  }
  await ensureAgentDir(slug);
  const configPath = path.join(resolveAgentDir(slug), "config.json");
  const tmp = `${configPath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
  await fs.rename(tmp, configPath);
}

// ─── small pure helpers ──────────────────────────────────────────────

/** The capability registry uses "none"; config.json's ReasoningEffort uses "off". */
function normalizeEffort(e: string): ReasoningEffort {
  return (e === "none" ? "off" : e) as ReasoningEffort;
}

/** Default model for a protocol, sourced from the wizard's ONBOARD_PROVIDERS so
 *  the wizard and `config add` stay in lockstep (D1). Non-wizard protocols
 *  (e.g. native deepseek_chat_completions) fall back to a sensible id. */
export function defaultModelFor(protocol: Protocol): string {
  const p = ONBOARD_PROVIDERS.find((x) => x.protocol === protocol);
  if (p) return p.defaultModel;
  if (protocol === "deepseek_chat_completions") return "deepseek-v4-flash";
  return "";
}

/** Display name for a protocol, sourced from ONBOARD_PROVIDERS (D1). */
function defaultDisplayName(protocol: Protocol): string {
  const p = ONBOARD_PROVIDERS.find((x) => x.protocol === protocol);
  return p ? p.displayName : protocol;
}

/** Feature keys valid for a (protocol, model), mirroring the desktop app's
 *  specialFeatures(): currently only DeepSeek V4 over the compat protocol. */
export function allowedFeatureKeys(protocol: Protocol, model: string): string[] {
  if (protocol === "openai_chat_compat" && /deepseek-v4/i.test(model)) {
    return ["jsonObjectMode"];
  }
  return [];
}

async function readStdinAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
