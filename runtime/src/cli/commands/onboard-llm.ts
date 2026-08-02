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
// never logged), persisted only as a 0600 file (staged at a pending path until
// the profile write lands), and the config stores a SecretRef, not the raw value.

import fs from "node:fs/promises";
import path from "node:path";

import type { HandlerEnv } from "../shared.js";
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_MAX_TOKENS,
} from "../../profile/config-schema.js";
import type { LLMConfig, LLMProfile, Protocol, ReasoningEffort } from "../../profile/config-schema.js";
import { validateProviderBaseURL } from "../../profile/config-schema.js";
import { resolveAgentDir } from "../../profile/profile-loader.js";
import { checkSecretStatus } from "../../profile/secret-ref.js";
import { resolveModelCapabilities, recommendMaxTokens } from "../../llm/capabilities/validate-capabilities.js";
import { resolveLocale, t, type Locale } from "../i18n.js";
import { createOutput } from "../output.js";
import { buildLLMProfile } from "./config-shared.js";
import type { MenuFrame } from "./menu-frame.js";
import type { MenuChoose } from "./menu-select.js";
import { promptValidatedDefault } from "./onboard-io.js";
import { pickOneKey, type PickOneDeps } from "./pick-one.js";

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
    // U3: single-spaced. The label used to be padded so a hand-printed list
    // lined up; it is now a frame row, where the renderer owns the alignment.
    label: "Claude (Anthropic)",
    protocol: "anthropic_messages",
    officialBaseURL: "https://api.anthropic.com",
    // Current-generation speed/intelligence tier. Sonnet 4.6 is now a legacy model,
    // so pointing a first run at it started new users one generation behind.
    // Shared with config-schema's DEFAULT_CONFIG so the starter template and
    // the wizard bump generations together.
    defaultModel: DEFAULT_CLAUDE_MODEL,
    displayName: "Claude (Anthropic)",
  },
  {
    key: "2",
    id: "gpt",
    label: "GPT (OpenAI Responses API)",
    protocol: "openai_responses",
    officialBaseURL: "https://api.openai.com/v1",
    // Cost-effective mainstream tier (not the flagship). Kept in sync with the
    // desktop app's model presets and model-capabilities.json (D15).
    defaultModel: "gpt-5.6-sol",
    displayName: "GPT (OpenAI Responses)",
  },
  {
    key: "3",
    id: "compat",
    label: "OpenAI Chat Completions (DeepSeek / GLM / Minimax / Qwen / …)",
    protocol: "openai_chat_compat",
    officialBaseURL: undefined, // base URL is required for compat providers
    defaultModel: "deepseek-v4-flash",
    displayName: "OpenAI-compatible provider",
  },
  {
    key: "4",
    id: "gemini",
    label: "Gemini (Google)",
    protocol: "gemini_generate_content",
    // Bare domain, NO /v1beta: the gemini_generate_content adapter appends the
    // version path itself. Must match protocolDefaultBaseURL (resolve-profile.ts)
    // — a baked-in /v1beta here produced /v1beta/v1beta request URLs.
    officialBaseURL: "https://generativelanguage.googleapis.com",
    defaultModel: "gemini-3.6-flash",
    displayName: "Gemini (Google)",
  },
] as const;

export interface OnboardIO {
  /**
   * The arrow-key chooser for every N-of-1 step (统一交互规范 P1, U3). Present
   * only when the host is a real terminal (createOnboardIO wires it behind the
   * stdin+stdout TTY gate); absent for scripted/injected IO, where pickOneKey
   * falls back to the printed frame + numbered line answer read by promptLine.
   */
  choose?: MenuChoose;
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

// ── The wizard on the shared interaction primitives (统一交互规范, U3) ──
//
// Every choice below goes through pickOneKey (P1) and every typed value through
// promptValidatedDefault (P3), so `aifight setup` and `aifight config llm` look
// and behave like the panel instead of like a different program. Two rules the
// steps here follow, because a wizard is a chain and not a menu:
//   * a STEP frame (provider, model) carries a Back row where going back is
//     meaningful;
//   * a VALUE frame (reasoning effort, streaming) carries none — q/Enter mean
//     "take the shown default", exactly what Enter meant before. That also
//     keeps an exhausted script moving FORWARD: a blank answer must never bounce
//     the wizard into a step that will read blank again.

/** The display locale for the wizard's chrome (menu.ts's rule: read fresh). */
function localeOf(env: HandlerEnv): Locale {
  return env.locale?.() ?? resolveLocale();
}

/** The wizard's IO shaped for the shared P1 primitive: the arrow-key chooser
 *  when the host wired one, the injected line prompt otherwise. */
export function onboardPickDeps(io: OnboardIO, env: HandlerEnv, locale: Locale): PickOneDeps {
  return {
    env,
    locale,
    ...(io.choose !== undefined ? { choose: io.choose } : {}),
    prompt: (question) => io.promptLine(question),
  };
}

/** The wizard's line prompt shaped for the P3 helpers (which take an env they
 *  do not use once a reader is injected). */
export function onboardAskLine(io: OnboardIO): (env: HandlerEnv, question: string) => Promise<string> {
  return (_env, question) => io.promptLine(question);
}

// DEFAULT_MAX_TOKENS is imported from config-schema (D16 single source):
// AIFight is a reasoning arena, so generous output room is the default.
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
    };
  config.profiles = { ...config.profiles, [profileId]: profile };
  config.activeProfile = profileId;
  config.routing = { ...config.routing, default: profileId };
  await fs.writeFile(file, JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

/**
 * After a successful interactive setup, drop leftover SCAFFOLD placeholder
 * profiles — the kind `config init`'s DEFAULT_CONFIG writes ("claude-default"
 * pointing at an unset ANTHROPIC_API_KEY) — so the user and the desktop app
 * only see the profile that actually works.
 *
 * Conservative by design (2026-07-29 audit): a profile is pruned ONLY when it
 * has the exact placeholder shape — id ending in "-default", key referenced
 * via an env var, and that env var not set in this process. A real profile
 * whose key simply does not resolve HERE (e.g. an --env VAR exported only in
 * the service's environment) must survive, so "unresolvable in this shell"
 * alone is never enough. Only ever runs after the active profile has probed
 * healthy, and never removes the active profile. Best-effort: a failure here
 * never fails onboarding.
 */
async function pruneUnresolvableProfiles(slug: string, env: HandlerEnv): Promise<void> {
  const config = await readConfig(slug);
  if (!config) return;
  const active = config.activeProfile;
  const placeholders: string[] = [];
  for (const [id, prof] of Object.entries(config.profiles)) {
    if (id === active) continue;
    if (!id.endsWith("-default")) continue;
    if (prof.apiKeyRef.type !== "env") continue;
    const status = await checkSecretStatus(prof.apiKeyRef);
    if (!status.available) placeholders.push(id);
  }
  if (placeholders.length === 0) return;
  // Say exactly what is being dropped BEFORE dropping it — a silent prune is
  // how a real profile disappears without anyone noticing.
  const loc = localeOf(env);
  for (const id of placeholders) {
    env.stdout(`${t(loc, "llmhub.wizard.prune.removing", { id })}\n`);
    delete config.profiles[id];
  }
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
      { encoding: "utf8", mode: 0o600 },
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
  const loc = localeOf(env);
  env.stdout(
    `${t(loc, "llmhub.wizard.existing.found", { name: active.displayName ?? config.activeProfile })}\n`,
  );
  const ok = await io.probe(slug);
  if (ok) {
    env.stdout(`${t(loc, "llmhub.wizard.existing.ok")}\n\n`);
    return true;
  }
  env.stdout(`${t(loc, "llmhub.wizard.existing.stale")}\n\n`);
  return false;
}

/**
 * Back-navigation sentinel. Every LINE prompt in the wizard accepts "b" to return
 * to the previous step (yes/no micro-questions stay binary — the summary screen is
 * the revision mechanism for anything they set). Symbol, not string, so a model
 * actually named "b" could still be typed via the summary's model jump.
 */
const BACK = Symbol("back");
type Back = typeof BACK;

function isBack(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return a === "b" || a === "back";
}

async function chooseProvider(io: OnboardIO, env: HandlerEnv): Promise<OnboardProvider | undefined> {
  const loc = localeOf(env);
  // P1: the provider used to be a hand-printed English list plus a typed
  // "Choose [1-4]". Same four rows, same keys, now the shared frame — the
  // brand labels stay English on purpose.
  const frame: MenuFrame = {
    title: t(loc, "llmhub.provider_title"),
    banner: [],
    choices: [
      ...ONBOARD_PROVIDERS.map((p) => ({ key: p.key, main: p.label })),
      { key: "q", main: t(loc, "challenge.menu.back.main") },
    ],
  };
  const key = await pickOneKey(onboardPickDeps(io, env, loc), frame);
  if (key === null) return undefined; // q / Esc / an exhausted script
  return ONBOARD_PROVIDERS.find((p) => p.key === key);
}

async function chooseBaseURL(
  provider: OnboardProvider,
  io: OnboardIO,
  env: HandlerEnv,
): Promise<string | undefined | Back> {
  // P3: one prompt shape, the reason printed in place, the question re-asked
  // without abandoning the step. "b" stays navigation rather than a value, so
  // the wizard's back-chain survives the move onto the shared helper.
  const validate = (value: string): string | null => {
    if (isBack(value)) return null;
    const problem = baseURLProblem(value);
    return problem === null ? null : `  ${problem}`;
  };
  const ask = onboardAskLine(io);
  const loc = localeOf(env);
  if (provider.officialBaseURL === undefined) {
    // Compat: base URL is required — there is no default to keep, so Enter
    // asks again (bounded, so an exhausted script still gets out).
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const answer = await promptValidatedDefault(
        env,
        t(loc, "llmhub.wizard.baseurl.q"),
        t(loc, "llmhub.wizard.baseurl.required"),
        validate,
        ask,
      );
      if (answer.kind === "cancel") return BACK;
      if (answer.kind === "keep") continue;
      return isBack(answer.value) ? BACK : answer.value.replace(/\/+$/, "");
    }
    return undefined;
  }
  const answer = await promptValidatedDefault(
    env,
    t(loc, "llmhub.wizard.baseurl.q"),
    t(loc, "llmhub.wizard.baseurl.official", { url: provider.officialBaseURL }),
    validate,
    ask,
  );
  if (answer.kind === "cancel") return BACK;
  if (answer.kind === "keep") return provider.officialBaseURL;
  return isBack(answer.value) ? BACK : answer.value.replace(/\/+$/, "");
}

/** The pasted key is sent to whatever base URL survives this prompt (model
 *  discovery, then the live probe), so vet it BEFORE the key is typed — with
 *  the same rules headless `config add` enforces via the config schema.
 *  Returns a printable reason, or null when the URL is acceptable. */
function baseURLProblem(candidate: string): string | null {
  const errors: string[] = [];
  validateProviderBaseURL(candidate, "base URL", errors);
  return errors.length > 0 ? errors[0]! : null;
}

async function chooseModel(
  provider: OnboardProvider,
  baseURL: string,
  apiKey: string,
  io: OnboardIO,
  env: HandlerEnv,
): Promise<string | Back> {
  const loc = localeOf(env);
  // Best-effort discovery; never blocks the flow.
  const models = await io.discoverModels({ protocol: provider.protocol, baseURL, apiKey });
  if (models && models.length > 0) {
    const shown = models.slice(0, 30);
    // P1: the discovered list is a frame, with one explicit row for "not in
    // this list" instead of the old "type a name here too" overloading. Enter
    // still means the provider's default model, so a scripted run behaves
    // exactly as it did — and always moves forward.
    const customKey = String(shown.length + 1);
    const frame: MenuFrame = {
      title: t(loc, "llmhub.model_title"),
      banner: [],
      choices: [
        ...shown.map((m, i) => ({
          key: String(i + 1),
          main: m,
          ...(m === provider.defaultModel ? { hint: t(loc, "llmhub.tag.default") } : {}),
        })),
        { key: customKey, main: t(loc, "llmhub.model_custom") },
      ],
    };
    const key = await pickOneKey(onboardPickDeps(io, env, loc), frame);
    if (key === null) return provider.defaultModel;
    if (key !== customKey) {
      const picked = shown[Number.parseInt(key, 10) - 1];
      if (picked !== undefined) return picked;
    }
    // the custom row falls through to the typed prompt below
  }
  return typeModel(provider, io, env);
}

/** P3: type a model id yourself — the no-discovery path, and what the
 *  discovered list's "type another model id" row opens. */
async function typeModel(provider: OnboardProvider, io: OnboardIO, env: HandlerEnv): Promise<string | Back> {
  const loc = localeOf(env);
  const answer = await promptValidatedDefault(
    env,
    t(loc, "llmhub.wizard.model.q"),
    t(loc, "llmhub.wizard.model.default", { model: provider.defaultModel }),
    () => null, // any id is accepted here; the live probe is the real check
    onboardAskLine(io),
  );
  if (answer.kind === "cancel") return BACK;
  if (answer.kind === "keep") return provider.defaultModel;
  return isBack(answer.value) ? BACK : answer.value;
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
): Promise<ModelSettings | Back> {
  const caps = resolveModelCapabilities(provider.protocol, model);
  const loc = localeOf(env);

  // ── Thinking ──
  let thinkingEnabled: boolean;
  if (!caps.supportsThinking) {
    thinkingEnabled = false;
  } else if (caps.thinkingAlwaysOn) {
    thinkingEnabled = true;
    env.stdout(`${t(loc, "llmhub.wizard.thinking.always_on")}\n`);
  } else {
    // Pass-through protocols default the toggle OFF: the endpoint's model may not
    // reason at all, and a forwarded reasoning_effort would 400 on it. Reasoning
    // arenas want it on everywhere else.
    thinkingEnabled = await io.promptYesNo(
      t(loc, caps.thinkingDefaultOn ? "llmhub.wizard.thinking.ask" : "llmhub.wizard.thinking.ask_passthrough"),
      caps.thinkingDefaultOn,
    );
  }

  // ── Effort (only when thinking is on and the model exposes levels) ──
  let effort: ReasoningEffort | undefined;
  let effortExplicit = false;
  if (thinkingEnabled && caps.efforts.length > 0) {
    const efforts = caps.efforts.map(normalizeEffort);
    // Owner decision 2026-07-26: the default is an EXPLICIT "high" wherever the
    // model has it — a reasoning arena should not quietly inherit a provider
    // default that may be medium (GPT-5.x) or none (gpt-5.4). The provider's own
    // default stays reachable as the "auto" tier.
    const def: ReasoningEffort = efforts.includes("high")
      ? "high"
      : caps.defaultEffort
        ? normalizeEffort(caps.defaultEffort)
        : (efforts[efforts.length - 1] as ReasoningEffort);
    // P1 value frame. The ROWS are the protocol's tier vocabulary (what the
    // desktop renders as chips) rather than only this model's list: a tier the
    // model doesn't list is storable and clamped by the adapter, so it stays
    // pickable and is annotated instead of gated away. Typing a tier used to be
    // the only way to reach those — the frame makes them visible.
    const tiers: ReasoningEffort[] = [];
    for (const raw of caps.protocolEfforts.length > 0 ? caps.protocolEfforts : caps.efforts) {
      const tier = normalizeEffort(raw);
      if (!tiers.includes(tier)) tiers.push(tier);
    }
    if (!tiers.includes(def)) tiers.unshift(def);
    const autoKey = String(tiers.length + 1);
    const frame: MenuFrame = {
      title: t(loc, "llmhub.effort_title"),
      banner: [],
      // Only said when it is true: the tiers are the protocol's, and the
      // registry has nothing model-specific to back them up.
      ...(caps.isKnownModel ? {} : { subheader: [`  ${t(loc, "llmhub.effort.unknown_model")}`] }),
      choices: [
        ...tiers.map((tier, i) => {
          const tags = [
            tier === def ? t(loc, "llmhub.tag.default") : null,
            caps.isKnownModel && !efforts.includes(tier) ? t(loc, "llmhub.tag.clamped") : null,
          ].filter((tag): tag is string => tag !== null);
          return { key: String(i + 1), main: tier, ...(tags.length > 0 ? { hint: tags.join(" · ") } : {}) };
        }),
        { key: autoKey, main: "auto", hint: t(loc, "llmhub.effort.auto") },
      ],
    };
    const key = await pickOneKey(onboardPickDeps(io, env, loc), frame);
    if (key === null || key === autoKey) {
      // Enter/q keeps the shown default (what Enter always did here); "auto"
      // means "send no effort at all", so neither counts as an explicit tier
      // for the max-tokens recommendation below.
      effort = key === autoKey ? "auto" : def;
    } else {
      const picked = tiers[Number.parseInt(key, 10) - 1];
      effort = picked ?? def;
      effortExplicit = picked !== undefined;
    }
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
      t(loc, "llmhub.wizard.tokens.raise", {
        effort: effort ?? "high",
        recommended: rec.recommended,
        current: maxTokens,
      }),
      true,
    );
    if (raise) maxTokens = rec.recommended;
  }
  let stream: "auto" | "always" | "never" = "auto";
  let temperature: number | null = null;

  const advanced = await io.promptYesNo(t(loc, "llmhub.wizard.advanced.ask"), false);
  if (advanced) {
    const ask = onboardAskLine(io);
    // P3: a number that isn't one is explained and re-asked in place. It used
    // to be swallowed — the wizard kept the default and never said so.
    const cap = caps.maxOutputTokens;
    const mtAnswer = await promptValidatedDefault(
      env,
      t(loc, "llmhub.wizard.tokens.q"),
      cap
        ? t(loc, "llmhub.wizard.tokens.default_cap", { tokens: maxTokens, cap })
        : t(loc, "llmhub.wizard.tokens.default", { tokens: maxTokens }),
      (value) => (/^\d+$/.test(value) ? null : `  ${t(loc, "llmhub.invalid.tokens")}`),
      ask,
    );
    if (mtAnswer.kind === "value") {
      let n = Number.parseInt(mtAnswer.value, 10);
      if (n < MIN_MAX_TOKENS) n = MIN_MAX_TOKENS;
      if (cap && n > cap) n = cap;
      maxTokens = n;
    }

    // P1 value frame: three fixed values, so they are picked, not spelled.
    // The row words are the config values themselves.
    const streamFrame: MenuFrame = {
      title: t(loc, "llmhub.stream_title"),
      banner: [],
      choices: [
        { key: "1", main: "auto", hint: t(loc, "llmhub.tag.default") },
        { key: "2", main: "always" },
        { key: "3", main: "never" },
      ],
    };
    const streamKey = await pickOneKey(onboardPickDeps(io, env, loc), streamFrame);
    if (streamKey === "2") stream = "always";
    else if (streamKey === "3") stream = "never";

    if (!thinkingEnabled && caps.temperatureUsableWhenThinkingOff) {
      const tAnswer = await promptValidatedDefault(
        env,
        t(loc, "llmhub.wizard.temperature.q"),
        t(loc, "llmhub.wizard.temperature.default"),
        (value) => {
          const n = Number.parseFloat(value);
          return Number.isFinite(n) && n >= 0 && n <= 2 ? null : `  ${t(loc, "llmhub.invalid.temperature")}`;
        },
        ask,
      );
      if (tAnswer.kind === "value") temperature = Number.parseFloat(tAnswer.value);
    } else if (!thinkingEnabled) {
      env.stdout(`${t(loc, "llmhub.wizard.temperature.ignored")}\n`);
    }
    // When thinking is ON we never ask about temperature — it is ignored or
    // rejected by every major provider in that mode.
  }

  const settings: ModelSettings = {
    thinkingEnabled,
    ...(effort ? { effort } : {}),
    maxTokens,
    stream,
    temperature,
  };
  env.stdout(`${t(loc, "llmhub.wizard.echo", { settings: describeSettings(loc, settings) })}\n`);
  return settings;
}

/**
 * The one sentence that describes a collected profile ("on · effort high ·
 * max tokens 32000 · streaming auto"). Built once and used by BOTH the
 * settings step's echo line and the summary screen's Reasoning row, so the
 * two can never describe the same profile differently.
 */
function describeSettings(loc: Locale, s: ModelSettings): string {
  const parts = [t(loc, s.thinkingEnabled ? "llmhub.wizard.set.on" : "llmhub.wizard.set.off")];
  if (s.thinkingEnabled && s.effort) parts.push(t(loc, "llmhub.wizard.set.effort", { effort: s.effort }));
  parts.push(t(loc, "llmhub.wizard.set.max_tokens", { tokens: s.maxTokens }));
  parts.push(t(loc, "llmhub.wizard.set.streaming", { stream: s.stream }));
  if (s.temperature !== null) {
    parts.push(t(loc, "llmhub.wizard.set.temperature", { temperature: s.temperature }));
  }
  return parts.join(" · ");
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
  const loc = localeOf(env);
  const out = createOutput();

  if (!opts.reconfigure && (await existingConfigIsUsable(slug, io, env))) return "configured";

  // Snapshot the profiles that already existed BEFORE this wizard run, so we can
  // warn before overwriting one. Each provider maps to a FIXED profile id (every
  // OpenAI-compatible provider is "compat", etc.), so re-picking a configured
  // provider would clobber it and force it active — silent data loss the new
  // "add another" flow makes easy to hit. A profile written by an earlier failed
  // attempt in THIS run is not "pre-existing" and never triggers the prompt.
  const preExistingProfiles = (await readConfig(slug))?.profiles ?? {};

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // ── The wizard as an explicit phase machine ─────────────────────────────
    // provider → baseURL → key → model → settings → summary → write. "b" on any
    // line prompt moves one phase back; the SUMMARY screen is the revision hub —
    // most people only notice the wrong answer at the end, and before this
    // machine the only way back was Ctrl-C and start over.
    type Phase = "provider" | "baseURL" | "key" | "model" | "settings" | "summary" | "write";
    let phase: Phase = "provider";
    // Set when a summary jump re-runs one phase, so it returns to the summary
    // instead of dragging the user through every later step again.
    let fromSummary = false;

    let provider: OnboardProvider | undefined;
    let baseURL: string | undefined;
    let apiKey = "";
    let keyFilePath = "";
    let model = "";
    let settings: ModelSettings | undefined;
    // The staged key for this attempt (see the key phase): renamed into place
    // only once the profile that references it is safely on disk, and deleted
    // on every other way out, so a cancel can neither clobber the previous key
    // file nor leave a stray secret behind.
    let pendingKeyPath: string | undefined;
    const discardPendingKey = async (): Promise<void> => {
      const staged = pendingKeyPath;
      pendingKeyPath = undefined;
      if (staged !== undefined) await fs.rm(staged, { force: true }).catch(() => {});
    };

    let cancelled = false;
    while (phase !== "write" && !cancelled) {
      switch (phase) {
        case "provider": {
          provider = await chooseProvider(io, env);
          if (!provider) {
            // Back-navigation can reach this phase with a key already staged.
            await discardPendingKey();
            env.stdout(`${t(loc, "llmhub.wizard.provider.none")}\n`);
            return "failed";
          }
          // Confirm before overwriting a pre-existing profile (default No). To keep
          // both, the user runs `aifight config add <name>` with a custom id. Headless
          // `config add` is untouched — this gate lives only in the interactive wizard.
          const clash = preExistingProfiles[provider.id];
          if (clash) {
            const replace = await io.promptYesNo(
              t(loc, "llmhub.wizard.clash.ask", { id: provider.id, model: clash.model }),
              false,
            );
            if (!replace) {
              await discardPendingKey();
              env.stdout(`${t(loc, "llmhub.wizard.clash.kept", { id: provider.id })}\n`);
              return "failed";
            }
          }
          phase = "baseURL";
          break;
        }
        case "baseURL": {
          const r = await chooseBaseURL(provider!, io, env);
          if (r === BACK) {
            phase = fromSummary ? "summary" : "provider";
            fromSummary = false;
            break;
          }
          if (provider!.officialBaseURL === undefined && r === undefined) {
            env.stdout(`${t(loc, "llmhub.wizard.baseurl.missing")}\n`);
            break; // re-ask
          }
          baseURL = r;
          phase = fromSummary ? "summary" : "key";
          fromSummary = false;
          break;
        }
        case "key": {
          const entered = (
            await io.promptHidden(t(loc, "llmhub.wizard.key.q", { provider: provider!.displayName }))
          ).trim();
          if (isBack(entered)) {
            phase = "baseURL";
            break;
          }
          if (entered === "") {
            env.stdout(`${t(loc, "llmhub.wizard.key.empty")}\n`);
            const again = await io.promptYesNo(t(loc, "llmhub.wizard.key.retry"), true);
            if (!again) {
              await discardPendingKey();
              return "failed";
            }
            break; // re-ask
          }
          apiKey = entered;
          // Same on-disk layout the desktop app uses (resolveAgentDir/keys/<id>.key),
          // so a profile configured here and one configured in the app share one file.
          keyFilePath = path.join(resolveAgentDir(slug), "keys", `${provider!.id}.key`);
          // Stage at a pending path, NOT the final one: the key lands at
          // keyFilePath only after the profile write succeeds (below), so
          // cancelling a Replace flow leaves the previous key file untouched.
          // Back-navigation can stage a second key in one attempt (different
          // provider) — drop the earlier staging file first.
          const staged = `${keyFilePath}.pending-${process.pid}`;
          if (pendingKeyPath !== undefined && pendingKeyPath !== staged) {
            await fs.rm(pendingKeyPath, { force: true }).catch(() => {});
          }
          pendingKeyPath = staged;
          await io.storeKey(pendingKeyPath, apiKey);
          env.stdout(`${t(loc, "llmhub.wizard.key.received")}\n`);
          phase = "model";
          break;
        }
        case "model": {
          const r = await chooseModel(provider!, baseURL!, apiKey, io, env);
          if (r === BACK) {
            phase = fromSummary ? "summary" : "key";
            fromSummary = false;
            break;
          }
          model = r;
          phase = fromSummary ? "summary" : "settings";
          fromSummary = false;
          break;
        }
        case "settings": {
          const r = await chooseModelSettings(provider!, model, io, env);
          if (r === BACK) {
            phase = "model";
            break;
          }
          settings = r;
          phase = "summary";
          break;
        }
        case "summary": {
          const st = settings!;
          // P6-adjacent styling (U7): the review screen is kv rows, so the
          // label column sizes itself — the zh labels are a different width
          // and used to glue onto their values under the hand-padded layout.
          const baseURLText =
            baseURL === undefined
              ? t(loc, "llmhub.wizard.summary.unset")
              : baseURL === provider!.officialBaseURL
                ? t(loc, "llmhub.wizard.summary.official", { url: baseURL })
                : baseURL;
          env.stdout(
            "\n" +
              out.section(`  ${t(loc, "llmhub.wizard.summary.title", { provider: provider!.displayName })}`) +
              "\n" +
              out
                .kvRows([
                  [t(loc, "llmhub.wizard.summary.baseurl"), baseURLText],
                  [t(loc, "llmhub.wizard.summary.model"), model],
                  [t(loc, "llmhub.wizard.summary.reasoning"), describeSettings(loc, st)],
                  [t(loc, "llmhub.wizard.summary.key"), t(loc, "llmhub.wizard.summary.key.value"), "dim"],
                ])
                .join("\n") +
              "\n\n",
          );
          const ans = (await io.promptLine(t(loc, "llmhub.wizard.summary.ask")))
            .trim()
            .toLowerCase();
          if (ans === "") {
            phase = "write";
          } else if (ans === "1") {
            fromSummary = true;
            phase = "baseURL";
          } else if (ans === "2") {
            fromSummary = true;
            phase = "model";
          } else if (ans === "3" || isBack(ans)) {
            phase = "settings";
          } else if (ans === "q" || ans === "quit") {
            cancelled = true;
          }
          // anything else: re-print the summary
          break;
        }
      }
    }
    if (cancelled) {
      await discardPendingKey();
      env.stdout(`${t(loc, "llmhub.wizard.cancelled")}\n`);
      return "failed";
    }

    try {
      await writeProfile(slug, provider!.id, profileFor(provider!, baseURL, model, keyFilePath, settings!));
      // The profile now references the final key path — move the staged key into
      // place before the probe (and any later run) reads it.
      if (pendingKeyPath !== undefined) {
        await fs.rename(pendingKeyPath, keyFilePath);
        pendingKeyPath = undefined;
      }
    } catch (cause) {
      // The error surfaces to the user either way; what must not survive it is
      // the staged plaintext key sitting at a .pending path forever.
      await discardPendingKey();
      throw cause;
    }

    env.stdout(`\n${t(loc, "llmhub.wizard.testing", { provider: provider!.displayName, model })}\n`);
    const ok = await io.probe(slug);
    if (ok) {
      // Drop any leftover placeholder profiles (e.g. config init's
      // DEFAULT_CONFIG "claude-default" pointing at an unset env var) so the
      // user — and the desktop app — only see the profile that actually works.
      await pruneUnresolvableProfiles(slug, env);
      env.stdout(`${t(loc, "llmhub.wizard.existing.ok")}\n`);
      env.stdout(`${t(loc, "llmhub.wizard.tip", { id: provider!.id })}\n\n`);
      return "configured";
    }

    // P6: THE failure block — red `✗` headline, no hand-rolled icon.
    env.stdout(out.fail(t(loc, "llmhub.wizard.no_response")));
    if (attempt < MAX_ATTEMPTS) {
      const again = await io.promptYesNo(t(loc, "llmhub.wizard.retry.ask"), true);
      if (!again) break;
    }
  }

  env.stdout(
    [
      "",
      t(loc, "llmhub.wizard.giveup"),
      t(loc, "llmhub.wizard.giveup.show"),
      t(loc, "llmhub.wizard.giveup.test"),
      "",
    ].join("\n"),
  );
  return "failed";
}
