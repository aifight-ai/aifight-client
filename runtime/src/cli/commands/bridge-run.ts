import { ensureRuntimeHome } from "../../store/paths";
import {
  acquireDaemonLock,
  cleanupStaleTmpFiles,
  generateToken,
  RuntimeFilesWriteError,
  type LockHandle,
  unlinkRuntimeFiles,
  writePid,
  writePort,
  writeToken,
} from "../../daemon/runtime-files-write";
import { createControlServer } from "../../controlapi/server";
import type { ControlRouterTarget, ControlServer } from "../../controlapi/types";
import { BridgeRunner, type BridgeRunnerLogEvent } from "../../bridge/runner";
import { readBridgeConfig, type BridgeConfig } from "../../bridge/config";
import { checkBridgeUpdate } from "../../bridge/update-check";
import {
  startBridgeAutoUpdater,
  type BridgeAutoUpdater,
} from "../../bridge/auto-update";
import { BridgeServiceError, statusBridgeService } from "../../bridge/service";
import { RUNTIME_VERSION } from "../../index";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { CommandError, expectArity } from "../shared";
import { SUPPORTED_GAMES, isSupportedGame } from "../shared";

type SupportedGame = "texas_holdem" | "liars_dice" | "coup";

const USAGE = [
  "usage: aifight run [--force]",
  "  Advanced: run the outbound Bridge in this terminal.",
  "  If aifight.service is already running, this command refuses unless --force is set.",
].join("\n");

export async function runBridgeRun(
  args: HandlerArgs,
  env: HandlerEnv,
): Promise<number> {
  expectArity(args, 0, 0, USAGE);
  const force = args.flags.force === true;
  if (!force && process.env.AIFIGHT_SERVICE_RUN !== "1") {
    const running = await detectRunningBridgeService(env);
    if (running) {
      throw new CommandError(
        "bridge_already_running",
        "aifight.service is already running.",
        {
          hint: "Use `aifight start` to request matches through the running service. Use `aifight run --force` only for advanced debugging.",
        },
      );
    }
  }
  if (force && process.stdin.isTTY && process.env.AIFIGHT_SERVICE_RUN !== "1") {
    env.stdout([
      "AIFight service may already be running.",
      "Starting a second foreground Bridge can duplicate match handling.",
      "",
    ].join("\n"));
    const accepted = await promptYesNoDefaultNo(env, "Continue anyway? [y/N] ");
    if (!accepted) return 0;
  }

  const config = readBridgeConfig();
  return runBridgeWithConfig({ config, env });
}

export async function runBridgeWithConfig(opts: {
  readonly config: BridgeConfig;
  readonly env: HandlerEnv;
}): Promise<number> {
  const { config, env } = opts;
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

  ensureRuntimeHome();
  cleanupStaleTmpFiles();
  let lock: LockHandle | null = null;
  let server: ControlServer | null = null;
  let autoUpdater: BridgeAutoUpdater | null = null;
  const runner = new BridgeRunner({
    config,
    ...automaticJoinOptions(config),
    onLog: (event) => {
      writeBridgeLog(event, env);
    },
  });

  try {
    lock = acquireDaemonLock();
    writePid(process.pid);
    const token = generateToken();
    env.stdout(startBanner(config));
    await runner.start();

    server = createControlServer({
      tokenSource: () => token,
      router: singleRunnerRouter(config, runner),
      onLog: (event) => {
        env.onLog?.({ code: `control.${event.code}`, message: event.message });
      },
    });
    const port = await server.listen();
    writeToken(token);
    writePort(port);

    // R13-F04: unattended auto-update is OPT-IN and OFF by default. A background
    // service silently running `npm install -g` (as whatever user the unit runs
    // as — possibly root) is a supply-chain foothold, so it only runs when the
    // operator explicitly sets AIFIGHT_AUTO_UPDATE=1. When off, `aifight update`
    // stays available for a manual, user-initiated update.
    if (process.env.AIFIGHT_SERVICE_RUN === "1") {
      if (autoUpdateOptedIn()) {
        autoUpdater = startBridgeAutoUpdater({
          baseUrl: config.baseUrl,
          fetchImpl: env.fetchImpl,
          snapshot: () => runner.snapshot(),
          execFile: env.bridgeService?.execFile,
          onLog: (event) => writeBridgeLog(event, env),
          onRestartRequired: () => {
            env.stdout("AIFight Bridge updated; stopping so aifight.service can restart with the new package.\n");
            process.kill(process.pid, "SIGTERM");
          },
        });
      } else {
        env.stdout(
          "Automatic updates are off. Enable with AIFIGHT_AUTO_UPDATE=1, or update manually: aifight update --yes\n",
        );
      }
    }

    env.stdout("Bridge online. Press Ctrl-C to stop.\n");
    await waitForStopSignal(async () => {
      autoUpdater?.stop();
      autoUpdater = null;
      await server?.close();
      server = null;
      await runner.stop();
      unlinkRuntimeFiles({ onLog: (msg) => env.stderr(`warning: ${msg}\n`) });
      lock?.release();
      lock = null;
    });
    return 0;
  } catch (cause) {
    autoUpdater?.stop();
    await server?.close().catch(() => undefined);
    await runner.stop().catch(() => undefined);
    unlinkRuntimeFiles({ onLog: () => undefined });
    lock?.release();
    if (cause instanceof RuntimeFilesWriteError) {
      if (cause.kind === "lock_held_by_other") {
        throw new CommandError(
          "bridge_already_running",
          `AIFight Bridge is already running${cause.heldByPid !== undefined ? ` (PID ${cause.heldByPid})` : ""}.`,
          { hint: "Use `aifight start` to request matches through the running Bridge." },
        );
      }
      throw new CommandError("bridge_runtime_files_failed", cause.message);
    }
    throw cause;
  }
}

/** R13-F04: unattended auto-update opt-in. Off unless AIFIGHT_AUTO_UPDATE is set
 *  to a truthy value ("1"/"true"/"yes"/"on"); anything else (unset, "0",
 *  "false", "") keeps auto-update disabled. Exported for testing the gate. */
export function autoUpdateOptedIn(): boolean {
  const v = (process.env.AIFIGHT_AUTO_UPDATE ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function automaticJoinOptions(config: BridgeConfig): {
  readonly autoJoinGame?: SupportedGame;
  readonly autoJoinMode?: string;
  readonly autoJoinOneShot?: boolean;
} {
  const automaticGame = (config.autoDailyLimit ?? 0) > 0
    ? pickAutomaticGame(config.autoGames)
    : undefined;
  return automaticGame === undefined
    ? {}
    : {
        autoJoinGame: automaticGame,
        autoJoinMode: "ranked",
        autoJoinOneShot: false,
      };
}

function singleRunnerRouter(
  config: BridgeConfig,
  runner: BridgeRunner,
): ControlRouterTarget {
  return {
    listAgents: () => {
      const snapshot = runner.snapshot();
      return snapshot === null ? [] : [snapshot];
    },
    getAgent: (selector) => {
      if (selector.name !== config.agentName && selector.name !== "default") {
        throw Object.assign(new Error(`agent '${selector.name}' not found`), {
          kind: "router_agent_not_found",
        });
      }
      const snapshot = runner.snapshot();
      if (snapshot === null) {
        throw Object.assign(new Error("bridge runner is not started"), {
          kind: "router_agent_not_found",
        });
      }
      return {
        snapshot: () => runner.snapshot() ?? snapshot,
      };
    },
    joinQueue: (selector, game, mode, joinOpts) => {
      if (selector.name !== config.agentName && selector.name !== "default") {
        throw Object.assign(new Error(`agent '${selector.name}' not found`), {
          kind: "router_agent_not_found",
        });
      }
      if (!isSupportedGame(game)) {
        throw new Error(`unsupported game '${game}'`);
      }
      runner.joinQueue(game as SupportedGame, mode, {
        ...(joinOpts?.oneShot !== undefined ? { oneShot: joinOpts.oneShot } : {}),
        ...(joinOpts?.count !== undefined ? { count: joinOpts.count } : {}),
      });
    },
    leaveQueue: (selector) => {
      if (selector.name !== config.agentName && selector.name !== "default") {
        throw Object.assign(new Error(`agent '${selector.name}' not found`), {
          kind: "router_agent_not_found",
        });
      }
      runner.leaveQueue();
    },
  };
}

function startBanner(config: BridgeConfig): string {
  const autoLine = (config.autoDailyLimit ?? 0) > 0
    ? `Automatic ranked matches: ${config.autoDailyLimit} per day`
    : "Automatic ranked matches: disabled; staying online for challenges and manual starts";
  const lines = [
    "Starting AIFight Bridge.",
    "",
    `Agent: ${config.agentName}`,
    `Runtime: ${runtimeLabel(config.runtimeType)} at ${config.runtimeLocalUrl}`,
    `AIFight: ${config.baseUrl}`,
    autoLine,
    "",
    "Safety boundary: this opens an outbound WebSocket to AIFight and calls your local Agent runtime on localhost.",
    "Your model/provider keys stay inside your local runtime.",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function writeBridgeLog(event: BridgeRunnerLogEvent, env: HandlerEnv): void {
  if (event.code === "fsm.game_state" || event.code === "server.event") return;
  if (event.code === "bridge.connected") return;
  if (event.code === "bridge.queue_joined") {
    env.stdout(`${event.message}\n`);
    return;
  }
  if (event.code === "bridge.match_complete") {
    env.stdout(`\n${event.message}\n`);
    return;
  }
  const prefix = event.level === "error" ? "error" : event.level === "warning" ? "warning" : "info";
  const line = `${prefix}: ${event.message}\n`;
  if (event.level === "error") env.stderr(line);
  else env.stdout(line);
}

function runtimeLabel(runtimeType: BridgeConfig["runtimeType"]): string {
  switch (runtimeType) {
    case "mock":
      return "mock";
    case "direct":
      return "Direct (LLM)";
  }
}

function pickAutomaticGame(configured: readonly string[] | undefined): SupportedGame {
  const games = (configured ?? SUPPORTED_GAMES).filter(isSupportedGame);
  const pool = games.length > 0 ? games : SUPPORTED_GAMES;
  return pool[Math.floor(Math.random() * pool.length)]! as SupportedGame;
}

async function detectRunningBridgeService(env: HandlerEnv): Promise<boolean> {
  try {
    const status = await statusBridgeService(env.bridgeService);
    return status.installed && status.running === true;
  } catch (cause) {
    if (cause instanceof BridgeServiceError) return false;
    return false;
  }
}

async function waitForStopSignal(stop: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    let stopping = false;
    const handle = async () => {
      if (stopping) return;
      stopping = true;
      process.off("SIGINT", handle);
      process.off("SIGTERM", handle);
      await stop();
      resolve();
    };
    process.on("SIGINT", handle);
    process.on("SIGTERM", handle);
  });
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
