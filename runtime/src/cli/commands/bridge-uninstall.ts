import { readBridgeConfig, removeBridgeConfig, type BridgeConfig } from "../../bridge/config";
import { BridgeServiceError, uninstallBridgeService } from "../../bridge/service";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { UsageError, expectArity } from "../shared";

const USAGE = [
  "usage: aifight uninstall",
  "  Remove local AIFight bridge setup from this machine.",
  "  This does not delete your AIFight Agent, ratings, match history, or provider keys.",
  "  To remove the CLI package itself, run `npm uninstall -g @aifight/aifight` after local cleanup.",
].join("\n");

export async function runBridgeUninstall(
  args: HandlerArgs,
  env: HandlerEnv,
): Promise<number> {
  expectArity(args, 0, 0, USAGE);
  if (args.jsonMode || !process.stdin.isTTY) {
    throw new UsageError("aifight uninstall requires an interactive terminal", USAGE);
  }

  env.stdout([
    "This removes local AIFight bridge setup from this machine.",
    "",
    "It can remove:",
    "  - aifight.service, if installed",
    "  - local bridge credentials/config, only if you explicitly approve that destructive step",
    "",
    "It will not delete your AIFight Agent, ratings, match history, or provider keys.",
    "By default it keeps local bridge credentials so reinstalling the npm package can reuse this Agent.",
    "",
  ].join("\n"));

  const bridgeConfig = readOptionalBridgeConfig();
  if (bridgeConfig !== undefined) {
    const profile = await fetchProfileLabel(bridgeConfig, env.fetchImpl);
    env.stdout([
      `Local bridge identity: ${bridgeConfig.agentName} (${bridgeConfig.agentId})`,
      `Profile: ${profile}`,
      "",
    ].join("\n"));
  } else {
    env.stdout("No local bridge credentials were found.\n\n");
  }

  const accepted = await promptYesNoDefaultNo(env, "Continue with local uninstall? [y/N] ");
  if (!accepted) {
    env.stdout("Uninstall cancelled.\n");
    return 0;
  }

  await uninstallServiceBestEffort(env);
  await maybeRemoveBridgeIdentity(env, bridgeConfig);

  env.stdout("AIFight local uninstall finished.\n\n");
  if (bridgeConfig !== undefined) {
    env.stdout("If local bridge credentials were kept, reinstalling the npm package can reuse this Agent.\n");
    env.stdout("For a claimed Agent on a new machine, use Dashboard `Connect Bridge` to generate a pairing code.\n\n");
  }
  env.stdout("To remove the CLI package itself, run:\n  npm uninstall -g @aifight/aifight\n\n");
  return 0;
}

async function maybeRemoveBridgeIdentity(
  env: HandlerEnv,
  config: BridgeConfig | undefined,
): Promise<boolean> {
  if (config === undefined) return false;

  env.stdout([
    "",
    "Local bridge credentials are still present.",
    "Keeping them is the safe default: npm reinstall or `aifight service install` can reuse the same Agent.",
    "Deleting them removes this machine's plaintext bridge API key. Claimed Agents must be restored from Dashboard `Connect Bridge`.",
    "",
  ].join("\n"));

  const accepted = await promptYesNoDefaultNo(env, "Delete local bridge credentials too? [y/N] ");
  if (!accepted) {
    env.stdout("Kept local bridge credentials.\n");
    return false;
  }

  const suffix = config.agentId.slice(-6);
  env.stdout(`Type the last 6 characters of the Agent ID (${suffix}) to confirm credential deletion: `);
  const answer = await readLineFromStdin();
  if (answer.trim() !== suffix) {
    env.stdout("Confirmation did not match. Kept local bridge credentials.\n");
    return false;
  }

  removeBridgeConfig();
  env.stdout("Local bridge credentials removed from this machine.\n");
  return true;
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

async function fetchProfileLabel(
  config: BridgeConfig,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetchImpl(`${config.baseUrl.replace(/\/+$/, "")}/api/agents/me/status`, {
      method: "GET",
      headers: { "X-API-Key": config.apiKey },
      signal: controller.signal,
    });
    if (!response.ok) return `unknown (server returned HTTP ${response.status})`;
    const body = await response.json().catch(() => undefined) as unknown;
    if (!body || typeof body !== "object") return "unknown";
    const status = (body as Record<string, unknown>).status;
    if (status === "ready") return "claimed, ready";
    if (status === "needs_official_name") return "claimed, ready"; // retired status (older-server back-compat)
    if (status === "pending_claim") return "unclaimed";
    return "unknown";
  } catch {
    return "unknown (server check unavailable)";
  } finally {
    clearTimeout(timer);
  }
}

async function readLineFromStdin(): Promise<string> {
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  const answer = await new Promise<string>((resolve) => {
    process.stdin.once("data", (chunk) => resolve(String(chunk)));
  });
  process.stdin.pause();
  return answer;
}

async function promptYesNoDefaultNo(env: HandlerEnv, question: string): Promise<boolean> {
  env.stdout(question);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  const answer = await new Promise<string>((resolve) => {
    process.stdin.once("data", (chunk) => resolve(String(chunk)));
  });
  process.stdin.pause();
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

async function uninstallServiceBestEffort(env: HandlerEnv): Promise<void> {
  try {
    const target = await uninstallBridgeService(env.bridgeService);
    env.stdout(`aifight.service removed if it existed (${target.platform}).\n`);
  } catch (e) {
    const message = e instanceof BridgeServiceError ? e.message : e instanceof Error ? e.message : String(e);
    env.stderr(`warning: could not uninstall aifight.service automatically: ${message}\n`);
    env.stderr("If you installed it, run `aifight service uninstall` manually before removing the npm package.\n");
  }
}
