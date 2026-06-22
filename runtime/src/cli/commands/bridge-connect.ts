import {
  readBridgeConfig,
  redactBridgeConfig,
  writeBridgeConfig,
  type BridgeConfig,
} from "../../bridge/config";
import { exchangePairingCode } from "../../bridge/pairing";
import { getDeviceId } from "../../account/device-id";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { CommandError, expectArity } from "../shared";

const USAGE = [
  "usage: aifight connect <PAIRING_CODE> [--replace-local-identity]",
  "  Authorize this machine for an existing claimed Agent using a Dashboard pairing code.",
  "  --replace-local-identity confirms that an existing local bridge identity may be replaced.",
].join("\n");

export async function runBridgeConnect(
  args: HandlerArgs,
  env: HandlerEnv,
): Promise<number> {
  expectArity(args, 1, 1, USAGE);
  const pairingCode = args.positional[0]!;
  const existing = readOptionalBridgeConfig();
  const replaceLocalIdentity = args.flags["replace-local-identity"] === true;
  if (existing !== undefined && !replaceLocalIdentity) {
    throw new CommandError(
      "local_identity_exists",
      [
        `This machine already has local AIFight bridge credentials for ${existing.agentName} (${existing.agentId}).`,
        "A pairing code rotates an Agent API key and replaces local bridge credentials.",
        "To avoid consuming a one-time pairing code by accident, this command is blocked until you approve local identity replacement.",
        "If you are intentionally reconnecting this machine from Dashboard, rerun:",
        `  aifight connect ${pairingCode} --replace-local-identity`,
      ].join("\n"),
    );
  }
  let config: BridgeConfig;
  try {
    config = await exchangePairingCode({
      pairingCode,
      fetchImpl: env.fetchImpl,
      deviceId: getDeviceId(),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new CommandError("pairing_failed", message);
  }
  writeBridgeConfig(config);

  if (args.jsonMode) {
    env.stdout(JSON.stringify({ status: "configured", config: redactBridgeConfig(config) }) + "\n");
    return 0;
  }

  if (existing !== undefined) {
    env.stdout(`Replaced local bridge identity ${existing.agentName} (${existing.agentId}).\n`);
  }
  env.stdout(`Bridge configured for ${config.agentName}.\n`);
  env.stdout("This machine is now the only one that can control this Agent; any previously paired machine has been signed out.\n");
  env.stdout("Next: run `aifight config` to set your LLM key on this machine, then `aifight service install`.\n");
  return 0;
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
