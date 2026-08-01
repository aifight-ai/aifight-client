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
import { resolveLocale, t } from "../i18n";
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
  env.stdout("Friendly challenge created.\n\n");
  env.stdout(`Game: ${game}\n`);
  if (playerCount !== undefined && playerCount > 2) {
    env.stdout(`Table size: ${playerCount} players (starts automatically when every seat is claimed)\n`);
  }
  env.stdout("Rating impact: none\n");
  if (playerCount !== undefined && playerCount > 2) {
    env.stdout(`Accepts: ${playerCount - 1} (one per open seat)\n\n`);
  } else {
    env.stdout("Accepts: 1 (accepted once)\n\n");
  }
  env.stdout("Share this URL:\n");
  env.stdout(`${created.joinUrl}\n\n`);
  {
    // A ready-to-forward invite (owner ask 2026-08-01), in the CLI's display
    // language — this is content the USER sends onward, not CLI chrome.
    const loc = resolveLocale();
    const count = playerCount ?? (game === "coup" ? 3 : 2);
    const label = count > 2
      ? t(loc, "challenge.invite.game_multi", { game: gameLabel(game), count })
      : gameLabel(game);
    env.stdout(`${t(loc, "challenge.invite.header")}\n`);
    env.stdout("──\n");
    env.stdout(`${t(loc, "challenge.invite.text", { game: label, url: created.joinUrl })}\n`);
    env.stdout("──\n\n");
  }
  env.stdout("This does not affect ratings or daily auto-play.\n");
  if (game === "texas_holdem" && (playerCount === undefined || playerCount === 2)) {
    env.stdout("Texas Hold'em challenges start as a direct two-player friendly table; normal matchmaking still starts at four players.\n");
  }
  env.stdout("Keep aifight.service running before the other side accepts. For temporary testing, run `aifight run` in another terminal.\n");
  return 0;
}

// --- challenge list ---

const ACTIVE_STATUSES = new Set(["pending", "accepted", "waiting_online", "in_match"]);
const HISTORY_SHOWN = 5;

function gameLabel(game: string): string {
  switch (game) {
    case "texas_holdem": return "Texas Hold'em";
    case "liars_dice": return "Liar's Dice";
    case "coup": return "Coup";
  }
  return game;
}

/** One human line of status. The server's states, in user words. */
function statusLabel(c: MyChallenge): string {
  switch (c.status) {
    case "pending":
      if (c.maxPlayers > 2) {
        return `${c.seatedCount ?? 1} of ${c.maxPlayers} seats taken`;
      }
      return c.hosted ? "waiting for an opponent to accept" : "waiting";
    case "accepted":
      return c.maxPlayers > 2 ? "table full — starting when everyone is online" : "accepted — starting";
    case "waiting_online":
      return "waiting for both sides to be online";
    case "in_match":
      return "playing now";
    case "finished":
      return "finished";
    case "expired":
      return "expired";
    case "cancelled":
      return "cancelled";
  }
  return c.status;
}

/** "23h 58m" / "41m" until expiry; empty for past/invalid. */
function expiresIn(c: MyChallenge, now: Date): string {
  if (c.expiresAt === undefined) return "";
  const ms = Date.parse(c.expiresAt) - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const mins = Math.floor(ms / 60_000);
  const h = Math.floor(mins / 60);
  return h > 0 ? `expires in ${h}h ${mins % 60}m` : `expires in ${mins}m`;
}

function challengeLine(c: MyChallenge, now: Date): string {
  const who = c.hosted
    ? (c.guestAgentName !== undefined ? `vs ${c.guestAgentName}` : "hosted by you")
    : (c.hostAgentName !== undefined ? `vs ${c.hostAgentName}` : "accepted by you");
  const parts = [gameLabel(c.game), who, statusLabel(c)];
  if (ACTIVE_STATUSES.has(c.status)) {
    const left = expiresIn(c, now);
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

  if (active.length === 0 && history.length === 0) {
    env.stdout("No friendly challenges yet.\n");
    env.stdout("Create one with `aifight challenge <game> [players]`, or accept one with `aifight accept <url>`.\n");
    return 0;
  }

  if (active.length > 0) {
    env.stdout(`Active challenges (${active.length}):\n`);
    for (const c of active) {
      env.stdout(`  ${challengeLine(c, now)}\n`);
      const rec = c.hosted ? local[c.id] : undefined;
      if (rec !== undefined && c.status !== "in_match") {
        env.stdout(`      ${rec.url}\n`);
      }
    }
    // Hosted rows created on ANOTHER machine have no local record — for those
    // the URL truly lives only in the create response.
    if (active.some((c) => c.hosted && c.status === "pending" && local[c.id] === undefined)) {
      env.stdout("Links are stored on the machine that created the challenge; one created elsewhere expires with its link (24h).\n");
    }
  } else {
    env.stdout("No active challenges.\n");
  }

  if (history.length > 0) {
    env.stdout(`\nRecent (${Math.min(history.length, HISTORY_SHOWN)} of ${history.length}):\n`);
    for (const c of history.slice(0, HISTORY_SHOWN)) env.stdout(`  ${challengeLine(c, now)}\n`);
  }
  return 0;
}
