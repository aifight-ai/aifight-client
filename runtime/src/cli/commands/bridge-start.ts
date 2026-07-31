import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readBridgeConfig, type BridgeConfig } from "../../bridge/config";
import { syncDeclaredModelAtStartup } from "../../bridge/declared-model";
import { checkBridgeUpdate } from "../../bridge/update-check";
import { BridgeServiceError, statusBridgeService } from "../../bridge/service";
import { RUNTIME_VERSION } from "../../index";
import { getRuntimeHome } from "../../store/paths";
import { createStatusIcons } from "../ansi";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { CommandError, UsageError, isSupportedGame, makeClient, SUPPORTED_GAMES } from "../shared";
import { ControlClientError } from "../control-client";

type SupportedGame = "texas_holdem" | "liars_dice" | "coup";

export const MAX_MANUAL_MATCHES = 20;
const USAGE = [
  "usage: aifight start [game] [N]",
  "       aifight start [N]",
  "  Request manual ranked match(es) through the running AIFight Bridge.",
  `  N must be 1-${MAX_MANUAL_MATCHES}. Manual starts do not consume the daily automatic match limit.`,
  `  supported games: ${SUPPORTED_GAMES.join(", ")}`,
].join("\n");

export async function runBridgeStart(
  args: HandlerArgs,
  env: HandlerEnv,
): Promise<number> {
  if (args.positional.length > 2) {
    const extras = args.positional.slice(2).join(" ");
    throw new UsageError(`unexpected extra positional arguments: ${extras}`, USAGE);
  }

  const config = readStartBridgeConfig();
  const request = parseStartRequest(args.positional, config);
  const update = await checkBridgeUpdate({
    baseUrl: config.baseUrl,
    currentVersion: RUNTIME_VERSION,
    fetchImpl: env.fetchImpl,
  });
  if (update.status === "unsupported") {
    env.stderr(`${update.message}\n`);
    env.stderr("Run: aifight update --yes\n");
    env.stderr(`Manual npm command: ${update.policy?.updateCommand ?? "npm install -g @aifight/aifight"}\n`);
    return 1;
  }
  if (update.status === "update_recommended") {
    env.stdout(`[warn] bridge.update: ${update.message}\n`);
    env.stdout("[warn] update when ready: aifight update --yes\n");
  }

  // Declared model: one best-effort platform sync with config load, so a pin
  // or a profile-model change made while offline reaches the leaderboard.
  await syncDeclaredModelAtStartup(config, {
    fetchImpl: env.fetchImpl ?? globalThis.fetch,
    warn: (message) => env.stderr(`warning: ${message}\n`),
  });

  try {
    const client = makeClient(env);
    await client.post<unknown>(
      `/v1/agents/${encodeURIComponent(config.agentName)}/join`,
      {
        game: request.game,
        mode: "ranked",
        one_shot: true,
        count: request.count,
      },
    );
  } catch (cause) {
    if (cause instanceof ControlClientError) {
      // The desktop app runs its bridge in-process: it holds the agent seat
      // (lock + pid) but never starts the CLI control API. "Unreachable" is
      // then NOT "nothing is running" — and the old fallback advice (install
      // the service) would have set up a second bridge queuing on the app's
      // lock. Probe the seat before blaming a missing bridge.
      if (cause.kind === "daemon_unreachable") {
        const pid = agentSeatHolderPid();
        if (pid !== undefined) {
          throw new CommandError(
            "bridge_seat_held_without_control_api",
            `A bridge for this agent is already running on this machine (PID ${pid}), but it does not expose the CLI control API.`,
            {
              hint: "If you use the AIFight desktop app, your agent is online inside it — request matches from the app, or quit it and use `aifight run` (or the service) for CLI control.",
            },
          );
        }
      }
      throw new CommandError(
        controlErrorCode(cause),
        controlErrorMessage(cause),
        { hint: await bridgeStartHint(env) },
      );
    }
    throw cause;
  }

  if (args.jsonMode) {
    env.stdout(JSON.stringify({
      status: "queued",
      agent: config.agentName,
      game: request.game,
      count: request.count,
      mode: "ranked",
      manual: true,
    }) + "\n");
  } else {
    const noun = request.count === 1 ? "match" : "matches";
    const icons = env.statusIcons ?? createStatusIcons();
    env.stdout(`${icons.ok} Requested ${request.count} manual ranked ${displayGameName(request.game)} ${noun} for ${config.agentName}.\n`);
    env.stdout("The running Bridge will keep your Agent online and handle the match when AIFight pairs it.\n");
  }
  return 0;
}

function readStartBridgeConfig(): BridgeConfig {
  try {
    return readBridgeConfig();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.includes("bridge is not configured")) {
      throw new CommandError(
        "bridge_not_configured",
        "AIFight Bridge is not configured.",
        {
          hint: "Run `aifight setup` for a new agent, or `aifight connect <PAIRING_CODE>` for an existing agent. Then install `aifight.service` before requesting manual matches.",
        },
      );
    }
    throw cause;
  }
}

function parseStartRequest(
  positional: readonly string[],
  config: BridgeConfig,
): { readonly game: SupportedGame; readonly count: number } {
  if (positional.length === 0) {
    return { game: pickManualGame(config.autoGames), count: 1 };
  }

  const first = positional[0]!;
  if (positional.length === 1) {
    const maybeCount = parsePositiveCount(first);
    if (maybeCount !== null) {
      return { game: pickManualGame(config.autoGames), count: maybeCount };
    }
    if (isSupportedGame(first)) {
      return { game: first as SupportedGame, count: 1 };
    }
    throw new UsageError(
      `unsupported game or count '${first}' (supported games: ${SUPPORTED_GAMES.join(", ")}; count N must be 1-${MAX_MANUAL_MATCHES})`,
      USAGE,
    );
  }

  const second = positional[1]!;
  if (!isSupportedGame(first)) {
    throw new UsageError(`unsupported game '${first}'`, USAGE);
  }
  const count = parsePositiveCount(second);
  if (count === null) {
    throw new UsageError(`N must be an integer between 1 and ${MAX_MANUAL_MATCHES}`, USAGE);
  }
  return { game: first as SupportedGame, count };
}

function parsePositiveCount(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > MAX_MANUAL_MATCHES) return null;
  return n;
}

function pickManualGame(configured: readonly string[] | undefined): SupportedGame {
  const games = (configured ?? SUPPORTED_GAMES).filter(isSupportedGame);
  const pool = games.length > 0 ? games : SUPPORTED_GAMES;
  return pool[Math.floor(Math.random() * pool.length)]! as SupportedGame;
}

function controlErrorCode(cause: ControlClientError): string {
  if (cause.kind === "daemon_unreachable") return "bridge_not_running";
  if (cause.kind === "runtime_files_corrupt") return "bridge_runtime_files_invalid";
  if (cause.kind === "auth_failed") return "bridge_control_auth_failed";
  if (cause.kind === "request_timeout") return "bridge_control_timeout";
  return "bridge_control_failed";
}

function controlErrorMessage(cause: ControlClientError): string {
  if (cause.kind === "daemon_unreachable") return "AIFight Bridge is not running.";
  if (cause.kind === "runtime_files_corrupt") return "AIFight Bridge runtime files are invalid.";
  if (cause.kind === "auth_failed") return "AIFight Bridge rejected the local control token.";
  if (cause.kind === "request_timeout") return "AIFight Bridge did not answer the local control request in time.";
  return cause.message;
}

async function bridgeStartHint(env: HandlerEnv): Promise<string> {
  try {
    const status = await statusBridgeService(env.bridgeService);
    if (status.installed && status.running === false) {
      return "Start it with `aifight service start`, then run this command again.";
    }
    if (status.installed && status.running === true) {
      return "The service appears to be running, but its local control API did not answer. Try `aifight service restart` when no match is in progress.";
    }
  } catch (cause) {
    if (!(cause instanceof BridgeServiceError)) throw cause;
  }
  return "Install the background service with `aifight service install`, or self-manage `aifight run` as an advanced path.";
}

/**
 * The pid of the LIVE process holding this machine's agent seat (the runtime
 * home lock), or undefined when no live holder can be identified.
 *
 * The desktop app runs the bridge in-process — it takes the lock and writes
 * the pid file but never starts the CLI control API (no token/port files), so
 * "control API unreachable" does not imply "no bridge is running". This is a
 * read-only mirror of the lock/pid contract in daemon/runtime-files-write.ts:
 * prefer the owner stamp inside the lock file, fall back to the pid file, and
 * probe liveness with kill(pid, 0) — EPERM (cross-user) counts as alive, the
 * same fail-safe default the lock's own probe uses.
 */
export function agentSeatHolderPid(): number | undefined {
  const home = getRuntimeHome();
  const owner = readLockOwnerStamp(path.join(home, "lock"));
  if (owner !== undefined) {
    // A stamp recorded in a DIFFERENT boot is a crash leftover whose pid may
    // have been recycled by an unrelated process since — probing it would
    // misreport a live desktop seat with no way out. Report "no live holder"
    // instead and let the authoritative lock probe (acquireDaemonLock) print
    // the "delete <lock> and try again" recovery if a start truly collides.
    if (!owner.sameBoot) return undefined;
    return processAlive(owner.pid) ? owner.pid : undefined;
  }
  const pid = readPidFilePid(path.join(home, "pid"));
  if (pid === undefined) return undefined;
  return processAlive(pid) ? pid : undefined;
}

/** The {"pid":N,"boot":M} stamp written inside the lock file since 2026-07-24. */
function readLockOwnerStamp(lockPath: string): { pid: number; sameBoot: boolean } | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; boot?: unknown };
    const pid = parsed.pid;
    const boot = parsed.boot;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1) return undefined;
    // Malformed boot: not a stamp this probe understands — same as the
    // authoritative readLockOwner, fall back to the pid file.
    if (typeof boot !== "number" || !Number.isFinite(boot)) return undefined;
    // Same tolerance as the authoritative probe (SAME_BOOT_TOLERANCE_MS):
    // os.uptime() has second granularity and suspends stretch it, so exact
    // equality would misclassify every stamp.
    const sameBoot = Math.abs(boot - (Date.now() - Math.round(os.uptime() * 1000))) <= 120_000;
    return { pid, sameBoot };
  } catch {
    return undefined; // pre-stamp lock (empty file) — caller falls back to the pid file
  }
}

function readPidFilePid(pidPath: string): number | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(pidPath, "utf8").trim();
  } catch {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number.parseInt(raw, 10);
  return n >= 1 ? n : undefined;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = gone. EPERM (cross-user, can't signal) or anything else = assume
    // alive — never declare a foreign bridge dead, same as the lock probe.
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function displayGameName(game: SupportedGame): string {
  switch (game) {
    case "texas_holdem":
      return "Texas Hold'em";
    case "liars_dice":
      return "Liar's Dice";
    case "coup":
      return "Coup";
  }
}
