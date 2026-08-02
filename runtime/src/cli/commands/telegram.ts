// `aifight telegram …` — the Telegram companion's local control surface.
//
// The companion is a private bot the user creates themselves: the token stays
// in this machine's encrypted bridge config, and messages travel between this
// machine and Telegram directly. AIFight's servers are not involved and know
// nothing about it.
//
// Everything here edits bridge.json. The bridge does not watch that file, so a
// change made while it is running is inert until it restarts. Every writing
// path therefore ends in applyPendingBridgeRestart(), which offers to do that
// restart on the spot; read-only `status` just says a restart is pending.

import {
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
import type { HandlerArgs, HandlerEnv } from "../shared";
import { CommandError, UsageError, expectArity } from "../shared";
import { createAnsi } from "../ansi";
import { createOutput } from "../output";
import { resolveLocale, t as ui, type Locale } from "../i18n";
import { applyPendingBridgeRestart, bridgeRestartPending, withDeferredApply } from "./apply-settings";
import { renderMenuFrame, type MenuFrame } from "./menu-frame";
import { createMenuChooser } from "./menu-select";
import type { OnboardIO } from "./onboard-llm";
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
    // if it isn't, otherwise open the panel.
    //
    // It used to print status and stop there, which meant a linked user had NO
    // way to change anything from the menu — the owner went round the loop four
    // times on a fresh VPS looking for the edit screen (2026-07-29). Scripts and
    // --json keep the old status-only behaviour; only a terminal gets the panel.
    //
    // The script branch is checked FIRST: --json on an unlinked machine must
    // answer with a status document ({status:"not_configured"}), not fall into
    // the interactive setup wizard and die as a usage error.
    case "":
      if (args.jsonMode || process.stdin.isTTY !== true) return telegramStatus(rest, env);
      if (!isLinked()) return telegramSetup(rest, env);
      return telegramPanel(rest, env);
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

// ── interactive panel (bare `aifight telegram` on a TTY, already linked) ──
//
// Everything here routes through the same subcommand handlers the flags use, so
// there is one implementation of each change and the panel adds no new rules.

/** Only the two prompts the panel actually asks for — injected so its control
 *  flow is unit-testable without a real terminal (same shape as menu.ts). */
export type PanelIO = Pick<OnboardIO, "promptLine" | "promptYesNo">;

interface PanelItem {
  readonly key: string;
  /** The row's action word, translated (CLI display locale). */
  readonly main: (loc: Locale) => string;
  /** The row's dim suffix — the CURRENT value for settings rows, a short
   *  description for action rows. Re-evaluated on every repaint, so the
   *  value shown is always the one just written. */
  readonly hint?: (loc: Locale, section: BridgeTelegramConfig) => string;
  readonly run: (env: HandlerEnv, io: PanelIO, loc: Locale) => Promise<void>;
}

/** Ask for one of a fixed set of values, re-asking until it is one of them.
 *  The bracketed values stay raw config words — that is what you type. */
async function pickValue(
  io: PanelIO,
  env: HandlerEnv,
  loc: Locale,
  prompt: string,
  allowed: readonly string[],
): Promise<string | undefined> {
  for (;;) {
    const raw = (await io.promptLine(
      `${prompt} [${allowed.join(" / ")} · ${ui(loc, "telegram.panel.back_hint")}]: `,
    )).trim().toLowerCase();
    if (raw === "" || raw === "b" || raw === "back") return undefined;
    if (allowed.includes(raw)) return raw;
    env.stdout(`${ui(loc, "telegram.panel.not_one_of", { allowed: allowed.join(", ") })}\n`);
  }
}

async function setSetting(env: HandlerEnv, key: string, value: string): Promise<void> {
  await telegramSet({ positional: [key, value], flags: {}, jsonMode: false }, env);
}

function onOffText(loc: Locale, value: boolean): string {
  return ui(loc, value ? "telegram.value.on" : "telegram.value.off");
}

const PANEL_ITEMS: readonly PanelItem[] = [
  {
    key: "1",
    main: (loc) => ui(loc, "telegram.row.results.main"),
    hint: (loc, s) =>
      s.results === "off" ? ui(loc, "telegram.value.off") : ui(loc, `telegram.value.results.${s.results}`),
    run: async (env, io, loc) => {
      const v = await pickValue(io, env, loc, ui(loc, "telegram.row.results.ask"), ["per_match", "daily", "both", "off"]);
      if (v !== undefined) await setSetting(env, "results", v);
    },
  },
  {
    key: "2",
    main: (loc) => ui(loc, "telegram.row.digest.main"),
    hint: (_loc, s) => s.digestAt ?? TELEGRAM_DEFAULT_DIGEST_AT,
    run: async (env, io, loc) => {
      const v = (await io.promptLine(ui(loc, "telegram.row.digest.ask"))).trim();
      if (v === "" || v.toLowerCase() === "b") return;
      await setSetting(env, "digest_at", v);
    },
  },
  {
    key: "3",
    main: (loc) => ui(loc, "telegram.row.alerts.main"),
    hint: (loc, s) => onOffText(loc, s.alerts),
    run: async (env, io, loc) => {
      const v = await pickValue(io, env, loc, ui(loc, "telegram.row.alerts.ask"), ["on", "off"]);
      if (v !== undefined) await setSetting(env, "alerts", v);
    },
  },
  {
    key: "4",
    main: (loc) => ui(loc, "telegram.row.challenge.main"),
    hint: (loc, s) => onOffText(loc, s.challengeEvents),
    run: async (env, io, loc) => {
      const v = await pickValue(io, env, loc, ui(loc, "telegram.row.challenge.ask"), ["on", "off"]);
      if (v !== undefined) await setSetting(env, "challenge_events", v);
    },
  },
  {
    key: "5",
    main: (loc) => ui(loc, "telegram.row.control.main"),
    hint: (loc, s) => onOffText(loc, s.control),
    run: async (env, io, loc) => {
      const v = await pickValue(io, env, loc, ui(loc, "telegram.row.control.ask"), ["on", "off"]);
      if (v !== undefined) await setSetting(env, "control", v);
    },
  },
  {
    // The TELEGRAM MESSAGE language (bridge.json telegram.locale), not the
    // CLI display language — the row name says "message" for that reason.
    key: "6",
    main: (loc) => ui(loc, "telegram.row.locale.main"),
    hint: (loc, s) => {
      const locale = s.locale ?? "auto";
      return locale === "auto" ? ui(loc, "telegram.value.locale.auto", { lang: resolveNotifyLocale(undefined) }) : locale;
    },
    run: async (env, io, loc) => {
      const v = await pickValue(io, env, loc, ui(loc, "telegram.row.locale.ask"), ["zh", "en", "auto"]);
      if (v !== undefined) await setSetting(env, "locale", v);
    },
  },
  {
    key: "7",
    main: (loc) => ui(loc, "telegram.row.mute.main"),
    hint: (loc, s) =>
      s.mutedUntil !== undefined && s.mutedUntil > Date.now()
        ? ui(loc, "telegram.value.muted_until", { time: new Date(s.mutedUntil).toLocaleString() })
        : ui(loc, "telegram.value.off"),
    run: async (env, io, loc) => {
      const v = await pickValue(io, env, loc, ui(loc, "telegram.row.mute.ask"), ["1h", "today", "off"]);
      if (v !== undefined) await telegramMute({ positional: [v], flags: {}, jsonMode: false }, env);
    },
  },
  {
    key: "8",
    main: (loc) => ui(loc, "telegram.row.test.main"),
    hint: (loc) => ui(loc, "telegram.row.test.hint"),
    run: async (env) => {
      await telegramTest({ positional: [], flags: {}, jsonMode: false }, env);
    },
  },
  {
    key: "9",
    main: (loc) => ui(loc, "telegram.row.pair.main"),
    hint: (loc) => ui(loc, "telegram.row.pair.hint"),
    run: async (env) => {
      await telegramSetup({ positional: [], flags: {}, jsonMode: false }, env);
    },
  },
  {
    key: "10",
    main: (loc) => ui(loc, "telegram.row.unlink.main"),
    hint: (loc) => ui(loc, "telegram.row.unlink.hint"),
    run: async (env, io, loc) => {
      if (!(await io.promptYesNo(ui(loc, "telegram.row.unlink.ask"), false))) {
        env.stdout(`${ui(loc, "telegram.panel.left_as_is")}\n`);
        return;
      }
      await telegramUnlink({ positional: [], flags: {}, jsonMode: false }, env);
    },
  },
];

/** The panel as a MenuFrame — same renderer as the main menu, so the 12 →
 *  Telegram hop no longer changes visual worlds (A1, 2026-08-02). Rows carry
 *  the live value as the hint; the header is a small status subline. */
function panelFrame(loc: Locale, config: BridgeConfig, section: BridgeTelegramConfig): MenuFrame {
  const linked = ui(loc, "telegram.panel.linked", { chat: section.chatId });
  const bot = config.telegramBotToken !== undefined
    ? ` · ${ui(loc, "telegram.panel.bot", { tail: tokenTailOf(config.telegramBotToken) })}`
    : "";
  return {
    title: ui(loc, "telegram.panel.title"),
    banner: [],
    subheader: [`${linked}${bot}`],
    choices: [
      ...PANEL_ITEMS.map((item) => ({
        key: item.key,
        main: item.main(loc),
        ...(item.hint !== undefined ? { hint: item.hint(loc, section) } : {}),
      })),
      { key: "q", main: ui(loc, "telegram.panel.done") },
    ],
  };
}

export async function telegramPanel(args: HandlerArgs, env: HandlerEnv, injectedIO?: PanelIO): Promise<number> {
  expectArity(args, 0, 0, USAGE);
  const io = injectedIO ?? createOnboardIO(env);
  // The arrow-key chooser, only for a REAL terminal opened without injected
  // IO: tests (and any chooser-less host) keep the printed-frame + line
  // fallback below, same split as menu.ts. runTelegram already gates the
  // panel to TTY stdin; stdout is checked here for the raw-repaint math.
  const choose = injectedIO === undefined && process.stdin.isTTY === true && process.stdout.isTTY === true
    ? createMenuChooser(env)
    : undefined;

  for (;;) {
    const loc = resolveLocale();
    const config = readOptionalBridgeConfig();
    if (config === undefined || config.telegram === undefined) {
      // Unlinked from the panel (item 10) or from the chat itself.
      env.stdout(`\n${ui(loc, "telegram.panel.unlinked_now")}\n`);
      return 0;
    }

    const frame = panelFrame(loc, config, config.telegram);
    let choice: string;
    if (choose !== undefined) {
      choice = (await choose(frame, { locale: loc, singleColumn: true })).trim().toLowerCase();
    } else {
      env.stdout(`\n${renderMenuFrame(frame, -1, createAnsi({ enabled: false }), 0, { singleColumn: true }).join("\n")}\n\n`);
      choice = (await io.promptLine(ui(loc, "menu.pick"))).trim().toLowerCase();
    }
    if (choice === "" || choice === "q" || choice === "quit" || choice === "done") {
      // One last chance to make pending edits real before dropping out.
      await applyPendingBridgeRestart(env, {});
      return 0;
    }
    const item = PANEL_ITEMS.find((i) => i.key === choice);
    if (item === undefined) {
      env.stdout(`  ${ui(loc, "telegram.panel.unknown_choice")}\n`);
      continue;
    }
    try {
      // Deferred: the handlers below each end in an apply offer, and asking
      // after every single edit is the nagging this whole thing set out to fix.
      // One offer, on the way out (see the `q` branch above).
      await withDeferredApply(() => item.run(env, io, loc));
    } catch (cause) {
      env.stdout(`  ${ui(loc, "telegram.panel.failed", { error: describeTelegramError(cause) })}\n`);
      // CommandError/UsageError carry the fix in their hint (the allowed
      // values, the "HH:MM" format) — without it the user is told THAT it
      // failed but not what would succeed.
      const hint = cause instanceof CommandError || cause instanceof UsageError ? cause.hint : undefined;
      if (hint !== undefined) env.stdout(`  ${hint}\n`);
    }
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

  const out = createOutput({ labelWidth: 18 });
  env.stdout(`${out.section("AIFight Telegram companion")}\n\n`);
  if (section === undefined) {
    env.stdout(
      tokenTail !== undefined
        ? `${out.kv("Status", `bot token saved (…${tokenTail}), no chat linked`, { tone: "yellow" })}\n`
        : `${out.kv("Status", "not set up", { tone: "yellow" })}\n`,
    );
    env.stdout(`${out.note("Set it up with: aifight telegram setup")}\n`);
    return 0;
  }

  env.stdout(`${out.kv("Status", `linked to chat ${section.chatId}`, { tone: "green" })}\n`);
  if (tokenTail !== undefined) env.stdout(`${out.kv("Bot token", `…${tokenTail}`, { tone: "dim" })}\n`);
  for (const line of describeTelegramSettings(section)) {
    const sep = line.indexOf(": ");
    if (sep > 0) env.stdout(`${out.kv(line.slice(0, sep), line.slice(sep + 2))}\n`);
    else env.stdout(`${line}\n`);
  }
  if (restartPending) {
    env.stdout(`\n${out.note("Settings changed since the bridge started — run `aifight service restart` to apply them.")}\n`);
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
  await applyPendingBridgeRestart(env, { jsonMode: args.jsonMode });
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

async function telegramSet(args: HandlerArgs, env: HandlerEnv): Promise<number> {
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
    // restartPending lets a script know the running bridge has not picked this
    // up yet — applyPendingBridgeRestart prints nothing in jsonMode, so the
    // boolean is the only channel that carries it.
    env.stdout(JSON.stringify({ status: "ok", key, applied: outcome.summary, restartPending: bridgeRestartPending() }) + "\n");
    return 0;
  }
  env.stdout(`Telegram ${outcome.summary}\n`);
  await applyPendingBridgeRestart(env, { jsonMode: args.jsonMode });
  return 0;
}

// ── mute ─────────────────────────────────────────────────────────────

async function telegramMute(args: HandlerArgs, env: HandlerEnv): Promise<number> {
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
    env.stdout(JSON.stringify({ status: "ok", mutedUntil: outcome.mutedUntil ?? null, restartPending: bridgeRestartPending() }) + "\n");
    return 0;
  }
  if (outcome.mutedUntil === undefined) {
    env.stdout("Telegram notifications unmuted.\n");
  } else {
    env.stdout(`Telegram notifications muted until ${new Date(outcome.mutedUntil).toLocaleString()}.\n`);
    env.stdout("Alerts (broken model key, disconnects, forfeits) are never muted.\n");
  }
  await applyPendingBridgeRestart(env, { jsonMode: args.jsonMode });
  return 0;
}

function dropMute(section: BridgeTelegramConfig): BridgeTelegramConfig {
  const { mutedUntil: _cleared, ...rest } = section;
  return rest;
}

// ── unlink / uninstall ───────────────────────────────────────────────

async function telegramUnlink(args: HandlerArgs, env: HandlerEnv): Promise<number> {
  expectArity(args, 0, 0, USAGE);
  const { config } = requireLinked();
  const { telegram: _dropped, ...rest } = config;
  writeBridgeConfig({ ...rest, updatedAt: new Date().toISOString() });

  if (args.jsonMode) {
    env.stdout(JSON.stringify({ status: "ok", unlinked: true, restartPending: bridgeRestartPending() }) + "\n");
    return 0;
  }
  env.stdout("Telegram chat unlinked. The bot token is kept, so `aifight telegram setup` can re-pair without BotFather.\n");
  await applyPendingBridgeRestart(env, { jsonMode: args.jsonMode });
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
  await applyPendingBridgeRestart(env, { jsonMode: args.jsonMode });
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


