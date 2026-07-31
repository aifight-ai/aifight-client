import { readBridgeConfig, writeBridgeConfig, type BridgeConfig } from "../../bridge/config";
import {
  DAILY_CAP_CONFIRM_THRESHOLD,
  DailyPolicySyncError,
  SETUP_WIZARD_CAP_MAX,
  dailyCapNeedsConfirm,
  syncDailyPolicy,
} from "../../bridge/daily-policy";
import {
  DECLARED_MODEL_MAX_CHARS,
  declaredModelOriginLabel,
  resolveEffectiveDeclaredModel,
  syncDeclaredModel,
} from "../../bridge/declared-model";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { CommandError, SUPPORTED_GAMES, UsageError, expectArity, isSupportedGame } from "../shared";
import { createAnsi, createStatusIcons } from "../ansi";
import { parseLocale, resolveLocale, t, type I18nKey } from "../i18n";
import { agentSeatHolderPid } from "./bridge-start";
import { createOnboardIO, promptDefault } from "./onboard-io";
import { selectMulti } from "./select-multi";
import type { RawInput } from "./menu-select";

// Re-exported for the CLI surfaces that already import them from here.
export { DAILY_CAP_CONFIRM_THRESHOLD, SETUP_WIZARD_CAP_MAX, dailyCapNeedsConfirm };

/** readBridgeConfig, with the expected local-config failures mapped to a
 *  CommandError (exit 1 + hint) instead of the exit-99 catchall. */
function readSetBridgeConfig(): BridgeConfig {
  try {
    return readBridgeConfig();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.includes("bridge is not configured")) {
      throw new CommandError("bridge_not_configured", "AIFight Bridge is not configured.", {
        hint: "Run `aifight setup` for a new agent, or `aifight connect <PAIRING_CODE>` for an existing agent.",
      });
    }
    if (message.includes("bridge config is invalid")) {
      throw new CommandError("bridge_config_invalid", "The local bridge config is damaged and cannot be read.", {
        hint: "Re-link this machine with `aifight connect <PAIRING_CODE>`, or re-run `aifight setup`.",
      });
    }
    throw cause;
  }
}

const USAGE = [
  "usage: aifight set daily <N> [--yes]",
  "       aifight set game <game1,game2>",
  "       aifight set language <en|zh>",
  "       aifight set declared-model <name...>",
  '       aifight set declared-model ""      (clear the custom name)',
  "       aifight set declared-model --clear",
  `supported games: ${SUPPORTED_GAMES.join(", ")}`,
  "0 = manual matches only; max 100; caps above 10 ask for confirmation (--yes skips)",
].join("\n");

export async function runBridgeSet(
  args: HandlerArgs,
  env: HandlerEnv,
): Promise<number> {
  const kind = args.positional[0]!;
  // declared-model takes a free-form (possibly multi-word) name or --clear, so
  // it owns its arity instead of the fixed 2-arg shape daily/game share.
  if (kind === "declared-model") return setDeclaredModel(args, env);
  // Bare `aifight set daily` / `aifight set game` on a terminal: ASK instead of
  // erroring — daily shows the current value as the default (3x-ui habit —
  // Enter keeps it, owner ask 2026-07-30); game opens the checkbox picker
  // (V3 fool-proof, design §1). Scripts (non-TTY / --json) keep the usage
  // error below, so automation is untouched.
  if (
    (kind === "daily" || kind === "game") &&
    args.positional.length === 1 &&
    args.jsonMode !== true &&
    process.stdin.isTTY === true
  ) {
    return kind === "daily" ? promptDailyCap(args, env) : promptGames(args, env, pickGamesCheckbox);
  }
  expectArity(args, 2, 2, USAGE);
  if (kind === "daily") return setDaily(args.positional[1]!, args, env);
  if (kind === "game") return setGames(args.positional[1]!, args, env);
  if (kind === "language") return setLanguage(args.positional[1]!, args, env);
  throw new UsageError(`unknown set target '${kind}'`, "available: daily | game | language | declared-model");
}

/** A line reader shaped like onboard-io's readLineVisible — injectable so the
 *  interactive paths are testable without a real stdin. */
export type SetReadLine = (env: HandlerEnv, question: string) => Promise<string>;

/** Test seam: bare `aifight set daily`'s interactive flow, line reader injected. */
export async function runSetDailyInteractive(
  args: HandlerArgs,
  env: HandlerEnv,
  readLine: SetReadLine,
): Promise<number> {
  return promptDailyCap(args, env, readLine);
}

/** The interactive half of bare `aifight set daily`: prompt with the current
 *  cap as the default, then delegate the actual write to setDaily (which owns
 *  validation, the >threshold confirmation, and the platform sync).
 *  Fool-proof (V3): a bad number is a yellow inline message and the prompt
 *  RE-ASKS — the current value stays in the bracket; q/Esc still cancels and
 *  a bare Enter still keeps. */
async function promptDailyCap(args: HandlerArgs, env: HandlerEnv, readLine?: SetReadLine): Promise<number> {
  const loc = env.locale?.() ?? resolveLocale();
  const config = readSetBridgeConfig();
  const shown = config.autoDailyLimit === undefined ? "server default" : String(config.autoDailyLimit);
  const question = t(loc, "prompt.daily.question", { max: SETUP_WIZARD_CAP_MAX });
  for (;;) {
    const answer = await promptDefault(env, question, shown, readLine);
    if (answer.kind === "cancel") {
      env.stdout(`${t(loc, "prompt.cancel")}\n`);
      return 0;
    }
    if (answer.kind === "keep") {
      env.stdout(`${t(loc, "prompt.keep", { value: shown })}\n`);
      return 0;
    }
    // Same forgiveness as the config hub's prompt: a bad number is explained,
    // not a usage-error exit — nothing is written either way, and we re-ask.
    if (!/^\d+$/.test(answer.value) || Number.parseInt(answer.value, 10) > SETUP_WIZARD_CAP_MAX) {
      env.stdout(yellow(t(loc, "prompt.daily.invalid", { max: SETUP_WIZARD_CAP_MAX })));
      continue;
    }
    return setDaily(answer.value, args, env);
  }
}

/** The games picker's contract: given the currently-checked list, resolve the
 *  new selection (null = cancelled, change nothing). The production picker is
 *  the raw-mode checkbox list (select-multi.ts); tests inject a fake. */
export type GamesPicker = (env: HandlerEnv, current: readonly string[]) => Promise<readonly string[] | null>;

/** Test seam: bare `aifight set game`'s interactive flow, picker injected. */
export async function runSetGamesInteractive(
  args: HandlerArgs,
  env: HandlerEnv,
  picker: GamesPicker = pickGamesCheckbox,
): Promise<number> {
  return promptGames(args, env, picker);
}

/** The interactive half of bare `aifight set game`: the checkbox picker
 *  (pre-checked from bridge.json, ALL checked when unset), then setGames owns
 *  the write. Zero selected never reaches setGames — the picker's own
 *  validate keeps the user picking instead. */
async function promptGames(args: HandlerArgs, env: HandlerEnv, picker: GamesPicker): Promise<number> {
  const loc = env.locale?.() ?? resolveLocale();
  const config = readSetBridgeConfig();
  const current =
    config.autoGames === undefined || config.autoGames.length === 0
      ? [...SUPPORTED_GAMES]
      : config.autoGames.filter(isSupportedGame);
  const picked = await picker(env, current);
  if (picked === null) {
    env.stdout(`${t(loc, "prompt.cancel")}\n`);
    return 0;
  }
  if (picked.length === 0) {
    // A custom picker bypassing the checkbox's own guard — explain, change
    // nothing (the checkbox itself re-asks instead of ever returning this).
    env.stdout(yellow(t(loc, "set.game.picker.empty")));
    return 0;
  }
  return setGames(picked.join(","), args, env);
}

/** Per-game display names + picker hints. Ids stay English everywhere; the
 *  display name mirrors displayGameName (inlined — the narrator module is
 *  bridge-side and pulls in match machinery this command must not load). */
const GAME_LABELS: Readonly<Record<string, string>> = {
  texas_holdem: "Texas Hold'em",
  liars_dice: "Liar's Dice",
  coup: "Coup",
};
const GAME_HINT_KEYS: Readonly<Record<string, I18nKey>> = {
  texas_holdem: "set.game.hint.texas_holdem",
  liars_dice: "set.game.hint.liars_dice",
  coup: "set.game.hint.coup",
};

/** The production games picker: the raw-mode checkbox list over
 *  SUPPORTED_GAMES, pre-checked from the current selection. Confirming with
 *  zero checked does NOT exit — the inline yellow hint explains that the way
 *  to turn auto-play off entirely is `set daily 0` (design §1). Exported for
 *  main.ts, which wires it as the menu's Games picker. */
export async function pickGamesCheckbox(env: HandlerEnv, current: readonly string[]): Promise<readonly string[] | null> {
  const loc = env.locale?.() ?? resolveLocale();
  const picked = await selectMulti(
    env,
    {
      title: t(loc, "set.game.picker.title"),
      items: SUPPORTED_GAMES.map((game) => ({
        label: GAME_LABELS[game] ?? game,
        hint: t(loc, GAME_HINT_KEYS[game] ?? "set.game.hint.coup"),
        checked: current.includes(game),
      })),
      navHint: t(loc, "set.game.picker.nav"),
      validate: (selected) => (selected.length === 0 ? t(loc, "set.game.picker.empty") : undefined),
    },
    process.stdin as unknown as RawInput,
    { locale: loc },
  );
  if (picked === null) return null;
  return picked.map((i) => SUPPORTED_GAMES[i]!);
}

/** Yellow inline feedback (invalid input, picker guard) — plain when colors
 *  are off (NO_COLOR / TERM=dumb / piped), so tests and scripts see text only. */
function yellow(message: string): string {
  return `${createAnsi().yellow(message)}\n`;
}

async function setDaily(raw: string, args: HandlerArgs, env: HandlerEnv): Promise<number> {
  if (!/^\d+$/.test(raw)) {
    throw new UsageError(`daily must be a non-negative integer (got '${raw}')`, USAGE);
  }
  const limit = Number.parseInt(raw, 10);

  // Clamp to the same 0–100 ceiling the setup wizard and desktop enforce, so all
  // three surfaces agree. Above this the server (agent_daily_ranked_cap) would
  // clamp anyway; reporting a value it won't apply is misleading — reject up front.
  if (limit > SETUP_WIZARD_CAP_MAX) {
    throw new UsageError(`daily cap maximum is ${SETUP_WIZARD_CAP_MAX} (got ${limit})`, USAGE);
  }

  // Token-burn guard: above the threshold needs an explicit second yes.
  // --yes and --json are the deliberate programmatic overrides; otherwise a
  // terminal gets an interactive prompt and a script gets a clear error.
  if (dailyCapNeedsConfirm(limit) && !args.jsonMode && args.flags["yes"] !== true) {
    if (process.stdin.isTTY !== true) {
      throw new CommandError(
        "daily_cap_confirm_required",
        [
          `${limit} automatic matches per day is above the confirmation threshold (${DAILY_CAP_CONFIRM_THRESHOLD}).`,
          "Every automatic match makes many model calls on your API key — token costs add up fast.",
          `Re-run with --yes to confirm: aifight set daily ${limit} --yes`,
        ].join("\n"),
      );
    }
    const io = createOnboardIO(env);
    const loc = env.locale?.() ?? resolveLocale();
    env.stdout(`${t(loc, "prompt.daily.confirm.warn", { limit })}\n`);
    const ok = await io.promptYesNo(t(loc, "prompt.daily.confirm.ask", { limit }), false);
    if (!ok) {
      env.stdout(`${t(loc, "prompt.cancel")}\n`);
      return 0;
    }
  }

  const config = readSetBridgeConfig();
  try {
    await syncDailyPolicy(config, limit, env.fetchImpl ?? globalThis.fetch);
  } catch (cause) {
    if (cause instanceof DailyPolicySyncError) throw new CommandError("policy_sync_failed", cause.message);
    throw cause;
  }
  const updated = { ...config, autoDailyLimit: limit, updatedAt: new Date().toISOString() };
  // preserveMtime (V3 重启精确化): the running bridge re-reads the cap at every
  // connect edge now, so this write must NOT read as "restart pending".
  writeBridgeConfig(updated, { preserveMtime: true });

  if (args.jsonMode) {
    env.stdout(JSON.stringify({ status: "ok", autoDailyLimit: limit, platformPolicySynced: true }) + "\n");
    return 0;
  }
  if (limit === 0) {
    env.stdout("Daily automatic ranked matches disabled. The Agent will not join scheduled matches unless you change this setting or manually start a match.\n");
  } else {
    env.stdout(`Automatic ranked matches set to ${limit} per day.\n`);
  }
  env.stdout("AIFight platform policy synced.\n");
  sayApplied(env);
  return 0;
}

/**
 * The setup wizard's daily-cap question (first-run guidance, mirrors the
 * desktop's SetupGuide). Explains what the cap protects against, defaults to
 * 2 on a bare Enter, validates 0–100, and re-asks after a declined >threshold
 * confirmation. Failures to sync are reported but never fail setup — the
 * server-side default (2) still stands, and `aifight set daily <N>` can fix
 * it later.
 */
export async function onboardDailyCap(env: HandlerEnv): Promise<void> {
  const io = createOnboardIO(env);
  env.stdout(
    [
      "Daily automatic matches",
      "  Your agent joins ranked matches BY ITSELF, up to a daily cap — and every",
      "  match makes many model calls on your own API key. The cap is the token-burn",
      "  safety valve. 0 = manual only (the agent never starts matches by itself).",
      "  Manual matches and friendly challenges are never counted against it.",
      "",
    ].join("\n"),
  );
  let limit: number;
  for (;;) {
    const raw = (await io.promptLine("  Automatic matches per day [2]: ")).trim();
    if (raw === "") {
      limit = 2;
      break;
    }
    if (!/^\d+$/.test(raw)) {
      env.stdout(`  Please enter a whole number between 0 and ${SETUP_WIZARD_CAP_MAX}.\n`);
      continue;
    }
    const parsed = Number.parseInt(raw, 10);
    if (parsed > SETUP_WIZARD_CAP_MAX) {
      env.stdout(`  The maximum is ${SETUP_WIZARD_CAP_MAX}.\n`);
      continue;
    }
    if (dailyCapNeedsConfirm(parsed)) {
      const ok = await io.promptYesNo(
        `  ${parsed}/day means a lot of model calls — token costs add up fast. Keep ${parsed}?`,
        false,
      );
      if (!ok) continue;
    }
    limit = parsed;
    break;
  }

  try {
    const config = readBridgeConfig();
    await syncDailyPolicy(config, limit, env.fetchImpl ?? globalThis.fetch);
    writeBridgeConfig({ ...config, autoDailyLimit: limit, updatedAt: new Date().toISOString() });
    env.stdout(
      limit === 0
        ? "  Automatic matching is OFF — you start every match yourself (aifight start).\n\n"
        : `  Up to ${limit} automatic match${limit === 1 ? "" : "es"} per day. Change any time with \`aifight set daily <N>\`.\n\n`,
    );
  } catch {
    env.stdout("  Could not sync the cap right now — set it later with `aifight set daily <N>`.\n\n");
  }
}

async function setGames(raw: string, args: HandlerArgs, env: HandlerEnv): Promise<number> {
  const games = raw.split(",").map((g) => g.trim()).filter((g) => g.length > 0);
  if (games.length === 0) {
    throw new UsageError("at least one game is required", USAGE);
  }
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const game of games) {
    if (!isSupportedGame(game)) {
      throw new UsageError(`unsupported game '${game}'`, `supported: ${SUPPORTED_GAMES.join(", ")}`);
    }
    if (!seen.has(game)) {
      seen.add(game);
      unique.push(game);
    }
  }

  const config = readSetBridgeConfig();
  const updated = { ...config, autoGames: unique, updatedAt: new Date().toISOString() };
  // preserveMtime (V3 重启精确化): the running bridge re-reads the games list
  // at every connect edge now, so this write must NOT read as "restart pending".
  writeBridgeConfig(updated, { preserveMtime: true });

  if (args.jsonMode) {
    env.stdout(JSON.stringify({ status: "ok", autoGames: unique }) + "\n");
    return 0;
  }
  env.stdout(`Automatic match games set to: ${unique.join(", ")}\n`);
  sayApplied(env);
  return 0;
}

/** The post-save truth for the two connect-edge settings (V3 ②): a running
 *  bridge re-reads the daily cap and games list at every (re)connect, so no
 *  restart is needed — and when nothing runs, the plain "applies on next
 *  bridge start". */
function sayApplied(env: HandlerEnv): void {
  const loc = env.locale?.() ?? resolveLocale();
  const icons = env.statusIcons ?? createStatusIcons();
  const running = agentSeatHolderPid() !== undefined;
  env.stdout(`${icons.ok} ${t(loc, running ? "set.apply.edge" : "set.apply.next_start")}\n`);
}

// ─── language ─────────────────────────────────────────────────────────
//
// The scriptable twin of the menu's Language item (owner ask 2026-07-31).
// Writes bridge.json's display-only locale field — the bridge never reads
// it, so the write preserves mtime (no restart offer) and takes effect for
// the CLI's human output immediately. The confirmation prints in the NEW
// language; --json stays English-keyed.

async function setLanguage(raw: string, args: HandlerArgs, env: HandlerEnv): Promise<number> {
  const locale = parseLocale(raw);
  if (locale === undefined) {
    throw new UsageError(`language must be en or zh (got '${raw}')`, USAGE);
  }
  const config = readSetBridgeConfig();
  writeBridgeConfig(
    { ...config, locale, updatedAt: new Date().toISOString() },
    { preserveMtime: true },
  );
  if (args.jsonMode) {
    env.stdout(JSON.stringify({ status: "ok", locale }) + "\n");
    return 0;
  }
  env.stdout(`${t(locale, "set.language.ok")}\n`);
  return 0;
}

// ─── declared-model ──────────────────────────────────────────────────
//
// The PUBLIC model label the leaderboard and agent profile show. Without a
// pin the label is derived from the active agent profile's configured LLM
// model (then "direct"); `aifight set declared-model <name>` pins a custom
// display name instead. After every write the EFFECTIVE label is pushed to
// the platform right away (best-effort: a failure warns and retries at the
// next bridge start — the local bridge.json stays the source of truth).

/** Client-side mirror of the platform rule (trimmed, 1..100 chars, no control
 *  characters) so a bad name fails fast locally instead of after a PATCH. */
function declaredModelValidationError(name: string): string | undefined {
  if (name.length === 0) return "the declared model name must not be empty";
  if (name.length > DECLARED_MODEL_MAX_CHARS) {
    return `the declared model name must be at most ${DECLARED_MODEL_MAX_CHARS} characters (got ${name.length})`;
  }
  for (const ch of name) {
    if (ch < " ") return "the declared model name must not contain control characters";
  }
  return undefined;
}

async function setDeclaredModel(args: HandlerArgs, env: HandlerEnv): Promise<number> {
  const clearFlag = args.flags["clear"] === true;
  // The name may contain spaces: every positional after the target joins into
  // it (`aifight set declared-model My Custom Bot`). `set declared-model ""`
  // is the documented empty-string form of --clear; BARE `set declared-model`
  // (no argument at all) is a usage error, not a clear.
  if (!clearFlag && args.positional.length < 2) {
    throw new UsageError("missing the model name to declare (or pass --clear)", USAGE);
  }
  const raw = args.positional.slice(1).join(" ").trim();
  if (clearFlag && raw !== "") {
    throw new UsageError("pass a name OR --clear, not both", USAGE);
  }
  const clearing = clearFlag || raw === "";
  if (!clearing) {
    const problem = declaredModelValidationError(raw);
    if (problem !== undefined) throw new UsageError(problem, USAGE);
  }

  const config = readSetBridgeConfig();
  const updatedAt = new Date().toISOString();
  let updated: BridgeConfig;
  if (clearing) {
    const { declaredModel: _dropped, ...rest } = config;
    updated = { ...rest, updatedAt };
  } else {
    updated = { ...config, declaredModel: raw, updatedAt };
  }
  // preserveMtime (V3 重启精确化): the effective label is pushed to the
  // platform over HTTP right below, so this write is display-only for the
  // bridge and must NOT read as "restart pending".
  writeBridgeConfig(updated, { preserveMtime: true });

  // Push the EFFECTIVE label: after a pin that's the name itself; after a
  // clear it falls back to the profile-derived model (or "direct").
  const result = await syncDeclaredModel(updated, env.fetchImpl ?? globalThis.fetch);
  const effective = resolveEffectiveDeclaredModel(updated);
  const label = `${effective.value} (${declaredModelOriginLabel(effective.origin)})`;

  if (args.jsonMode) {
    env.stdout(
      JSON.stringify({
        status: "ok",
        declaredModel: clearing ? null : raw,
        effective: { value: effective.value, origin: effective.origin },
        platformSynced: result.ok,
        ...(result.ok ? {} : { syncError: result.error }),
      }) + "\n",
    );
    return 0;
  }
  if (clearing) {
    env.stdout("Declared model custom name cleared.\n");
  } else {
    env.stdout(`Declared model set to "${raw}". This name is PUBLIC on the leaderboard and your agent profile.\n`);
  }
  if (result.ok) {
    env.stdout(`Leaderboard now shows: ${label}\n`);
  } else {
    env.stdout(`The leaderboard will show: ${label}\n`);
    env.stderr(
      `warning: could not sync the declared model to the platform (${result.error}) — it retries at the next \`aifight run\`/\`aifight start\`.\n`,
    );
  }
  return 0;
}
