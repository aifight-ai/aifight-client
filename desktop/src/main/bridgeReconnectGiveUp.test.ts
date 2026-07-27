// E5 (windows-loop) — the reconnect.give_up branch in BridgeHost#startOnce.
//
// This branch only fires on a TRULY terminal reconnect (version mismatch, 403
// device takeover, aborted transport); transient blips retry forever. Which is
// exactly why it had no coverage and why it matters: it is the rarely-walked
// path whose whole job is to leave the host in a state the user can recover
// from. Two things must hold, and both are invisible from the status text:
//
//   - the runner is RELEASED, so the 重连 button (→ start()) really restarts
//     instead of no-opping on a non-null runner and looking dead;
//   - the machine's agent seat is handed back only AFTER stop() settles (F3) —
//     releasing it early lets a standby CLI service connect alongside a
//     mid-dial zombie of the runner we are still stopping.
//
// The engine is mocked at its import specifier: BridgeHost pulls it with a
// dynamic import so nothing native loads, and the fake hands us the very onLog
// the branch lives in.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeBridgeConfig, type BridgeConfig } from "@aifight/aifight/bridge/config";
import type { BridgeLogEvent } from "../shared/ipc";

/** Captured per constructed runner, newest last. */
interface FakeRunner {
  onLog: (event: BridgeLogEvent) => void;
  started: boolean;
  stopped: boolean;
  /** Resolves stop(); left pending to observe seat-release ordering. */
  releaseStop: () => void;
}
const runners: FakeRunner[] = [];
/** When set, stop() waits on it so the test controls when teardown finishes. */
let holdStop = false;

vi.mock("@aifight/aifight/bridge/runner", () => ({
  BridgeRunner: class {
    #self: FakeRunner;
    #gate: Promise<void>;
    constructor(opts: { onLog: (event: BridgeLogEvent) => void }) {
      let open = (): void => {};
      this.#gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      this.#self = { onLog: opts.onLog, started: false, stopped: false, releaseStop: open };
      runners.push(this.#self);
    }
    async start(): Promise<void> {
      this.#self.started = true;
    }
    async stop(): Promise<void> {
      this.#self.stopped = true;
      if (holdStop) await this.#gate;
    }
    onConnectionStateChange(): () => void {
      return () => {};
    }
    poke(): void {}
    suspendConnection(): void {}
    resumeConnection(): void {}
  },
}));

const { BridgeHost } = await import("./bridge-host");

const ORIGINAL_HOME = process.env.AIFIGHT_RUNTIME_HOME;
const tmpDirs: string[] = [];

function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-giveup-"));
  tmpDirs.push(dir);
  process.env.AIFIGHT_RUNTIME_HOME = dir;
  return dir;
}

function validConfig(): BridgeConfig {
  return {
    version: 1,
    baseUrl: "https://aifight.ai",
    wsUrl: "wss://aifight.ai/api/ws",
    agentId: "agent-giveup",
    agentName: "GiveUp Agent",
    apiKey: "sk-not-a-real-key",
    runtimeType: "direct",
    runtimeLocalUrl: "direct://local",
    runtimeLocalToken: "token-not-real",
    updatedAt: "2026-07-26T00:00:00.000Z",
  };
}

const GAVE_UP: BridgeLogEvent = {
  level: "error",
  code: "reconnect.give_up",
  message: "Reconnect gave up",
};

beforeEach(() => {
  runners.length = 0;
  holdStop = false;
  freshHome();
  writeBridgeConfig(validConfig());
});

afterEach(async () => {
  holdStop = false;
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

/** Lets the queued microtasks of the branch's fire-and-forget teardown run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("reconnect.give_up (terminal reconnect)", () => {
  it("surfaces an error and frees the runner so 重连 actually restarts", async () => {
    const host = new BridgeHost();
    const started = await host.start();
    expect(started.phase, "precondition: the mocked engine should bring us up").toBe("running");
    expect(runners).toHaveLength(1);

    runners[0].onLog(GAVE_UP);
    await settle();

    const status = host.getStatus();
    expect(status.phase).toBe("error");
    expect(status.message ?? "").not.toBe("");
    expect(runners[0].stopped, "the dead runner must be stopped, not merely dropped").toBe(true);

    // The payoff: start() must build a NEW runner rather than see a non-null one
    // and return the stale error status — that no-op is what made the host look
    // permanently dead with a 重连 button that did nothing.
    const restarted = await host.start();
    expect(runners, "重连 did not construct a new runner").toHaveLength(2);
    expect(restarted.phase).toBe("running");
  });

  it("holds the machine seat until stop() settles, then hands it back", async () => {
    holdStop = true;
    const host = new BridgeHost();
    await host.start();

    runners[0].onLog(GAVE_UP);
    await settle();

    // stop() is still pending. A second BridgeHost in this process cannot probe
    // the lock (acquireDaemonLock is not reentrant), so read the seat's own
    // artifact: the lock file must still be there while teardown is in flight.
    const lockDir = process.env.AIFIGHT_RUNTIME_HOME!;
    const seatFiles = () =>
      fs.readdirSync(lockDir, { recursive: true, encoding: "utf8" }).filter((f) => f.includes("lock"));
    expect(seatFiles().length, "the seat was released while stop() was still running").toBeGreaterThan(0);

    runners[0].releaseStop();
    await settle();
    await settle();

    // And the seat must genuinely come back — a start() that could not reclaim
    // it would report an error instead of running.
    const restarted = await host.start();
    expect(restarted.phase).toBe("running");
  });
});
