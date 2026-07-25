import { isSafeAutoUpdatePhase, performBridgePackageUpdate } from "../../bridge/auto-update";
import { readBridgeConfig } from "../../bridge/config";
import {
  BridgeServiceError,
  restartBridgeService,
  statusBridgeService,
} from "../../bridge/service";
import { checkBridgeUpdate } from "../../bridge/update-check";
import { RUNTIME_VERSION } from "../../index";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { CommandError, expectArity, makeClient } from "../shared";

const USAGE = [
  "usage: aifight update [--yes] [--force]",
  "  Update the AIFight CLI package from npm, then restart aifight.service if it is installed.",
  "  Use --yes only after the human has approved the local AIFight package update.",
  "  The restart waits while a match is in progress; --force restarts anyway.",
].join("\n");

const DEFAULT_BASE_URL = "https://aifight.ai";
const UPDATE_PACKAGE = "@aifight/aifight";

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

  // The npm install itself is always safe: a running Bridge already has its code
  // in memory and keeps playing. Only the RESTART below can interrupt a match.
  await runNpmUpdate(env, args.jsonMode);
  const service = await restartInstalledService(env, args.jsonMode, args.flags.force === true);

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
  force: boolean,
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

  // Restarting drops the WebSocket mid-hand: the agent misses its turn and can
  // lose the match on time. The new package is already on disk, so waiting costs
  // nothing — the service picks it up at its next restart either way.
  const busyPhase = force ? null : await matchInProgressPhase(env);
  if (busyPhase !== null) {
    if (!jsonMode) {
      env.stdout(`A match is in progress (${busyPhase}) — not restarting the service.\n`);
      env.stdout("The new package is installed. Run `aifight service restart` once the match ends,\n");
      env.stdout("or `aifight update --yes --force` to restart now and give up the match.\n");
    }
    return {
      installed: true,
      restarted: false,
      running: status.running,
      detail: `match_in_progress:${busyPhase}`,
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

/**
 * The phase of a match currently in flight, or null if nothing would be
 * interrupted by restarting the service.
 *
 * Asks the running Bridge over its local control API — the same question the
 * unattended auto-updater answers from inside the process, using the same
 * definition of "busy" so a manual update and an automatic one never disagree.
 *
 * Any failure means "nothing to protect": no Bridge is listening (not running,
 * or the desktop app owns the agent and runs no control server), so a restart
 * cannot interrupt a match of ours. Never block an update on a broken probe —
 * that would make a wedged Bridge un-updatable, which is the state where
 * updating matters most.
 */
async function matchInProgressPhase(env: HandlerEnv): Promise<string | null> {
  try {
    const body = await makeClient(env).get<{
      readonly agents?: ReadonlyArray<{ readonly state?: { readonly phase?: unknown } | null }>;
    }>("/v1/agents");
    for (const agent of body.agents ?? []) {
      const phase = agent?.state?.phase;
      if (typeof phase === "string" && !isSafeAutoUpdatePhase(phase)) return phase;
    }
  } catch {
    // See above — an unanswered probe is not a reason to refuse.
  }
  return null;
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
