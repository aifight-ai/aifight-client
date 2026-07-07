import { execFile as nodeExecFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { getRuntimeHome } from "../store/paths";

export const AIFIGHT_SERVICE_NAME = "aifight.service";
const LAUNCHD_LABEL = "ai.aifight.service";

export type BridgeServicePlatform =
  | "linux-systemd-system"
  | "linux-systemd-user"
  | "darwin-launchd-user";

export interface ServiceExecResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface ServiceExecError extends Error {
  readonly code?: string;
  readonly stdout?: string;
  readonly stderr?: string;
}

export type ServiceExecFile = (
  file: string,
  args: readonly string[],
) => Promise<ServiceExecResult>;

export interface BridgeServiceDeps {
  readonly execFile?: ServiceExecFile;
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  readonly username?: string;
  readonly homeDir?: string;
  readonly aifightExec?: string;
  readonly nodeExec?: string;
  readonly runtimeHome?: string;
  readonly systemdSystemUnitPath?: string;
  readonly systemdUserUnitPath?: string;
  readonly launchdPlistPath?: string;
  readonly launchdLogDir?: string;
  /** How long (ms) install polls `launchctl print` to confirm the freshly
   *  bootstrapped job registered before nudging it. Default 2000; tests pass 0
   *  for a single immediate check. */
  readonly launchdReadyTimeoutMs?: number;
}

export interface BridgeServiceTarget {
  readonly platform: BridgeServicePlatform;
  readonly unitPath: string;
  readonly nodeExec: string;
  readonly aifightExec: string;
  readonly runtimeHome: string;
}

export interface BridgeServiceInstallResult extends BridgeServiceTarget {
  readonly linger: "not_needed" | "enabled" | "failed" | "skipped";
  readonly warning?: string;
}

export interface BridgeServiceStatus extends BridgeServiceTarget {
  readonly installed: boolean;
  readonly running: boolean | null;
  readonly detail: string;
}

export class BridgeServiceError extends Error {
  readonly code: string;
  readonly hint?: string;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "BridgeServiceError";
    this.code = code;
    if (hint !== undefined) this.hint = hint;
  }
}

const execFileAsync = promisify(nodeExecFile);

export const defaultServiceExecFile: ServiceExecFile = async (file, args) => {
  try {
    const { stdout, stderr } = await execFileAsync(file, [...args], {
      timeout: 5_000,
      maxBuffer: 128 * 1024,
    } as never);
    return {
      stdout: typeof stdout === "string" ? stdout : stdout.toString("utf8"),
      stderr: typeof stderr === "string" ? stderr : stderr.toString("utf8"),
    };
  } catch (e) {
    throw e;
  }
};

export async function installBridgeService(
  deps: BridgeServiceDeps = {},
): Promise<BridgeServiceInstallResult> {
  const target = await resolveBridgeServiceTarget(deps);
  const execFile = deps.execFile ?? defaultServiceExecFile;
  writeServiceFile(target);

  try {
    if (target.platform === "darwin-launchd-user") {
      await execFile("launchctl", ["bootout", launchdDomain(deps), target.unitPath]).catch(() => undefined);
      await execFile("launchctl", ["bootstrap", launchdDomain(deps), target.unitPath]);
      // bootstrap + the plist's RunAtLoad already start the job; just confirm it
      // registered. No `kickstart -k` here — it raced the fresh load and printed
      // a scary "did not complete cleanly" during a perfectly healthy install.
      const warning = await ensureLaunchdRunningBestEffort(deps);
      return { ...target, linger: "not_needed", ...(warning ? { warning } : {}) };
    }

    const systemctl = systemctlArgs(target.platform);
    await execFile("systemctl", [...systemctl, "daemon-reload"]);
    await execFile("systemctl", [...systemctl, "enable", "--now", AIFIGHT_SERVICE_NAME]);

    if (target.platform === "linux-systemd-user") {
      const linger = await enableLingerBestEffort(deps);
      return { ...target, linger: linger.status, ...(linger.warning ? { warning: linger.warning } : {}) };
    }

    return { ...target, linger: "not_needed" };
  } catch (e) {
    await cleanupAfterInstallFailure(target, deps);
    throw new BridgeServiceError(
      "service_install_failed",
      `failed to install ${AIFIGHT_SERVICE_NAME}: ${firstErrorLine(e)}`,
      "The bridge can still run in the foreground with `aifight run`.",
    );
  }
}

export async function uninstallBridgeService(
  deps: BridgeServiceDeps = {},
): Promise<BridgeServiceTarget> {
  const target = await resolveBridgeServiceTarget(deps);
  const execFile = deps.execFile ?? defaultServiceExecFile;

  if (target.platform === "darwin-launchd-user") {
    await execFile("launchctl", ["bootout", launchdDomain(deps), target.unitPath]).catch(() => undefined);
    fs.rmSync(target.unitPath, { force: true });
    return target;
  }

  const systemctl = systemctlArgs(target.platform);
  await execFile("systemctl", [...systemctl, "disable", "--now", AIFIGHT_SERVICE_NAME]).catch(() => undefined);
  fs.rmSync(target.unitPath, { force: true });
  await execFile("systemctl", [...systemctl, "daemon-reload"]).catch(() => undefined);
  return target;
}

export async function startBridgeService(deps: BridgeServiceDeps = {}): Promise<BridgeServiceTarget> {
  const target = await resolveBridgeServiceTarget(deps);
  const execFile = deps.execFile ?? defaultServiceExecFile;
  if (target.platform === "darwin-launchd-user") {
    await execFile("launchctl", ["bootstrap", launchdDomain(deps), target.unitPath]).catch(() => undefined);
    await kickstartLaunchdBestEffort(deps);
    return target;
  }
  await execFile("systemctl", [...systemctlArgs(target.platform), "start", AIFIGHT_SERVICE_NAME]);
  return target;
}

export async function stopBridgeService(deps: BridgeServiceDeps = {}): Promise<BridgeServiceTarget> {
  const target = await resolveBridgeServiceTarget(deps);
  const execFile = deps.execFile ?? defaultServiceExecFile;
  if (target.platform === "darwin-launchd-user") {
    await execFile("launchctl", ["bootout", launchdDomain(deps), target.unitPath]).catch(() => undefined);
    return target;
  }
  await execFile("systemctl", [...systemctlArgs(target.platform), "stop", AIFIGHT_SERVICE_NAME]);
  return target;
}

export async function restartBridgeService(deps: BridgeServiceDeps = {}): Promise<BridgeServiceTarget> {
  const target = await resolveBridgeServiceTarget(deps);
  const execFile = deps.execFile ?? defaultServiceExecFile;
  if (target.platform === "darwin-launchd-user") {
    await execFile("launchctl", ["bootout", launchdDomain(deps), target.unitPath]).catch(() => undefined);
    await execFile("launchctl", ["bootstrap", launchdDomain(deps), target.unitPath]);
    await kickstartLaunchdBestEffort(deps);
    return target;
  }
  await execFile("systemctl", [...systemctlArgs(target.platform), "restart", AIFIGHT_SERVICE_NAME]);
  return target;
}

export async function statusBridgeService(deps: BridgeServiceDeps = {}): Promise<BridgeServiceStatus> {
  const target = await resolveBridgeServiceTarget(deps);
  const execFile = deps.execFile ?? defaultServiceExecFile;
  const installed = fs.existsSync(target.unitPath);
  if (!installed) {
    return { ...target, installed: false, running: null, detail: "not installed" };
  }

  if (target.platform === "darwin-launchd-user") {
    try {
      await execFile("launchctl", ["print", `${launchdDomain(deps)}/${LAUNCHD_LABEL}`]);
      return { ...target, installed: true, running: true, detail: "running" };
    } catch (e) {
      return { ...target, installed: true, running: false, detail: firstErrorLine(e) };
    }
  }

  try {
    const out = await execFile("systemctl", [...systemctlArgs(target.platform), "is-active", AIFIGHT_SERVICE_NAME]);
    const detail = out.stdout.trim() || "active";
    return { ...target, installed: true, running: detail === "active", detail };
  } catch (e) {
    return { ...target, installed: true, running: false, detail: firstErrorLine(e) };
  }
}

export async function resolveBridgeServiceTarget(
  deps: BridgeServiceDeps = {},
): Promise<BridgeServiceTarget> {
  const platform = deps.platform ?? process.platform;
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  const homeDir = deps.homeDir ?? os.homedir();
  const runtimeHome = deps.runtimeHome ?? getRuntimeHome();
  const aifightExec = await resolveAifightExec(deps);
  const nodeExec = resolveNodeExec(deps);

  if (platform === "linux") {
    await assertCommandWorks("systemctl", ["--version"], deps);
    if (uid === 0) {
      return {
        platform: "linux-systemd-system",
        unitPath: deps.systemdSystemUnitPath ?? "/etc/systemd/system/aifight.service",
        nodeExec,
        aifightExec,
        runtimeHome,
      };
    }
    return {
      platform: "linux-systemd-user",
      unitPath: deps.systemdUserUnitPath ?? path.join(homeDir, ".config", "systemd", "user", "aifight.service"),
      nodeExec,
      aifightExec,
      runtimeHome,
    };
  }

  if (platform === "darwin") {
    await assertCommandWorks("launchctl", ["version"], deps);
    return {
      platform: "darwin-launchd-user",
      unitPath: deps.launchdPlistPath ?? path.join(homeDir, "Library", "LaunchAgents", "ai.aifight.service.plist"),
      nodeExec,
      aifightExec,
      runtimeHome,
    };
  }

  throw new BridgeServiceError(
    "service_platform_unsupported",
    `automatic background service is not supported on ${platform}`,
    "Run `aifight run` manually or use your own process manager.",
  );
}

function writeServiceFile(target: BridgeServiceTarget): void {
  fs.mkdirSync(path.dirname(target.unitPath), { recursive: true });
  const text = target.platform === "darwin-launchd-user"
    ? renderLaunchdPlist(target)
    : renderSystemdUnit(target);
  writeAtomic(target.unitPath, text, target.platform === "linux-systemd-system" ? 0o644 : 0o600);
}

function renderSystemdUnit(target: BridgeServiceTarget): string {
  const wantedBy = target.platform === "linux-systemd-system" ? "multi-user.target" : "default.target";
  return [
    "# Auto-generated by AIFight. Re-run `aifight service install` to refresh.",
    "",
    "[Unit]",
    "Description=AIFight Agent Service",
    "Documentation=https://aifight.ai/skill.md",
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${quoteSystemdExecPath(target.nodeExec)} ${quoteSystemdExecPath(target.aifightExec)} run`,
    quoteSystemdEnvironment("AIFIGHT_RUNTIME_HOME", target.runtimeHome),
    quoteSystemdEnvironment("AIFIGHT_SERVICE_RUN", "1"),
    "Restart=always",
    "RestartSec=5",
    "StandardOutput=journal",
    "StandardError=journal",
    "",
    "[Install]",
    `WantedBy=${wantedBy}`,
    "",
  ].join("\n");
}

function renderLaunchdPlist(target: BridgeServiceTarget): string {
  const logDir = path.dirname(target.unitPath).includes("LaunchAgents")
    ? path.join(os.homedir(), "Library", "Logs", "aifight")
    : path.join(path.dirname(target.unitPath), "logs");
  fs.mkdirSync(logDir, { recursive: true });
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    "<dict>",
    "  <key>Label</key>",
    `  <string>${LAUNCHD_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${xmlEscape(target.nodeExec)}</string>`,
    `    <string>${xmlEscape(target.aifightExec)}</string>`,
    "    <string>run</string>",
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>AIFIGHT_RUNTIME_HOME</key>",
    `    <string>${xmlEscape(target.runtimeHome)}</string>`,
    "    <key>AIFIGHT_SERVICE_RUN</key>",
    "    <string>1</string>",
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>StandardOutPath</key>",
    `  <string>${xmlEscape(path.join(logDir, "service.out.log"))}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xmlEscape(path.join(logDir, "service.err.log"))}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function systemctlArgs(platform: BridgeServicePlatform): readonly string[] {
  return platform === "linux-systemd-user" ? ["--user"] : [];
}

function launchdDomain(deps: BridgeServiceDeps): string {
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  return `gui/${uid}`;
}

async function kickstartLaunchdBestEffort(
  deps: BridgeServiceDeps,
): Promise<string | undefined> {
  const execFile = deps.execFile ?? defaultServiceExecFile;
  const serviceName = `${launchdDomain(deps)}/${LAUNCHD_LABEL}`;
  try {
    await execFile("launchctl", ["kickstart", "-k", serviceName]);
    return undefined;
  } catch (e) {
    try {
      await execFile("launchctl", ["print", serviceName]);
      return `launchctl kickstart did not complete cleanly, but ${LAUNCHD_LABEL} is loaded: ${firstErrorLine(e)}`;
    } catch {
      throw e;
    }
  }
}

/**
 * Confirm a freshly bootstrapped launchd job is up — the gentle path used by
 * `install`. The plist's RunAtLoad starts the service on bootstrap, so the
 * normal path only verifies `launchctl print` answers (with a brief poll, since
 * a just-loaded job can take a beat to register). Only if it never answers do we
 * nudge it with a PLAIN `kickstart` (start, not `-k` kill+restart) and re-check.
 *
 * Never throws and never emits the old alarming "kickstart did not complete
 * cleanly / Command failed" wording during a healthy install (⑤). Returns
 * undefined on success; a single calm note only when the job was bootstrapped
 * but could not be confirmed running. A genuine bootstrap failure throws earlier
 * (installBridgeService's try/catch → a loud BridgeServiceError) and never
 * reaches here.
 */
async function ensureLaunchdRunningBestEffort(
  deps: BridgeServiceDeps,
): Promise<string | undefined> {
  const execFile = deps.execFile ?? defaultServiceExecFile;
  const serviceName = `${launchdDomain(deps)}/${LAUNCHD_LABEL}`;
  const timeoutMs = deps.launchdReadyTimeoutMs ?? 2_000;

  if (await launchdJobRegistered(execFile, serviceName, timeoutMs)) return undefined;

  // Not observably up yet → start it (plain kickstart), then re-check.
  await execFile("launchctl", ["kickstart", serviceName]).catch(() => undefined);
  if (await launchdJobRegistered(execFile, serviceName, timeoutMs)) return undefined;

  return `${LAUNCHD_LABEL} is installed and set to start automatically, but has not reported as running yet. If your Agent does not come online, run \`aifight service restart\`.`;
}

/** Poll `launchctl print <service>` until it answers or the budget runs out.
 *  timeoutMs = 0 → a single immediate check (used by tests). */
async function launchdJobRegistered(
  execFile: ServiceExecFile,
  serviceName: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    try {
      await execFile("launchctl", ["print", serviceName]);
      return true;
    } catch {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await sleep(Math.min(200, remaining));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function enableLingerBestEffort(
  deps: BridgeServiceDeps,
): Promise<{ readonly status: "enabled" | "failed" | "skipped"; readonly warning?: string }> {
  const username = deps.username ?? os.userInfo().username;
  if (!username) return { status: "skipped", warning: "could not determine username for loginctl enable-linger" };
  const execFile = deps.execFile ?? defaultServiceExecFile;
  try {
    await execFile("loginctl", ["enable-linger", username]);
    return { status: "enabled" };
  } catch (e) {
    return {
      status: "failed",
      warning: `loginctl enable-linger ${username} failed: ${firstErrorLine(e)}`,
    };
  }
}

async function cleanupAfterInstallFailure(
  target: BridgeServiceTarget,
  deps: BridgeServiceDeps,
): Promise<void> {
  const execFile = deps.execFile ?? defaultServiceExecFile;
  if (target.platform === "darwin-launchd-user") {
    await execFile("launchctl", ["bootout", launchdDomain(deps), target.unitPath]).catch(() => undefined);
    fs.rmSync(target.unitPath, { force: true });
    return;
  }
  const systemctl = systemctlArgs(target.platform);
  await execFile("systemctl", [...systemctl, "disable", "--now", AIFIGHT_SERVICE_NAME]).catch(() => undefined);
  fs.rmSync(target.unitPath, { force: true });
  await execFile("systemctl", [...systemctl, "daemon-reload"]).catch(() => undefined);
}

async function resolveAifightExec(deps: BridgeServiceDeps): Promise<string> {
  const explicit = deps.aifightExec;
  if (explicit !== undefined && explicit.trim() !== "") return realExecutablePath(explicit);

  const candidate = process.argv[1];
  if (candidate !== undefined && candidate !== "" && !looksTemporaryNpxPath(candidate)) {
    try {
      return realExecutablePath(candidate);
    } catch {
      // Fall through to PATH lookup.
    }
  }

  const execFile = deps.execFile ?? defaultServiceExecFile;
  try {
    const out = await execFile("sh", ["-lc", "command -v aifight"]);
    const found = out.stdout.trim().split("\n")[0];
    if (found) return realExecutablePath(found);
  } catch {
    // Report a clean error below.
  }

  throw new BridgeServiceError(
    "service_exec_unresolved",
    "could not resolve a stable `aifight` executable for the background service",
    "Install with `npm install -g @aifight/aifight`, then run `aifight service install` again.",
  );
}

function resolveNodeExec(deps: BridgeServiceDeps): string {
  const explicit = deps.nodeExec;
  if (explicit !== undefined && explicit.trim() !== "") return realExecutablePath(explicit);

  try {
    return realExecutablePath(process.execPath);
  } catch {
    throw new BridgeServiceError(
      "service_exec_unresolved",
      "could not resolve a stable Node.js executable for the background service",
      "Install Node.js >=20.19 and rerun `aifight service install`.",
    );
  }
}

function realExecutablePath(raw: string): string {
  const resolved = fs.realpathSync(raw);
  fs.accessSync(resolved, fs.constants.X_OK);
  return resolved;
}

function looksTemporaryNpxPath(raw: string): boolean {
  return /[/\\](_npx|\.npm[/\\]_npx|npm-cache[/\\]_npx)[/\\]/.test(raw);
}

async function assertCommandWorks(
  file: string,
  args: readonly string[],
  deps: BridgeServiceDeps,
): Promise<void> {
  const execFile = deps.execFile ?? defaultServiceExecFile;
  try {
    await execFile(file, args);
  } catch (e) {
    throw new BridgeServiceError(
      "service_manager_unavailable",
      `${file} is not available or not usable on this system: ${firstErrorLine(e)}`,
      "AIFight will keep running in the foreground; use your own process manager if needed.",
    );
  }
}

function quoteSystemdExecPath(p: string): string {
  if (!/[\s"\\]/.test(p)) return p;
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function quoteSystemdEnvironment(key: string, value: string): string {
  return `Environment="${key}=${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function writeAtomic(filePath: string, text: string, mode: number): void {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, text, { mode });
  if (process.platform !== "win32") fs.chmodSync(tmpPath, mode);
  fs.renameSync(tmpPath, filePath);
}

function firstErrorLine(e: unknown): string {
  const err = e as ServiceExecError;
  const raw = typeof err.stderr === "string" && err.stderr.trim() !== ""
    ? err.stderr
    : err.message;
  return String(raw).trim().split("\n")[0] ?? "unknown error";
}

function xmlEscape(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
