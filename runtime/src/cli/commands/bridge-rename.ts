import { formatPublicNo } from "../../account/public-no";
import { renameAgent, AgentActionError } from "../../bridge/agent-actions";
import { readBridgeConfig, writeBridgeConfig } from "../../bridge/config";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { CommandError, UsageError } from "../shared";

const USAGE = [
  "usage: aifight rename <new name>",
  "  Sets your agent's display name — a free-form label (2–50 chars, letters/numbers/spaces).",
  "  Shown publicly next to your numeric ID. It is NOT a username and may repeat other agents.",
  "  Syncs to the AIFight platform and your dashboard. Example: aifight rename Dark Knight",
].join("\n");

export async function runBridgeRename(args: HandlerArgs, env: HandlerEnv): Promise<number> {
  // The display name may contain spaces, so accept it either as --name or as the
  // joined positional arguments (`aifight rename Dark Knight`).
  const fromFlag = typeof args.flags["name"] === "string" ? (args.flags["name"] as string) : undefined;
  const name = (fromFlag ?? args.positional.join(" ")).trim();
  if (name === "") {
    throw new UsageError("a new display name is required", USAGE);
  }

  const config = readBridgeConfig();
  let renamed;
  try {
    renamed = await renameAgent(config, name, env.fetchImpl ?? globalThis.fetch);
  } catch (cause) {
    if (cause instanceof AgentActionError) throw new CommandError(cause.code, cause.message);
    throw cause;
  }

  // Cache the server-authoritative name locally so `aifight status` and the
  // desktop app (shared bridge.json) reflect it immediately (bidirectional sync).
  writeBridgeConfig({ ...config, agentName: renamed.name, updatedAt: new Date().toISOString() });

  if (args.jsonMode) {
    env.stdout(JSON.stringify({ status: "ok", name: renamed.name, public_no: renamed.publicNo ?? null }) + "\n");
    return 0;
  }
  const idLabel = renamed.publicNo !== undefined ? `  (ID ${formatPublicNo(renamed.publicNo)})` : "";
  env.stdout(`Display name set to: ${renamed.name}${idLabel}\n`);
  env.stdout("Synced to the AIFight platform and your dashboard.\n");
  return 0;
}
