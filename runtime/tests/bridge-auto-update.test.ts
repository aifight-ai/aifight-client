import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentInstanceSnapshot } from "../src/agents/agent";
import {
  isSafeAutoUpdatePhase,
  runBridgeAutoUpdateCheck,
  startBridgeAutoUpdater,
} from "../src/bridge/auto-update";

function versionPolicyResp(recommendedVersion = "99.0.0-alpha.1"): Response {
  return new Response(JSON.stringify({
    minimum_supported_version: "0.1.0-alpha.2",
    recommended_version: recommendedVersion,
    latest_version: recommendedVersion,
    update_command: "npm install -g @aifight/aifight@alpha",
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function snapshot(phase: string): AgentInstanceSnapshot {
  return {
    name: "alpha",
    state: { phase },
    transport: "open",
    started: true,
    stopped: false,
  } as unknown as AgentInstanceSnapshot;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("bridge idle auto update", () => {
  it("updates while connected and asks the service process to restart", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const restarts: string[] = [];
    const result = await runBridgeAutoUpdateCheck({
      baseUrl: "https://aifight.ai",
      fetchImpl: (async () => versionPolicyResp()) as unknown as typeof fetch,
      snapshot: () => snapshot("connected"),
      execFile: async (file, args) => {
        calls.push({ file, args });
        return { stdout: "ok\n", stderr: "" };
      },
      onRestartRequired: () => restarts.push("restart"),
    });

    expect(result.status).toBe("updated");
    expect(calls.map((c) => [c.file, ...c.args].join(" "))).toEqual([
      "npm install -g @aifight/aifight@alpha",
    ]);
    expect(restarts).toEqual(["restart"]);
  });

  it("defers updates while an agent is in a match or deciding", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const result = await runBridgeAutoUpdateCheck({
      baseUrl: "https://aifight.ai",
      fetchImpl: (async () => versionPolicyResp()) as unknown as typeof fetch,
      snapshot: () => snapshot("deciding"),
      execFile: async (file, args) => {
        calls.push({ file, args });
        return { stdout: "ok\n", stderr: "" };
      },
    });

    expect(result.status).toBe("busy");
    expect(result).toMatchObject({ phase: "deciding" });
    expect(calls).toEqual([]);
  });

  it("treats connected and queuing as safe idle states only", () => {
    expect(isSafeAutoUpdatePhase("connected")).toBe(true);
    expect(isSafeAutoUpdatePhase("queuing")).toBe(true);
    expect(isSafeAutoUpdatePhase("confirming")).toBe(false);
    expect(isSafeAutoUpdatePhase("matching")).toBe(false);
    expect(isSafeAutoUpdatePhase("in_match")).toBe(false);
    expect(isSafeAutoUpdatePhase("deciding")).toBe(false);
    expect(isSafeAutoUpdatePhase("reporting")).toBe(false);
    expect(isSafeAutoUpdatePhase(null)).toBe(false);
  });

  it("waits for its configured delay and interval instead of checking continuously", async () => {
    vi.useFakeTimers();
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const controller = startBridgeAutoUpdater({
      baseUrl: "https://aifight.ai",
      initialDelayMs: 100,
      intervalMs: 1_000,
      fetchImpl: (async () => versionPolicyResp()) as unknown as typeof fetch,
      snapshot: () => snapshot("connected"),
      execFile: async (file, args) => {
        calls.push({ file, args });
        return { stdout: "ok\n", stderr: "" };
      },
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);

    controller.stop();
  });
});
