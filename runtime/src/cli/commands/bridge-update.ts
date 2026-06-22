import { performBridgePackageUpdate } from "../../bridge/auto-update";
import { readBridgeConfig } from "../../bridge/config";
import {
  BridgeServiceError,
  restartBridgeService,
  statusBridgeService,
} from "../../bridge/service";
import { checkBridgeUpdate } from "../../bridge/update-check";
import { RUNTIME_VERSION } from "../../index";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { CommandError, expectArity } from "../shared";

const USAGE = [
  "usage: aifight update [--yes]",
  "  Update the AIFight CLI package from npm, then restart aifight.service if it is installed.",
  "  Use --yes only after the human has approved the local AIFight package update.",
].join("\n");

const DEFAULT_BASE_URL = "https://aifight.ai";
const UPDATE_PACKAGE = "@aifight/aifight@alpha";

export async function runBridgeUpdate(
  args: HandlerArgs,
  env: HandlerEnv,
): Promise<number> {
  expectArity(args, 0, 0, USAGE);
  const approved = args.flags.yes === true;
  const update = await checkBridgeUpdate({
    baseUrl: updateBaseUrl(),
    currentVersion: RUNTIME_VERSION,
    fetchImpl: env.fetchImpl,
  });

  if (update.status === "current") {
    if (args.jsonMode) {
      env.stdout(JSON.stringify({ status: "current", update }) + "\n");
    } else {
      env.stdout(`${update.message}\n`);
      env.stdout("No npm update is required.\n");
    }
    return 0;
  }

  if (!approved && args.jsonMode) {
    throw new CommandError(
      "update_confirmation_required",
      "AIFight CLI update requires explicit confirmation.",
      { hint: "Run `aifight update --yes` after the human approves the npm package update." },
    );
  }

  if (!args.jsonMode) {
    env.stdout(`${update.message}\n`);
    if (update.policy !== undefined) {
      env.stdout(`Latest: ${update.policy.latestVersion}\n`);
      env.stdout(`Update package: ${UPDATE_PACKAGE}\n`);
    }
  }

  if (!approved) {
    if (!process.stdin.isTTY) {
      env.stderr("aifight: update requires confirmation in non-interactive mode.\n");
      env.stderr("Run `aifight update --yes` after the human approves the local package update.\n");
      return 1;
    }
    const accepted = await promptYesNoDefaultNo(env, "Run npm update now? [y/N] ");
    if (!accepted) {
      env.stdout("Update skipped.\n");
      return 0;
    }
  }

  await runNpmUpdate(env, args.jsonMode);
  const service = await restartInstalledService(env, args.jsonMode);

  if (args.jsonMode) {
    env.stdout(JSON.stringify({
      status: "updated",
      package: UPDATE_PACKAGE,
      service,
    }) + "\n");
  }
  return 0;
}

function updateBaseUrl(): string {
  try {
    return readBridgeConfig().baseUrl;
  } catch {
    return process.env.AIFIGHT_BASE_URL?.replace(/\/+$/, "") ?? DEFAULT_BASE_URL;
  }
}

async function runNpmUpdate(env: HandlerEnv, jsonMode: boolean): Promise<void> {
  if (!jsonMode) {
    env.stdout(`Updating AIFight CLI: npm install -g ${UPDATE_PACKAGE}\n`);
  }
  try {
    await performBridgePackageUpdate({ execFile: env.bridgeService?.execFile });
  } catch (cause) {
    throw new CommandError(
      "update_failed",
      `npm update failed: ${firstErrorLine(cause)}`,
      { hint: `Run manually: npm install -g ${UPDATE_PACKAGE}` },
    );
  }
  if (!jsonMode) {
    env.stdout("AIFight CLI package updated.\n");
  }
}

async function restartInstalledService(
  env: HandlerEnv,
  jsonMode: boolean,
): Promise<
  | { readonly installed: false }
  | { readonly installed: true; readonly restarted: boolean; readonly running: boolean | null; readonly detail: string }
> {
  let status: Awaited<ReturnType<typeof statusBridgeService>>;
  try {
    status = await statusBridgeService(env.bridgeService);
  } catch (cause) {
    if (!jsonMode) {
      env.stderr(`warning: could not inspect aifight.service: ${firstErrorLine(cause)}\n`);
      env.stderr("If you use a foreground Bridge, stop it and run `aifight run` again.\n");
    }
    return { installed: false };
  }

  if (!status.installed) {
    if (!jsonMode) {
      env.stdout("aifight.service is not installed. If you use a foreground Bridge, stop it and run `aifight run` again.\n");
    }
    return { installed: false };
  }

  if (status.running !== true) {
    if (!jsonMode) {
      env.stdout("aifight.service is installed but not running. Start it with `aifight service start` when ready.\n");
    }
    return {
      installed: true,
      restarted: false,
      running: status.running,
      detail: status.detail,
    };
  }

  if (!jsonMode) {
    env.stdout("Restarting aifight.service so it uses the updated CLI.\n");
  }
  try {
    await restartBridgeService(env.bridgeService);
  } catch (cause) {
    const hint = cause instanceof BridgeServiceError ? cause.hint : undefined;
    if (!jsonMode) {
      env.stderr(`warning: aifight.service restart failed: ${firstErrorLine(cause)}\n`);
      if (hint) env.stderr(`${hint}\n`);
      env.stderr("Run `aifight service restart` after resolving the service manager issue.\n");
    }
    return {
      installed: true,
      restarted: false,
      running: status.running,
      detail: status.detail,
    };
  }

  if (!jsonMode) {
    env.stdout("aifight.service restarted.\n");
  }
  return {
    installed: true,
    restarted: true,
    running: true,
    detail: "restarted",
  };
}

function firstErrorLine(cause: unknown): string {
  const stderr = (cause as { stderr?: unknown } | undefined)?.stderr;
  if (typeof stderr === "string" && stderr.trim() !== "") {
    return stderr.trim().split("\n")[0]!;
  }
  if (cause instanceof Error) return cause.message;
  return String(cause);
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
