// `aifight config <subcommand>` — manage the LLM config that powers direct
// mode (BridgeConfig.runtimeType === "direct"). All subcommands read/write
// the SAME shared agent profile under <aifight-home>/agents/<slug>/, so the
// CLI and the desktop app stay in sync.
//
// Subcommands:
//   init   [slug]                       create config.json (LLM provider/model/key refs)
//   validate [slug]                     validate the agent profile files
//   test   [slug] [--profile name]      live 1-call probe of a configured profile (alias: probe)
//   show   [slug]                       print config; secrets described, never shown
//   set-key <profile> [slug] --env N|--file P   point a profile's apiKeyRef at a key (never raw key)
//   route  <game> <profile> [slug]      set per-game routing
//   use    <profile> [slug]             set the active/default profile
//
// Secret-handling rule: the raw API key NEVER passes through argv. set-key
// only stores an indirection (env var name or a key-file path).

import fs from "node:fs/promises";
import path from "node:path";

import type { HandlerArgs, HandlerEnv } from "../shared.js";
import { CommandError, UsageError, expectArity, isSupportedGame, SUPPORTED_GAMES } from "../shared.js";
import { runConfigInit } from "./config-init.js";
import { runConfigValidate } from "./config-validate.js";
import { runConfigProbe } from "./config-probe.js";
import { createOnboardIO } from "./onboard-io.js";
import { onboardDirectLLM, type OnboardIO } from "./onboard-llm.js";
import { suggestClosest, CONFIG_EXAMPLES } from "./config-shared.js";
import { runConfigAdd, runConfigUpdate } from "./config-edit.js";
import { runConfigModels } from "./config-models.js";
import { runConfigRemove, runConfigClearKey } from "./config-manage.js";

// Every config subcommand, for the did-you-mean suggester (D14). Keep in sync
// with the dispatch switch in runConfig.
const KNOWN_CONFIG_SUBS: readonly string[] = [
  "init", "validate", "test", "probe", "show", "explain", "set-key",
  "route", "use", "review", "add", "update", "models", "remove", "clear-key",
];
import { runBridgeSet } from "./bridge-set.js";
import { readBridgeConfig } from "../../bridge/config.js";
import { resolveAgentDir } from "../../profile/profile-loader.js";
import { resolveModelCapabilities } from "../../llm/capabilities/validate-capabilities.js";
import { validateConfig, type LLMConfig, type SecretRef as ConfigSecretRef } from "../../profile/config-schema.js";
import {
  checkSecretStatus,
  describeRef,
  validateSecretRef,
} from "../../profile/secret-ref.js";

const USAGE = [
  "usage: aifight config                                  interactive setup (LLM key, daily, claim, style)",
  "       aifight config add <profile> --protocol <claude|gpt|compat|gemini> (--env N|--file P|--key-stdin) [options]",
  "       aifight config update <profile> [--model N] [--base-url URL] [--stream …] [--max-tokens N] [options]",
  "       aifight config models [profile] [agent-slug]   list the models a profile's provider exposes",
  "       aifight config remove <profile> [--yes] [agent-slug]",
  "       aifight config clear-key <profile> [agent-slug]",
  "       aifight config test [agent-slug] [--profile <name>]",
  "       aifight config show [agent-slug]",
  "       aifight config explain [agent-slug] [--profile <name>]",
  "       aifight config set-key <profile> [agent-slug] (--env <NAME> | --file <PATH>)",
  "       aifight config route <game> <profile> [agent-slug]",
  "       aifight config use <profile> [agent-slug]",
  "       aifight config review [auto <off|all|losses_only> | model <profile|none>] [agent-slug]",
  "       aifight config validate [agent-slug]",
  "       aifight config init [agent-slug]                advanced: scaffold config files non-interactively",
  "  Configure direct-LLM mode. Your key is read only when you paste it or point",
  "  --env/--file/--key-stdin at it — nothing is auto-detected. The raw key never goes in argv.",
  "",
  ...CONFIG_EXAMPLES,
].join("\n");

export async function runConfig(args: HandlerArgs, env: HandlerEnv): Promise<number> {
  const sub = args.positional[0];
  if (sub === undefined) {
    // Bare `aifight config` in a terminal → guided interactive setup hub.
    if (!args.jsonMode && process.stdin.isTTY === true) {
      return runConfigInteractive(env);
    }
    // Non-interactive (piped input, CI, --json): print usage, don't prompt.
    env.stdout(USAGE + "\n");
    return 0;
  }
  const rest: HandlerArgs = { ...args, positional: args.positional.slice(1) };
  switch (sub) {
    case "init":
      return runConfigInit(rest, env);
    case "add":
      return runConfigAdd(rest, env);
    case "update":
      return runConfigUpdate(rest, env);
    case "remove":
      return runConfigRemove(rest, env);
    case "clear-key":
      return runConfigClearKey(rest, env);
    case "models":
      return runConfigModels(rest, env);
    case "validate":
      return runConfigValidate(rest, env);
    case "test":
    case "probe":
      return runConfigProbe(rest, env);
    case "show":
      return runConfigShow(rest, env);
    case "explain":
      return runConfigExplain(rest, env);
    case "set-key":
      return runConfigSetKey(rest, env);
    case "route":
      return runConfigRoute(rest, env);
    case "use":
      return runConfigUse(rest, env);
    case "review":
      return runConfigReview(rest, env);
    default: {
      const guess = suggestClosest(sub, KNOWN_CONFIG_SUBS);
      throw new UsageError(
        `unknown config subcommand '${sub}'`,
        guess !== undefined ? `Did you mean 'config ${guess}'?\n${USAGE}` : USAGE,
      );
    }
  }
}

// ─── interactive hub (bare `aifight config` on a TTY) ─────────────────
//
// One friendly entry point that walks through everything a player needs:
// connecting & testing an LLM, the daily match cadence, the claim link, and
// where the competitive-style files live. Each item delegates to the same
// handlers the explicit subcommands use, so there is no duplicated logic.

async function runConfigInteractive(env: HandlerEnv): Promise<number> {
  const slug = "default";
  const io = createOnboardIO(env);
  env.stdout("AIFight config — set up your agent.\n");

  for (;;) {
    env.stdout(
      [
        "",
        "  1) LLM API key & model     pick a provider, paste your key, test it",
        "  2) Daily ranked matches    how many automatic games per day",
        "  3) Claim your agent        show the Dashboard link that names it",
        "  4) Strategy                where to edit your agent's strategy files",
        "  5) Show current config",
        "  q) Done",
        "",
      ].join("\n"),
    );
    const choice = (await io.promptLine("  Choose [1-5, q]: ")).trim().toLowerCase();
    if (choice === "" || choice === "q" || choice === "quit" || choice === "done") {
      env.stdout("Done. Run `aifight config` any time to change these.\n");
      return 0;
    }
    try {
      switch (choice) {
        case "1":
          await configureLLMInteractive(slug, io, env);
          break;
        case "2":
          await configureDailyInteractive(io, env);
          break;
        case "3":
          showClaim(env);
          break;
        case "4":
          showStyle(slug, env);
          break;
        case "5":
          await runConfigShow({ positional: [slug], flags: {}, jsonMode: false }, env);
          break;
        default:
          env.stdout("  Please enter 1, 2, 3, 4, 5, or q.\n");
      }
    } catch (e) {
      env.stdout(`  Could not complete that step: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
}

async function configureLLMInteractive(slug: string, io: OnboardIO, env: HandlerEnv): Promise<void> {
  // Ensure the agent files exist, quietly. This never reads the environment.
  await runConfigInit({ positional: [slug], flags: {}, jsonMode: false }, { ...env, stdout: () => {} });
  let reconfigure = false;
  if (await activeKeyResolves(slug)) {
    reconfigure = await io.promptYesNo("  An LLM is already set up. Set up a different one?", false);
  }
  env.stdout("\n");
  await onboardDirectLLM({ slug, env, io, reconfigure });
}

async function configureDailyInteractive(io: OnboardIO, env: HandlerEnv): Promise<void> {
  const raw = (await io.promptLine("  Automatic ranked matches per day [0-20, 0 = off]: ")).trim();
  if (!/^\d+$/.test(raw) || Number.parseInt(raw, 10) > 20) {
    env.stdout("  Enter a whole number between 0 and 20.\n");
    return;
  }
  await runBridgeSet({ positional: ["daily", raw], flags: {}, jsonMode: false }, env);
}

function showClaim(env: HandlerEnv): void {
  let config: ReturnType<typeof readBridgeConfig>;
  try {
    config = readBridgeConfig();
  } catch {
    env.stdout("  No agent on this machine yet. Run `aifight setup` first, then come back to claim it.\n");
    return;
  }
  if (!config.claimUrl) {
    env.stdout("  No claim URL on file (this agent may already be claimed). Manage it in the Dashboard.\n");
    return;
  }
  env.stdout("\n  Open this link to claim your agent — claiming unlocks play; rename any time with `aifight rename`:\n");
  env.stdout(`  ${config.claimUrl}\n`);
}

function showStyle(_slug: string, env: HandlerEnv): void {
  env.stdout("\n  Your agent's strategy lives in local Markdown files you can edit:\n");
  env.stdout("    `aifight strategy init`  creates strategy/global.md (+ per-game files) you can fill in,\n");
  env.stdout("    `aifight strategy path`  prints exactly where each file lives.\n");
  env.stdout("  Write plain guidance there — how your agent reasons, weighs risk, and reads opponents.\n");
  env.stdout("  global.md applies to every game; strategy/games/<game>.md layers tactics on top.\n");
}

/** True when the active profile's key currently resolves (env present / file readable). */
async function activeKeyResolves(slug: string): Promise<boolean> {
  try {
    const { config } = await readConfigJson(slug);
    const active = config.activeProfile ? config.profiles[config.activeProfile] : undefined;
    if (!active) return false;
    return (await checkSecretStatus(active.apiKeyRef)).available;
  } catch {
    return false;
  }
}

// ─── show ────────────────────────────────────────────────────────────

async function runConfigShow(args: HandlerArgs, env: HandlerEnv): Promise<number> {
  expectArity(args, 0, 1, "usage: aifight config show [agent-slug]");
  const slug = (args.positional[0] as string | undefined) ?? "default";
  const { config } = await readConfigJson(slug);

  const profiles = [];
  for (const [id, def] of Object.entries(config.profiles)) {
    const status = await checkSecretStatus(def.apiKeyRef);
    profiles.push({
      id,
      displayName: def.displayName ?? id,
      protocol: def.protocol,
      model: def.model,
      baseURL: def.baseURL ?? null,
      key: status.sourceDescription, // e.g. "env:ANTHROPIC_API_KEY" — never the value
      keyResolvable: status.available,
    });
  }

  if (args.jsonMode) {
    env.stdout(
      JSON.stringify({
        agentSlug: slug,
        activeProfile: config.activeProfile,
        routing: config.routing,
        profiles,
      }) + "\n",
    );
    return 0;
  }

  env.stdout(`aifight config: agent "${slug}"\n`);
  env.stdout(`  active profile : ${config.activeProfile}\n`);
  env.stdout(`  routing default: ${config.routing.default}\n`);
  const byGame = config.routing.byGame ?? {};
  const routes = Object.entries(byGame);
  if (routes.length > 0) {
    env.stdout(`  per-game route : ${routes.map(([g, p]) => `${g}->${p}`).join(", ")}\n`);
  }
  env.stdout("  profiles:\n");
  for (const p of profiles) {
    env.stdout(`    - ${p.id} (${p.displayName})\n`);
    env.stdout(`        protocol : ${p.protocol}\n`);
    env.stdout(`        model    : ${p.model}\n`);
    env.stdout(`        baseURL  : ${p.baseURL ?? "(protocol default)"}\n`);
    env.stdout(`        key      : ${p.key} ${p.keyResolvable ? "(resolvable)" : "(NOT resolvable)"}\n`);
  }
  env.stdout("\n");
  return 0;
}

// ─── explain ─────────────────────────────────────────────────────────
//
// A capability-aware field guide: better than static comments in config.json
// because it reflects the user's CURRENT model — it shows what this model
// actually supports (effort levels, whether temperature applies, output cap)
// next to each field's current value.

async function runConfigExplain(args: HandlerArgs, env: HandlerEnv): Promise<number> {
  const usage = "usage: aifight config explain [agent-slug] [--profile <name>]";
  expectArity(args, 0, 1, usage);
  const slug = (args.positional[0] as string | undefined) ?? "default";
  const { config } = await readConfigJson(slug);
  const profileId =
    (typeof args.flags["profile"] === "string" ? (args.flags["profile"] as string) : undefined) ??
    config.activeProfile;
  const p = config.profiles[profileId];
  if (!p) {
    throw new CommandError(
      "config_explain_unknown_profile",
      `unknown profile "${profileId}". Available: ${Object.keys(config.profiles).join(", ") || "(none)"}`,
    );
  }

  const caps = resolveModelCapabilities(p.protocol, p.model);
  const keyStatus = await checkSecretStatus(p.apiKeyRef);
  const pad = 24;
  const field = (label: string, value: string, desc: string, note?: string): void => {
    env.stdout(`  ${label.padEnd(pad)}${value}\n`);
    env.stdout(`  ${" ".repeat(pad)}${desc}\n`);
    if (note) env.stdout(`  ${" ".repeat(pad)}→ ${note}\n`);
    env.stdout("\n");
  };

  env.stdout(`aifight config — field guide for profile "${profileId}"\n`);
  env.stdout(
    `  ${p.model} via ${p.protocol}${caps.isKnownModel ? "" : "   (unknown model — capabilities unverified)"}\n\n`,
  );

  field("protocol", p.protocol, "Wire API / request format. Tied to the provider you picked.");
  field(
    "baseURL",
    p.baseURL ?? `(default ${caps.defaultBaseURL ?? "—"})`,
    "Provider endpoint. Override for a proxy or an OpenAI-compatible gateway.",
  );
  field("model", p.model, "Model id in the provider's namespace.");
  field(
    "apiKeyRef",
    `${keyStatus.sourceDescription} ${keyStatus.available ? "(resolvable)" : "(NOT resolvable)"}`,
    "Where the key is read from. The value itself is never stored or shown.",
  );

  if (!caps.supportsThinking) {
    field("thinking", "n/a", "This model/protocol has no reasoning mode.");
  } else {
    field(
      "thinking.enabled",
      String(p.thinking?.enabled ?? false),
      "Reasoning on/off. AIFight rewards reasoning, so it defaults to on.",
      caps.thinkingAlwaysOn
        ? "this model always reasons — it can't be turned off."
        : "this model can also run with thinking off.",
    );
    if (caps.efforts.length > 0) {
      field(
        "thinking.effort",
        String(p.thinking?.effort ?? caps.defaultEffort ?? "—"),
        "How deeply the model reasons.",
        `supported here: ${caps.efforts.map((e) => (e === "none" ? "off" : e)).join(", ")}.`,
      );
    }
  }

  field(
    "request.maxTokens",
    String(p.request?.maxTokens ?? "(default)"),
    "Output-token ceiling. Higher = more room to reason (you pay for tokens used, not the cap).",
    caps.maxOutputTokens ? `model max ${caps.maxOutputTokens}.` : undefined,
  );
  field(
    "request.stream",
    String(p.request?.stream ?? "auto"),
    "SSE streaming. auto streams large/reasoning outputs; always|never to force.",
  );
  const thinkingOn = caps.supportsThinking && p.thinking?.enabled !== false;
  const tempNote =
    thinkingOn || caps.samplingIgnoredWhenThinking
      ? "ignored while thinking is on — leave it omitted."
      : caps.temperatureUsableWhenThinkingOff
        ? "with thinking off, set a low value (e.g. 0.2) for more rigour; omitted = provider default (~1)."
        : "this model ignores temperature.";
  field(
    "request.temperature",
    p.request?.temperature === null || p.request?.temperature === undefined
      ? "(omitted)"
      : String(p.request.temperature),
    "Sampling randomness. Omitted = the provider's own default.",
    tempNote,
  );
  field(
    "request.responseFormat",
    String(p.request?.responseFormat ?? "json"),
    "Output format hint. AIFight needs JSON actions, so keep this json.",
  );

  env.stdout("  Change these by re-running `aifight config`, or with set-key / route / use.\n");
  env.stdout("  Full annotated reference: docs/config-reference.md\n\n");
  return 0;
}

// ─── set-key ─────────────────────────────────────────────────────────

async function runConfigSetKey(args: HandlerArgs, env: HandlerEnv): Promise<number> {
  const usage =
    "usage: aifight config set-key <profile> [agent-slug] (--env <NAME> | --file <PATH>)";
  expectArity(args, 1, 2, usage);
  const profileId = args.positional[0] as string;
  const slug = (args.positional[1] as string | undefined) ?? "default";

  const envName = typeof args.flags["env"] === "string" ? (args.flags["env"] as string) : undefined;
  const filePath = typeof args.flags["file"] === "string" ? (args.flags["file"] as string) : undefined;
  const chosen = [envName, filePath].filter((v) => v !== undefined).length;
  if (chosen !== 1) {
    throw new UsageError(
      "set-key needs exactly one source: --env <NAME> (read from an environment variable) or --file <PATH> (read from a 0600 key file)",
      usage,
    );
  }

  const ref: ConfigSecretRef =
    envName !== undefined
      ? { type: "env", name: envName }
      : { type: "file", path: filePath as string };
  const validated = validateSecretRef(ref);
  if (!validated.ok) {
    throw new CommandError("config_setkey_invalid", validated.error);
  }

  const { configPath, config } = await readConfigJson(slug);
  const def = config.profiles[profileId];
  if (!def) {
    throw new CommandError(
      "config_setkey_unknown_profile",
      `unknown profile "${profileId}". Available: ${Object.keys(config.profiles).join(", ") || "(none)"}`,
    );
  }

  const next: LLMConfig = {
    ...config,
    profiles: { ...config.profiles, [profileId]: { ...def, apiKeyRef: ref } },
  };
  await writeConfigJson(configPath, next);

  if (args.jsonMode) {
    env.stdout(
      JSON.stringify({ agentSlug: slug, profile: profileId, apiKeyRef: describeRef(ref) }) + "\n",
    );
  } else {
    env.stdout(
      `aifight config set-key: profile "${profileId}" now reads its key from ${describeRef(ref)} (the key value is not stored in config.json).\n`,
    );
  }
  return 0;
}

// ─── route ───────────────────────────────────────────────────────────

async function runConfigRoute(args: HandlerArgs, env: HandlerEnv): Promise<number> {
  const usage = "usage: aifight config route <game> <profile> [agent-slug]";
  expectArity(args, 2, 3, usage);
  const game = args.positional[0] as string;
  const profileId = args.positional[1] as string;
  const slug = (args.positional[2] as string | undefined) ?? "default";

  if (!isSupportedGame(game)) {
    throw new UsageError(
      `unsupported game "${game}". Direct mode supports: ${SUPPORTED_GAMES.join(", ")}`,
      usage,
    );
  }

  const { configPath, config } = await readConfigJson(slug);
  if (!config.profiles[profileId]) {
    throw new CommandError(
      "config_route_unknown_profile",
      `unknown profile "${profileId}". Available: ${Object.keys(config.profiles).join(", ") || "(none)"}`,
    );
  }

  const byGame = { ...(config.routing.byGame ?? {}), [game]: profileId } as LLMConfig["routing"]["byGame"];
  const next: LLMConfig = { ...config, routing: { ...config.routing, byGame } };
  await writeConfigJson(configPath, next);

  if (args.jsonMode) {
    env.stdout(JSON.stringify({ agentSlug: slug, game, profile: profileId }) + "\n");
  } else {
    env.stdout(`aifight config route: ${game} will now use profile "${profileId}".\n`);
  }
  return 0;
}

// ─── use ─────────────────────────────────────────────────────────────

async function runConfigUse(args: HandlerArgs, env: HandlerEnv): Promise<number> {
  const usage = "usage: aifight config use <profile> [agent-slug]";
  expectArity(args, 1, 2, usage);
  const profileId = args.positional[0] as string;
  const slug = (args.positional[1] as string | undefined) ?? "default";

  const { configPath, config } = await readConfigJson(slug);
  if (!config.profiles[profileId]) {
    throw new CommandError(
      "config_use_unknown_profile",
      `unknown profile "${profileId}". Available: ${Object.keys(config.profiles).join(", ") || "(none)"}`,
    );
  }

  const next: LLMConfig = {
    ...config,
    activeProfile: profileId,
    routing: { ...config.routing, default: profileId },
  };
  await writeConfigJson(configPath, next);

  if (args.jsonMode) {
    env.stdout(JSON.stringify({ agentSlug: slug, activeProfile: profileId }) + "\n");
  } else {
    env.stdout(`aifight config use: active profile is now "${profileId}".\n`);
  }
  return 0;
}

// ─── review (self-review settings) ───────────────────────────────────
//
// Get/set the post-match self-review behavior (SELF_REVIEW_DESIGN.md). The
// desktop Settings panel drives the same subcommand via cliRun, so CLI and app
// stay in sync. autoMode default is "off" — nothing auto-runs until opted in.

async function runConfigReview(args: HandlerArgs, env: HandlerEnv): Promise<number> {
  const usage =
    "usage: aifight config review [auto <off|all|losses_only> | model <profile|none>] [agent-slug]";
  const action = args.positional[0];

  if (action === "auto") {
    expectArity(args, 2, 3, usage);
    const mode = args.positional[1];
    if (mode !== "off" && mode !== "all" && mode !== "losses_only") {
      throw new UsageError(`auto mode must be one of: off, all, losses_only`, usage);
    }
    const slug = (args.positional[2] as string | undefined) ?? "default";
    const { configPath, config } = await readConfigJson(slug);
    const next: LLMConfig = { ...config, selfReview: { ...(config.selfReview ?? {}), autoMode: mode } };
    await writeConfigJson(configPath, next);
    return printReviewConfig(env, slug, next, args.jsonMode);
  }

  if (action === "model") {
    expectArity(args, 2, 3, usage);
    const model = args.positional[1] as string;
    const slug = (args.positional[2] as string | undefined) ?? "default";
    const { configPath, config } = await readConfigJson(slug);
    const clear = model === "none" || model === "";
    if (!clear && !config.profiles[model]) {
      throw new CommandError(
        "config_review_unknown_profile",
        `unknown profile "${model}". Available: ${Object.keys(config.profiles).join(", ") || "(none)"}`,
      );
    }
    const selfReview = { ...(config.selfReview ?? {}) };
    if (clear) delete selfReview.model;
    else selfReview.model = model;
    const next: LLMConfig = { ...config, selfReview };
    await writeConfigJson(configPath, next);
    return printReviewConfig(env, slug, next, args.jsonMode);
  }

  // No action → show current settings (optional agent-slug positional).
  expectArity(args, 0, 1, usage);
  const slug = (action as string | undefined) ?? "default";
  const { config } = await readConfigJson(slug);
  return printReviewConfig(env, slug, config, args.jsonMode);
}

function printReviewConfig(env: HandlerEnv, slug: string, config: LLMConfig, jsonMode: boolean): number {
  const sr = config.selfReview ?? {};
  const autoMode = sr.autoMode ?? "off";
  const model = sr.model ?? "";
  if (jsonMode) {
    env.stdout(
      JSON.stringify({
        agentSlug: slug,
        selfReview: { autoMode, model, maxTurns: sr.maxTurns ?? null },
      }) + "\n",
    );
    return 0;
  }
  env.stdout(`aifight config review: agent "${slug}"\n`);
  env.stdout(`  auto-review  : ${autoMode}\n`);
  env.stdout(`  review model : ${model !== "" ? model : "(same model the match used)"}\n`);
  return 0;
}

// ─── shared config.json read/write ───────────────────────────────────

async function readConfigJson(slug: string): Promise<{ configPath: string; config: LLMConfig }> {
  const configPath = path.join(resolveAgentDir(slug), "config.json");
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (e) {
    throw new CommandError(
      "config_not_found",
      `cannot read ${configPath}: ${(e as Error).message}. Run \`aifight config init${slug === "default" ? "" : " " + slug}\` first.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CommandError("config_invalid_json", `${configPath} is not valid JSON: ${(e as Error).message}`);
  }
  const result = validateConfig(parsed);
  if (!result.ok) {
    throw new CommandError("config_invalid", `config.json is invalid: ${result.errors.join("; ")}`);
  }
  return { configPath, config: result.config };
}

async function writeConfigJson(configPath: string, config: LLMConfig): Promise<void> {
  const result = validateConfig(config);
  if (!result.ok) {
    throw new CommandError("config_write_invalid", `refusing to write invalid config: ${result.errors.join("; ")}`);
  }
  const tmp = `${configPath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
  await fs.rename(tmp, configPath);
}
