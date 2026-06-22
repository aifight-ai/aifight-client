import { afterEach, describe, expect, it } from "vitest";
import { execFile as nodeExecFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  installBridgeService,
  restartBridgeService,
  startBridgeService,
  statusBridgeService,
  stopBridgeService,
  uninstallBridgeService,
  type BridgeServiceDeps,
} from "../src/bridge/service";

const execFile = promisify(nodeExecFile);
const RUN_REAL_SMOKE = process.env.AIFIGHT_REAL_SERVICE_SMOKE === "1";
const LAUNCHD_LABEL = "gui/" + (process.getuid?.() ?? 0) + "/ai.aifight.service";
const SYSTEMD_UNIT = "aifight.service";

const cleanupQueue: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanupQueue.length > 0) {
    await cleanupQueue.pop()!();
  }
});

describe.runIf(RUN_REAL_SMOKE)("real service-manager smoke", () => {
  it.runIf(process.platform === "darwin")(
    "macOS launchd install/status/restart/stop/start/uninstall with isolated shims",
    async () => {
      if (await launchdLabelExists()) {
        console.warn("Skipping launchd real smoke because ai.aifight.service already exists.");
        return;
      }

      const fixture = makeFixture("launchd");
      cleanupQueue.push(async () => {
        await execFile("launchctl", ["bootout", LAUNCHD_LABEL]).catch(() => undefined);
        fs.rmSync(fixture.root, { recursive: true, force: true });
      });

      const deps: BridgeServiceDeps = {
        platform: "darwin",
        uid: process.getuid?.() ?? 0,
        homeDir: fixture.homeDir,
        runtimeHome: fixture.runtimeHome,
        nodeExec: fixture.nodeExec,
        aifightExec: fixture.aifightExec,
        launchdPlistPath: fixture.unitPath,
      };

      const installed = await installBridgeService(deps);
      expect(installed.platform).toBe("darwin-launchd-user");
      expect(fs.readFileSync(fixture.unitPath, "utf8")).toContain("<string>run</string>");
      expect(fs.readFileSync(fixture.unitPath, "utf8")).toContain(fixture.runtimeHome);

      await expect(statusBridgeService(deps)).resolves.toMatchObject({
        installed: true,
      });
      await restartBridgeService(deps);
      await expect(statusBridgeService(deps)).resolves.toMatchObject({
        installed: true,
      });

      await stopBridgeService(deps);
      const stopped = await statusBridgeService(deps);
      expect(stopped.installed).toBe(true);

      await startBridgeService(deps);
      await uninstallBridgeService(deps);
      expect(fs.existsSync(fixture.unitPath)).toBe(false);
      expect(await launchdLabelExists()).toBe(false);
    },
    30_000,
  );

  it.runIf(process.platform === "linux" && (process.getuid?.() ?? 1) === 0)(
    "Linux root systemd install/status/restart/stop/start/uninstall with isolated shims",
    async () => {
      if (await systemdUnitExists()) {
        console.warn("Skipping systemd real smoke because aifight.service already exists.");
        return;
      }

      const fixture = makeFixture("systemd");
      const unitPath = "/etc/systemd/system/aifight.service";
      cleanupQueue.push(async () => {
        await execFile("systemctl", ["disable", "--now", SYSTEMD_UNIT]).catch(() => undefined);
        fs.rmSync(unitPath, { force: true });
        await execFile("systemctl", ["daemon-reload"]).catch(() => undefined);
        fs.rmSync(fixture.root, { recursive: true, force: true });
      });

      const deps: BridgeServiceDeps = {
        platform: "linux",
        uid: 0,
        homeDir: fixture.homeDir,
        runtimeHome: fixture.runtimeHome,
        nodeExec: fixture.nodeExec,
        aifightExec: fixture.aifightExec,
      };

      const installed = await installBridgeService(deps);
      expect(installed.platform).toBe("linux-systemd-system");
      const unit = fs.readFileSync(unitPath, "utf8");
      expect(unit).toContain("ExecStart=");
      expect(unit).toContain(" run");
      expect(unit).toContain("AIFIGHT_SERVICE_RUN=1");
      expect(unit).toContain(fixture.runtimeHome);

      await expect(statusBridgeService(deps)).resolves.toMatchObject({
        installed: true,
        running: true,
      });
      await restartBridgeService(deps);
      await expect(statusBridgeService(deps)).resolves.toMatchObject({
        installed: true,
        running: true,
      });

      await stopBridgeService(deps);
      await expect(statusBridgeService(deps)).resolves.toMatchObject({
        installed: true,
        running: false,
      });

      await startBridgeService(deps);
      await uninstallBridgeService(deps);
      expect(fs.existsSync(unitPath)).toBe(false);
      expect(await systemdUnitExists()).toBe(false);
    },
    30_000,
  );
});

function makeFixture(kind: "launchd" | "systemd"): {
  readonly root: string;
  readonly homeDir: string;
  readonly runtimeHome: string;
  readonly nodeExec: string;
  readonly aifightExec: string;
  readonly unitPath: string;
} {
  const root = fs.mkdtempSync(path.join(realServiceSmokeTmpDir(), `aifight-${kind}-real-smoke-`));
  const binDir = path.join(root, "bin");
  const homeDir = path.join(root, "home");
  const runtimeHome = path.join(root, "runtime-home");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(runtimeHome, { recursive: true });

  const nodeExec = path.join(binDir, "fake-node");
  const aifightExec = path.join(binDir, "fake-aifight.mjs");
  const logPath = path.join(root, "service.log");
  fs.writeFileSync(
    nodeExec,
    [
      "#!/bin/sh",
      `echo "$0 $@" >> ${shellQuote(logPath)}`,
      "trap 'exit 0' TERM INT",
      "while true; do sleep 1; done",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(aifightExec, "console.log('fake aifight shim');\n", { mode: 0o755 });

  return {
    root,
    homeDir,
    runtimeHome,
    nodeExec,
    aifightExec,
    unitPath: path.join(root, "ai.aifight.service.plist"),
  };
}

function realServiceSmokeTmpDir(): string {
  // launchd is more reliable with plain /tmp paths than with macOS'
  // per-user /var/folders temporary directories when bootstrapping a plist.
  if (process.platform === "darwin" || process.platform === "linux") return "/tmp";
  return os.tmpdir();
}

async function launchdLabelExists(): Promise<boolean> {
  try {
    await execFile("launchctl", ["print", LAUNCHD_LABEL], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function systemdUnitExists(): Promise<boolean> {
  try {
    await execFile("systemctl", ["cat", SYSTEMD_UNIT], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function shellQuote(raw: string): string {
  return "'" + raw.replaceAll("'", "'\\''") + "'";
}
