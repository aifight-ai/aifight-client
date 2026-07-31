import { formatPublicNo } from "../../account/public-no";
import { renameAgent, AgentActionError } from "../../bridge/agent-actions";
import { readBridgeConfig, writeBridgeConfig, type BridgeConfig } from "../../bridge/config";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { CommandError, UsageError } from "../shared";
import { resolveLocale, t } from "../i18n";
import { applyPendingBridgeRestart, bridgeRestartPending } from "./apply-settings";
import { promptDefault } from "./onboard-io";

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
  let name = (fromFlag ?? args.positional.join(" ")).trim();
  if (name === "") {
    // Bare `aifight rename` on a terminal: ASK instead of erroring, showing
    // the current name as the default — Enter keeps it, q/Esc cancels
    // (3x-ui habit, owner ask 2026-07-30). Scripts keep the usage error.
    if (
      fromFlag === undefined &&
      args.positional.length === 0 &&
      !args.jsonMode &&
      process.stdin.isTTY === true
    ) {
      const prompted = await promptPublicName(env);
      if (prompted === undefined) return 0; // kept or cancelled — already said so
      name = prompted;
    } else {
      throw new UsageError("a new display name is required", USAGE);
    }
  }

  const config = readRenameBridgeConfig();
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
    env.stdout(JSON.stringify({
      status: "ok",
      name: renamed.name,
      public_no: renamed.publicNo ?? null,
      restartPending: bridgeRestartPending(),
    }) + "\n");
    return 0;
  }
  const idLabel = renamed.publicNo !== undefined ? `  (ID ${formatPublicNo(renamed.publicNo)})` : "";
  env.stdout(`Display name set to: ${renamed.name}${idLabel}\n`);
  env.stdout("Synced to the AIFight platform and your dashboard.\n");
  // The running bridge routes control commands by the agent name it read at
  // startup, so after a rename it answers to the OLD name only — `aifight start`
  // (which POSTs the new name) would 404 until it restarts. Offer that restart
  // here, like every other setting write does.
  await applyPendingBridgeRestart(env, { jsonMode: args.jsonMode });
  return 0;
}

/** Test seam: bare `aifight rename`'s interactive flow, line reader injected. */
export async function runRenameInteractive(
  env: HandlerEnv,
  readLine: (env: HandlerEnv, question: string) => Promise<string>,
): Promise<string | undefined> {
  return promptPublicName(env, readLine);
}

/** The interactive half of bare `aifight rename`: `Public name [current]: ` —
 *  Enter keeps the current name, q/Esc cancels; anything else is handed back
 *  to the normal rename flow. undefined = nothing to change. */
async function promptPublicName(
  env: HandlerEnv,
  readLine?: (env: HandlerEnv, question: string) => Promise<string>,
): Promise<string | undefined> {
  const loc = env.locale?.() ?? resolveLocale();
  const config = readRenameBridgeConfig();
  const answer = await promptDefault(env, t(loc, "prompt.rename.question"), config.agentName, readLine);
  if (answer.kind === "cancel") {
    env.stdout(`${t(loc, "prompt.cancel")}\n`);
    return undefined;
  }
  if (answer.kind === "keep") {
    env.stdout(`${t(loc, "prompt.keep", { value: config.agentName })}\n`);
    return undefined;
  }
  return answer.value;
}

/** readBridgeConfig, with the expected local-config failures mapped to a
 *  CommandError (exit 1 + hint) instead of the exit-99 catchall. */
function readRenameBridgeConfig(): BridgeConfig {
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
