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
import {
  BridgeClientMismatchError,
  BridgeCredentialRejectedError,
  BridgeDeviceMismatchError,
  BridgeRunner,
  type BridgeRunnerLogEvent,
} from "../../bridge/runner";
import { readBridgeConfig, type BridgeConfig } from "../../bridge/config";
import { syncDeclaredModelAtStartup } from "../../bridge/declared-model";
import { automaticJoinOptions } from "../../bridge/auto-join";
import { checkBridgeUpdate } from "../../bridge/update-check";
import {
  startBridgeAutoUpdater,
  type BridgeAutoUpdater,
} from "../../bridge/auto-update";
import { BridgeServiceError, statusBridgeService } from "../../bridge/service";
import {
  notifyBridgeUnavailable,
  startTelegramCompanion,
  type TelegramCompanion,
} from "../../notify/telegram/companion";
import { MatchNarrator, type NarratorLine } from "../../bridge/match-narrator";
import { RUNTIME_VERSION } from "../../index";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { CommandError, expectArity } from "../shared";
import { SUPPORTED_GAMES, isSupportedGame } from "../shared";

type SupportedGame = "texas_holdem" | "liars_dice" | "coup";

/** How often a supervised service re-tries for the agent seat while the desktop
 *  app holds it. Short enough to feel instant after the app quits, long enough
 *  that an app left open all day costs nothing. */
const SERVICE_STANDBY_POLL_MS = 5_000;

/** How often a standing-by service repeats why it is waiting. */
const STANDBY_HEARTBEAT_MS = 60 * 60_000;

/** How long to keep waiting on a lock whose owner cannot be identified. Long
 *  enough to ride out the real transient (another bridge between taking the lock
 *  and stamping it — microseconds), short enough that a genuinely broken runtime
 *  home reaches the supervisor as a failure instead of a silent standby. */
const AMBIGUOUS_LOCK_MAX_WAIT_MS = 60_000;

/** How often a supervised service re-tries after being REFUSED — the agent
 *  belongs to another client, or to another machine. Much slower than the lock
 *  poll: only a human action (re-pairing from the Dashboard) can change the
 *  answer, so this is a "has the owner moved it back yet" check, not a race to
 *  be won. */
const CLIENT_MISMATCH_STANDBY_MS = 60_000;

/** How long one connect attempt may hold the machine's agent seat before we
 *  hand it back and try again.
 *
 *  The reconnect loop never gives up on a transient failure, which is right for
 *  a service but wrong while holding a lock: a laptop that wakes up with no
 *  network would sit here for hours with the seat in its pocket, and the desktop
 *  app — which the user is looking at — could not start. Ninety seconds is long
 *  enough for a slow first connect and short enough that the app never waits
 *  meaningfully on a service that is going nowhere. */
const CONNECT_ATTEMPT_TIMEOUT_MS = 90_000;

/** Pause after abandoning a timed-out connect attempt, seat released. Short —
 *  nothing is wrong, we are simply taking turns. */
const CONNECT_RETRY_PAUSE_MS = 15_000;

/** Repeat an unchanged refusal at most this often. A refusal message is a dozen
 *  lines of explanation, and the standby loop reproduces it every minute; on
 *  macOS launchd does not rotate service logs, so v1 wrote 1.4 MB a day saying
 *  the same thing. Say it once, then hourly so the log cannot go silent. */
const REFUSAL_LOG_REPEAT_MS = 60 * 60_000;

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

  const config = readRunBridgeConfig();
  return runBridgeWithConfig({ config, env });
}

/** readBridgeConfig, with the expected local-config failures mapped to a
 *  CommandError (exit 1 + hint) instead of the exit-99 catchall. */
function readRunBridgeConfig(): BridgeConfig {
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

export async function runBridgeWithConfig(opts: {
  readonly config: BridgeConfig;
  readonly env: HandlerEnv;
}): Promise<number> {
  const { env } = opts;
  // Re-read on every standby round (see the loop below), so `config` is a let.
  let config = opts.config;
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

  // Declared model: ONE best-effort platform sync per process start (never on
  // reconnect), so a pin or a profile-model change made while offline reaches
  // the leaderboard.
  await syncDeclaredModelAtStartup(config, {
    fetchImpl: env.fetchImpl ?? globalThis.fetch,
    warn: (message) => env.stderr(`warning: ${message}\n`),
  });

  ensureRuntimeHome();
  cleanupStaleTmpFiles();
  let lock: LockHandle | null = null;
  let server: ControlServer | null = null;
  let autoUpdater: BridgeAutoUpdater | null = null;
  // Optional phone companion. Null until it starts (and forever when it is not
  // configured), so every call site is `?.` — a notification channel must never
  // be able to stand between the bridge and a match.
  let telegram: TelegramCompanion | null = null;
  // In-match terminal narrator: match start, one line per decision, model-error
  // warnings. Without it the terminal is silent from "queue joined" until the
  // final match_complete block.
  const narrator = new MatchNarrator();
  // Resolves if the reconnect loop ever stops for good. Without this the process
  // stays alive around a dead socket: waitForStopSignal only wakes on a signal,
  // so the supervisor sees a healthy process, never restarts it, and the agent is
  // silently offline until someone notices by hand (2026-07-24 owner report).
  let onReconnectDead: ((reason: string) => void) | null = null;
  const reconnectDied = new Promise<string>((resolve) => {
    onReconnectDead = resolve;
  });
  const makeRunner = (cfg: BridgeConfig): BridgeRunner =>
    new BridgeRunner({
      config: cfg,
      clientKind: "cli",
      ...automaticJoinOptions(cfg),
      onLog: (event) => {
        writeBridgeLog(event, env);
        telegram?.observeLog(event);
        if (event.code === "reconnect.give_up" || event.code === "reconnect.closed") {
          onReconnectDead?.(event.message || event.code);
        }
      },
      onServerMessage: (message) => {
        telegram?.observeServerMessage(message);
        writeNarratorLine(narrator.observeServerMessage(message), env);
      },
      // A failed model call does not throw — the provider substitutes its own
      // move and carries on — so without the narrator the terminal in front of
      // the user is silent for the whole match and blind to that degradation.
      onTrace: (trace) => {
        telegram?.observeTrace(trace);
        writeNarratorLine(narrator.observeTrace(trace), env);
      },
    });
  let runner = makeRunner(config);

  try {
    // Two seats have to be free, not one. The lockfile settles who runs on THIS
    // machine; the server settles which client owns the agent at all. A service
    // that took the local lock and then sat waiting on the server would be the
    // worst of both: it would hold the seat the desktop app needs while waiting
    // for the server to hand it the agent the app already owns, and neither
    // would ever play. So a server refusal drops the local lock before waiting.
    let mismatchWaitedMs = 0;
    let mismatchAnnouncedAtMs = -1;
    let bannerShown = false;
    for (;;) {
      const seat = await acquireAgentSeat(env);
      lock = seat;
      writePid(process.pid);
      // Once, not once per retry: a service parked overnight would otherwise
      // reprint the whole banner every minute and bury its own standby notice.
      if (!bannerShown) {
        env.stdout(startBanner(config));
        bannerShown = true;
      }
      let refusal: Error | null = null;
      try {
        // Bounded: see CONNECT_ATTEMPT_TIMEOUT_MS. A timeout is not a failure —
        // we just stop holding the seat while we wait for the world to improve.
        const connected = await startWithinAttemptWindow(runner);
        if (connected) break;
        lock = null;
        await handBackSeat(seat);
        await sleep(CONNECT_RETRY_PAUSE_MS);
        // Fall through to the bottom of the loop, which re-reads the config.
      } catch (cause) {
        if (!isServerRefusal(cause)) throw cause;
        refusal = cause;
      }
      if (refusal !== null) {
        // The companion is mounted only after a successful connect, so on this
        // path there is nothing to observe the refusal — and a service install
        // can sit here all night. Send the one message directly. Once per
        // announcement, so standing by does not become a notification loop.
        if (mismatchAnnouncedAtMs < 0) {
          await notifyBridgeUnavailable(config, refusalCode(refusal), refusal.message, {
            ...(env.fetchImpl !== undefined ? { fetchImpl: env.fetchImpl } : {}),
          });
        }
        if (process.env.AIFIGHT_SERVICE_RUN !== "1") {
          // Foreground: the operator is watching. Say it once, plainly, and stop
          // — "unexpected error" would read as a bug rather than a choice they
          // made in the Dashboard.
          throw new CommandError(refusalCode(refusal), refusal.message);
        }
        lock = null;
        ({ waitedMs: mismatchWaitedMs, announcedAtMs: mismatchAnnouncedAtMs } =
          await standByAfterClientMismatch({
            lock: seat,
            env,
            message: refusal.message,
            waitedMs: mismatchWaitedMs,
            announcedAtMs: mismatchAnnouncedAtMs,
          }));
      }
      // Re-read the credentials before trying again, and build the runner from
      // what is on disk NOW. This is the whole point of standing by: the way out
      // is the owner re-pairing from the Dashboard, which rotates the api key in
      // the shared config file. A service clutching the config it started with
      // would present the dead key forever and never notice it had been given
      // the agent back.
      config = rereadBridgeConfig(config, env);
      runner = makeRunner(config);
    }
    const token = generateToken();

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

    // Phone notifications, if this machine has them set up. Returns null when
    // unconfigured (the default), so nothing starts and nothing is polled.
    try {
      telegram = startTelegramCompanion({
        config,
        runner,
        onLog: (event) => writeBridgeLog(event, env),
        ...(env.fetchImpl !== undefined ? { fetchImpl: env.fetchImpl } : {}),
      });
    } catch (cause) {
      env.stderr(`warning: Telegram companion did not start: ${cause instanceof Error ? cause.message : String(cause)}\n`);
      telegram = null;
    }

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
    const shutdown = async (): Promise<void> => {
      autoUpdater?.stop();
      autoUpdater = null;
      // Bounded internally (a flush budget, not a network wait), so a wedged
      // Telegram cannot hold the bridge open.
      await telegram?.stop().catch(() => undefined);
      telegram = null;
      await server?.close();
      server = null;
      await runner.stop();
      unlinkRuntimeFiles({ onLog: (msg) => env.stderr(`warning: ${msg}\n`) });
      lock?.release();
      lock = null;
    };
    const stopReason = await Promise.race([
      waitForStopSignal(shutdown).then(() => null),
      reconnectDied,
    ]);
    if (stopReason === null) return 0;
    // The loop gave up. Tear down and exit non-zero so the supervisor starts us
    // again with a fresh connection — and so a foreground run says why.
    await shutdown().catch(() => undefined);
    env.stderr(`Bridge stopped: ${stopReason}\n`);
    env.stderr("Exiting so the service manager can restart it; run `aifight run` again if you started it by hand.\n");
    return 1;
  } catch (cause) {
    autoUpdater?.stop();
    await telegram?.stop().catch(() => undefined);
    telegram = null;
    await server?.close().catch(() => undefined);
    await runner.stop().catch(() => undefined);
    // Clean up OUR files only. When acquireAgentSeat refused because another
    // Bridge holds the seat, `lock` is null and the token/port/pid under the
    // runtime home belong to that live process: deleting them would break its
    // `aifight start` and strand it (a lock with no pid reads as "ambiguous",
    // which every later acquire then refuses).
    if (lock !== null) {
      unlinkRuntimeFiles({ onLog: () => undefined });
      lock.release();
      lock = null;
    }
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

/**
 * Is this the server telling us, in so many words, that this client may not have
 * this agent?
 *
 * Both answers are terminal for the attempt and identical in what they need from
 * us: stop, hand the seat back, and wait for the owner to re-pair. They are NOT
 * failures to retry into — retrying cannot change either answer — and they are
 * not reasons to exit either, because a supervised service that exits is
 * restarted seconds later, forever.
 */
export function isServerRefusal(cause: unknown): cause is Error {
  return (
    cause instanceof BridgeClientMismatchError ||
    cause instanceof BridgeDeviceMismatchError ||
    cause instanceof BridgeCredentialRejectedError
  );
}

/** Doubles as the CommandError code and the phone alert's code — the three
 *  names are deliberately the same on both sides. */
function refusalCode(cause: Error): "device_mismatch" | "credential_rejected" | "client_mismatch" {
  if (cause instanceof BridgeDeviceMismatchError) return "device_mismatch";
  if (cause instanceof BridgeCredentialRejectedError) return "credential_rejected";
  return "client_mismatch";
}

/**
 * Run one connect attempt with a deadline. Resolves true when the bridge is up,
 * false when the attempt outstayed its welcome.
 *
 * On timeout the runner is stopped BEFORE the caller releases the seat. Skipping
 * that would be the worst possible outcome: a connect that lands a moment later
 * gives us a live socket while another client holds the machine's lock — the
 * two-bridges-one-agent state the lock exists to prevent.
 */
export async function startWithinAttemptWindow(
  runner: { start(): Promise<unknown>; stop(): Promise<unknown> },
  timeoutMs: number = CONNECT_ATTEMPT_TIMEOUT_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    const started = await Promise.race([runner.start().then(() => true as const), expired]);
    if (started) return true;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  await runner.stop().catch(() => undefined);
  return false;
}

/** Drop our runtime files and the seat, in that order, so a client waking up the
 *  instant we let go never finds a lock pointing at files we are still using. */
async function handBackSeat(lock: LockHandle): Promise<void> {
  unlinkRuntimeFiles({ onLog: () => undefined });
  lock.release();
}

/** Re-read the bridge config, keeping the previous one if the file has become
 *  unreadable — a half-written config during a re-pair must not kill a service
 *  that is otherwise fine. */
function rereadBridgeConfig(previous: BridgeConfig, env: HandlerEnv): BridgeConfig {
  try {
    return readBridgeConfig();
  } catch (cause) {
    env.stderr(`warning: could not re-read the bridge config (${cause instanceof Error ? cause.message : String(cause)}); keeping the current one\n`);
    return previous;
  }
}

/**
 * Take the machine-wide "I am this agent's Bridge" seat, waiting instead of
 * dying when the desktop app (or another `aifight run`) already holds it.
 *
 * One machine runs ONE Bridge per agent. The platform keeps a single live
 * connection per agent, so a second Bridge does not coexist with the first —
 * it kicks it off, the first one reconnects and kicks the second one off, and
 * the two trade the seat forever without either of them ever playing a match.
 * The lockfile in the runtime home is how the desktop app and this service
 * agree on who holds it.
 *
 * A foreground `aifight run` fails fast and tells the user. A supervised
 * service must not: exiting makes launchd/systemd respawn us every few seconds
 * for as long as the app stays open — log spam plus an update check per
 * restart. So in service mode we idle here and claim the seat within a few
 * seconds of the holder letting go. Safe to block: the stop-signal handlers are
 * installed only after a successful start, so `service stop` during standby
 * still terminates us the ordinary way.
 */
async function acquireAgentSeat(env: HandlerEnv): Promise<LockHandle> {
  const serviceMode = process.env.AIFIGHT_SERVICE_RUN === "1";
  let waitedMs = 0;
  let ambiguousMs = 0;
  let announcedAtMs = -1;
  for (;;) {
    try {
      return acquireDaemonLock();
    } catch (cause) {
      if (!serviceMode || !(cause instanceof RuntimeFilesWriteError)) throw cause;
      if (cause.kind === "lock_acquire_failed") {
        // Not the same thing as "someone else is running". This is "the lock is
        // there but who owns it is unreadable" — briefly true while another
        // bridge is between taking the lock and stamping it (worth waiting out),
        // but ALSO how a permanently broken runtime home looks: a lock left by an
        // older bridge whose pid file was deleted, a permissions failure, a full
        // disk. Waiting forever on those would leave a live process that never
        // opens a socket and that no supervisor will ever restart — exactly the
        // silent-offline failure this command's non-zero exit exists to prevent.
        // So give the transient case room, then surface it.
        ambiguousMs += SERVICE_STANDBY_POLL_MS;
        if (ambiguousMs > AMBIGUOUS_LOCK_MAX_WAIT_MS) throw cause;
      } else if (cause.kind !== "lock_held_by_other") {
        throw cause;
      } else {
        ambiguousMs = 0;
      }
      // Announce on entry, then hourly: a service log that goes silent for a day
      // cannot be told apart from a wedged one. Always carry cause.message — it
      // is the only place the actionable detail lives (which pid, or which file
      // to remove).
      if (announcedAtMs < 0 || waitedMs - announcedAtMs >= STANDBY_HEARTBEAT_MS) {
        announcedAtMs = waitedMs;
        env.stdout(
          waitedMs === 0
            ? `Standing by — cannot take this agent yet: ${cause.message}\n`
            : `Still standing by after ${Math.round(waitedMs / 60_000)} min: ${cause.message}\n`,
        );
      }
      await sleep(SERVICE_STANDBY_POLL_MS);
      waitedMs += SERVICE_STANDBY_POLL_MS;
    }
  }
}

/**
 * One standby step after the SERVER refused this client: hand the local seat back,
 * say why, then wait.
 *
 * The release has to come first, and it is the whole reason this is a named
 * function instead of four inline statements. Holding the lockfile while waiting
 * for the server to change its mind is a deadlock, not a delay: the server is
 * refusing us precisely because the desktop app owns this agent, and the app
 * cannot start without the lock we would be sitting on. Both clients would wait
 * on each other and the agent would simply never play.
 *
 * Returns the updated counters (waited / last-announced) for the next step.
 */
export async function standByAfterClientMismatch(opts: {
  readonly lock: LockHandle;
  readonly env: HandlerEnv;
  readonly message: string;
  readonly waitedMs: number;
  readonly announcedAtMs: number;
  readonly sleepFn?: (ms: number) => Promise<void>;
  readonly unlinkFn?: () => void;
}): Promise<{ readonly waitedMs: number; readonly announcedAtMs: number }> {
  const { lock, env, message, waitedMs, announcedAtMs } = opts;
  (opts.unlinkFn ?? (() => unlinkRuntimeFiles({ onLog: () => undefined })))();
  lock.release();

  let nextAnnouncedAtMs = announcedAtMs;
  if (announcedAtMs < 0 || waitedMs - announcedAtMs >= STANDBY_HEARTBEAT_MS) {
    nextAnnouncedAtMs = waitedMs;
    env.stderr(
      waitedMs === 0
        ? `${message}\nStanding by — this service will pick the agent up if you move it back here.\n`
        : `Still standing by after ${Math.round(waitedMs / 60_000)} min: this agent belongs to another AIFight client.\n`,
    );
  }
  await (opts.sleepFn ?? sleep)(CLIENT_MISMATCH_STANDBY_MS);
  return { waitedMs: waitedMs + CLIENT_MISMATCH_STANDBY_MS, announcedAtMs: nextAnnouncedAtMs };
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** R13-F04: unattended auto-update opt-in. Off unless AIFIGHT_AUTO_UPDATE is set
 *  to a truthy value ("1"/"true"/"yes"/"on"); anything else (unset, "0",
 *  "false", "") keeps auto-update disabled. Exported for testing the gate. */
export function autoUpdateOptedIn(): boolean {
  const v = (process.env.AIFIGHT_AUTO_UPDATE ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
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

/** Last time each throttled log code was actually written (epoch ms). */
const refusalLoggedAt = new Map<string, number>();

/** Test-only: forget the throttle state between cases. */
export function resetRefusalLogThrottleForTests(): void {
  refusalLoggedAt.clear();
}

/** Should this refusal be written, or has it already been said recently?
 *  Only the two refusal codes are throttled — everything else is either rare or
 *  genuinely worth repeating. */
export function shouldWriteRefusalLog(code: string, now: number): boolean {
  if (
    code !== "bridge.device_mismatch" &&
    code !== "bridge.client_mismatch" &&
    code !== "bridge.credential_rejected"
  ) {
    return true;
  }
  const last = refusalLoggedAt.get(code);
  if (last !== undefined && now - last < REFUSAL_LOG_REPEAT_MS) return false;
  refusalLoggedAt.set(code, now);
  return true;
}

/** Print one narrator line (or nothing), matching writeBridgeLog's tone. */
function writeNarratorLine(line: NarratorLine | null, env: HandlerEnv): void {
  if (line === null) return;
  const text = line.level === "warning" ? `warning: ${line.message}` : line.message;
  env.stdout(`${line.blockStart === true ? "\n" : ""}${text}\n`);
}

function writeBridgeLog(event: BridgeRunnerLogEvent, env: HandlerEnv): void {
  if (event.code === "fsm.game_state" || event.code === "server.event") return;
  if (event.code === "bridge.connected") return;
  if (!shouldWriteRefusalLog(event.code, Date.now())) return;
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
