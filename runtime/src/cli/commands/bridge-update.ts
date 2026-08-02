import { isPinnableVersion, isSafeAutoUpdatePhase, performBridgePackageUpdate } from "../../bridge/auto-update";
import { readBridgeConfig } from "../../bridge/config";
import {
  BridgeServiceError,
  restartBridgeService,
  statusBridgeService,
} from "../../bridge/service";
import { checkBridgeUpdate, type BridgeUpdateCheck } from "../../bridge/update-check";
import { RUNTIME_VERSION } from "../../index";
import { createStatusIcons } from "../ansi";
import { createOutput } from "../output";
import { resolveLocale, t } from "../i18n";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { CommandError, expectArity, makeClient } from "../shared";
import { bindConfirm, type ConfirmFn } from "./onboard-io";

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
  /** P4 test seam (批 U4): supplying one also stands in for the terminal, so
   *  both branches of the confirm are testable. Production passes nothing and
   *  gets onboard-io's promptYesNo behind the real isTTY gate. */
  confirm?: ConfirmFn,
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
    const kit = createOutput();
    env.stdout(`${kit.section("AIFight CLI update")}\n`);
    env.stdout(`${update.message}\n`);
    // The resolved "latest" (npm registry first, server policy as fallback) —
    // not the server policy's own latest_version field, which can lag npm.
    const latest = update.latestVersion ?? update.policy?.latestVersion;
    if (latest !== undefined) {
      env.stdout(`${kit.kv("Current", RUNTIME_VERSION)}\n`);
      env.stdout(`${kit.kv("Latest", latest, { tone: "yellow" })}\n`);
      env.stdout(`${kit.kv("Package", UPDATE_PACKAGE)}\n`);
    }
  }

  if (!approved) {
    if (confirm === undefined && !process.stdin.isTTY) {
      env.stderr("aifight: update requires confirmation in non-interactive mode.\n");
      env.stderr("Run `aifight update --yes` after the human approves the local package update.\n");
      return 1;
    }
    // P4 (统一交互规范 §2): the shared yes/no, default NO — an update the user
    // did not ask for is never what a bare Enter should mean.
    const loc = env.locale?.() ?? resolveLocale();
    const accepted = await (confirm ?? bindConfirm(env))(t(loc, "confirm.update.ask"), false);
    if (!accepted) {
      env.stdout(`${t(loc, "confirm.update.declined")}\n`);
      return 0;
    }
  }

  // The npm install itself is always safe: a running Bridge already has its code
  // in memory and keeps playing. Only the RESTART below can interrupt a match.
  await runNpmUpdate(env, args.jsonMode, update);
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

async function runNpmUpdate(env: HandlerEnv, jsonMode: boolean, update: BridgeUpdateCheck): Promise<void> {
  // Pin the exact version the npm registry named when we have it. In the
  // degraded server-only arm (registry unreachable) the user explicitly asked
  // for "update", so the bare package — npm's own latest dist-tag — is the
  // honest fallback for this manual, attended path.
  const pin = update.latestSource === "npm" && isPinnableVersion(update.latestVersion)
    ? update.latestVersion
    : undefined;
  const target = pin !== undefined ? `${UPDATE_PACKAGE}@${pin}` : UPDATE_PACKAGE;
  if (!jsonMode) {
    env.stdout(`Updating AIFight CLI: npm install -g ${target}\n`);
  }
  try {
    await performBridgePackageUpdate({
      execFile: env.bridgeService?.execFile,
      ...(pin !== undefined ? { version: pin } : {}),
    });
  } catch (cause) {
    throw new CommandError(
      "update_failed",
      `npm update failed: ${firstErrorLine(cause)}`,
      { hint: `Run manually: npm install -g ${target}` },
    );
  }
  if (!jsonMode) {
    env.stdout(`${icons(env).ok} ${t(env.locale?.() ?? resolveLocale(), "update.ok")}\n`);
  }
}

/** The V2 status icons for human feedback lines (never in --json output). */
function icons(env: HandlerEnv): { readonly ok: string; readonly warn: string } {
  return env.statusIcons ?? createStatusIcons();
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
      const loc = env.locale?.() ?? resolveLocale();
      env.stderr(`${icons(env).warn} ${t(loc, "update.warn.inspect", { error: firstErrorLine(cause) })}\n`);
      env.stderr(`${t(loc, "update.warn.inspect.tail")}\n`);
    }
    return { installed: false };
  }

  if (!status.installed) {
    if (!jsonMode) {
      env.stdout(`${icons(env).warn} aifight.service is not installed. If you use a foreground Bridge, stop it and run \`aifight run\` again.\n`);
    }
    return { installed: false };
  }

  if (status.running !== true) {
    if (!jsonMode) {
      env.stdout(`${icons(env).warn} aifight.service is installed but not running. Start it with \`aifight service start\` when ready.\n`);
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
      env.stdout(`${icons(env).warn} A match is in progress (${busyPhase}) — not restarting the service.\n`);
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
      const loc = env.locale?.() ?? resolveLocale();
      env.stderr(`${icons(env).warn} ${t(loc, "update.warn.restart_failed", { error: firstErrorLine(cause) })}\n`);
      if (hint) env.stderr(`${hint}\n`);
      env.stderr(`${t(loc, "update.warn.restart_failed.tail")}\n`);
    }
    return {
      installed: true,
      restarted: false,
      running: status.running,
      detail: status.detail,
    };
  }

  if (!jsonMode) {
    env.stdout(`${icons(env).ok} aifight.service restarted.\n`);
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
