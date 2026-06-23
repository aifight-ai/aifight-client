// `aifight setup` — the one guided command that gets a new player playing.
//
// It orchestrates the primitives (create an agent identity, connect & test the
// LLM, install the background service, claim) so a newcomer runs ONE command
// instead of remembering several. It is idempotent: re-running it inspects what
// already exists on this machine and offers to continue or start fresh.
//
// Modes:
//   - interactive (TTY): pre-flight (use existing / new) → register → LLM setup
//     (aifight config's wizard) → service install → claim URL → checklist.
//   - --auto: non-interactive — register, save credentials, install the service,
//     then print what's left (set up the LLM with `aifight config`).
//   - --json: programmatic — register and emit machine-readable output, no
//     prompts or service setup (used by the desktop app).
//   - --approved-local-setup: Agent-assisted, after the human approved local
//     service changes; non-interactive, installs/reloads the service.

import { generateSuggestedName } from "../../account/suggested-name";
import { registerAgent } from "../../account/registration";
import { getDeviceId } from "../../account/device-id";
import { RegisterHttpError, RegisterNetworkError } from "../../account/errors";
import {
  defaultRuntimeLocalUrl,
  defaultRuntimeModel,
  readBridgeConfig,
  redactBridgeConfig,
  writeBridgeConfig,
  type BridgeConfig,
} from "../../bridge/config";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { CommandError, UsageError, expectArity } from "../shared";
import { offerBridgeServiceInstall } from "./bridge-service";
import { onboardDailyCap } from "./bridge-set";
import { runConfigInit } from "./config-init";
import { onboardDirectLLM } from "./onboard-llm";
import { createOnboardIO } from "./onboard-io";
import { scaffoldGlobalStrategy } from "../../strategy/local-strategy";

const DEFAULT_BASE_URL = "https://aifight.ai";
const DEFAULT_AUTO_DAILY_LIMIT = 2;
const APPROVED_LOCAL_SETUP_FLAG = "approved-local-setup";
const AUTO_FLAG = "auto";

const USAGE = [
  "usage: aifight setup [--name <suggested_name>] [--auto] [--approved-local-setup]",
  "  Guided setup: create your agent, connect & test your LLM, go online, and claim it.",
  "  In a terminal it walks you through each step; re-run it any time to add or fix things.",
  "  --auto runs non-interactively: register, save credentials, install the service, then",
  "         print what's left — set up the LLM with `aifight config`.",
  "  --approved-local-setup is for Agent-assisted setup after the human approved local changes.",
  "  --json registers and prints machine-readable output with no prompts or service setup.",
].join("\n");

export async function runSetup(args: HandlerArgs, env: HandlerEnv): Promise<number> {
  expectArity(args, 0, 1, USAGE);
  // No positional argument. A bare legacy `direct` token (old `register direct`
  // muscle memory / scripts) is accepted silently but never required.
  const legacy = args.positional[0];
  if (legacy !== undefined && legacy !== "direct") {
    throw new UsageError(
      `aifight setup takes no positional argument; '${legacy}' is not understood. Run \`aifight setup\`.`,
      USAGE,
    );
  }

  const autoMode = args.flags[AUTO_FLAG] === true;
  const approvedLocalSetup = args.flags[APPROVED_LOCAL_SETUP_FLAG] === true;
  if (args.jsonMode && approvedLocalSetup) {
    throw new UsageError("--approved-local-setup cannot be combined with --json", USAGE);
  }
  if (args.jsonMode && autoMode) {
    throw new UsageError("--auto cannot be combined with --json", USAGE);
  }

  const interactive =
    !args.jsonMode && !autoMode && !approvedLocalSetup && process.stdin.isTTY === true;
  const existing = readOptionalBridgeConfig();

  // ── Stage 0: pre-flight — decide identity ──
  let config: BridgeConfig;
  let registeredNow = false;

  if (existing !== undefined) {
    if (!interactive) {
      // Non-interactive runs never silently replace an existing identity.
      throw new CommandError(
        "bridge_already_configured",
        [
          `This machine already has local AIFight bridge credentials for ${existing.agentName} (${existing.agentId}).`,
          "`aifight setup` will not replace an existing local identity without a prompt.",
          "Run `aifight setup` in a terminal to choose use-existing or create-new, use `aifight update --yes` to upgrade,",
          "`aifight service install` to restore the background service, or Dashboard `Connect Bridge` plus",
          "`aifight connect <PAIRING_CODE>` to authorize this machine for an existing claimed Agent.",
          "To remove the local identity first, run `aifight uninstall`.",
        ].join("\n"),
      );
    }
    const choice = await preflightChoice(existing, env);
    if (choice === "quit") {
      env.stdout("No changes made. Run `aifight setup` again any time.\n");
      return 0;
    }
    if (choice === "connect") {
      env.stdout(
        [
          "",
          'To move this Agent to this machine, open the Dashboard → your Agent → "Connect Bridge",',
          "copy the pairing code, then run:",
          "  aifight connect <PAIRING_CODE>",
          "This rotates the key, binds the Agent to this machine, and signs the old machine out.",
          "(If this Agent isn't claimed yet, claim it from its claim link first, then pair.)",
          "",
        ].join("\n"),
      );
      return 0;
    }
    if (choice === "use") {
      config = existing;
      env.stdout(`\nContinuing with your existing agent ${existing.agentName}.\n\n`);
    } else {
      env.stdout("\nCreating a new agent — this replaces the local identity on this machine.\n\n");
      config = await performRegistration(args, env);
      registeredNow = true;
    }
  } else {
    config = await performRegistration(args, env);
    registeredNow = true;
  }

  const slug = config.directAgentSlug ?? "default";

  // Scaffold a starter Markdown strategy (strategy/global.md) for the new agent,
  // at the exact path the runtime reads each decision. Best-effort and
  // idempotent — never clobbers an existing file and never blocks setup. Runs in
  // every mode (interactive / --auto / --json) so a fresh agent always has an
  // editable strategy; the LLM config (config.json) is scaffolded separately.
  try {
    await scaffoldGlobalStrategy(config.agentId);
  } catch {
    // A strategy scaffold hiccup must never look like a setup failure; the user
    // can always create it later with `aifight strategy init`.
  }

  // ── Programmatic JSON path (desktop / scripting) ──
  if (args.jsonMode) {
    env.stdout(
      JSON.stringify({
        status: "registered",
        claimUrl: config.claimUrl,
        config: redactBridgeConfig(config),
      }) + "\n",
    );
    return 0;
  }

  if (registeredNow) printRegistrationSummary(config, env);

  // ── Stage 2: LLM (interactive only) ──
  let llmConfigured = false;
  if (interactive) {
    try {
      await runConfigInit(
        { positional: [slug], flags: {}, jsonMode: false },
        { ...env, stdout: () => {} },
      );
      env.stdout("Now connect the LLM your agent will play with — your key stays on this machine.\n\n");
      const result = await onboardDirectLLM({ slug, env, io: createOnboardIO(env) });
      llmConfigured = result === "configured";
    } catch {
      // A setup hiccup must not look like a registration failure.
      env.stdout("\nLLM setup didn't finish — you can run `aifight config` later.\n");
    }
  } else if (autoMode || approvedLocalSetup) {
    env.stdout("Skipping LLM setup (non-interactive). Configure it with `aifight config` before playing.\n\n");
  }

  // ── Stage 2.5: daily auto-match cap (interactive only) ──
  // The token-burn safety: the user consciously picks how many matches per day
  // the agent may start by itself (default 2; 0 = manual only; >10 confirms).
  if (interactive) {
    try {
      await onboardDailyCap(env);
    } catch {
      env.stdout("\nDaily-cap setup didn't finish — the default (2/day) stands; change it with `aifight set daily <N>`.\n");
    }
  }

  // ── Stage 3: service (offer; auto-accept in --auto / approved) ──
  const service = await offerBridgeServiceInstall(env, {
    approvedLocalSetup: approvedLocalSetup || autoMode,
  });

  // ── Final checklist ──
  printSetupChecklist(env, {
    config,
    llmConfigured,
    serviceInstalled: service === "installed",
  });
  return 0;
}

// ─── Pre-flight choice ───────────────────────────────────────────────

async function preflightChoice(
  existing: BridgeConfig,
  env: HandlerEnv,
): Promise<"use" | "new" | "connect" | "quit"> {
  env.stdout("Found an existing AIFight agent on this machine:\n");
  env.stdout(`  ${existing.agentName} (${existing.agentId})\n\n`);
  env.stdout("  [U] Use it     — keep this identity (works only on the machine it was set up on)\n");
  env.stdout("  [C] Connect    — move it here with a Dashboard pairing code (claimed agent on a new machine)\n");
  env.stdout("  [N] New agent  — create a fresh agent (replaces this local identity)\n");
  env.stdout("  [Q] Quit       — make no changes\n");
  for (let i = 0; i < 3; i++) {
    const ans = (await readLine(env, "  Choose [U/c/n/q]: ")).trim().toLowerCase();
    if (ans === "" || ans === "u" || ans === "use") return "use";
    if (ans === "c" || ans === "connect") return "connect";
    if (ans === "n" || ans === "new") return "new";
    if (ans === "q" || ans === "quit") return "quit";
    env.stdout("  Please enter U, C, N, or Q.\n");
  }
  return "quit";
}

// ─── Registration core ───────────────────────────────────────────────

async function performRegistration(args: HandlerArgs, env: HandlerEnv): Promise<BridgeConfig> {
  const suggestedName = resolveAgentName(args);
  const baseUrl = normalizeBaseUrl(process.env.AIFIGHT_BASE_URL ?? DEFAULT_BASE_URL);
  const runtimeModel = defaultRuntimeModel("direct");
  const runtimeLocalUrl = defaultRuntimeLocalUrl("direct");

  try {
    const result = await registerAgent({
      baseUrl,
      request: {
        name: suggestedName,
        model: runtimeModel,
        description: "AIFight Bridge agent (direct)",
      },
      fetchImpl: env.fetchImpl,
      deviceId: getDeviceId(),
    });

    const config: BridgeConfig = {
      version: 1,
      baseUrl,
      wsUrl: deriveWsUrl(baseUrl),
      agentId: result.agentId,
      agentName: result.response.agent.name,
      suggestedName: result.response.agent.suggested_name ?? suggestedName,
      apiKey: result.apiKey,
      claimUrl: result.claimUrl,
      claimToken: result.claimToken,
      runtimeType: "direct",
      runtimeLocalUrl,
      runtimeModel,
      directAgentSlug: "default",
      autoDailyLimit: DEFAULT_AUTO_DAILY_LIMIT,
      updatedAt: new Date().toISOString(),
    };
    writeBridgeConfig(config);
    return config;
  } catch (e) {
    if (e instanceof RegisterHttpError) {
      const error = typeof e.body === "object" ? e.body.error : undefined;
      throw new CommandError("registration_failed", error ?? `registration failed with HTTP ${e.status}`);
    }
    if (e instanceof RegisterNetworkError) {
      throw new CommandError("registration_failed", e.message);
    }
    throw e;
  }
}

// ─── Output helpers ──────────────────────────────────────────────────

function printRegistrationSummary(config: BridgeConfig, env: HandlerEnv): void {
  env.stdout("AIFight agent created.\n\n");
  env.stdout(`  Bootstrap ID   : ${config.agentName}\n`);
  env.stdout(`  Name           : ${config.agentName}  (change any time: aifight rename <name>)\n`);
  env.stdout("  Status         : unclaimed — claim to go live\n");
  env.stdout(`  Daily matches  : ${DEFAULT_AUTO_DAILY_LIMIT} ranked per day\n`);
  env.stdout("  Local credentials saved on this machine.\n\n");
}

function printSetupChecklist(
  env: HandlerEnv,
  s: { config: BridgeConfig; llmConfigured: boolean; serviceInstalled: boolean },
): void {
  const mark = (ok: boolean): string => (ok ? "✓" : "☐");
  env.stdout("Setup summary\n");
  env.stdout(`  ✓ Agent     : ${s.config.agentName} (unclaimed)\n`);
  env.stdout(
    `  ${mark(s.llmConfigured)} LLM       : ${s.llmConfigured ? "configured & tested" : "not set up — run `aifight config`"}\n`,
  );
  env.stdout(
    `  ${mark(s.serviceInstalled)} Service   : ${s.serviceInstalled ? "aifight.service running" : "not installed — run `aifight service install`"}\n`,
  );
  env.stdout("  ☐ Claim     : open the link below to verify your email (required before it can play)\n");
  if (s.config.claimUrl) env.stdout(`               ${s.config.claimUrl}\n`);
  env.stdout("\nHandy commands:\n");
  env.stdout("  aifight status     check your agent any time\n");
  env.stdout("  aifight config     change your LLM, daily matches, or style\n");
  env.stdout("  aifight setup      re-run this guided setup\n\n");
}

// ─── Small utilities (lifted from the former register command) ───────

function resolveAgentName(args: HandlerArgs): string {
  const explicit = stringFlag(args.flags, "name");
  if (explicit !== undefined) return explicit;
  // A nice evocative "Adjective Noun" display name (owner ruling 2026-06-18),
  // not the old `agent-direct-<host>-<hex>` slug. The user can keep it or change
  // it any time with `aifight rename`.
  return generateSuggestedName();
}

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

function readOptionalBridgeConfig(): BridgeConfig | undefined {
  try {
    return readBridgeConfig();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.includes("bridge is not configured")) return undefined;
    throw cause;
  }
}

function deriveWsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else throw new Error(`unsupported AIFight base URL protocol: ${url.protocol}`);
  url.pathname = "/api/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function stringFlag(
  flags: Readonly<Record<string, string | number | boolean>>,
  flagName: string,
): string | undefined {
  const value = flags[flagName];
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.trim();
}

function readLine(env: HandlerEnv, question: string): Promise<string> {
  env.stdout(question);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise<string>((resolve) => {
    process.stdin.once("data", (chunk) => {
      process.stdin.pause();
      resolve(String(chunk).replace(/[\r\n]+$/, ""));
    });
  });
}
