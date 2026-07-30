// 审查 P1/P2 (2026-07-29) — the start/enrollment guards added in this audit round:
//
//   #2  BridgeHost gates start() on the platform's bridge-version policy
//       (checkBridgeUpdate — the same gate the CLI runs in bridge-run.ts):
//       "unsupported" refuses with the updateRequired code BEFORE connecting,
//       "update_recommended" warns and runs, and an unreachable/failed check
//       ("unknown") never blocks startup — offline must not lock the user out.
//   #4  the seat retry is QUIET: while another bridge holds the lock it no
//       longer broadcasts "starting" on every 5s pass (the status flickered
//       starting↔error); only acquiring the seat enters the starting flow.
//   #5  joinAutoMatch skips enrollment when the policy fetch FAILED (null) —
//       the daily cap is the token-burn valve, so a failed read never joins.
//
// The engine and the version check are mocked at their import specifiers, so
// nothing native loads and no network is touched.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeBridgeConfig, type BridgeConfig } from "@aifight/aifight/bridge/config";
import type { BridgeUpdateCheck } from "@aifight/aifight/bridge/update-check";
import type { BridgeLogEvent } from "../shared/ipc";
import desktopPkg from "../../package.json";

/** Captured per constructed runner, newest last. */
interface FakeRunner {
  onLog: (event: BridgeLogEvent) => void;
  started: boolean;
  stopped: boolean;
  joinCalls: Array<{ game: string; mode?: string }>;
}
const runners: FakeRunner[] = [];

vi.mock("@aifight/aifight/bridge/runner", () => ({
  BridgeRunner: class {
    #self: FakeRunner;
    constructor(opts: { onLog: (event: BridgeLogEvent) => void }) {
      this.#self = { onLog: opts.onLog, started: false, stopped: false, joinCalls: [] };
      runners.push(this.#self);
    }
    async start(): Promise<void> {
      this.#self.started = true;
    }
    async stop(): Promise<void> {
      this.#self.stopped = true;
    }
    onConnectionStateChange(): () => void {
      return () => {};
    }
    joinQueue(game: string, mode?: string): void {
      this.#self.joinCalls.push({ game, mode });
    }
    leaveQueue(): void {}
    poke(): void {}
    suspendConnection(): void {}
    resumeConnection(): void {}
  },
}));

/** What the mocked platform policy answers; reset to "current" per test. */
let updateAnswer: BridgeUpdateCheck = {
  status: "current",
  currentVersion: "0.1.0-beta.33",
  message: "current",
};
const updateCalls: Array<{ baseUrl: string; currentVersion: string }> = [];

vi.mock("@aifight/aifight/bridge/update-check", () => ({
  checkBridgeUpdate: async (opts: { baseUrl: string; currentVersion: string }): Promise<BridgeUpdateCheck> => {
    updateCalls.push({ baseUrl: opts.baseUrl, currentVersion: opts.currentVersion });
    return updateAnswer;
  },
}));

const { BridgeHost } = await import("./bridge-host");

const ORIGINAL_HOME = process.env.AIFIGHT_RUNTIME_HOME;
const tmpDirs: string[] = [];

function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-startguards-"));
  tmpDirs.push(dir);
  process.env.AIFIGHT_RUNTIME_HOME = dir;
  return dir;
}

function validConfig(): BridgeConfig {
  return {
    version: 1,
    baseUrl: "https://aifight.ai",
    wsUrl: "wss://aifight.ai/api/ws",
    agentId: "agent-guards",
    agentName: "Guards Agent",
    apiKey: "sk-not-a-real-key",
    runtimeType: "direct",
    runtimeLocalUrl: "direct://local",
    runtimeLocalToken: "token-not-real",
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
}

/** Impersonate a live foreign Bridge (same trick as bridge-host.test.ts). */
function foreignBridgeHoldsSeat(home: string): void {
  fs.writeFileSync(
    path.join(home, "lock"),
    JSON.stringify({ pid: process.pid, boot: Date.now() }),
    { mode: 0o600 },
  );
  fs.writeFileSync(path.join(home, "pid"), `${process.pid}\n`, { mode: 0o600 });
}

beforeEach(() => {
  runners.length = 0;
  updateCalls.length = 0;
  updateAnswer = { status: "current", currentVersion: "0.1.0-beta.33", message: "current" };
  freshHome();
  writeBridgeConfig(validConfig());
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const r of tmpDirs.splice(0)) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  if (ORIGINAL_HOME === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
  else process.env.AIFIGHT_RUNTIME_HOME = ORIGINAL_HOME;
});

describe("version policy gate (#2)", () => {
  it("unsupported refuses BEFORE connecting: updateRequired, no runner, seat released", async () => {
    updateAnswer = {
      status: "unsupported",
      currentVersion: desktopPkg.version,
      message: `Bridge ${desktopPkg.version} is below the minimum supported version 0.2.0. Update before joining matches.`,
    };
    const home = process.env.AIFIGHT_RUNTIME_HOME!;

    const status = await new BridgeHost().start();

    expect(status.phase).toBe("error");
    expect(status.code).toBe("updateRequired");
    expect(status.message).toContain("minimum supported version");
    expect(runners, "an unsupported build must never construct a runner").toHaveLength(0);
    // The seat was claimed before the gate and must be handed back, or the CLI
    // service can never take over and our own next start() would refuse.
    expect(fs.existsSync(path.join(home, "lock"))).toBe(false);
    // The gate ran against the configured platform with THIS app's version.
    expect(updateCalls).toEqual([{ baseUrl: "https://aifight.ai", currentVersion: desktopPkg.version }]);
  });

  it("update_recommended warns through the log stream and still connects", async () => {
    updateAnswer = {
      status: "update_recommended",
      currentVersion: desktopPkg.version,
      message: `Bridge ${desktopPkg.version} works, but 0.2.0 is recommended.`,
    };
    const logs: BridgeLogEvent[] = [];

    const status = await new BridgeHost({ onLog: (e) => logs.push(e) }).start();

    expect(status.phase).toBe("running");
    expect(runners).toHaveLength(1);
    expect(logs.some((e) => e.code === "bridge.update_recommended" && e.level === "warning")).toBe(true);
  });

  it("unknown (offline / unreachable check) never blocks startup — it only logs", async () => {
    updateAnswer = { status: "unknown", currentVersion: desktopPkg.version, message: "version check unavailable" };
    const logs: BridgeLogEvent[] = [];

    const status = await new BridgeHost({ onLog: (e) => logs.push(e) }).start();

    expect(status.phase).toBe("running");
    expect(runners).toHaveLength(1);
    expect(logs.some((e) => e.code === "desktop.version_check_skipped" && e.level === "info")).toBe(true);
  });

  it("current proceeds with no version-policy noise", async () => {
    const logs: BridgeLogEvent[] = [];

    const status = await new BridgeHost({ onLog: (e) => logs.push(e) }).start();

    expect(status.phase).toBe("running");
    expect(logs.filter((e) => e.code.includes("update") || e.code.includes("version"))).toEqual([]);
  });
});

describe("quiet seat retry (#4)", () => {
  it("broadcasts nothing while the lock is held; the freed seat enters the normal starting flow", async () => {
    vi.useFakeTimers();
    try {
      const home = process.env.AIFIGHT_RUNTIME_HOME!;
      foreignBridgeHoldsSeat(home);
      const phases: string[] = [];
      const host = new BridgeHost({ onStatus: (s) => phases.push(s.phase) });

      const first = await host.start();
      expect(first.code).toBe("lockHeld");
      // The FIRST (manual) start is unchanged: starting, then the seat error.
      expect(phases).toEqual(["starting", "error"]);
      phases.length = 0;

      // Three retry passes (5s apart) while the seat is held: not a single
      // broadcast — the standing error is already the whole answer. Before the
      // fix each pass emitted starting→error, flickering the pill.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(phases).toEqual([]);
      expect(runners).toHaveLength(0);

      // The seat frees up → the next retry acquires it and joins the loud flow.
      fs.rmSync(path.join(home, "lock"), { force: true });
      fs.rmSync(path.join(home, "pid"), { force: true });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(phases).toEqual(["starting", "running"]);
      expect(runners).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("joinAutoMatch policy gate (#5)", () => {
  it("a FAILED policy read (null) skips enrollment and logs — never joins blind", async () => {
    const logs: BridgeLogEvent[] = [];
    const host = new BridgeHost({ onLog: (e) => logs.push(e) });
    await host.start();
    expect(runners).toHaveLength(1);

    // /api/agents/me/status is unreachable this round.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline blip")));
    await host.joinAutoMatch();

    expect(runners[0].joinCalls, "enrolled despite the policy read failing").toEqual([]);
    expect(logs.some((e) => e.code === "desktop.automatch_policy_unknown" && e.level === "warning")).toBe(true);
  });

  it("a fetched cap > 0 still enrolls (the gate did not close on success)", async () => {
    const host = new BridgeHost();
    await host.start();
    expect(runners).toHaveLength(1);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ max_games_per_day: 2, max_games_per_hour: 1, cooldown_seconds: 0 }),
      }),
    );
    await host.joinAutoMatch();

    expect(runners[0].joinCalls).toHaveLength(1);
    expect(runners[0].joinCalls[0]?.mode).toBe("ranked");
  });
});
