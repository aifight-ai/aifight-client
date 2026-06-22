import { BridgeServiceError, installBridgeService, restartBridgeService, startBridgeService, statusBridgeService, stopBridgeService, uninstallBridgeService } from "../../bridge/service";
import { readBridgeConfig } from "../../bridge/config";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { UsageError, expectArity } from "../shared";

const USAGE = [
  "usage: aifight service <install|status|start|stop|restart|uninstall>",
  "       aifight service install [--aifight-path <path>]",
  "  Manage the local background service named aifight.service.",
  "  The service runs `aifight run` so this Agent comes back online after reboot.",
  "  --aifight-path is an advanced install-only override for the CLI binary path.",
].join("\n");

export async function runBridgeService(
  args: HandlerArgs,
  env: HandlerEnv,
): Promise<number> {
  expectArity(args, 1, 1, USAGE);
  const sub = args.positional[0]!;
  const explicitAifightPath = stringFlag(args, "aifight-path");
  if (explicitAifightPath !== undefined && sub !== "install") {
    throw new UsageError("--aifight-path is only supported with `aifight service install`", USAGE);
  }

  try {
    switch (sub) {
      case "install": {
        readBridgeConfig();
        const serviceDeps = explicitAifightPath === undefined
          ? env.bridgeService
          : { ...(env.bridgeService ?? {}), aifightExec: explicitAifightPath };
        const result = await installBridgeService(serviceDeps);
        if (args.jsonMode) {
          env.stdout(JSON.stringify({ status: "installed", result }) + "\n");
        } else {
          env.stdout(`aifight.service installed and started (${result.platform}).\n`);
          env.stdout(`unit: ${result.unitPath}\n`);
          if (result.warning) env.stderr(`warning: ${result.warning}\n`);
        }
        return 0;
      }
      case "status": {
        const status = await statusBridgeService(env.bridgeService);
        if (args.jsonMode) {
          env.stdout(JSON.stringify(status) + "\n");
        } else if (!status.installed) {
          env.stdout("aifight.service: not installed\n");
          env.stdout("run: aifight service install\n");
        } else {
          env.stdout(`aifight.service: ${status.running ? "running" : "stopped"} (${status.detail})\n`);
          env.stdout(`unit: ${status.unitPath}\n`);
        }
        return 0;
      }
      case "start": {
        const target = await startBridgeService(env.bridgeService);
        env.stdout(`aifight.service started (${target.platform}).\n`);
        return 0;
      }
      case "stop": {
        const target = await stopBridgeService(env.bridgeService);
        env.stdout(`aifight.service stopped (${target.platform}).\n`);
        return 0;
      }
      case "restart": {
        const target = await restartBridgeService(env.bridgeService);
        env.stdout(`aifight.service restarted (${target.platform}).\n`);
        return 0;
      }
      case "uninstall": {
        const target = await uninstallBridgeService(env.bridgeService);
        env.stdout(`aifight.service uninstalled (${target.platform}).\n`);
        return 0;
      }
      default:
        throw new UsageError(`unknown service command '${sub}'`, USAGE);
    }
  } catch (e) {
    if (e instanceof UsageError) throw e;
    if (e instanceof BridgeServiceError) {
      if (args.jsonMode) {
        env.stderr(JSON.stringify({ error: { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) } }) + "\n");
      } else {
        env.stderr(`aifight: ${e.message}\n`);
        if (e.hint) env.stderr(`${e.hint}\n`);
      }
      return e.code === "service_platform_unsupported" || e.code === "service_manager_unavailable" ? 2 : 1;
    }
    const message = e instanceof Error ? e.message : String(e);
    if (args.jsonMode) {
      env.stderr(JSON.stringify({ error: { code: "service_command_failed", message } }) + "\n");
    } else {
      env.stderr(`aifight: service command failed: ${message}\n`);
    }
    return 1;
  }
}

function stringFlag(args: HandlerArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

export async function offerBridgeServiceInstall(
  env: HandlerEnv,
  opts: { readonly approvedLocalSetup?: boolean } = {},
): Promise<"installed" | "declined" | "unavailable"> {
  if (!process.stdin.isTTY && opts.approvedLocalSetup !== true) return "unavailable";
  const existing = await currentServiceStatus(env);
  if (existing?.installed && existing.running === true) {
    env.stdout([
      "aifight.service is already running.",
      "AIFight just saved bridge credentials, so the service must reload them before the Dashboard can show the new Agent online.",
      "",
    ].join("\n"));
    const accepted = opts.approvedLocalSetup === true
      ? true
      : await promptYesNo(
        env,
        "Restart aifight.service now? [Y/n] ",
      );
    if (!accepted) return "declined";
    if (opts.approvedLocalSetup === true) {
      env.stdout("Using the previously approved AIFight local setup scope; restarting aifight.service now.\n");
    }
    try {
      const result = await restartBridgeService(env.bridgeService);
      env.stdout(`aifight.service restarted (${result.platform}).\n`);
      env.stdout(`unit: ${result.unitPath}\n`);
      return "installed";
    } catch (e) {
      const message = e instanceof BridgeServiceError ? e.message : (e as Error).message;
      const hint = e instanceof BridgeServiceError ? e.hint : undefined;
      env.stderr(`aifight.service could not be restarted: ${message}\n`);
      if (hint) env.stderr(`${hint}\n`);
      return "unavailable";
    }
  }

  env.stdout([
    "AIFight needs a long-running local Bridge before your Agent can play scheduled matches and challenges.",
    "",
    "I can install a local background service named aifight.service.",
    "It runs `aifight run` after reboot and keeps the outbound Bridge online for normal use.",
    "",
    "This does not expose your machine to the public internet.",
    "AIFight Bridge only opens an outbound WebSocket to AIFight and calls your local Agent runtime on localhost.",
    "",
    "If you do not install it now, finish setup later with `aifight service install` or manage `aifight run` yourself.",
    "",
  ].join("\n"));
  const accepted = opts.approvedLocalSetup === true
    ? true
    : await promptYesNo(
      env,
      "Install and start aifight.service now? [Y/n] ",
    );
  if (!accepted) return "declined";
  if (opts.approvedLocalSetup === true) {
    env.stdout("Using the previously approved AIFight local setup scope; installing aifight.service now.\n");
  }
  try {
    const result = await installBridgeService(env.bridgeService);
    env.stdout(`aifight.service installed and started (${result.platform}).\n`);
    env.stdout(`unit: ${result.unitPath}\n`);
    if (result.warning) env.stderr(`warning: ${result.warning}\n`);
    return "installed";
  } catch (e) {
    const message = e instanceof BridgeServiceError ? e.message : (e as Error).message;
    const hint = e instanceof BridgeServiceError ? e.hint : undefined;
    env.stderr(`aifight.service could not be installed: ${message}\n`);
    if (hint) env.stderr(`${hint}\n`);
    return "unavailable";
  }
}

async function currentServiceStatus(env: HandlerEnv) {
  try {
    return await statusBridgeService(env.bridgeService);
  } catch {
    return undefined;
  }
}

async function promptYesNo(env: HandlerEnv, question: string): Promise<boolean> {
  env.stdout(question);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  const answer = await new Promise<string>((resolve) => {
    process.stdin.once("data", (chunk) => resolve(String(chunk)));
  });
  process.stdin.pause();
  const normalized = answer.trim().toLowerCase();
  return normalized === "" || normalized === "y" || normalized === "yes";
}
