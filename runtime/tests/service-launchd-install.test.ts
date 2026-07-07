// Batch 3 — launchd install no longer prints a scary "kickstart did not
// complete cleanly / Command failed" during a healthy install (⑤). Drives
// installBridgeService with a MOCKED execFile (no real launchctl) and
// launchdReadyTimeoutMs: 0 so the poll is a single immediate check.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  installBridgeService,
  BridgeServiceError,
  type BridgeServiceDeps,
  type ServiceExecFile,
} from "../src/bridge/service";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync("/tmp/aifight-launchd-install-");
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  // realExecutablePath() requires real, executable files on disk.
  fs.writeFileSync(path.join(root, "bin", "node"), "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(path.join(root, "bin", "aifight"), "#!/bin/sh\n", { mode: 0o755 });
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function execError(message: string): Error {
  return new Error(message);
}

/** A launchctl stand-in. `print` outcomes are consumed from a queue (default
 *  false = "not found"); bootstrap/kickstart can be told to fail. Records every
 *  invocation for assertions. */
function mockLaunchctl(cfg: {
  bootstrapFails?: boolean;
  kickstartFails?: boolean;
  printResults?: boolean[];
}): { exec: ServiceExecFile; calls: string[][] } {
  const calls: string[][] = [];
  const prints = [...(cfg.printResults ?? [])];
  const exec: ServiceExecFile = async (file, args) => {
    calls.push([file, ...args]);
    if (file !== "launchctl") return { stdout: "", stderr: "" };
    switch (args[0]) {
      case "bootstrap":
        if (cfg.bootstrapFails) throw execError("Bootstrap failed: 5: Input/output error");
        return { stdout: "", stderr: "" };
      case "kickstart":
        if (cfg.kickstartFails) throw execError("Could not find service");
        return { stdout: "", stderr: "" };
      case "print": {
        const ok = prints.length ? prints.shift() : false;
        if (ok) return { stdout: "state = running", stderr: "" };
        throw execError("Could not find service");
      }
      default: // version, bootout, …
        return { stdout: "", stderr: "" };
    }
  };
  return { exec, calls };
}

function baseDeps(exec: ServiceExecFile, over: Partial<BridgeServiceDeps> = {}): BridgeServiceDeps {
  return {
    platform: "darwin",
    uid: 501,
    homeDir: path.join(root, "home"),
    runtimeHome: path.join(root, "runtime"),
    nodeExec: path.join(root, "bin", "node"),
    aifightExec: path.join(root, "bin", "aifight"),
    launchdPlistPath: path.join(root, "ai.aifight.service.plist"),
    launchdReadyTimeoutMs: 0,
    execFile: exec,
    ...over,
  };
}

function kickstartCalls(calls: string[][]): string[][] {
  return calls.filter((c) => c[0] === "launchctl" && c[1] === "kickstart");
}

describe("launchd install — no kickstart-race warning (⑤)", () => {
  it("clean install: print confirms the job → no kickstart, no warning", async () => {
    const { exec, calls } = mockLaunchctl({ printResults: [true] });
    const result = await installBridgeService(baseDeps(exec));

    expect(result.platform).toBe("darwin-launchd-user");
    expect(result.warning).toBeUndefined();
    expect(kickstartCalls(calls)).toHaveLength(0); // never runs kickstart on the happy path
    expect(fs.existsSync(path.join(root, "ai.aifight.service.plist"))).toBe(true);
  });

  it("slow-to-register: nudges with a PLAIN kickstart (no -k), then succeeds quietly", async () => {
    // First print misses, kickstart succeeds, second print confirms.
    const { exec, calls } = mockLaunchctl({ printResults: [false, true] });
    const result = await installBridgeService(baseDeps(exec));

    expect(result.warning).toBeUndefined();
    const ks = kickstartCalls(calls);
    expect(ks).toHaveLength(1);
    expect(ks[0]).not.toContain("-k"); // start, never the racy kill+restart
  });

  it("bootstrap failure is surfaced loudly, not swallowed", async () => {
    const { exec } = mockLaunchctl({ bootstrapFails: true });
    await expect(installBridgeService(baseDeps(exec))).rejects.toMatchObject({
      name: "BridgeServiceError",
      code: "service_install_failed",
    });
    // and the plist is cleaned up on failure
    expect(fs.existsSync(path.join(root, "ai.aifight.service.plist"))).toBe(false);
  });

  it("bootstrapped but never confirmed running → one calm note, no alarming wording", async () => {
    const { exec } = mockLaunchctl({ printResults: [false, false], kickstartFails: true });
    const result = await installBridgeService(baseDeps(exec));

    expect(result.warning).toBeDefined();
    expect(result.warning).toMatch(/installed and set to start automatically/);
    expect(result.warning).not.toMatch(/kickstart|Command failed|did not complete cleanly/);
  });
});

// Guard against BridgeServiceError import drifting to a type-only export.
it("BridgeServiceError is a runtime class", () => {
  expect(typeof BridgeServiceError).toBe("function");
});
