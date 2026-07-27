// `aifight telegram …` — the Telegram companion's local control surface.
//
// The companion is a private bot the user creates themselves: the token stays
// in this machine's encrypted bridge config, and messages travel between this
// machine and Telegram directly. AIFight's servers are not involved and know
// nothing about it.
//
// Everything here edits bridge.json. The bridge does not watch that file, so a
// change made while it is running takes effect on the next restart — `status`
// says so out loud rather than letting the user wonder.

import fs from "node:fs";

import {
  getBridgeConfigPath,
  readBridgeConfig,
  writeBridgeConfig,
  type BridgeConfig,
  type BridgeTelegramConfig,
} from "../../bridge/config";
import { resolveNotifyLocale } from "../../notify/locale";
import { TelegramApiError, createTelegramApi, escapeHtml, type TelegramApi } from "../../notify/telegram/api";
import {
  PAIRING_CODE_TTL_MS,
  generatePairingCode,
  waitForPairingCode,
} from "../../notify/telegram/pairing";
import { botCommands, t } from "../../notify/telegram/render";
import {
  TELEGRAM_DEFAULT_DIGEST_AT,
  TELEGRAM_SETTING_KEYS,
  TELEGRAM_SETTING_VALUES,
  applyTelegramSetting,
  defaultTelegramConfig,
  isTelegramSettingKey,
  parseMuteSpec,
} from "../../notify/telegram/settings";
import { portFilePath } from "../runtime-files";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { CommandError, UsageError, expectArity } from "../shared";
import { createOnboardIO } from "./onboard-io";

const USAGE = [
  "usage: aifight telegram setup [--token-env <NAME>]",
  "       aifight telegram status",
  "       aifight telegram test",
  "       aifight telegram set <key> <value>",
  "       aifight telegram mute <1h|today|off>",
  "       aifight telegram unlink",
  "       aifight telegram uninstall [--yes]",
  "",
  "  Phone notifications and remote control through a Telegram bot you own.",
  "  set keys:",
  ...TELEGRAM_SETTING_KEYS.map((k) => `    ${k.padEnd(18)}${TELEGRAM_SETTING_VALUES[k]}`),
].join("\n");

export async function runTelegram(args: HandlerArgs, env: HandlerEnv): Promise<number> {
  const sub = args.positional[0] ?? "";
  const rest: HandlerArgs = { ...args, positional: args.positional.slice(1) };

  switch (sub) {
    // Bare `aifight telegram` is the interactive menu's entry point: set it up
    // if it isn't, otherwise show where things stand.
    case "":
      return isLinked() ? telegramStatus(rest, env) : telegramSetup(rest, env);
    case "status":
      return telegramStatus(rest, env);
    case "setup":
      return telegramSetup(rest, env);
    case "test":
      return telegramTest(rest, env);
    case "set":
      return telegramSet(rest, env);
    case "mute":
      return telegramMute(rest, env);
    case "unlink":
      return telegramUnlink(rest, env);
    case "uninstall":
      return telegramUninstall(rest, env);
    default:
      throw new UsageError(`unknown telegram subcommand '${sub}'`, USAGE);
  }
}

// ── status ───────────────────────────────────────────────────────────

function telegramStatus(args: HandlerArgs, env: HandlerEnv): number {
  expectArity(args, 0, 0, USAGE);
  const config = readOptionalBridgeConfig();

  if (config === undefined) {
    if (args.jsonMode) {
      env.stdout(JSON.stringify({ status: "no_bridge" }) + "\n");
      return 0;
    }
    env.stdout("AIFight Telegram companion\n\n");
    env.stdout("This machine has no AIFight agent yet.\n");
    env.stdout("Next: run `aifight setup` (new agent) or `aifight connect <PAIRING_CODE>` (existing agent).\n");
    return 0;
  }

  const section = config.telegram;
  const tokenTail = config.telegramBotToken !== undefined ? tokenTailOf(config.telegramBotToken) : undefined;
  const restartPending = bridgeRestartPending();

  if (args.jsonMode) {
    env.stdout(JSON.stringify({
      status: section !== undefined ? "linked" : tokenTail !== undefined ? "token_only" : "not_configured",
      ...(tokenTail !== undefined ? { botTokenTail: tokenTail } : {}),
      ...(section !== undefined
        ? {
            chatId: section.chatId,
            settings: {
              results: section.results,
              digestAt: section.digestAt ?? TELEGRAM_DEFAULT_DIGEST_AT,
              alerts: section.alerts,
              challengeEvents: section.challengeEvents,
              control: section.control,
              locale: section.locale ?? "auto",
              effectiveLocale: resolveNotifyLocale(section.locale),
              mutedUntil: section.mutedUntil ?? null,
            },
          }
        : {}),
      restartPending,
    }) + "\n");
    return 0;
  }

  env.stdout("AIFight Telegram companion\n\n");
  if (section === undefined) {
    env.stdout(
      tokenTail !== undefined
        ? `Status: bot token saved (…${tokenTail}), no chat linked\n`
        : "Status: not set up\n",
    );
    env.stdout("Set it up with: aifight telegram setup\n");
    return 0;
  }

  env.stdout(`Status: linked to chat ${section.chatId}\n`);
  if (tokenTail !== undefined) env.stdout(`Bot token: …${tokenTail}\n`);
  for (const line of describeTelegramSettings(section)) env.stdout(`${line}\n`);
  if (restartPending) {
    env.stdout("\nSettings changed since the bridge started — run `aifight service restart` to apply them.\n");
  }
  return 0;
}

/** The settings block as display lines, in the order the design's §4.2 table
 *  lists them. Shared by `status` and the confirmation after `set`. */
function describeTelegramSettings(section: BridgeTelegramConfig): string[] {
  const locale = section.locale ?? "auto";
  const lines = [
    `Match results: ${section.results}`,
    `Daily digest: ${section.digestAt ?? TELEGRAM_DEFAULT_DIGEST_AT} (local time)`,
    `Alerts: ${onOff(section.alerts)}`,
    `Challenge events: ${onOff(section.challengeEvents)}`,
    `Remote control: ${onOff(section.control)}`,
    `Language: ${locale === "auto" ? `auto (${resolveNotifyLocale(undefined)})` : locale}`,
  ];
  if (section.mutedUntil !== undefined && section.mutedUntil > Date.now()) {
    lines.push(`Notifications: muted until ${new Date(section.mutedUntil).toLocaleString()} (alerts still go through)`);
  } else {
    lines.push("Notifications: on");
  }
  return lines;
}

function onOff(value: boolean): string {
  return value ? "on" : "off";
}

// ── setup ────────────────────────────────────────────────────────────

const BOTFATHER_STEPS = [
  "First create your own bot — one minute, once:",
  "  1. In Telegram, open a chat with @BotFather",
  "  2. Send /newbot and answer its two questions (a display name, then a",
  "     username ending in `bot`)",
  "  3. It replies with a token shaped like 8123456789:AA… — that is what this asks for",
  "",
  "The token is stored encrypted on this machine and used only from here.",
  "AIFight's servers never see it, and messages go straight to Telegram.",
];

async function telegramSetup(args: HandlerArgs, env: HandlerEnv): Promise<number> {
  expectArity(args, 0, 0, USAGE);
  if (args.jsonMode) {
    throw new UsageError("aifight telegram setup is interactive; --json is not supported", USAGE);
  }

  const config = readOptionalBridgeConfig();
  if (config === undefined) {
    throw new CommandError(
      "bridge_not_configured",
      "this machine has no AIFight agent yet",
      { hint: "Run `aifight setup` (new agent) or `aifight connect <PAIRING_CODE>` (existing agent) first." },
    );
  }

  const interactive = process.stdin.isTTY === true;
  const io = createOnboardIO(env);

  if (config.telegram !== undefined && args.flags["yes"] !== true) {
    env.stdout(`This machine already sends notifications to Telegram chat ${config.telegram.chatId}.\n`);
    if (!interactive) {
      throw new CommandError(
        "telegram_already_linked",
        "the companion is already linked; re-run with --yes to pair a different chat",
      );
    }
    if (!(await io.promptYesNo("Pair a different chat?", false))) {
      env.stdout("No changes made.\n");
      return 0;
    }
  }

  const token = await resolveSetupToken(args, env, config, interactive, io);
  const api = makeTelegramApi(token, env);

  let me;
  try {
    me = await api.getMe();
  } catch (cause) {
    throw telegramCommandError(cause);
  }
  const botLabel = me.username !== undefined ? `@${me.username}` : me.first_name ?? "your bot";
  env.stdout(`\nBot verified: ${botLabel}\n`);

  // Save the token before waiting for the phone: if pairing times out, the next
  // `aifight telegram setup` skips BotFather and goes straight to a new code.
  // Re-read first — `config` was loaded before two interactive prompts and a
  // network round trip, and bridge.json is shared with the desktop app and the
  // running bridge. Writing the old snapshot back would revert whatever they
  // changed in the meantime (a daily cap, a completed claim).
  if (config.telegramBotToken !== token) {
    writeBridgeConfig({ ...readBridgeConfig(), telegramBotToken: token, updatedAt: new Date().toISOString() });
  }

  const code = generatePairingCode();
  const minutes = Math.round(PAIRING_CODE_TTL_MS / 60_000);
  env.stdout([
    "",
    me.username !== undefined
      ? `Open your bot on the phone you want notified:  https://t.me/${me.username}`
      : "Open your bot in Telegram on the phone you want notified",
    "",
    `  Send it this pairing code:   ${code}`,
    "",
    `Waiting up to ${minutes} minutes… (Ctrl-C to stop)`,
    "",
  ].join("\n"));

  let outcome;
  try {
    outcome = await waitForPairingCode({
      api,
      code,
      deadline: Date.now() + PAIRING_CODE_TTL_MS,
      onLog: (message) => env.stderr(`warning: still trying (${message})\n`),
    });
  } catch (cause) {
    throw telegramCommandError(cause);
  }
  if (outcome.status === "timeout") {
    throw new CommandError(
      "telegram_pairing_timeout",
      "no pairing code arrived in time",
      { hint: "Run `aifight telegram setup` again — the bot token is saved, so it goes straight to a new code." },
    );
  }
  if (outcome.status === "conflict") {
    throw new CommandError(
      "telegram_pairing_conflict",
      `another AIFight bridge is already listening on this bot (${outcome.message})`,
      {
        hint: "Stop the running bridge first (Ctrl-C on `aifight run`, or `aifight service stop`), then run `aifight telegram setup` again. Two listeners split the messages between them, so the code can land in the wrong one.",
      },
    );
  }
  if (outcome.status === "abandoned") {
    throw new CommandError(
      "telegram_pairing_abandoned",
      "too many wrong codes arrived — someone else is guessing this one",
      {
        hint: "Pairing was cancelled on purpose. Run `aifight telegram setup` again for a fresh code; if it keeps happening, make a new bot in BotFather (the current one's name is known to someone else).",
      },
    );
  }

  // Re-read: the config on disk may have been rewritten above (and by anything
  // else in the meantime); building on the stale object would drop that.
  const current = readBridgeConfig();
  const section: BridgeTelegramConfig = {
    ...(current.telegram ?? defaultTelegramConfig(outcome.chatId)),
    chatId: outcome.chatId,
  };
  writeBridgeConfig({
    ...current,
    telegramBotToken: token,
    telegram: section,
    updatedAt: new Date().toISOString(),
  });

  const locale = resolveNotifyLocale(section.locale);
  try {
    await api.sendMessage({
      chatId: outcome.chatId,
      text: t(locale, "pair_welcome", { agent: escapeHtml(current.agentName) }),
    });
  } catch (cause) {
    env.stderr(`warning: paired, but the welcome message failed: ${describeTelegramError(cause)}\n`);
  }
  try {
    await api.setMyCommands(botCommands(locale));
  } catch {
    // Cosmetic: the /commands list in the chat's menu button. Not worth a word.
  }

  env.stdout(`\nLinked to chat ${outcome.chatId}. ${botLabel} will send match results and alerts there.\n`);
  for (const line of describeTelegramSettings(section)) env.stdout(`${line}\n`);
  env.stdout("Change any of it with `aifight telegram set <key> <value>`, or from the chat itself.\n");
  printRestartHintIfRunning(env);
  return 0;
}

async function resolveSetupToken(
  args: HandlerArgs,
  env: HandlerEnv,
  config: BridgeConfig,
  interactive: boolean,
  io: ReturnType<typeof createOnboardIO>,
): Promise<string> {
  const flag = args.flags["token-env"];
  if (typeof flag === "string" && flag.trim() !== "") {
    const name = flag.trim();
    if (/^\d+:/.test(name)) {
      // Deliberately NOT `TELEGRAM_BOT_TOKEN=… aifight …`: an inline assignment
      // is written to ~/.zsh_history verbatim, token and all, which outlives
      // both the encrypted config field and `telegram uninstall`.
      throw new UsageError(
        "--token-env takes the NAME of an environment variable, not the token itself",
        "Run `aifight telegram setup` with no flags and paste the token when prompted (it is not echoed). For a script, put the value in the environment without typing it on the command line: read -rs TELEGRAM_BOT_TOKEN && export TELEGRAM_BOT_TOKEN",
      );
    }
    const value = (process.env[name] ?? "").trim();
    if (value === "") {
      throw new CommandError("telegram_token_env_empty", `environment variable ${name} is empty or not set`);
    }
    return value;
  }

  if (config.telegramBotToken !== undefined) {
    if (!interactive) return config.telegramBotToken;
    if (await io.promptYesNo("A bot token is already saved on this machine. Use it?", true)) {
      return config.telegramBotToken;
    }
  }

  if (!interactive) {
    throw new UsageError(
      "there is no terminal to paste a bot token into",
      "Pass it through an environment variable instead: aifight telegram setup --token-env TELEGRAM_BOT_TOKEN",
    );
  }

  env.stdout(`\n${BOTFATHER_STEPS.join("\n")}\n\n`);
  const pasted = (await io.promptHidden("Paste the bot token (input hidden): ")).trim();
  if (pasted === "") throw new UsageError("a bot token is required", USAGE);
  return pasted;
}

// ── test ─────────────────────────────────────────────────────────────

async function telegramTest(args: HandlerArgs, env: HandlerEnv): Promise<number> {
  expectArity(args, 0, 0, USAGE);
  const { config, section } = requireLinked();
  if (config.telegramBotToken === undefined) {
    throw new CommandError(
      "telegram_token_missing",
      "the bot token is missing from this machine's config",
      { hint: "Run `aifight telegram setup` to store it again." },
    );
  }

  const api = makeTelegramApi(config.telegramBotToken, env);
  try {
    await api.sendMessage({
      chatId: section.chatId,
      text: t(resolveNotifyLocale(section.locale), "test_message", { agent: escapeHtml(config.agentName) }),
    });
  } catch (cause) {
    throw telegramCommandError(cause);
  }

  if (args.jsonMode) {
    env.stdout(JSON.stringify({ status: "ok", chatId: section.chatId }) + "\n");
    return 0;
  }
  env.stdout(`Test message sent to chat ${section.chatId}. Check your phone.\n`);
  return 0;
}

// ── set ──────────────────────────────────────────────────────────────

function telegramSet(args: HandlerArgs, env: HandlerEnv): number {
  expectArity(args, 2, 2, USAGE);
  const key = args.positional[0]!;
  const rawValue = args.positional[1]!;

  if (!isTelegramSettingKey(key)) {
    throw new UsageError(
      `unknown telegram setting '${key}'`,
      `available keys: ${TELEGRAM_SETTING_KEYS.join(", ")}`,
    );
  }

  const { config, section } = requireLinked();
  const outcome = applyTelegramSetting(section, key, rawValue);
  if (!outcome.ok) {
    throw new UsageError(outcome.message, `allowed: ${outcome.allowed}`);
  }

  writeBridgeConfig({ ...config, telegram: outcome.section, updatedAt: new Date().toISOString() });

  if (args.jsonMode) {
    env.stdout(JSON.stringify({ status: "ok", key, applied: outcome.summary }) + "\n");
    return 0;
  }
  env.stdout(`Telegram ${outcome.summary}\n`);
  printRestartHintIfRunning(env);
  return 0;
}

// ── mute ─────────────────────────────────────────────────────────────

function telegramMute(args: HandlerArgs, env: HandlerEnv): number {
  expectArity(args, 1, 1, USAGE);
  const outcome = parseMuteSpec(args.positional[0]!, Date.now());
  if (!outcome.ok) {
    throw new UsageError(outcome.message, `allowed: ${outcome.allowed}`);
  }

  const { config, section } = requireLinked();
  const next: BridgeTelegramConfig =
    outcome.mutedUntil === undefined
      ? dropMute(section)
      : { ...section, mutedUntil: outcome.mutedUntil };
  writeBridgeConfig({ ...config, telegram: next, updatedAt: new Date().toISOString() });

  if (args.jsonMode) {
    env.stdout(JSON.stringify({ status: "ok", mutedUntil: outcome.mutedUntil ?? null }) + "\n");
    return 0;
  }
  if (outcome.mutedUntil === undefined) {
    env.stdout("Telegram notifications unmuted.\n");
  } else {
    env.stdout(`Telegram notifications muted until ${new Date(outcome.mutedUntil).toLocaleString()}.\n`);
    env.stdout("Alerts (broken model key, disconnects, forfeits) are never muted.\n");
  }
  printRestartHintIfRunning(env);
  return 0;
}

function dropMute(section: BridgeTelegramConfig): BridgeTelegramConfig {
  const { mutedUntil: _cleared, ...rest } = section;
  return rest;
}

// ── unlink / uninstall ───────────────────────────────────────────────

function telegramUnlink(args: HandlerArgs, env: HandlerEnv): number {
  expectArity(args, 0, 0, USAGE);
  const { config } = requireLinked();
  const { telegram: _dropped, ...rest } = config;
  writeBridgeConfig({ ...rest, updatedAt: new Date().toISOString() });

  if (args.jsonMode) {
    env.stdout(JSON.stringify({ status: "ok", unlinked: true }) + "\n");
    return 0;
  }
  env.stdout("Telegram chat unlinked. The bot token is kept, so `aifight telegram setup` can re-pair without BotFather.\n");
  printRestartHintIfRunning(env);
  return 0;
}

async function telegramUninstall(args: HandlerArgs, env: HandlerEnv): Promise<number> {
  expectArity(args, 0, 0, USAGE);
  const config = readOptionalBridgeConfig();
  if (config === undefined || (config.telegram === undefined && config.telegramBotToken === undefined)) {
    env.stdout("Telegram companion is not configured on this machine — nothing to remove.\n");
    return 0;
  }

  if (args.flags["yes"] !== true) {
    if (args.jsonMode || process.stdin.isTTY !== true) {
      throw new CommandError(
        "telegram_uninstall_confirm_required",
        "removing the Telegram companion deletes the stored bot token; re-run with --yes to confirm",
      );
    }
    env.stdout("This deletes the stored bot token and all Telegram settings from this machine.\n");
    env.stdout("Your bot itself still exists — remove it with @BotFather if you want it gone.\n");
    const ok = await createOnboardIO(env).promptYesNo("Remove the Telegram companion?", false);
    if (!ok) {
      env.stdout("No changes made.\n");
      return 0;
    }
  }

  // writeBridgeConfig releases the previous encrypted token reference for any
  // ENCRYPTED_FIELD not carried over, so dropping it here also wipes the secret.
  // Re-read: the confirmation prompt above has no time limit, and `config` must
  // not carry a minutes-old copy of everything else back onto disk.
  const { telegram: _section, telegramBotToken: _token, ...rest } = readBridgeConfig();
  writeBridgeConfig({ ...rest, updatedAt: new Date().toISOString() });

  if (args.jsonMode) {
    env.stdout(JSON.stringify({ status: "ok", removed: true }) + "\n");
    return 0;
  }
  env.stdout("Telegram companion removed: bot token and settings deleted from this machine.\n");
  printRestartHintIfRunning(env);
  return 0;
}

// ── shared helpers ───────────────────────────────────────────────────

function requireLinked(): { config: BridgeConfig; section: BridgeTelegramConfig } {
  const config = readOptionalBridgeConfig();
  if (config === undefined) {
    throw new CommandError(
      "bridge_not_configured",
      "this machine has no AIFight agent yet",
      { hint: "Run `aifight setup` (new agent) or `aifight connect <PAIRING_CODE>` (existing agent) first." },
    );
  }
  if (config.telegram === undefined) {
    throw new CommandError(
      "telegram_not_linked",
      "the Telegram companion is not linked on this machine",
      { hint: "Run `aifight telegram setup` to pair a bot with your phone." },
    );
  }
  return { config, section: config.telegram };
}

function isLinked(): boolean {
  return readOptionalBridgeConfig()?.telegram !== undefined;
}

function makeTelegramApi(token: string, env: HandlerEnv): TelegramApi {
  return createTelegramApi({
    token,
    ...(env.fetchImpl !== undefined ? { fetchImpl: env.fetchImpl } : {}),
  });
}

/** Turn an API failure into an actionable CLI error. Never carries the token —
 *  api.ts guarantees its messages are built from status + description only. */
function telegramCommandError(cause: unknown): Error {
  if (!(cause instanceof TelegramApiError)) {
    return cause instanceof Error ? cause : new Error(String(cause));
  }
  switch (cause.kind) {
    case "auth":
      return new CommandError("telegram_token_rejected", "Telegram rejected that bot token", {
        hint: "Copy the whole token from @BotFather (it looks like 8123456789:AA…), or send /revoke there for a fresh one.",
      });
    case "rate_limit":
      return new CommandError("telegram_rate_limited", "Telegram is rate-limiting this bot; try again shortly");
    case "network":
      return new CommandError("telegram_unreachable", "could not reach Telegram (api.telegram.org)", {
        hint: "Check this machine's network — some networks block Telegram. Nothing was changed.",
      });
    case "request":
      return new CommandError("telegram_request_rejected", `Telegram refused the request: ${cause.message}`, {
        hint: "If the chat was deleted or the bot was blocked, run `aifight telegram setup` to pair again.",
      });
    default:
      return new CommandError("telegram_api_error", cause.message);
  }
}

function describeTelegramError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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

/** Last 4 characters of the bot token — enough to tell two bots apart, not
 *  enough to use. The leading digits are the bot's own id, but there is no
 *  reason to print any part of a credential that does not aid recognition. */
function tokenTailOf(token: string): string {
  return token.slice(-4);
}

/**
 * Has bridge.json changed since the running bridge read it? The port file is
 * written when the bridge comes up and removed when it stops, so its mtime is
 * a good-enough "started at". Best effort by design: a missing file just means
 * "no bridge running here", which is the safe answer.
 */
function bridgeRestartPending(): boolean {
  try {
    const started = fs.statSync(portFilePath()).mtimeMs;
    return fs.statSync(getBridgeConfigPath()).mtimeMs > started;
  } catch {
    return false;
  }
}

function printRestartHintIfRunning(env: HandlerEnv): void {
  if (bridgeRestartPending()) {
    env.stdout("The bridge is running with the previous settings — run `aifight service restart` to apply this.\n");
  }
}
