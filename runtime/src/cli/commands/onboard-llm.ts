// Interactive direct-LLM onboarding used by `aifight setup` and `aifight config` (TTY only).
//
// Goal: a first-time user runs ONE command and is guided to a working,
// tested LLM configuration. Resolution order matches the product spec:
//   1. If the agent's config.json already resolves a working key → just test it.
//   2. Else, interactively: pick a protocol, (optionally) override the base URL,
//      paste the API key (hidden input, stored 0600 / never echoed), pick or
//      type a model, then run a live test. On failure, guide a retry.
//
// All real I/O (prompts, model discovery, the live probe, secret storage) is
// injected via OnboardIO so the decision logic is unit-testable without a TTY
// or network. The raw-stdin / fetch implementations live in onboard-io.ts.
//
// Security: the API key is read via hidden input (never argv, never echoed,
// never logged), persisted only through storeSecretFile (0600) or the OS
// keychain, and the config stores a SecretRef, not the raw value.

import fs from "node:fs/promises";
import path from "node:path";

import type { HandlerEnv } from "../shared.js";
import type { LLMConfig, LLMProfile, Protocol, ReasoningEffort } from "../../profile/config-schema.js";
import { resolveAgentDir } from "../../profile/profile-loader.js";
import { checkSecretStatus } from "../../profile/secret-ref.js";
import { resolveModelCapabilities, recommendMaxTokens } from "../../llm/capabilities/validate-capabilities.js";
import { buildLLMProfile } from "./config-shared.js";

export interface OnboardProvider {
  /** Menu key, e.g. "1". */
  readonly key: string;
  /** Stable profile id written into config.json. */
  readonly id: string;
  /** Menu label. */
  readonly label: string;
  /** Wire protocol / adapter. */
  readonly protocol: Protocol;
  /**
   * Canonical official base URL. undefined => the user MUST supply one
   * (the openai_chat_compat protocol has no default — every provider differs).
   */
  readonly officialBaseURL?: string;
  /** Sensible default model the user can accept with Enter. */
  readonly defaultModel: string;
  /** Friendly name used in prompts and messages. */
  readonly displayName: string;
}

// Menu is protocol-oriented (the same model can be reached via several
// protocols; the protocol dictates the wire format).
export const ONBOARD_PROVIDERS: readonly OnboardProvider[] = [
  {
    key: "1",
    id: "claude",
    label: "Claude   (Anthropic)",
    protocol: "anthropic_messages",
    officialBaseURL: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-4-6",
    displayName: "Claude (Anthropic)",
  },
  {
    key: "2",
    id: "gpt",
    label: "GPT      (OpenAI Responses API)",
    protocol: "openai_responses",
    officialBaseURL: "https://api.openai.com/v1",
    // Cost-effective mainstream tier (not the flagship). Kept in sync with the
    // desktop app's model presets and model-capabilities.json (D15).
    defaultModel: "gpt-5.4",
    displayName: "GPT (OpenAI Responses)",
  },
  {
    key: "3",
    id: "compat",
    label: "OpenAI Chat Completions  (DeepSeek / GLM / Minimax / Qwen / …)",
    protocol: "openai_chat_compat",
    officialBaseURL: undefined, // base URL is required for compat providers
    defaultModel: "deepseek-v4-flash",
    displayName: "OpenAI-compatible provider",
  },
  {
    key: "4",
    id: "gemini",
    label: "Gemini   (Google)",
    protocol: "gemini_generate_content",
    officialBaseURL: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-2.5-flash",
    displayName: "Gemini (Google)",
  },
] as const;

export interface OnboardIO {
  /** Visible single-line prompt; returns the trimmed answer. */
  promptLine(question: string): Promise<string>;
  /** Masked prompt for secrets; returns the raw value (not trimmed of inner chars). */
  promptHidden(question: string): Promise<string>;
  /** Yes/No prompt; Enter selects the default. */
  promptYesNo(question: string, defaultYes: boolean): Promise<boolean>;
  /**
   * Best-effort model discovery. Returns a model id list, or null when
   * discovery is unsupported / failed (caller falls back to manual entry).
   * Must never throw.
   */
  discoverModels(input: { protocol: Protocol; baseURL: string; apiKey: string }): Promise<string[] | null>;
  /** Persist a secret to a 0600 file. */
  storeKey(filePath: string, value: string): Promise<void>;
  /** Run the live model probe for the agent's active profile; true = healthy. */
  probe(slug: string): Promise<boolean>;
}

export type OnboardResult = "configured" | "failed";

const MAX_ATTEMPTS = 3;

/** AIFight is a reasoning arena, so generous output room is the default. */
const DEFAULT_MAX_TOKENS = 32000;
const MIN_MAX_TOKENS = 256;

/** The model knobs the wizard collects (capability-aware). */
interface ModelSettings {
  thinkingEnabled: boolean;
  /** Reasoning effort (only when thinking is on and the model exposes levels). */
  effort?: ReasoningEffort;
  maxTokens: number;
  stream: "auto" | "always" | "never";
  /** null = omit the temperature parameter entirely (the default). */
  temperature: number | null;
}

/** The capability registry uses "none"; config.json's ReasoningEffort uses "off". */
function normalizeEffort(e: string): ReasoningEffort {
  return (e === "none" ? "off" : e) as ReasoningEffort;
}

function profileFor(
  provider: OnboardProvider,
  baseURL: string | undefined,
  model: string,
  keyFilePath: string,
  settings: ModelSettings,
): LLMProfile {
  // Delegate to the shared builder (D1) so a wizard-configured profile is
  // byte-identical to a `config add`-configured one. The wizard does not set
  // verbosity/features, so those stay omitted here.
  return buildLLMProfile({
    displayName: provider.displayName,
    protocol: provider.protocol,
    ...(baseURL ? { baseURL } : {}),
    apiKeyRef: { type: "file", path: keyFilePath },
    model,
    settings: {
      thinkingEnabled: settings.thinkingEnabled,
      ...(settings.effort ? { effort: settings.effort } : {}),
      maxTokens: settings.maxTokens,
      stream: settings.stream,
      temperature: settings.temperature,
    },
  });
}

async function readConfig(slug: string): Promise<LLMConfig | undefined> {
  const file = path.join(resolveAgentDir(slug), "config.json");
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as LLMConfig;
  } catch {
    return undefined;
  }
}

async function writeProfile(slug: string, profileId: string, profile: LLMProfile): Promise<void> {
  const agentDir = resolveAgentDir(slug);
  const file = path.join(agentDir, "config.json");
  const config: LLMConfig =
    (await readConfig(slug)) ?? {
      schemaVersion: 1,
      activeProfile: profileId,
      profiles: {},
      routing: { default: profileId },
      logging: { storePrompts: "redacted", storeRawProviderResponses: false, storeReasoningContent: false },
    };
  config.profiles = { ...config.profiles, [profileId]: profile };
  config.activeProfile = profileId;
  config.routing = { ...config.routing, default: profileId };
  await fs.writeFile(file, JSON.stringify(config, null, 2) + "\n", "utf8");
}

/**
 * After a successful interactive setup, drop NON-active profiles whose key
 * cannot resolve — e.g. config init's DEFAULT_CONFIG "claude-default" placeholder
 * pointing at an unset ANTHROPIC_API_KEY — so the user and the desktop app only
 * see the profile that actually works. Only ever runs after the active profile
 * has probed healthy, and never removes the active profile, so it cannot drop a
 * working config. Best-effort: a failure here never fails onboarding.
 */
async function pruneUnresolvableProfiles(slug: string): Promise<void> {
  const config = await readConfig(slug);
  if (!config) return;
  const active = config.activeProfile;
  let changed = false;
  for (const [id, prof] of Object.entries(config.profiles)) {
    if (id === active) continue;
    const status = await checkSecretStatus(prof.apiKeyRef);
    if (!status.available) {
      delete config.profiles[id];
      changed = true;
    }
  }
  if (!changed) return;
  if (config.profiles[config.routing.default] === undefined) config.routing.default = active;
  if (config.routing.byGame) {
    const kept: Record<string, string> = {};
    for (const [game, profileId] of Object.entries(config.routing.byGame)) {
      if (config.profiles[profileId] !== undefined) kept[game] = profileId;
    }
    config.routing.byGame = kept as LLMConfig["routing"]["byGame"];
  }
  try {
    await fs.writeFile(
      path.join(resolveAgentDir(slug), "config.json"),
      JSON.stringify(config, null, 2) + "\n",
      "utf8",
    );
  } catch {
    // best-effort cleanup; never fail onboarding over a tidy-up write
  }
}

/** True when config.json already has a resolvable, testable active profile. */
async function existingConfigIsUsable(slug: string, io: OnboardIO, env: HandlerEnv): Promise<boolean> {
  const config = await readConfig(slug);
  if (!config) return false;
  const active = config.activeProfile ? config.profiles?.[config.activeProfile] : undefined;
  if (!active) return false;
  // Only treat the config as "already set up" when its key actually resolves
  // (env var present, or a previously-saved file/keychain ref). A fresh
  // DEFAULT_CONFIG points at an absent env var → fall through to interactive.
  const status = await checkSecretStatus(active.apiKeyRef);
  if (!status.available) return false;
  env.stdout(`Found a saved LLM config (${active.displayName ?? config.activeProfile}). Testing…\n`);
  const ok = await io.probe(slug);
  if (ok) {
    env.stdout("  ✓ model responded.\n\n");
    return true;
  }
  env.stdout("  The saved key did not respond — let's set it up again.\n\n");
  return false;
}

async function chooseProvider(io: OnboardIO, env: HandlerEnv): Promise<OnboardProvider | undefined> {
  env.stdout("Which LLM will your agent play with?\n");
  for (const p of ONBOARD_PROVIDERS) env.stdout(`    ${p.key}) ${p.label}\n`);
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const answer = (await io.promptLine("  Choose [1-4]: ")).trim();
    const match = ONBOARD_PROVIDERS.find((p) => p.key === answer);
    if (match) return match;
    env.stdout("  Please enter 1, 2, 3, or 4.\n");
  }
  return undefined;
}

async function chooseBaseURL(provider: OnboardProvider, io: OnboardIO): Promise<string | undefined> {
  if (provider.officialBaseURL === undefined) {
    // Compat: base URL is required.
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const raw = (await io.promptLine("  Base URL (e.g. https://api.deepseek.com/v1): ")).trim();
      if (/^https?:\/\/.+/i.test(raw)) return raw.replace(/\/+$/, "");
      // empty / invalid → ask again
    }
    return undefined;
  }
  const raw = (
    await io.promptLine(`  Base URL [Enter = official ${provider.officialBaseURL}, or paste a custom one]: `)
  ).trim();
  if (raw === "") return provider.officialBaseURL;
  if (/^https?:\/\/.+/i.test(raw)) return raw.replace(/\/+$/, "");
  return provider.officialBaseURL;
}

async function chooseModel(
  provider: OnboardProvider,
  baseURL: string,
  apiKey: string,
  io: OnboardIO,
  env: HandlerEnv,
): Promise<string> {
  // Best-effort discovery; never blocks the flow.
  const models = await io.discoverModels({ protocol: provider.protocol, baseURL, apiKey });
  if (models && models.length > 0) {
    const shown = models.slice(0, 30);
    env.stdout("  Available models:\n");
    shown.forEach((m, i) => env.stdout(`    ${i + 1}) ${m}\n`));
    const answer = (
      await io.promptLine(`  Pick a number, type a model name, or Enter for default (${provider.defaultModel}): `)
    ).trim();
    if (answer === "") return provider.defaultModel;
    const asNum = Number.parseInt(answer, 10);
    if (Number.isInteger(asNum) && asNum >= 1 && asNum <= shown.length) return shown[asNum - 1]!;
    return answer;
  }
  const answer = (
    await io.promptLine(`  Model [Enter = ${provider.defaultModel}, or type a name]: `)
  ).trim();
  return answer === "" ? provider.defaultModel : answer;
}

/**
 * Capability-aware settings step. Only surfaces the knobs the chosen model
 * actually has: thinking is ON by default (AIFight is a reasoning arena) and is
 * only offered as a toggle when the model can disable it; effort only when the
 * model exposes levels; max tokens / streaming / temperature behind one
 * "advanced?" gate so the common path stays short. Temperature is NEVER
 * defaulted — it is omitted unless the user opts in, and only offered when
 * thinking is off and the model accepts it.
 */
async function chooseModelSettings(
  provider: OnboardProvider,
  model: string,
  io: OnboardIO,
  env: HandlerEnv,
): Promise<ModelSettings> {
  const caps = resolveModelCapabilities(provider.protocol, model);

  // ── Thinking ──
  let thinkingEnabled: boolean;
  if (!caps.supportsThinking) {
    thinkingEnabled = false;
  } else if (caps.thinkingAlwaysOn) {
    thinkingEnabled = true;
    env.stdout("  This model always reasons — thinking can't be turned off.\n");
  } else {
    thinkingEnabled = await io.promptYesNo("  Enable thinking / reasoning? (recommended)", true);
  }

  // ── Effort (only when thinking is on and the model exposes levels) ──
  let effort: ReasoningEffort | undefined;
  let effortExplicit = false;
  if (thinkingEnabled && caps.efforts.length > 0) {
    const efforts = caps.efforts.map(normalizeEffort);
    const def: ReasoningEffort = caps.defaultEffort
      ? normalizeEffort(caps.defaultEffort)
      : (efforts[efforts.length - 1] as ReasoningEffort);
    env.stdout(`  Reasoning effort: ${efforts.join(", ")}\n`);
    const ans = (await io.promptLine(`  Effort [Enter = ${def}]: `)).trim().toLowerCase();
    const picked = normalizeEffort(ans);
    effort = ans === "" ? def : efforts.includes(picked) ? picked : def;
    effortExplicit = ans !== "" && efforts.includes(picked);
  }

  // ── Advanced (off by default; LLM config is set once, but keep the common path short) ──
  let maxTokens = caps.maxOutputTokens && DEFAULT_MAX_TOKENS > caps.maxOutputTokens
    ? caps.maxOutputTokens
    : DEFAULT_MAX_TOKENS;
  // D4: when the user EXPLICITLY picks a high reasoning effort, it can need up to
  // the model's ceiling of headroom (e.g. Opus at max = 128000) — offer to raise
  // before the advanced gate. Accepting the default effort never nags.
  const rec = effortExplicit
    ? recommendMaxTokens({ protocol: provider.protocol, model, ...(effort ? { effort } : {}), thinkingEnabled })
    : undefined;
  if (rec && maxTokens < rec.recommended) {
    const raise = await io.promptYesNo(
      `  ${effort ?? "high"} effort works best with max tokens ≥ ${rec.recommended} (currently ${maxTokens}). Raise it?`,
      true,
    );
    if (raise) maxTokens = rec.recommended;
  }
  let stream: "auto" | "always" | "never" = "auto";
  let temperature: number | null = null;

  const advanced = await io.promptYesNo(
    "  Tune advanced settings (max tokens, streaming, temperature)?",
    false,
  );
  if (advanced) {
    const cap = caps.maxOutputTokens;
    const mtAns = (
      await io.promptLine(
        `  Max output tokens [Enter = ${maxTokens}${cap ? `, model max ${cap}` : ""}]: `,
      )
    ).trim();
    if (/^\d+$/.test(mtAns)) {
      let n = Number.parseInt(mtAns, 10);
      if (n < MIN_MAX_TOKENS) n = MIN_MAX_TOKENS;
      if (cap && n > cap) n = cap;
      maxTokens = n;
    }

    const sAns = (await io.promptLine("  Streaming [Enter = auto / always / never]: ")).trim().toLowerCase();
    if (sAns === "always" || sAns === "never") stream = sAns;

    if (!thinkingEnabled && caps.temperatureUsableWhenThinkingOff) {
      const tAns = (
        await io.promptLine("  Temperature [Enter = omit (provider default); e.g. 0.2 for more rigour]: ")
      ).trim();
      if (tAns !== "") {
        const t = Number.parseFloat(tAns);
        if (Number.isFinite(t) && t >= 0 && t <= 2) temperature = t;
      }
    } else if (!thinkingEnabled) {
      env.stdout("  (This model ignores temperature, so it stays omitted.)\n");
    }
    // When thinking is ON we never ask about temperature — it is ignored or
    // rejected by every major provider in that mode.
  }

  env.stdout(
    `  → thinking ${thinkingEnabled ? `on${effort ? ` (effort ${effort})` : ""}` : "off"}, ` +
      `max tokens ${maxTokens}, streaming ${stream}` +
      `${temperature !== null ? `, temperature ${temperature}` : ""}.\n`,
  );

  return {
    thinkingEnabled,
    ...(effort ? { effort } : {}),
    maxTokens,
    stream,
    temperature,
  };
}

/**
 * Drive the interactive direct-LLM setup. Assumes `config init` already ran
 * (config.json exists). Returns "configured" once the model
 * probes healthy, or "failed" if the user gives up / exhausts retries (the
 * config is still saved so they can fix it later with `aifight config test`).
 */
export async function onboardDirectLLM(opts: {
  slug: string;
  env: HandlerEnv;
  io: OnboardIO;
  /**
   * When true, skip the "an existing key already works, just test it" shortcut
   * and go straight to interactive provider selection. Used by `aifight config`
   * when the user explicitly chooses to set up a different LLM.
   */
  reconfigure?: boolean;
}): Promise<OnboardResult> {
  const { slug, env, io } = opts;

  if (!opts.reconfigure && (await existingConfigIsUsable(slug, io, env))) return "configured";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const provider = await chooseProvider(io, env);
    if (!provider) {
      env.stdout("No provider selected.\n");
      return "failed";
    }

    const baseURL = await chooseBaseURL(provider, io);
    if (provider.officialBaseURL === undefined && baseURL === undefined) {
      env.stdout("  A base URL is required for an OpenAI-compatible provider.\n");
      continue;
    }

    const apiKey = (await io.promptHidden(`  Paste your ${provider.displayName} API key (hidden): `)).trim();
    if (apiKey === "") {
      env.stdout("  No key entered.\n");
      const again = await io.promptYesNo("  Try again?", true);
      if (!again) return "failed";
      continue;
    }

    // Same on-disk layout the desktop app uses (resolveAgentDir/keys/<id>.key),
    // so a profile configured here and one configured in the app share one file.
    const keyFilePath = path.join(resolveAgentDir(slug), "keys", `${provider.id}.key`);
    await io.storeKey(keyFilePath, apiKey);
    env.stdout("  ✓ Key saved to local config (0600 file, never uploaded).\n");

    const model = await chooseModel(provider, baseURL!, apiKey, io, env);
    const settings = await chooseModelSettings(provider, model, io, env);
    await writeProfile(slug, provider.id, profileFor(provider, baseURL, model, keyFilePath, settings));

    env.stdout(`\nTesting ${provider.displayName} (${model})…\n`);
    const ok = await io.probe(slug);
    if (ok) {
      // Drop any leftover placeholder profiles (e.g. config init's
      // DEFAULT_CONFIG "claude-default" pointing at an unset env var) so the
      // user — and the desktop app — only see the profile that actually works.
      await pruneUnresolvableProfiles(slug);
      env.stdout("  ✓ model responded.\n");
      env.stdout(
        `  Tip: change any field later with one command — \`aifight config update ${provider.id} --model …\` (see \`aifight config --help\`).\n\n`,
      );
      return "configured";
    }

    env.stdout("  ✗ the model did not respond — the key, model name, or base URL may be wrong.\n");
    if (attempt < MAX_ATTEMPTS) {
      const again = await io.promptYesNo("  Re-enter the key / pick another provider?", true);
      if (!again) break;
    }
  }

  env.stdout(
    [
      "",
      "Could not confirm the model yet. Your config is saved; you can fix it later with:",
      "  aifight config show      # review provider, base URL, model",
      "  aifight config test      # try the model again",
      "",
    ].join("\n"),
  );
  return "failed";
}
