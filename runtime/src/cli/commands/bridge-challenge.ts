import {
  createChallenge,
  listMyChallenges,
  AgentActionError,
  type ChallengeGame,
  type MyChallenge,
} from "../../bridge/agent-actions";
import {
  forgetEndedChallenges,
  loadCreatedChallenges,
  rememberCreatedChallenge,
} from "../../bridge/challenge-record";
import { readBridgeConfig, type BridgeConfig } from "../../bridge/config";
import { formatMinutes, gameLabel, resolveLocale, t, type Locale } from "../i18n";
import { createOutput } from "../output";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { CommandError, UsageError, expectArity } from "../shared";

const USAGE = "usage: aifight challenge <texas_holdem|liars_dice|coup> [players]  |  aifight challenge list";

/** readBridgeConfig, with the expected local-config failures mapped to a
 *  CommandError (exit 1 + hint) instead of the exit-99 catchall. */
function readChallengeBridgeConfig(): BridgeConfig {
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

export async function runBridgeChallenge(
  args: HandlerArgs,
  env: HandlerEnv,
): Promise<number> {
  expectArity(args, 1, 2, USAGE);
  const game = args.positional[0]!;
  if (game === "list") {
    if (args.positional.length > 1) throw new UsageError("challenge list takes no further arguments", USAGE);
    return runChallengeList(args, env);
  }
  if (game !== "texas_holdem" && game !== "liars_dice" && game !== "coup") {
    throw new UsageError(
      `challenge game must be texas_holdem, liars_dice, or coup (got '${game}')`,
      USAGE,
    );
  }
  // Optional table size. Omitted → the server picks the game's smallest legal
  // friendly table (texas 2, coup 3, dice 2). The server is the authority on
  // legal sizes; only the number format is validated here.
  let playerCount: number | undefined;
  if (args.positional.length > 1) {
    const parsed = Number(args.positional[1]);
    if (!Number.isInteger(parsed) || parsed < 2 || parsed > 6) {
      throw new UsageError(`players must be a whole number between 2 and 6 (got '${args.positional[1]}')`, USAGE);
    }
    playerCount = parsed;
  }

  const config = readChallengeBridgeConfig();
  let created;
  try {
    created = await createChallenge(config, game as ChallengeGame, env.fetchImpl ?? globalThis.fetch, playerCount);
  } catch (cause) {
    if (cause instanceof AgentActionError) throw new CommandError(cause.code, cause.message);
    throw cause;
  }

  // Keep the URL locally (keyed by duel id): the server stores only the
  // token's digest, so this record is the only way `challenge list` can show
  // the link again.
  const duelId = (() => {
    const raw = created.raw as { duel?: { id?: unknown } } | undefined;
    return typeof raw?.duel?.id === "string" ? raw.duel.id : "";
  })();
  rememberCreatedChallenge(duelId, {
    url: created.joinUrl,
    game,
    players: playerCount ?? (game === "coup" ? 3 : 2),
    at: new Date().toISOString(),
  });

  if (args.jsonMode) {
    env.stdout(JSON.stringify(created.raw) + "\n");
    return 0;
  }
  // P7 (U8b): the confirmation used to be a flat `Label: value` wall with the
  // raw game id in it. Same facts, styled kv block + the link on its own
  // unstyled line.
  const loc = env.locale?.() ?? resolveLocale();
  const out = createOutput();
  // The EFFECTIVE table size, not just the one that was typed: omitting the
  // count on coup still opens a 3-seat table (the invite text and the local
  // record have always used this number). The block used to branch on the
  // typed count alone, so a default coup challenge claimed "Accepts: 1
  // (accepted once)" for a table that needs two people to sit down.
  const seats = playerCount ?? (game === "coup" ? 3 : 2);
  const multi = seats > 2;
  env.stdout(`${out.section(t(loc, "challenge.created.title"))}\n`);
  for (const line of out.kvRows([
    [t(loc, "challenge.created.game"), gameLabel(loc, game), "cyan"],
    ...(multi
      ? [[t(loc, "challenge.created.players"), t(loc, "challenge.created.players.value", { count: seats })] as const]
      : []),
    [t(loc, "challenge.created.rating"), t(loc, "challenge.created.rating.value"), "green"],
    [
      t(loc, "challenge.created.accepts"),
      multi
        ? t(loc, "challenge.created.accepts.seats", { count: seats - 1 })
        : t(loc, "challenge.created.accepts.one"),
    ],
  ])) {
    env.stdout(`${line}\n`);
  }
  env.stdout(`${out.note(t(loc, "challenge.created.share"))}\n`);
  env.stdout(`  ${created.joinUrl}\n\n`);
  {
    // A ready-to-forward invite (owner ask 2026-08-01), in the CLI's display
    // language — this is content the USER sends onward, not CLI chrome.
    const label = seats > 2
      ? t(loc, "challenge.invite.game_multi", { game: gameLabel(loc, game), count: seats })
      : gameLabel(loc, game);
    env.stdout(`${t(loc, "challenge.invite.header")}\n`);
    env.stdout("──\n");
    env.stdout(`${t(loc, "challenge.invite.text", { game: label, url: created.joinUrl })}\n`);
    env.stdout("──\n\n");
  }
  if (game === "texas_holdem" && (playerCount === undefined || playerCount === 2)) {
    env.stdout(`${out.note(t(loc, "challenge.created.note.texas"))}\n`);
  }
  env.stdout(`${out.note(t(loc, "challenge.created.note.online"))}\n`);
  return 0;
}

// --- challenge list ---

const ACTIVE_STATUSES = new Set(["pending", "accepted", "waiting_online", "in_match"]);
const HISTORY_SHOWN = 5;

/** One human line of status. The server's states, in user words. */
function statusLabel(c: MyChallenge, loc: Locale): string {
  switch (c.status) {
    case "pending":
      if (c.maxPlayers > 2) {
        return t(loc, "challenge.status.seats", { seated: c.seatedCount ?? 1, max: c.maxPlayers });
      }
      return t(loc, c.hosted ? "challenge.status.pending.hosted" : "challenge.status.pending");
    case "accepted":
      return t(loc, c.maxPlayers > 2 ? "challenge.status.accepted.full" : "challenge.status.accepted");
    case "waiting_online":
      return t(loc, "challenge.status.waiting_online");
    case "in_match":
      return t(loc, "challenge.status.in_match");
    case "finished":
      return t(loc, "challenge.status.finished");
    case "expired":
      return t(loc, "challenge.status.expired");
    case "cancelled":
      return t(loc, "challenge.status.cancelled");
  }
  // A state this client has never heard of prints raw — same rule as
  // gameLabel: a new server-side status must never blank the row.
  return c.status;
}

/** "expires in 23h 58m" / "41 分后过期"; empty for past/invalid. */
function expiresIn(c: MyChallenge, now: Date, loc: Locale): string {
  if (c.expiresAt === undefined) return "";
  const ms = Date.parse(c.expiresAt) - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return t(loc, "challenge.row.expires", { duration: formatMinutes(loc, ms / 60_000) });
}

function challengeLine(c: MyChallenge, now: Date, loc: Locale): string {
  const opponent = c.hosted ? c.guestAgentName : c.hostAgentName;
  const who = opponent !== undefined
    ? t(loc, "challenge.row.vs", { name: opponent })
    : t(loc, c.hosted ? "challenge.row.hosted_by_you" : "challenge.row.accepted_by_you");
  const parts = [gameLabel(loc, c.game), who, statusLabel(c, loc)];
  if (ACTIVE_STATUSES.has(c.status)) {
    const left = expiresIn(c, now, loc);
    if (left !== "" && c.status !== "in_match") parts.push(left);
  }
  return parts.join(" · ");
}

async function runChallengeList(args: HandlerArgs, env: HandlerEnv): Promise<number> {
  const config = readChallengeBridgeConfig();
  let list;
  try {
    list = await listMyChallenges(config, env.fetchImpl ?? globalThis.fetch);
  } catch (cause) {
    if (cause instanceof AgentActionError) throw new CommandError(cause.code, cause.message);
    throw cause;
  }

  if (args.jsonMode) {
    env.stdout(JSON.stringify(list.raw) + "\n");
    return 0;
  }

  const now = new Date();
  const active = list.duels.filter((c) => ACTIVE_STATUSES.has(c.status));
  const history = list.duels.filter((c) => !ACTIVE_STATUSES.has(c.status));

  // This machine's own create records: lets hosted rows show their share URL
  // again (the server stores only the token digest). Records whose duel the
  // list shows as ended are dropped here — the natural sweep point.
  const local = loadCreatedChallenges();
  forgetEndedChallenges(history.map((c) => c.id).filter((id) => local[id] !== undefined));

  // P7 (U8b): section headers + a line that says what a friendly challenge IS;
  // the rows themselves keep their wording.
  const loc = env.locale?.() ?? resolveLocale();
  const out = createOutput();
  env.stdout(`${out.section(t(loc, "challenge.list.title"))}\n`);
  env.stdout(`${out.note(t(loc, "challenge.list.intro"))}\n`);

  if (active.length === 0 && history.length === 0) {
    env.stdout(`${out.note(t(loc, "challenge.list.empty"))}\n`);
    env.stdout(`${out.note(t(loc, "challenge.list.empty.hint"))}\n`);
    return 0;
  }

  if (active.length > 0) {
    env.stdout(`\n${out.section(t(loc, "challenge.list.active", { count: active.length }))}\n`);
    for (const c of active) {
      env.stdout(`  ${challengeLine(c, now, loc)}\n`);
      const rec = c.hosted ? local[c.id] : undefined;
      if (rec !== undefined && c.status !== "in_match") {
        env.stdout(`      ${rec.url}\n`);
      }
    }
    // Hosted rows created on ANOTHER machine have no local record — for those
    // the URL truly lives only in the create response.
    if (active.some((c) => c.hosted && c.status === "pending" && local[c.id] === undefined)) {
      env.stdout(`${out.note(t(loc, "challenge.list.links_local"))}\n`);
    }
  } else {
    env.stdout(`${out.note(t(loc, "challenge.list.none_active"))}\n`);
  }

  if (history.length > 0) {
    env.stdout(`\n${out.section(t(loc, "challenge.list.recent", { shown: Math.min(history.length, HISTORY_SHOWN), total: history.length }))}\n`);
    for (const c of history.slice(0, HISTORY_SHOWN)) env.stdout(`  ${challengeLine(c, now, loc)}\n`);
  }
  return 0;
}
