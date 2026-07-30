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
    update_command: "npm install -g @aifight/aifight",
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** Route the two version-check endpoints: the server policy and the npm
 *  registry latest. `npmVersion` undefined = registry unreachable (the
 *  server-policy fallback arm). */
function updateFetch(npmVersion?: string): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/bridge/version")) return versionPolicyResp();
    if (url.startsWith("https://registry.npmjs.org/")) {
      if (npmVersion === undefined) throw new Error("registry unreachable");
      return new Response(JSON.stringify({ version: npmVersion }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
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
      fetchImpl: updateFetch("99.0.0-alpha.1"),
      snapshot: () => snapshot("connected"),
      execFile: async (file, args) => {
        calls.push({ file, args });
        return { stdout: "ok\n", stderr: "" };
      },
      onRestartRequired: () => restarts.push("restart"),
    });

    expect(result.status).toBe("updated");
    // R13-F04: the unattended install pins the exact resolved latest version
    // rather than pulling the bare `latest` dist-tag.
    expect(calls.map((c) => [c.file, ...c.args].join(" "))).toEqual([
      "npm install -g @aifight/aifight@99.0.0-alpha.1",
    ]);
    expect(restarts).toEqual(["restart"]);
  });

  it("pins the npm registry latest, not the server recommended version", async () => {
    // Owner decision 2026-07-30: "latest" is whatever npm says; the server
    // policy only supplies the floor (and the fallback when npm is down).
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const result = await runBridgeAutoUpdateCheck({
      baseUrl: "https://aifight.ai",
      // Server recommends 99.0.0-alpha.1, but npm already has 99.0.0-alpha.9.
      fetchImpl: updateFetch("99.0.0-alpha.9"),
      snapshot: () => snapshot("connected"),
      execFile: async (file, args) => {
        calls.push({ file, args });
        return { stdout: "ok\n", stderr: "" };
      },
    });

    expect(result.status).toBe("updated");
    expect(calls.map((c) => [c.file, ...c.args].join(" "))).toEqual([
      "npm install -g @aifight/aifight@99.0.0-alpha.9",
    ]);
  });

  it("falls back to the server recommended version when the registry is unreachable", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const result = await runBridgeAutoUpdateCheck({
      baseUrl: "https://aifight.ai",
      fetchImpl: updateFetch(undefined),
      snapshot: () => snapshot("connected"),
      execFile: async (file, args) => {
        calls.push({ file, args });
        return { stdout: "ok\n", stderr: "" };
      },
    });

    expect(result.status).toBe("updated");
    expect(calls.map((c) => [c.file, ...c.args].join(" "))).toEqual([
      "npm install -g @aifight/aifight@99.0.0-alpha.1",
    ]);
  });

  it("defers updates while an agent is in a match or deciding", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const result = await runBridgeAutoUpdateCheck({
      baseUrl: "https://aifight.ai",
      fetchImpl: updateFetch("99.0.0-alpha.1"),
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

  it("treats only match-arranging/playing phases as busy — closed and not-connected are safe", () => {
    // 2026-07-24 field failure: the old allow-list called "closed" busy, so a
    // dead bridge could never self-update ("update available, but agent is
    // busy (closed)" forever). Only phases an update restart could corrupt
    // count as busy now.
    expect(isSafeAutoUpdatePhase("connected")).toBe(true);
    expect(isSafeAutoUpdatePhase("queuing")).toBe(true);
    expect(isSafeAutoUpdatePhase("closed")).toBe(true);
    expect(isSafeAutoUpdatePhase(null)).toBe(true);
    expect(isSafeAutoUpdatePhase("confirming")).toBe(false);
    expect(isSafeAutoUpdatePhase("matching")).toBe(false);
    expect(isSafeAutoUpdatePhase("in_match")).toBe(false);
    expect(isSafeAutoUpdatePhase("deciding")).toBe(false);
    expect(isSafeAutoUpdatePhase("reporting")).toBe(false);
  });

  it("waits for its configured delay and interval instead of checking continuously", async () => {
    vi.useFakeTimers();
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const controller = startBridgeAutoUpdater({
      baseUrl: "https://aifight.ai",
      initialDelayMs: 100,
      intervalMs: 1_000,
      fetchImpl: updateFetch("99.0.0-alpha.1"),
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
