import { BridgeServiceError, installBridgeService, restartBridgeService, startBridgeService, statusBridgeService, stopBridgeService, uninstallBridgeService } from "../../bridge/service";
import { readBridgeConfig } from "../../bridge/config";
import { resolveLocale, t } from "../i18n";
import { createOutput } from "../output";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { UsageError, expectArity } from "../shared";
import { bindConfirm, type ConfirmFn } from "./onboard-io";

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
          return 0;
        }
        // P7 (U8b): the plainest block in the panel — two bare `label: value`
        // lines with no title and nothing saying what the service is FOR.
        const loc = env.locale?.() ?? resolveLocale();
        const out = createOutput();
        env.stdout(`${out.section(t(loc, "service.status.title"))}\n`);
        if (!status.installed) {
          env.stdout(`${out.kv(t(loc, "service.status.label.state"), t(loc, "service.status.not_installed"), { tone: "yellow" })}\n`);
          env.stdout(`${out.note(t(loc, "service.status.note"))}\n`);
          env.stdout(`${out.note(t(loc, "service.status.note.install"))}\n`);
          return 0;
        }
        for (const line of out.kvRows([
          [
            t(loc, "service.status.label.state"),
            status.running ? t(loc, "service.status.running") : t(loc, "service.status.stopped"),
            status.running ? "green" : "yellow",
          ],
          [t(loc, "service.status.label.detail"), status.detail, "dim"],
          [t(loc, "service.status.label.unit"), status.unitPath, "dim"],
        ])) {
          env.stdout(`${line}\n`);
        }
        env.stdout(`${out.note(t(loc, "service.status.note"))}\n`);
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
  opts: {
    readonly approvedLocalSetup?: boolean;
    /** P4 test seam (批 U4): supplying one also stands in for the terminal. */
    readonly confirm?: ConfirmFn;
  } = {},
): Promise<"installed" | "declined" | "unavailable"> {
  const ask = opts.confirm ?? bindConfirm(env);
  const interactive = opts.confirm !== undefined || process.stdin.isTTY === true;
  if (!interactive && opts.approvedLocalSetup !== true) return "unavailable";
  const loc = env.locale?.() ?? resolveLocale();
  const out = createOutput();
  const existing = await currentServiceStatus(env);
  if (existing?.installed && existing.running === true) {
    env.stdout([
      t(loc, "wizard.service.running1"),
      t(loc, "wizard.service.running2"),
      "",
    ].join("\n"));
    // P4: the shared yes/no, default YES — the credentials are already saved
    // and the service must reload them before the Agent shows up online.
    const accepted = opts.approvedLocalSetup === true
      ? true
      : await ask(t(loc, "confirm.service.restart.ask"), true);
    if (!accepted) return "declined";
    if (opts.approvedLocalSetup === true) {
      env.stdout(`${t(loc, "wizard.service.approved.restart")}\n`);
    }
    try {
      const result = await restartBridgeService(env.bridgeService);
      env.stdout(`${t(loc, "wizard.service.restarted", { platform: result.platform })}\n`);
      env.stdout(`${t(loc, "wizard.service.unit", { path: result.unitPath })}\n`);
      return "installed";
    } catch (e) {
      // P6: red `✗` headline, the service manager's own hint plain underneath.
      const message = e instanceof BridgeServiceError ? e.message : (e as Error).message;
      const hint = e instanceof BridgeServiceError ? e.hint : undefined;
      env.stderr(out.fail(t(loc, "confirm.service.restart.failed", { error: message }), hint));
      return "unavailable";
    }
  }

  env.stdout([
    t(loc, "wizard.service.offer1"),
    "",
    t(loc, "wizard.service.offer2"),
    t(loc, "wizard.service.offer3"),
    "",
    t(loc, "wizard.service.offer4"),
    t(loc, "wizard.service.offer5"),
    "",
    t(loc, "wizard.service.offer6"),
    "",
  ].join("\n"));
  // P4, default YES: the banner above has just made the case for installing it.
  const accepted = opts.approvedLocalSetup === true
    ? true
    : await ask(t(loc, "confirm.service.install.ask"), true);
  if (!accepted) return "declined";
  if (opts.approvedLocalSetup === true) {
    env.stdout(`${t(loc, "wizard.service.approved.install")}\n`);
  }
  try {
    const result = await installBridgeService(env.bridgeService);
    env.stdout(`${t(loc, "wizard.service.installed", { platform: result.platform })}\n`);
    env.stdout(`${t(loc, "wizard.service.unit", { path: result.unitPath })}\n`);
    if (result.warning) env.stderr(`${t(loc, "wizard.service.warning", { warning: result.warning })}\n`);
    return "installed";
  } catch (e) {
    // P6 — same shape as the restart failure above.
    const message = e instanceof BridgeServiceError ? e.message : (e as Error).message;
    const hint = e instanceof BridgeServiceError ? e.hint : undefined;
    env.stderr(out.fail(t(loc, "confirm.service.install.failed", { error: message }), hint));
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
