import { readBridgeConfig, writeBridgeConfig } from "../../bridge/config";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { CommandError, SUPPORTED_GAMES, UsageError, expectArity, isSupportedGame } from "../shared";
import { createOnboardIO } from "./onboard-io";

const USAGE = [
  "usage: aifight set daily <N> [--yes]",
  "       aifight set game <game1,game2>",
  `supported games: ${SUPPORTED_GAMES.join(", ")}`,
  "0 = manual matches only; max 100; caps above 10 ask for confirmation (--yes skips)",
].join("\n");

/** Above this many automatic matches per day the CLI asks for an explicit
 *  second confirmation — the daily cap is a token-burn safety valve, and
 *  >10/day means a lot of model calls on the user's own key. Mirrors the
 *  desktop dashboard's CAP_CONFIRM_THRESHOLD; change both together. */
export const DAILY_CAP_CONFIRM_THRESHOLD = 10;

/** The setup wizard's custom-entry ceiling. Mirrors the desktop dashboard's
 *  CAP_MAX (PlayView.tsx); change both together. This is the client-side
 *  first-run cap — the server ceiling (agent_daily_ranked_cap, admin-tunable)
 *  is the real hard limit and clamps anything higher on the PATCH. */
export const SETUP_WIZARD_CAP_MAX = 100;

export function dailyCapNeedsConfirm(limit: number): boolean {
  return limit > DAILY_CAP_CONFIRM_THRESHOLD;
}

export async function runBridgeSet(
  args: HandlerArgs,
  env: HandlerEnv,
): Promise<number> {
  expectArity(args, 2, 2, USAGE);
  const kind = args.positional[0]!;
  if (kind === "daily") return setDaily(args.positional[1]!, args, env);
  if (kind === "game") return setGames(args.positional[1]!, args, env);
  throw new UsageError(`unknown set target '${kind}'`, "available: daily | game");
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
    env.stdout(
      `${limit} automatic matches per day means a lot of model calls on your key — token costs add up fast.\n`,
    );
    const ok = await io.promptYesNo(`Allow up to ${limit} automatic matches per day?`, false);
    if (!ok) {
      env.stdout("No changes made.\n");
      return 0;
    }
  }

  const config = readBridgeConfig();
  await syncDailyPolicy(config, limit, env.fetchImpl ?? globalThis.fetch);
  const updated = { ...config, autoDailyLimit: limit, updatedAt: new Date().toISOString() };
  writeBridgeConfig(updated);

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

async function syncDailyPolicy(
  config: ReturnType<typeof readBridgeConfig>,
  limit: number,
  fetchImpl: typeof fetch,
): Promise<void> {
  const body = limit === 0
    ? { auto_requeue: false }
    : { max_games_per_day: limit, auto_requeue: true };
  const res = await fetchImpl(`${config.baseUrl}/api/agents/me/policy`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": config.apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new CommandError("policy_sync_failed", await readAPIError(res, `daily policy sync failed with HTTP ${res.status}`));
  }
}

function setGames(raw: string, args: HandlerArgs, env: HandlerEnv): number {
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

  const config = readBridgeConfig();
  const updated = { ...config, autoGames: unique, updatedAt: new Date().toISOString() };
  writeBridgeConfig(updated);

  if (args.jsonMode) {
    env.stdout(JSON.stringify({ status: "ok", autoGames: unique }) + "\n");
    return 0;
  }
  env.stdout(`Automatic match games set to: ${unique.join(", ")}\n`);
  return 0;
}

async function readAPIError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => undefined) as unknown;
  if (body && typeof body === "object") {
    const error = (body as Record<string, unknown>).error;
    if (typeof error === "string" && error.length > 0) return error;
  }
  return fallback;
}
