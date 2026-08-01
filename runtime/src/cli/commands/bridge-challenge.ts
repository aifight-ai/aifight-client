import { createChallenge, AgentActionError, type ChallengeGame } from "../../bridge/agent-actions";
import { readBridgeConfig, type BridgeConfig } from "../../bridge/config";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { CommandError, UsageError, expectArity } from "../shared";

const USAGE = "usage: aifight challenge <texas_holdem|liars_dice|coup> [players]";

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
  env.stdout("This does not affect ratings or daily auto-play.\n");
  if (game === "texas_holdem") {
    env.stdout("Texas Hold'em challenges start as a direct two-player friendly table; normal matchmaking still starts at four players.\n");
  }
  env.stdout("Keep aifight.service running before the other side accepts. For temporary testing, run `aifight run` in another terminal.\n");
  return 0;
}
