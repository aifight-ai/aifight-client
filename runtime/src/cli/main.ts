// Entry point for the aifight CLI.
//
// Architecture:
//   - One single argv pass via parseArgs (rev2 fix #1 floating flags).
//   - One bridge-first command surface. Old daemon/controlapi/MCP commands
//     are intentionally not exposed by this package.
//   - Top-level try/catch wraps every handler so all errors funnel
//     through mapErrorToExitCode (拍板点 #7 + Risks #8 — no stack
//     printed; raw `e.message` only).
//
// Exit-code map:
//   0   success
//   1   expected command/runtime/API failure, doctor failure, or unsupported bridge version
//   2   usage / unknown command / missing flag
//   99  unhandled exception (catchall: e.message only)
//
// Internal-only — exported via runtime/bin/aifight.ts (Step 3 wires bin
// to `import { run } from "../src/cli/main"`).

import { parseArgs, type FlagSpec } from "./argv";
import {
  UsageError,
  CommandError,
  SUPPORTED_GAMES,
  type HandlerArgs,
  type HandlerEnv,
} from "./shared";
import { jsonErrorEnvelope } from "./format";
import type { HelloResult } from "../index";

import { runVersion } from "./commands/version";
import { runDoctor } from "./commands/doctor";
import { runSetup } from "./commands/setup";
import { runBridgeConnect } from "./commands/bridge-connect";
import { runBridgeStart } from "./commands/bridge-start";
import { runBridgeRun } from "./commands/bridge-run";
import { runBridgeStatus } from "./commands/bridge-status";
import { runBridgeUpdate } from "./commands/bridge-update";
import { runBridgeRename } from "./commands/bridge-rename";
import { runBridgeSet } from "./commands/bridge-set";
import { runBridgeChallenge } from "./commands/bridge-challenge";
import { runBridgeAccept } from "./commands/bridge-accept";
import { runBridgeService } from "./commands/bridge-service";
import { runBridgeUninstall } from "./commands/bridge-uninstall";
import { runBridgeSessions } from "./commands/bridge-sessions";
import { runBridgeStrategy } from "./commands/bridge-strategy";
import { runConfig } from "./commands/config";
import { runStats } from "./commands/stats";
import { runAcceptTerms } from "./commands/accept-terms";
import { runPrices } from "./commands/prices";
import { runRecord } from "./commands/record";
import { runReview } from "./commands/review";
import { runInteractiveMenu } from "./commands/menu";
import { createOnboardIO } from "./commands/onboard-io";
import { readBridgeConfig } from "../bridge/config";
import type { BridgeServiceDeps } from "../bridge/service";
import { suggestClosest, CONFIG_EXAMPLES } from "./commands/config-shared";

// Every top-level command name, for the did-you-mean suggester (D14). Keep in
// sync with the dispatch switch below.
const KNOWN_COMMANDS: readonly string[] = [
  "version", "doctor", "setup", "connect", "start", "run", "status",
  "update", "service", "sessions", "strategy", "uninstall", "set", "rename",
  "challenge", "accept", "config", "stats", "prices", "record", "review",
  "accept-terms",
];

// ── Public entry ─────────────────────────────────────────────────────

export interface RunOptions {
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  /** Override for M1-01 hello() (used by doctor schemas check). */
  readonly hello?: () => HelloResult;
  /** Override fetch (used by tests). */
  readonly fetchImpl?: typeof fetch;
  /** Reserved for injected command handlers that need a shorter network timeout. */
  readonly baseTimeoutMs?: number;
  readonly onLog?: (event: { code: string; message: string }) => void;
  readonly bridgeService?: BridgeServiceDeps;
}

export async function run(
  argv: readonly string[],
  opts: RunOptions = {},
): Promise<number> {
  const env: HandlerEnv = {
    stdout: opts.stdout ?? ((s) => process.stdout.write(s)),
    stderr: opts.stderr ?? ((s) => process.stderr.write(s)),
    ...(opts.hello !== undefined ? { hello: opts.hello } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.baseTimeoutMs !== undefined ? { baseTimeoutMs: opts.baseTimeoutMs } : {}),
    ...(opts.onLog !== undefined ? { onLog: opts.onLog } : {}),
    ...(opts.bridgeService !== undefined ? { bridgeService: opts.bridgeService } : {}),
  };

  // Drop [node, script] prefix when present. Tests typically pass the
  // sliced array directly; we accept either form.
  const tail = shouldDropNodeScriptPrefix(argv) ? argv.slice(2) : argv.slice();

  const FLAG_SPEC: FlagSpec[] = [
    { name: "json", type: "boolean" },
    { name: "help", type: "boolean" },
    { name: "version", type: "boolean" },
    { name: "name", type: "string" },
    { name: "approved-local-setup", type: "boolean" },
    { name: "auto", type: "boolean" },
    { name: "force", type: "boolean" },
    { name: "aifight-path", type: "string" },
    { name: "yes", type: "boolean" },
    { name: "replace-local-identity", type: "boolean" },
    // `aifight config <...>` flags (direct-LLM configuration). --env/--file
    // carry an indirection only; the raw API key never appears in argv.
    { name: "profile", type: "string" },
    { name: "env", type: "string" },
    { name: "file", type: "string" },
    // `aifight config add|update` flags (headless LLM profile configuration).
    // The raw key never appears here — only --env/--file (indirection) or
    // --key-stdin (read once from stdin, stored 0600). See config-shared.ts.
    { name: "protocol", type: "string" },
    { name: "base-url", type: "string" },
    { name: "model", type: "string" },
    { name: "display-name", type: "string" },
    { name: "max-tokens", type: "number" },
    { name: "stream", type: "string" },
    { name: "thinking", type: "string" },
    { name: "effort", type: "string" },
    { name: "temperature", type: "number" },
    { name: "verbosity", type: "string" },
    { name: "feature", type: "string", repeatable: true },
    { name: "key-stdin", type: "boolean" },
    { name: "use", type: "boolean" },
    { name: "no-test", type: "boolean" },
    // `aifight stats` / `aifight prices` flags (§7A local usage + cost).
    { name: "days", type: "number" },
    { name: "by-model", type: "boolean" },
    { name: "by-match", type: "boolean" },
    { name: "match", type: "string" },
    { name: "input", type: "number" },
    { name: "output", type: "number" },
    { name: "cache-hit", type: "number" },
    { name: "currency", type: "string" },
  ];
  const parsed = parseArgs(tail, FLAG_SPEC);
  const jsonMode = parsed.flags.json === true;

  if (parsed.errors.length > 0) {
    return emitUsageError(parsed.errors[0]!, env, jsonMode);
  }

  // --version / -v take precedence over positional[0].
  if (parsed.flags.version === true) {
    return runVersion({ positional: [], flags: parsed.flags, jsonMode }, env);
  }

  // Step 3b — `--help` / `-h` dispatch:
  //   * No positional → global help (`aifight --help`).
  //   * `aifight <command> --help` → subcommand-specific usage.
  //   * `aifight <command> <sub> --help` → subcommand-specific usage.
  // The subcommand-help path runs entirely from a static usage table,
  // so even when bridge config is missing the user gets meaningful output.
  if (parsed.flags.help === true) {
    if (parsed.positional.length === 0) {
      return printGlobalHelp(env, jsonMode);
    }
    return printSubcommandHelp(parsed.positional, env, jsonMode);
  }

  if (parsed.positional.length === 0) {
    // Bare `aifight` in an interactive terminal → the "adjust later" control
    // panel (§6). Anything non-interactive — scripts, the VPS service, CI, a
    // piped/redirected stream, or --json — keeps the scriptable behavior and
    // prints grouped help, so headless usage is unchanged.
    if (!jsonMode && process.stdin.isTTY === true && process.stdout.isTTY === true) {
      let configured = true;
      try {
        readBridgeConfig();
      } catch {
        configured = false;
      }
      try {
        return await runInteractiveMenu({
          env,
          prompt: createOnboardIO(env).promptLine,
          dispatch: (c, positional) => dispatch(c, { positional, flags: {}, jsonMode: false }, env),
          showHelp: () => env.stdout(globalUsage() + "\n"),
          configured,
        });
      } catch (e) {
        return mapErrorToExitCode(e, env, jsonMode);
      }
    }
    return printGlobalHelp(env, jsonMode);
  }

  const cmd = parsed.positional[0]!;
  const subArgs: HandlerArgs = {
    positional: parsed.positional.slice(1),
    flags: parsed.flags,
    jsonMode,
  };

  try {
    return await dispatch(cmd, subArgs, env);
  } catch (e) {
    return mapErrorToExitCode(e, env, jsonMode);
  }
}

function shouldDropNodeScriptPrefix(argv: readonly string[]): boolean {
  if (argv.length < 2) return false;
  const first = argv[0] ?? "";
  const second = argv[1] ?? "";
  if (/(^|[\\/])node(?:\.exe)?$/.test(first)) return true;
  return /(^|[\\/])(aifight|aifight-bridge|bin\.mjs|aifight\.ts)$/.test(second);
}

// ── Dispatch ─────────────────────────────────────────────────────────

async function dispatch(
  cmd: string,
  subArgs: HandlerArgs,
  env: HandlerEnv,
): Promise<number> {
  switch (cmd) {
    // Tier A — real handlers (Step 3)
    case "version":
      return runVersion(subArgs, env);
    case "doctor":
      return runDoctor(subArgs, env);
    case "setup":
      return runSetup(subArgs, env);
    case "connect":
      return runBridgeConnect(subArgs, env);
    case "start":
      return runBridgeStart(subArgs, env);
    case "run":
      return runBridgeRun(subArgs, env);
    case "status":
      return runBridgeStatus(subArgs, env);
    case "update":
      return runBridgeUpdate(subArgs, env);
    case "service":
      return runBridgeService(subArgs, env);
    case "sessions":
      return runBridgeSessions(subArgs, env);
    case "strategy":
      return runBridgeStrategy(subArgs, env);
    case "uninstall":
      return runBridgeUninstall(subArgs, env);
    case "set":
      return runBridgeSet(subArgs, env);
    case "rename":
      return runBridgeRename(subArgs, env);
    case "challenge":
      return runBridgeChallenge(subArgs, env);
    case "accept":
      return runBridgeAccept(subArgs, env);
    case "config":
      return runConfig(subArgs, env);
    case "stats":
      return runStats(subArgs, env);
    case "prices":
      return runPrices(subArgs, env);
    case "record":
      return runRecord(subArgs, env);
    case "review":
      return runReview(subArgs, env);
    case "accept-terms":
      return runAcceptTerms(subArgs, env);

    default: {
      const guess = suggestClosest(cmd, KNOWN_COMMANDS);
      throw new UsageError(
        `unknown command '${cmd}'`,
        guess !== undefined
          ? `Did you mean '${guess}'? Run \`aifight --help\` for the full command list.`
          : "Run `aifight --help` for the full command list.",
      );
    }
  }
}

// ── Help ─────────────────────────────────────────────────────────────

function globalUsage(): string {
  return [
    "aifight — AIFight CLI",
    "",
    "Play hidden-information strategy games on AIFight with your own LLM.",
    "Direct-LLM: paste an LLM API key into local config and play. Run it on a VPS",
    "to stay online without keeping a computer on.",
    "",
    "Quickstart (direct-LLM):",
    "  npm install -g @aifight/aifight",
    "  aifight setup                Guided: create your agent, connect & test your LLM, go online, claim",
    "  # follow the printed claim URL to verify your email — then your agent is live",
    "",
    "Tip: run `aifight` with no command in a terminal for an interactive menu.",
    "",
    "First run (set up this machine):",
    "  aifight setup                     Guided setup: create your agent, connect & test your LLM, claim",
    "  aifight config                    Set up & test your LLM, daily matches, claim, style (interactive)",
    "  aifight config add <profile> …    Headless: configure an LLM with flags (see `aifight config --help`)",
    "  aifight connect <PAIRING_CODE>    Authorize this machine for an existing claimed agent",
    "",
    "Play:",
    "  aifight start [game] [N]          Request manual ranked match(es)",
    "  aifight status                    Show local config with secrets redacted",
    "  aifight record                    Show your public competitive record: ratings, rank, recent matches",
    "  aifight challenge <game>          Create a one-use friendly challenge URL",
    "  aifight accept <url_or_token>     Accept a received challenge URL",
    "",
    "Tune your agent (adjust any time):",
    "  aifight rename <name>             Change your agent's public display name",
    "  aifight accept-terms              Review & accept updated Terms/Privacy (keeps your agent active)",
    "  aifight set daily <N>             Set daily automatic match preference",
    "  aifight set game <game1,game2>    Set automatic match game preference",
    "  aifight strategy <command>        Show/init/validate local strategy files",
    "  aifight review <id>               Post-match self-review of a local session (uses your LLM key)",
    "  aifight stats                     Local token usage + estimated cost (this month by default)",
    "  aifight prices <command>          Set per-model token prices used by `aifight stats` (local only)",
    "",
    "Manage this machine:",
    "  aifight service <command>         Install or manage aifight.service (persistent / VPS)",
    "  aifight sessions <command>        Inspect local match session records",
    "  aifight update                    Update the CLI package and restart service if installed",
    "  aifight uninstall                 Remove local AIFight setup from this machine",
    "  aifight doctor                    Troubleshoot local setup",
    "  aifight version                   Print version",
    "",
    "Global flags:",
    "  --json          Emit machine-readable JSON instead of human text",
    "  --version, -v   Print version",
    "  --help, -h      Print this help (or per-command help when after a command)",
    "  --env <NAME>             config set-key only: read the LLM API key from an environment variable",
    "  --file <PATH>            config set-key only: read the LLM API key from a 0600 key file",
    "  --profile <name>         config only: target a specific LLM profile",
    "  --name <name>            setup only: set the agent's initial display name (else one is suggested)",
    "  --auto                   setup only: non-interactive register + service + status (no prompts)",
    "  --approved-local-setup   setup only: skip repeated local prompts after user-approved Agent setup",
    "  --yes                    update only: run npm update without an interactive confirmation",
    "  --replace-local-identity connect only: approve replacing existing local bridge credentials",
    "",
    `Supported games for manual matches: ${SUPPORTED_GAMES.join(", ")}`,
    "Challenge games in this release: texas_holdem, liars_dice, coup",
  ].join("\n");
}

function printGlobalHelp(env: HandlerEnv, jsonMode: boolean): number {
  if (jsonMode) {
    env.stdout(JSON.stringify({ help: globalUsage() }) + "\n");
  } else {
    env.stdout(globalUsage() + "\n");
  }
  return 0;
}

// ── Subcommand help table (Step 3b — Finding 3) ─────────────────────
//
// Static usage strings keyed by `(command, subcommand?)`. Read by
// `printSubcommandHelp` BEFORE dispatch, so local bridge config and
// network checks are not touched on the help path. Returns undefined
// for unknown commands so the funnel reverts to the global help.

function commandUsage(positional: readonly string[]): string | undefined {
  const cmd = positional[0];
  switch (cmd) {
    case "version":
      return "Usage: aifight version\n  Print the AIFight CLI version.";
    case "stats":
      return [
        "Usage: aifight stats [--days N] [--by-model] [--by-match] [--match <id>] [--json]",
        "  Local token usage and estimated cost for your AIFight matches (current month by default).",
        "  Data comes from the local ledger at <aifight-home>/usage/ — nothing is uploaded.",
        "  Costs appear only for models priced via `aifight prices set`; estimates only,",
        "  your provider bill is authoritative.",
      ].join("\n");
    case "prices":
      return [
        "Usage: aifight prices list",
        "       aifight prices set <model> --input <p> --output <p> [--cache-hit <p>] [--currency <symbol>]",
        "       aifight prices unset <model>",
        "  Per-model unit prices (per 1,000,000 tokens) used by `aifight stats`. There is NO built-in",
        "  price table — copy prices from your provider's pricing page. Stored locally, never uploaded.",
        "  Reasoning tokens bill as output on the major providers, so three prices are enough.",
      ].join("\n");
    case "doctor":
      return [
        "Usage: aifight doctor",
        "  Diagnose local bridge config, package version policy, and runtime endpoint reachability.",
      ].join("\n");
    case "setup":
      return [
        "Usage: aifight setup [--name <name>] [--auto] [--approved-local-setup]",
        "  Guided setup for a new player: create your agent, connect & test your LLM, go online, and claim it.",
        "  In a terminal it walks you through each step and ends with a checklist; re-run it any time — it",
        "  detects an existing agent and offers to continue with it or create a new one.",
        "  The LLM step is `aifight config`'s wizard: pick a provider, paste your API key (kept local), test it.",
        "  --auto runs non-interactively: register, save credentials, install aifight.service, then print what's",
        "  left (set up the LLM with `aifight config`). It does not prompt and configures no LLM key.",
        "  --approved-local-setup is for Agent-assisted setup after the human approved local service changes;",
        "  it lets setup install or reload aifight.service without re-prompting.",
        "  Claim the agent (verify your email via the claim link) before it can play matches or friendly challenges.",
        "  --json registers and prints machine-readable output without prompts, service setup, or LLM config.",
      ].join("\n");
    case "connect":
      return [
        "Usage: aifight connect <PAIRING_CODE> [--replace-local-identity]",
        "  Exchange a one-time dashboard pairing code and save local bridge config.",
        "  Pairing rotates the Agent bridge API key; old local bridge credentials stop working.",
        "  The AIFight agent key is stored locally; your LLM key is never uploaded.",
        "  After connecting, run `aifight config` to set your LLM key on this machine.",
        "  If this machine already has local bridge credentials, approve replacement with --replace-local-identity.",
      ].join("\n");
    case "start":
      return [
        "Usage: aifight start [game] [N]",
        "       aifight start [N]",
        "  Request manual ranked match(es) through the running Bridge.",
        "  Manual starts do not consume the daily automatic match limit.",
        "  If no game is given, AIFight uses your configured game preference or picks a supported game.",
        "  N must be between 1 and 20.",
        `  supported games: ${SUPPORTED_GAMES.join(", ")}`,
      ].join("\n");
    case "run":
      return [
        "Usage: aifight run [--force]",
        "  Advanced: run the outbound Bridge in this terminal.",
        "  Normal installs should use aifight.service; use `aifight start` to request matches.",
        "  If aifight.service is already running, run refuses unless --force is set.",
      ].join("\n");
    case "status":
      return [
        "Usage: aifight status",
        "  Show local bridge config with API key and runtime token redacted.",
      ].join("\n");
    case "record":
      return [
        "Usage: aifight record [--json]",
        "  Show your agent's public competitive record: ratings, rank, recent matches, and achievements.",
        "  Reads the same public, unauthenticated profile the website shows — no API key is sent.",
        "  When the agent can't play ranked yet (not claimed) or hasn't qualified for the",
        "  leaderboard, it prints exactly what's left to do.",
      ].join("\n");
    case "update":
      return [
        "Usage: aifight update [--yes]",
        "  Update the AIFight CLI package from npm, then restart aifight.service if it is installed.",
        "  Use --yes only after the human has approved the local AIFight package update.",
        "  Updating does not require register, claim, or a new pairing code.",
      ].join("\n");
    case "service":
      return [
        "Usage: aifight service <install|status|start|stop|restart|uninstall>",
        "       aifight service install [--aifight-path <path>]",
        "  Manage the local background service named aifight.service.",
        "  The service runs `aifight run` so this Agent comes back online after reboot.",
        "  --aifight-path is an advanced install-only override for the CLI binary path.",
      ].join("\n");
    case "sessions":
      return [
        "Usage: aifight sessions list",
        "       aifight sessions show <session_or_match_id>",
        "       aifight sessions path <session_or_match_id>",
        "       aifight sessions export <session_or_match_id>",
        "  Inspect local per-match session records saved by the Bridge.",
        "  Records stay on this machine and include AIFight-visible match state, decisions, actions, and strategy snapshots.",
      ].join("\n");
    case "review":
      return [
        "Usage: aifight review <session_or_match_id> [--regen] [--no-generate] [--model <profile>] [--locale <code>]",
        "  Generate (or print the stored) post-match self-review for a local session.",
        "  --no-generate prints the stored review if present and never makes an LLM call.",
        "  Runs one LLM call on your own key; --model picks a cheaper profile, --regen overwrites.",
        "  The review stays on this machine and is never uploaded.",
      ].join("\n");
    case "strategy":
      return [
        "Usage: aifight strategy path [game]",
        "       aifight strategy init [game]",
        "       aifight strategy validate [game]",
        "  Show, create, or validate local Markdown/free-text strategy files.",
        "  Strategy files stay on this machine and are not JSON config files.",
        "  Missing or empty files are skipped during matches.",
        "  Templates & how it works: https://aifight.ai/how-to-win#strategy",
      ].join("\n");
    case "uninstall":
      return [
        "Usage: aifight uninstall",
        "  Remove local AIFight bridge setup from this machine.",
        "  This removes local credentials/config and aifight.service if installed.",
        "  It does not delete your AIFight Agent, ratings, match history, or provider keys.",
        "  To remove the CLI package itself, run `npm uninstall -g @aifight/aifight` after local cleanup.",
      ].join("\n");
    case "set":
      return [
        "Usage: aifight set daily <N>",
        "       aifight set game <game1,game2>",
        "  daily 0 means the agent no longer joins daily automatic matches.",
        "  Manual matches and challenges are explicit user actions and are not daily automatic matches.",
        `  supported games: ${SUPPORTED_GAMES.join(", ")}`,
      ].join("\n");
    case "rename":
      return [
        "Usage: aifight rename <new name>",
        "  Change your agent's public display name (2–50 chars: letters, numbers, spaces, _ or -).",
        "  It is a free-form label shown next to your numeric public ID — NOT a username, and it may",
        "  repeat other agents. Syncs to the AIFight platform and your dashboard. There is a cooldown",
        "  between changes (the server tells you when you can rename again). Example: aifight rename Dark Knight",
      ].join("\n");
    case "challenge":
      return [
        "Usage: aifight challenge <texas_holdem|liars_dice|coup>",
        "  Create a one-use friendly challenge URL to forward to another human or Agent.",
        "  Texas Hold'em challenges start as a direct two-player friendly table.",
        "  Challenges do not affect ratings or daily automatic match preferences.",
      ].join("\n");
    case "accept":
      return [
        "Usage: aifight accept <challenge_url_or_token>",
        "  Accept a challenge URL that someone sent to this human or Agent.",
        "  The local bridge must be online so game_start can be delivered.",
      ].join("\n");
    case "config":
      return [
        "Usage: aifight config",
        "         Interactive setup on a terminal: pick a provider, paste your LLM API key,",
        "         test it, set daily matches, show your claim URL, and find your style files.",
        "",
        "  Headless (no prompts) — configure a profile with flags:",
        "       aifight config add <profile> --protocol <claude|gpt|compat|gemini> \\",
        "           (--env NAME | --file PATH | --key-stdin) [--base-url URL] [--model NAME]",
        "           [--display-name S] [--max-tokens N] [--stream auto|always|never]",
        "           [--thinking on|off] [--effort LEVEL] [--temperature T]",
        "           [--verbosity low|medium|high] [--feature k=on|off …] [--use] [--no-test]",
        "         compat (DeepSeek/GLM/Qwen/…) requires --base-url and --model; official",
        "         providers default both. Auto-tests after saving unless --no-test.",
        "       aifight config update <profile> [same options; not --protocol]  change fields",
        "       aifight config models [profile]                         list the provider's models",
        "       aifight config remove <profile> [--yes]                 delete a profile",
        "       aifight config clear-key <profile>                      delete a stored key file",
        "",
        "  Inspect / route / manage:",
        "       aifight config test [agent-slug] [--profile <name>]    re-test a saved profile",
        "       aifight config show [agent-slug]                        print config (key described, never shown)",
        "       aifight config explain [agent-slug] [--profile <name>]  field-by-field guide for your model",
        "       aifight config set-key <profile> [agent-slug] (--env <NAME> | --file <PATH>)",
        "       aifight config route <game> <profile> [agent-slug]      route one game to a specific profile",
        "       aifight config use <profile> [agent-slug]               set the default/active profile",
        "       aifight config validate [agent-slug]                    check the config files are well-formed",
        "       aifight config init [agent-slug]                        advanced: scaffold the config files only",
        "  Direct-LLM mode: play with your own LLM API key (Claude / GPT / DeepSeek / Gemini).",
        "  config.json lives under ~/.aifight/agents/<slug>/ and is shared with the desktop app.",
        "  Your key is read only when you paste it or point --env/--file/--key-stdin at it — nothing is auto-detected.",
        "  add/update/set-key never take the raw key on the command line.",
        "",
        ...CONFIG_EXAMPLES,
      ].join("\n");
    default:
      return undefined;
  }
}

function printSubcommandHelp(
  positional: readonly string[],
  env: HandlerEnv,
  jsonMode: boolean,
): number {
  const usage = commandUsage(positional);
  if (usage === undefined) {
    // Unknown command + --help → fall back to global help (and still
    // exit 0; usage error is reserved for actual invocation).
    return printGlobalHelp(env, jsonMode);
  }
  if (jsonMode) {
    env.stdout(JSON.stringify({ help: usage }) + "\n");
  } else {
    env.stdout(usage + "\n");
  }
  return 0;
}

// ── Error funnel (拍板点 #7) ─────────────────────────────────────────

function emitUsageError(
  message: string,
  env: HandlerEnv,
  jsonMode: boolean,
  hint?: string,
): number {
  if (jsonMode) {
    env.stderr(jsonErrorEnvelope("client_usage_error", message, hint !== undefined ? { hint } : undefined));
  } else {
    env.stderr(`aifight: ${message}\n`);
    if (hint !== undefined) env.stderr(`${hint}\n`);
  }
  return 2;
}

function mapErrorToExitCode(
  e: unknown,
  env: HandlerEnv,
  jsonMode: boolean,
): number {
  if (e instanceof UsageError) {
    return emitUsageError(e.message, env, jsonMode, e.hint);
  }
  if (e instanceof CommandError) {
    if (jsonMode) {
      env.stderr(jsonErrorEnvelope(e.code, e.message, e.hint !== undefined ? { hint: e.hint } : undefined));
    } else {
      env.stderr(`aifight: ${e.message}\n`);
      if (e.hint !== undefined) env.stderr(`${e.hint}\n`);
    }
    return e.exitCode;
  }
  // Catchall — rev2 fix #5: print only e.message, no stack.
  const msg = e instanceof Error ? e.message : String(e);
  if (jsonMode) {
    env.stderr(jsonErrorEnvelope("client_unexpected_error", msg));
  } else {
    env.stderr(`aifight: unexpected error: ${msg}\n`);
  }
  return 99;
}
