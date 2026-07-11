// R13-F04: unattended auto-update is opt-in + pinned, and a system (root) unit
// is hardened rather than silently created.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { autoUpdateOptedIn } from "../src/cli/commands/bridge-run";
import { performBridgePackageUpdate } from "../src/bridge/auto-update";
import { installBridgeService, type BridgeServiceDeps, type ServiceExecFile } from "../src/bridge/service";

describe("R13-F04 auto-update opt-in gate", () => {
  const prev = process.env.AIFIGHT_AUTO_UPDATE;
  afterEach(() => {
    if (prev === undefined) delete process.env.AIFIGHT_AUTO_UPDATE;
    else process.env.AIFIGHT_AUTO_UPDATE = prev;
  });

  it("is OFF by default (unset / empty / falsey values)", () => {
    delete process.env.AIFIGHT_AUTO_UPDATE;
    expect(autoUpdateOptedIn()).toBe(false);
    for (const v of ["", "0", "false", "no", "off", "nope"]) {
      process.env.AIFIGHT_AUTO_UPDATE = v;
      expect(autoUpdateOptedIn()).toBe(false);
    }
  });

  it("is ON only for explicit truthy opt-in values", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"]) {
      process.env.AIFIGHT_AUTO_UPDATE = v;
      expect(autoUpdateOptedIn()).toBe(true);
    }
  });
});

describe("R13-F04 pinned install command", () => {
  it("pins the exact version when one is provided", async () => {
    const calls: string[][] = [];
    const exec: (f: string, a: readonly string[]) => Promise<{ stdout: string; stderr: string }> = async (f, a) => {
      calls.push([f, ...a]);
      return { stdout: "", stderr: "" };
    };
    await performBridgePackageUpdate({ execFile: exec, version: "0.1.0-beta.14" });
    expect(calls).toEqual([["npm", "install", "-g", "@aifight/aifight@0.1.0-beta.14"]]);
  });

  it("strips a leading v from the pinned version", async () => {
    const calls: string[][] = [];
    const exec: (f: string, a: readonly string[]) => Promise<{ stdout: string; stderr: string }> = async (f, a) => {
      calls.push([f, ...a]);
      return { stdout: "", stderr: "" };
    };
    await performBridgePackageUpdate({ execFile: exec, version: "v2.3.4" });
    expect(calls).toEqual([["npm", "install", "-g", "@aifight/aifight@2.3.4"]]);
  });

  it("falls back to the bare package for a manual (unversioned) update", async () => {
    const calls: string[][] = [];
    const exec: (f: string, a: readonly string[]) => Promise<{ stdout: string; stderr: string }> = async (f, a) => {
      calls.push([f, ...a]);
      return { stdout: "", stderr: "" };
    };
    await performBridgePackageUpdate({ execFile: exec });
    expect(calls).toEqual([["npm", "install", "-g", "@aifight/aifight"]]);
  });
});

describe("R13-F04 system (root) unit hardening", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync("/tmp/aifight-systemd-install-");
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    fs.writeFileSync(path.join(root, "bin", "node"), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(path.join(root, "bin", "aifight"), "#!/bin/sh\n", { mode: 0o755 });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function deps(over: Partial<BridgeServiceDeps> = {}): BridgeServiceDeps {
    const exec: ServiceExecFile = async () => ({ stdout: "", stderr: "" });
    return {
      platform: "linux",
      uid: 0, // → linux-systemd-system (root)
      homeDir: path.join(root, "home"),
      runtimeHome: path.join(root, "runtime"),
      nodeExec: path.join(root, "bin", "node"),
      aifightExec: path.join(root, "bin", "aifight"),
      systemdSystemUnitPath: path.join(root, "aifight.service"),
      execFile: exec,
      ...over,
    };
  }

  it("installs a hardened root unit and returns a root warning", async () => {
    const result = await installBridgeService(deps());
    expect(result.platform).toBe("linux-systemd-system");
    expect(result.warning).toMatch(/runs as root/i);

    const unit = fs.readFileSync(path.join(root, "aifight.service"), "utf8");
    expect(unit).toContain("NoNewPrivileges=true");
    expect(unit).toContain("# User=aifight"); // least-privilege recommendation
    expect(unit).toMatch(/AIFIGHT_AUTO_UPDATE=1/); // documents that auto-update is off by default
  });

  it("a user (non-root) unit is not marked with the root warning or NoNewPrivileges", async () => {
    const result = await installBridgeService(
      deps({
        uid: 1000,
        systemdUserUnitPath: path.join(root, "user", "aifight.service"),
      }),
    );
    expect(result.platform).toBe("linux-systemd-user");
    expect(result.warning ?? "").not.toMatch(/runs as root/i);
    const unit = fs.readFileSync(path.join(root, "user", "aifight.service"), "utf8");
    expect(unit).not.toContain("NoNewPrivileges=true");
  });
});
