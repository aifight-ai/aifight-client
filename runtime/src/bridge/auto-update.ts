import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

import type { AgentInstanceSnapshot } from "../agents/agent";
import { RUNTIME_VERSION } from "../index";
import {
  checkBridgeUpdate,
  type BridgeUpdateCheck,
} from "./update-check";

const UPDATE_PACKAGE = "@aifight/aifight";
export const DEFAULT_AUTO_UPDATE_INITIAL_DELAY_MS = 10 * 60 * 1000;
export const DEFAULT_AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

interface UpdateExecResult {
  readonly stdout: string;
  readonly stderr: string;
}

type UpdateExecFile = (
  file: string,
  args: readonly string[],
) => Promise<UpdateExecResult>;

type AutoUpdateLogLevel = "info" | "warning";

export interface BridgeAutoUpdateLogEvent {
  readonly level: AutoUpdateLogLevel;
  readonly code: string;
  readonly message: string;
}

export type BridgeAutoUpdateResult =
  | { readonly status: "current" | "unknown"; readonly update: BridgeUpdateCheck }
  | { readonly status: "busy"; readonly phase: string | null; readonly update: BridgeUpdateCheck }
  | { readonly status: "updated"; readonly update: BridgeUpdateCheck }
  | { readonly status: "failed"; readonly update: BridgeUpdateCheck; readonly error: string };

export interface RunBridgeAutoUpdateCheckOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly snapshot: () => AgentInstanceSnapshot | null;
  readonly execFile?: UpdateExecFile;
  readonly onRestartRequired?: () => void;
  readonly onLog?: (event: BridgeAutoUpdateLogEvent) => void;
}

export interface StartBridgeAutoUpdaterOptions extends RunBridgeAutoUpdateCheckOptions {
  readonly initialDelayMs?: number;
  readonly intervalMs?: number;
}

export interface BridgeAutoUpdater {
  readonly stop: () => void;
  readonly triggerNow: () => Promise<BridgeAutoUpdateResult | null>;
}

const execFileAsync = promisify(nodeExecFile);

const defaultUpdateExecFile: UpdateExecFile = async (file, args) => {
  const { stdout, stderr } = await execFileAsync(file, [...args], {
    timeout: 120_000,
    maxBuffer: 512 * 1024,
  } as never);
  return {
    stdout: typeof stdout === "string" ? stdout : stdout.toString("utf8"),
    stderr: typeof stderr === "string" ? stderr : stderr.toString("utf8"),
  };
};

export function startBridgeAutoUpdater(opts: StartBridgeAutoUpdaterOptions): BridgeAutoUpdater {
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const intervalMs = opts.intervalMs ?? DEFAULT_AUTO_UPDATE_INTERVAL_MS;
  const initialDelayMs = opts.initialDelayMs ?? DEFAULT_AUTO_UPDATE_INITIAL_DELAY_MS;

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick();
    }, delayMs);
  };

  const tick = async (): Promise<BridgeAutoUpdateResult | null> => {
    if (stopped || running) return null;
    running = true;
    try {
      return await runBridgeAutoUpdateCheck(opts);
    } finally {
      running = false;
      schedule(intervalMs);
    }
  };

  schedule(initialDelayMs);

  return {
    stop: () => {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    triggerNow: async () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      return tick();
    },
  };
}

export async function runBridgeAutoUpdateCheck(
  opts: RunBridgeAutoUpdateCheckOptions,
): Promise<BridgeAutoUpdateResult> {
  const update = await checkBridgeUpdate({
    baseUrl: opts.baseUrl,
    currentVersion: RUNTIME_VERSION,
    fetchImpl: opts.fetchImpl,
  });

  if (update.status === "current" || update.status === "unknown") {
    return { status: update.status, update };
  }

  const snapshot = opts.snapshot();
  const phase = snapshot?.state?.phase ?? null;
  if (!isSafeAutoUpdatePhase(phase)) {
    opts.onLog?.({
      level: "info",
      code: "bridge.auto_update_busy",
      message: `Bridge update available, but agent is busy (${phase ?? "not connected"}); will retry later.`,
    });
    return { status: "busy", phase, update };
  }

  // R13-F04: only install an EXACT version the platform policy advertised — never
  // the bare `latest` dist-tag (a hijacked tag would be pulled silently). If no
  // exact version is available, do NOT install.
  const recommendedVersion = update.policy?.recommendedVersion;
  if (!isPinnableVersion(recommendedVersion)) {
    opts.onLog?.({
      level: "warning",
      code: "bridge.auto_update_no_pinned_version",
      message: "Automatic Bridge update skipped: the platform did not advertise an exact version to pin.",
    });
    return { status: "failed", update, error: "no exact recommendedVersion to pin" };
  }

  opts.onLog?.({
    level: "info",
    code: "bridge.auto_update_start",
    message: `Updating AIFight Bridge to ${recommendedVersion} while idle.`,
  });

  try {
    await performBridgePackageUpdate({ execFile: opts.execFile, version: recommendedVersion });
  } catch (cause) {
    const error = firstErrorLine(cause);
    opts.onLog?.({
      level: "warning",
      code: "bridge.auto_update_failed",
      message: `Automatic AIFight Bridge update failed: ${error}`,
    });
    return { status: "failed", update, error };
  }

  opts.onLog?.({
    level: "info",
    code: "bridge.auto_update_done",
    message: "AIFight Bridge package updated; restarting service process to use the new version.",
  });
  try {
    opts.onRestartRequired?.();
  } catch (cause) {
    opts.onLog?.({
      level: "warning",
      code: "bridge.auto_update_restart_signal_failed",
      message: `AIFight Bridge package updated, but restart signal failed: ${firstErrorLine(cause)}`,
    });
  }
  return { status: "updated", update };
}

export async function performBridgePackageUpdate(opts: {
  readonly execFile?: UpdateExecFile;
  /** R13-F04: exact version to pin (e.g. "0.1.0-beta.14"). When omitted the
   *  bare package is installed (manual `aifight update` — user-initiated). The
   *  unattended auto-update path ALWAYS passes an exact version. */
  readonly version?: string;
} = {}): Promise<void> {
  const execFile = opts.execFile ?? defaultUpdateExecFile;
  // R13-F04: pin to the exact version when provided so a compromised `latest`
  // dist-tag cannot be pulled in unattended. NOTE: this pins the version only;
  // signed-manifest / npm provenance verification is release-infra (R15) and is
  // intentionally NOT stubbed here — a comment, not a fake check.
  const version = typeof opts.version === "string" ? opts.version.trim().replace(/^v/, "") : "";
  const target = version !== "" ? `${UPDATE_PACKAGE}@${version}` : UPDATE_PACKAGE;
  await execFile("npm", ["install", "-g", target]);
}

export function isSafeAutoUpdatePhase(phase: string | null): boolean {
  // Busy = a match is being arranged or played — the only states an update
  // restart could corrupt. Everything else is safe, INCLUDING "closed" and
  // null (not connected): a dead agent is exactly when updating helps most.
  // The old allow-list (connected|queuing) classified "closed" as busy, so a
  // permanently-disconnected bridge could never self-update — the 2026-07-24
  // field failure where a beta.14 service logged
  // "update available, but agent is busy (closed)" forever.
  switch (phase) {
    case "confirming":
    case "matching":
    case "in_match":
    case "deciding":
    case "reporting":
      return false;
    default:
      return true;
  }
}

/** R13-F04: an EXACT semver (optional leading "v", optional prerelease) — never a
 *  range or dist-tag. Only such a value may be auto-installed. */
function isPinnableVersion(v: string | undefined): v is string {
  return typeof v === "string" && /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v.trim());
}

function firstErrorLine(cause: unknown): string {
  const stderr = (cause as { stderr?: unknown } | undefined)?.stderr;
  if (typeof stderr === "string" && stderr.trim() !== "") {
    return stderr.trim().split("\n")[0]!;
  }
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
