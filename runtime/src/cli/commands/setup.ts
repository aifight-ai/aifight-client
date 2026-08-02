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
import { getDeviceId, stampLocalDeviceIdentity } from "../../account/device-id";
import { RegisterHttpError, RegisterNetworkError } from "../../account/errors";
import {
  archiveReplacedBridgeConfig,
  defaultRuntimeLocalUrl,
  defaultRuntimeModel,
  readBridgeConfig,
  redactBridgeConfig,
  validatePlatformBaseUrl,
  writeBridgeConfig,
  type BridgeConfig,
} from "../../bridge/config";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { CommandError, UsageError, expectArity } from "../shared";
import { padEndVisible, visibleWidth } from "../ansi";
import { resolveLocale, t, type Locale } from "../i18n";
import { createOutput, type KvRow } from "../output";
import { offerBridgeServiceInstall } from "./bridge-service";
import { onboardDailyCap } from "./bridge-set";
import { runConfigInit } from "./config-init";
import type { MenuFrame } from "./menu-frame";
import { onboardDirectLLM } from "./onboard-llm";
import { createOnboardIO } from "./onboard-io";
import { pickOneKey } from "./pick-one";
import { scaffoldGlobalStrategy } from "../../strategy/local-strategy";

const DEFAULT_BASE_URL = "https://aifight.ai";
const DEFAULT_AUTO_DAILY_LIMIT = 2;
const APPROVED_LOCAL_SETUP_FLAG = "approved-local-setup";
const AUTO_FLAG = "auto";
// Reuses the existing connect-flow flag: "approve replacing the existing local
// identity". For setup it means register a FRESH agent here (archiving the old).
const REPLACE_FLAG = "replace-local-identity";

const USAGE = [
  "usage: aifight setup [--name <suggested_name>] [--auto] [--approved-local-setup] [--replace-local-identity]",
  "  Guided setup: create your agent, connect & test your LLM, go online, and claim it.",
  "  In a terminal it walks you through each step; re-run it any time to add or fix things.",
  "  --auto runs non-interactively: register, save credentials, install the service, then",
  "         print what's left — set up the LLM with `aifight config`.",
  "  --approved-local-setup is for Agent-assisted setup after the human approved local changes.",
  "  --json registers and prints machine-readable output with no prompts or service setup.",
  "  --replace-local-identity registers a FRESH agent on the same host even if one is already",
  "         set up, archiving a redacted snapshot of the old identity (local sessions / LLM kept).",
].join("\n");

/** The wizard's display locale (menu.ts's rule: read fresh, never cache). */
function localeOf(env: HandlerEnv): Locale {
  return env.locale?.() ?? resolveLocale();
}

export async function runSetup(args: HandlerArgs, env: HandlerEnv): Promise<number> {
  expectArity(args, 0, 1, USAGE);
  const loc = localeOf(env);
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
  const replace = args.flags[REPLACE_FLAG] === true;
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

  if (existing !== undefined && replace) {
    // Re-register on the SAME host (preserve beta/prod), archiving a redacted
    // snapshot of the old identity first. Local sessions (runtime/agents/<id>)
    // and the shared LLM config are untouched — only the active pointer moves.
    // Desktop "set up a new agent" / `aifight setup --json --replace` use this.
    archiveReplacedBridgeConfig(existing);
    env.stdout(`${t(loc, "wizard.new.archived")}\n\n`);
    config = await performRegistration(args, env, existing.baseUrl);
    registeredNow = true;
  } else if (existing !== undefined) {
    if (!interactive) {
      // Non-interactive runs never silently replace an existing identity (use
      // --replace to opt in, which archives the old one first).
      throw new CommandError(
        "bridge_already_configured",
        [
          `This machine already has local AIFight bridge credentials for ${existing.agentName} (${existing.agentId}).`,
          "`aifight setup` will not replace an existing local identity without a prompt.",
          "Run `aifight setup` in a terminal to choose use-existing or create-new, pass",
          "`--replace-local-identity` to register a fresh agent here (archiving the old one),",
          "use `aifight update --yes` to upgrade,",
          "`aifight service install` to restore the background service, or Dashboard `Connect Bridge` plus",
          "`aifight connect <PAIRING_CODE>` to authorize this machine for an existing claimed Agent.",
          "To remove the local identity first, run `aifight uninstall`.",
        ].join("\n"),
      );
    }
    const choice = await preflightChoice(existing, env, loc);
    if (choice === "quit") {
      env.stdout(`${t(loc, "wizard.preflight.quit.done")}\n`);
      return 0;
    }
    if (choice === "connect") {
      env.stdout(
        [
          "",
          t(loc, "wizard.connect.1"),
          t(loc, "wizard.connect.2"),
          t(loc, "wizard.connect.3"),
          t(loc, "wizard.connect.4"),
          t(loc, "wizard.connect.5"),
          "",
        ].join("\n"),
      );
      return 0;
    }
    if (choice === "use") {
      config = existing;
      env.stdout(`\n${t(loc, "wizard.use.continue", { name: existing.agentName })}\n\n`);
    } else {
      env.stdout(`\n${t(loc, "wizard.new.replace")}\n\n`);
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

  if (registeredNow) printRegistrationSummary(config, env, loc);

  // ── Stage 2: LLM (interactive only) ──
  let llmConfigured = false;
  if (interactive) {
    try {
      await runConfigInit(
        { positional: [slug], flags: {}, jsonMode: false },
        { ...env, stdout: () => {} },
      );
      env.stdout(`${t(loc, "wizard.llm.intro")}\n\n`);
      const result = await onboardDirectLLM({ slug, env, io: createOnboardIO(env) });
      llmConfigured = result === "configured";
    } catch {
      // A setup hiccup must not look like a registration failure.
      env.stdout(`\n${t(loc, "wizard.llm.failed")}\n`);
    }
  } else if (autoMode || approvedLocalSetup) {
    env.stdout(`${t(loc, "wizard.llm.skipped")}\n\n`);
  }

  // ── Stage 2.5: daily auto-match cap (interactive only) ──
  // The token-burn safety: the user consciously picks how many matches per day
  // the agent may start by itself (default 2; 0 = manual only; >10 confirms).
  if (interactive) {
    try {
      await onboardDailyCap(env);
    } catch {
      env.stdout(`\n${t(loc, "wizard.daily.failed")}\n`);
    }
  }

  // ── Stage 3: service (offer; auto-accept in --auto / approved) ──
  const service = await offerBridgeServiceInstall(env, {
    approvedLocalSetup: approvedLocalSetup || autoMode,
  });

  // ── Final checklist ──
  env.stdout(
    renderSetupChecklist(loc, {
      config,
      llmConfigured,
      serviceInstalled: service === "installed",
    }).join("\n") + "\n\n",
  );
  return 0;
}

// ─── Pre-flight choice ───────────────────────────────────────────────

/**
 * P1 (统一交互规范 §2, 批 U7): the four ways out of "this machine already has
 * an agent". It used to be a hand-printed `[U] / [C] / [N] / [Q]` list read by
 * a raw stdin line — the wizard's own version of the hand-typed action words
 * §3 banned everywhere else. Same four outcomes, same order (so Enter on the
 * chooser still means "use it"), now the shared frame.
 */
async function preflightChoice(
  existing: BridgeConfig,
  env: HandlerEnv,
  loc: Locale,
): Promise<"use" | "new" | "connect" | "quit"> {
  const io = createOnboardIO(env);
  const key = await pickOneKey(
    { env, locale: loc, ...(io.choose !== undefined ? { choose: io.choose } : {}), prompt: io.promptLine },
    buildPreflightFrame(existing, loc),
  );
  if (key === "1") return "use";
  if (key === "2") return "connect";
  if (key === "3") return "new";
  // q / Esc / an exhausted script: change nothing (the safe way out).
  return "quit";
}

/** The pre-flight frame. Exported for the rendering tests only. */
export function buildPreflightFrame(existing: BridgeConfig, loc: Locale): MenuFrame {
  return {
    title: t(loc, "wizard.preflight.title"),
    banner: [],
    subheader: [`  ${existing.agentName} (${existing.agentId})`, `  ${t(loc, "wizard.preflight.note")}`],
    choices: [
      { key: "1", main: t(loc, "wizard.preflight.use.main"), hint: t(loc, "wizard.preflight.use.hint") },
      { key: "2", main: t(loc, "wizard.preflight.connect.main"), hint: t(loc, "wizard.preflight.connect.hint") },
      { key: "3", main: t(loc, "wizard.preflight.new.main"), hint: t(loc, "wizard.preflight.new.hint") },
      { key: "q", main: t(loc, "wizard.preflight.quit.main"), hint: t(loc, "wizard.preflight.quit.hint") },
    ],
  };
}

// ─── Registration core ───────────────────────────────────────────────

async function performRegistration(
  args: HandlerArgs,
  env: HandlerEnv,
  baseUrlOverride?: string,
): Promise<BridgeConfig> {
  const config = await registerAgentConfig(args, env, baseUrlOverride);
  writeBridgeConfig(config);
  // A brand-new agent registered from here is by definition this machine's.
  // Re-stamping matters most on a copied home directory: "register a new
  // agent" is one of the offered ways out of that, and leaving the previous
  // machine's stamp in place would refuse the fresh agent too.
  stampLocalDeviceIdentity();
  return config;
}

/**
 * The NETWORK half of registration: register the agent with the platform and
 * build its BridgeConfig — writing NOTHING locally. `aifight setup` makes the
 * result the active identity (performRegistration above); the panel's Profile
 * "Create new agent" flow (V3 ④) stores it as a NEW identity and only makes
 * it active after the user confirms the switch, so a cancelled create never
 * clobbers bridge.json.
 */
export async function registerAgentConfig(
  args: HandlerArgs,
  env: HandlerEnv,
  baseUrlOverride?: string,
): Promise<BridgeConfig> {
  const suggestedName = resolveAgentName(args);
  // On --replace, keep the host the machine was already on (beta vs prod) rather
  // than the env/default, so re-register doesn't silently jump servers.
  // F-05: refuse a plaintext-http (non-loopback) base before the API key is
  // ever created and sent to it.
  let baseUrl: string;
  try {
    baseUrl = validatePlatformBaseUrl(baseUrlOverride ?? process.env.AIFIGHT_BASE_URL ?? DEFAULT_BASE_URL);
  } catch (e) {
    throw new CommandError("invalid_base_url", e instanceof Error ? e.message : String(e));
  }
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

    return {
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

function printRegistrationSummary(config: BridgeConfig, env: HandlerEnv, loc: Locale): void {
  // V4 styled kit (批 U7): the hand-padded label column became kvRows, which
  // sizes itself from the longest label — the zh labels are a different width
  // and used to glue onto their values.
  const out = createOutput();
  env.stdout(`${out.section(t(loc, "wizard.registered.title"))}\n\n`);
  env.stdout(
    out
      .kvRows([
        [t(loc, "wizard.registered.bootstrap"), config.agentName],
        [t(loc, "wizard.registered.name"), t(loc, "wizard.registered.name.value", { name: config.agentName })],
        [t(loc, "wizard.registered.status"), t(loc, "wizard.registered.status.value")],
        [
          t(loc, "wizard.registered.daily"),
          t(loc, "wizard.registered.daily.value", { limit: DEFAULT_AUTO_DAILY_LIMIT }),
        ],
      ])
      .join("\n") + "\n",
  );
  env.stdout(`${out.note(t(loc, "wizard.registered.saved"))}\n\n`);
}

/**
 * The wizard's closing checklist, as lines. Exported so the zh/en rendering
 * (and the alignment maths behind it) is unit-testable without driving a whole
 * interactive `aifight setup`; runSetup is the only production caller.
 */
export function renderSetupChecklist(
  loc: Locale,
  s: { config: BridgeConfig; llmConfigured: boolean; serviceInstalled: boolean },
): string[] {
  // ✓ / ☐ stay literal here (not statusIcons): this is a two-state checklist,
  // and the ☐ has no icon-kit counterpart — a mixed "OK" / "☐" would be worse
  // than the pair. Done rows are green, pending rows plain (P6's colours).
  const out = createOutput();
  // Done rows carry the ✓ and go green; pending rows keep ☐ and stay plain
  // (P6's colour grammar: green = it is actually done).
  const item = (done: boolean, label: string, value: string): KvRow =>
    done ? [`✓ ${label}`, value, "green"] : [`☐ ${label}`, value];
  // One kvRows call for all five items so the label column is sized once —
  // then the two continuation lines are spliced back in under their row.
  const items: readonly KvRow[] = [
    item(true, t(loc, "wizard.summary.agent"), t(loc, "wizard.summary.agent.value", { name: s.config.agentName })),
    item(
      s.llmConfigured,
      t(loc, "wizard.summary.llm"),
      t(loc, s.llmConfigured ? "wizard.summary.llm.ok" : "wizard.summary.llm.todo"),
    ),
    item(
      s.serviceInstalled,
      t(loc, "wizard.summary.service"),
      t(loc, s.serviceInstalled ? "wizard.summary.service.ok" : "wizard.summary.service.todo"),
    ),
    item(false, t(loc, "wizard.summary.claim"), t(loc, "wizard.summary.claim.todo")),
    item(false, t(loc, "wizard.summary.strategy"), t(loc, "wizard.summary.strategy.todo")),
  ];
  const rows = out.kvRows(items);
  // The claim URL and the strategy tail are CONTINUATIONS of the row above,
  // so they start where that row's value does — kvRows' own column rule
  // (longest label + 2), measured in visible columns so zh lines up too.
  const cont = (text: string): string =>
    `  ${" ".repeat(Math.max(...items.map(([label]) => visibleWidth(label))) + 2)}${out.ansi.dim(text)}`;
  const lines = [out.section(t(loc, "wizard.summary.title")), ...rows.slice(0, 4)];
  if (s.config.claimUrl) lines.push(cont(s.config.claimUrl));
  lines.push(rows[4]!, cont(t(loc, "wizard.summary.strategy.tail")));

  // The commands stay cyan (help.ts's convention: what you type is cyan), so
  // this block is padded by hand rather than run through kv's dim label.
  const cmds: ReadonlyArray<readonly [string, string]> = [
    ["aifight status", t(loc, "wizard.commands.status")],
    ["aifight config", t(loc, "wizard.commands.config")],
    ["aifight strategy path", t(loc, "wizard.commands.strategy")],
    ["aifight setup", t(loc, "wizard.commands.setup")],
  ];
  const width = Math.max(...cmds.map(([cmd]) => visibleWidth(cmd))) + 2;
  lines.push("", out.section(t(loc, "wizard.commands.title")));
  for (const [cmd, desc] of cmds) lines.push(`  ${out.ansi.cyan(padEndVisible(cmd, width))}${desc}`);
  return lines;
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

// (The wizard's own readLine died with the hand-typed pre-flight prompt in
// U7 — every line read now comes from onboard-io's shared primitives.)
