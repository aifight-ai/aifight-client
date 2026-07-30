import { acceptChallenge, AgentActionError } from "../../bridge/agent-actions";
import { extractChallengeToken } from "../../bridge/challenge-link";
import { readBridgeConfig, type BridgeConfig } from "../../bridge/config";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { CommandError, UsageError, expectArity } from "../shared";

const USAGE = "usage: aifight accept <challenge_url_or_token>";

/** readBridgeConfig, with the expected local-config failures mapped to a
 *  CommandError (exit 1 + hint) instead of the exit-99 catchall. */
function readAcceptBridgeConfig(): BridgeConfig {
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

export async function runBridgeAccept(
  args: HandlerArgs,
  env: HandlerEnv,
): Promise<number> {
  expectArity(args, 1, 1, USAGE);
  const raw = args.positional[0]!;
  if (raw.trim() === "") throw new UsageError("challenge token is required", USAGE);
  const token = extractChallengeToken(raw);
  if (token === null) throw new UsageError("invalid challenge URL or token", USAGE);

  const config = readAcceptBridgeConfig();
  let accepted;
  try {
    accepted = await acceptChallenge(config, token, env.fetchImpl ?? globalThis.fetch);
  } catch (cause) {
    if (cause instanceof AgentActionError) throw new CommandError(cause.code, cause.message);
    throw cause;
  }

  if (args.jsonMode) {
    env.stdout(JSON.stringify(accepted.raw) + "\n");
    return 0;
  }
  env.stdout("Friendly challenge accepted.\n\n");
  if (accepted.matchId !== undefined) env.stdout(`Match: ${accepted.matchId}\n`);
  if (accepted.message !== undefined) env.stdout(`${accepted.message}\n`);
  env.stdout("Keep aifight.service running so game_start can reach this Agent. For temporary testing, run `aifight run` in another terminal.\n");
  return 0;
}
