import { readBridgeConfig, removeBridgeConfig, type BridgeConfig } from "../../bridge/config";
import { BridgeServiceError, uninstallBridgeService } from "../../bridge/service";
import { fetchNoFollow } from "../../net/guarded-fetch.js";
import { createStatusIcons } from "../ansi";
import { resolveLocale, t, type Locale } from "../i18n";
import { createOutput } from "../output";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { UsageError, expectArity } from "../shared";
import { bindConfirm, bindPromptLine, type ConfirmFn, type PromptLineFn } from "./onboard-io";

/** P4/P3 test seams (批 U4). Supplying either also stands in for the
 *  terminal, so both branches of every confirmation are unit-testable;
 *  production passes nothing and keeps the real isTTY gate. */
export interface UninstallIO {
  readonly confirm?: ConfirmFn;
  readonly promptLine?: PromptLineFn;
}

const USAGE = [
  "usage: aifight uninstall",
  "  Remove local AIFight bridge setup from this machine.",
  "  This does not delete your AIFight Agent, ratings, match history, or provider keys.",
  "  To remove the CLI package itself, run `npm uninstall -g @aifight/aifight` after local cleanup.",
].join("\n");

export async function runBridgeUninstall(
  args: HandlerArgs,
  env: HandlerEnv,
  io: UninstallIO = {},
): Promise<number> {
  expectArity(args, 0, 0, USAGE);
  const seamed = io.confirm !== undefined || io.promptLine !== undefined;
  if (args.jsonMode || (!seamed && !process.stdin.isTTY)) {
    throw new UsageError("aifight uninstall requires an interactive terminal", USAGE);
  }
  const loc = env.locale?.() ?? resolveLocale();
  const confirm = io.confirm ?? bindConfirm(env);

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

  // P4, default NO: uninstall is destructive, so a bare Enter must not run it.
  const accepted = await confirm(t(loc, "confirm.uninstall.ask"), false);
  if (!accepted) {
    env.stdout(`${t(loc, "confirm.uninstall.declined")}\n`);
    return 0;
  }

  await uninstallServiceBestEffort(env, loc);
  await maybeRemoveBridgeIdentity(env, bridgeConfig, loc, confirm, io.promptLine ?? bindPromptLine(env));

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
  loc: Locale,
  confirm: ConfirmFn,
  promptLine: PromptLineFn,
): Promise<boolean> {
  if (config === undefined) return false;

  env.stdout([
    "",
    "Local bridge credentials are still present.",
    "Keeping them is the safe default: npm reinstall or `aifight service install` can reuse the same Agent.",
    "Deleting them removes this machine's plaintext bridge API key. Claimed Agents must be restored from Dashboard `Connect Bridge`.",
    "",
  ].join("\n"));

  // P4, default NO — this deletes the machine's only copy of the bridge key.
  const accepted = await confirm(t(loc, "confirm.uninstall.credentials.ask"), false);
  if (!accepted) {
    env.stdout(`${t(loc, "confirm.uninstall.credentials.declined")}\n`);
    return false;
  }

  // The typed second confirmation stays exactly as strict as it was — U4 only
  // restyles it (i18n + P6 on a mismatch); a yes/no would not be enough here.
  const suffix = config.agentId.slice(-6);
  const answer = await promptLine(`${t(loc, "confirm.uninstall.credentials.verify", { suffix })}: `);
  if (answer.trim() !== suffix) {
    env.stdout(createOutput().fail(
      t(loc, "confirm.uninstall.credentials.mismatch"),
      t(loc, "confirm.uninstall.credentials.declined"),
    ));
    return false;
  }

  removeBridgeConfig();
  env.stdout(`${(env.statusIcons ?? createStatusIcons()).ok} ${t(loc, "confirm.uninstall.credentials.removed")}\n`);
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
    const response = await fetchNoFollow(`${config.baseUrl.replace(/\/+$/, "")}/api/agents/me/status`, {
      method: "GET",
      headers: { "X-API-Key": config.apiKey },
      signal: controller.signal,
    }, { fetchImpl });
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

async function uninstallServiceBestEffort(env: HandlerEnv, loc: Locale): Promise<void> {
  try {
    const target = await uninstallBridgeService(env.bridgeService);
    env.stdout(`aifight.service removed if it existed (${target.platform}).\n`);
  } catch (e) {
    // P6: the whole command is TTY-only, so this failure is on the interactive
    // path — red `✗` + the one line that says what WOULD work.
    const message = e instanceof BridgeServiceError ? e.message : e instanceof Error ? e.message : String(e);
    env.stderr(createOutput().fail(
      t(loc, "confirm.uninstall.service.failed", { error: message }),
      t(loc, "confirm.uninstall.service.failed.tail"),
    ));
  }
}
