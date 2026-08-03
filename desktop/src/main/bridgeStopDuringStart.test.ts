// D6a (windows-loop R12, P2) — stop() landing inside start()'s engine-import
// window.
//
// stop() handles stop-during-start by sampling `this.#runner` and aborting it —
// but during the `await import(...)` window #runner is still null, so nothing
// gets aborted and stop() settles into `await this.#starting`. The start it is
// waiting for proceeds to `await runner.start()`, whose first-connect promise
// legitimately pends FOREVER while the server is unreachable. Net effect, with
// the server down and Stop pressed right after launch:
//
//   - the Stop invoke never returns (renderer button wedged on a dead promise);
//   - removeLocalIdentity (device unbind, which awaits stop()) hangs the same way;
//   - hours later, when the server comes back, the bridge CONNECTS anyway —
//     the user's Stop is honoured only after a visible zombie session.
//
// The fix mirrors agent.ts's #stopped re-check after its connect await: stop()
// raises #stopDuringStart, and #startOnce re-checks it at both resumption points
// (post-import, post-start). These tests pin the contract from the outside: a
// stop during the import window must settle promptly, must win over the pending
// start, and must not leave a live runner behind.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeBridgeConfig, type BridgeConfig } from "@aifight/aifight/bridge/config";

/** Captured per constructed runner, newest last. */
interface FakeRunner {
  started: boolean;
  stopped: boolean;
  /** Resolves start() — "the server came back". */
  releaseStart: () => void;
}
const runners: FakeRunner[] = [];
/** When true, start() pends on its gate: the unreachable-server first connect. */
let holdStart = false;
/** When true, a stop() mid-connect does NOT reject start(): the abort lost. */
let abortLoses = false;

vi.mock("@aifight/aifight/bridge/runner", () => ({
  BridgeRunner: class {
    #self: FakeRunner;
    #gate: Promise<void>;
    constructor() {
      let open = (): void => {};
      this.#gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      this.#self = { started: false, stopped: false, releaseStart: open };
      runners.push(this.#self);
    }
    async start(): Promise<void> {
      this.#self.started = true;
      if (holdStart) await this.#gate;
      // A real runner's stop() aborts an in-flight first connect; model that so
      // the fixed code's abort path (stop sampling a non-null runner) also works
      // against this mock. abortLoses simulates the genuine race where the
      // welcome frame beats the abort and start() resolves anyway.
      if (this.#self.stopped && !abortLoses) throw new Error("connect aborted by stop");
    }
    async stop(): Promise<void> {
      this.#self.stopped = true;
      this.#self.releaseStart();
    }
    onConnectionStateChange(): () => void {
      return () => {};
    }
    /** U8a: every status emit mirrors the runner's standby belief. */
    standbyGames(): readonly string[] | null {
      return null;
    }
    poke(): void {}
    suspendConnection(): void {}
    resumeConnection(): void {}
  },
}));

// The version-policy gate (审查 P1-2) runs inside start(); pin it to "current"
// so these tests never touch the real network.
vi.mock("@aifight/aifight/bridge/update-check", () => ({
  checkBridgeUpdate: async () => ({ status: "current", currentVersion: "0.0.0", message: "current" }),
}));

const { BridgeHost } = await import("./bridge-host");

const ORIGINAL_HOME = process.env.AIFIGHT_RUNTIME_HOME;
const tmpDirs: string[] = [];

function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-stopstart-"));
  tmpDirs.push(dir);
  process.env.AIFIGHT_RUNTIME_HOME = dir;
  return dir;
}

function validConfig(): BridgeConfig {
  return {
    version: 1,
    baseUrl: "https://aifight.ai",
    wsUrl: "wss://aifight.ai/api/ws",
    agentId: "agent-stopstart",
    agentName: "StopStart Agent",
    apiKey: "sk-not-a-real-key",
    runtimeType: "direct",
    runtimeLocalUrl: "direct://local",
    runtimeLocalToken: "token-not-real",
    updatedAt: "2026-07-26T00:00:00.000Z",
  };
}

beforeEach(() => {
  runners.length = 0;
  holdStart = false;
  abortLoses = false;
  freshHome();
  writeBridgeConfig(validConfig());
});

afterEach(() => {
  holdStart = false;
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  if (ORIGINAL_HOME === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
  else process.env.AIFIGHT_RUNTIME_HOME = ORIGINAL_HOME;
});

/** Rejects if the promise does not settle within ms — the "hung invoke" probe. */
function withinMs<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
      t.unref?.();
    }),
  ]);
}

describe("stop() during start's engine-import window (server unreachable)", () => {
  it("settles promptly instead of waiting out the server outage", async () => {
    holdStart = true;
    const host = new BridgeHost();

    // Call start WITHOUT awaiting: its synchronous prefix runs through config
    // read + seat acquire and suspends at the engine import — the exact window
    // where #runner is still null. stop() lands there.
    const startP = host.start();
    const stopped = await withinMs(host.stop(), 2000, "stop() during import window");
    expect(stopped.phase).toBe("stopped");

    // The start the user aborted must ALSO settle (renderer awaits it too), and
    // must not report the bridge as running.
    const started = await withinMs(startP, 2000, "the aborted start()");
    expect(started.phase).not.toBe("running");
  });

  it("wins over the pending start: no zombie connect when the server returns", async () => {
    holdStart = true;
    const host = new BridgeHost();

    const startP = host.start();
    await withinMs(host.stop(), 2000, "stop()");

    // "Hours later, the server comes back": every runner's gate opens. A fixed
    // host either never called start() on the runner, or stopped it right after.
    for (const r of runners) r.releaseStart();
    await withinMs(startP, 2000, "start() after the server returned");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(host.getStatus().phase).not.toBe("running");
    for (const r of runners) {
      expect(
        !r.started || r.stopped,
        "a runner the user stopped went (or stayed) live after the server returned",
      ).toBe(true);
    }

    // And the machine seat must be free — a hung/half stop that keeps the lock
    // locks the user out of their own agent (CLI service can never take over).
    const lockDir = process.env.AIFIGHT_RUNTIME_HOME!;
    const seatFiles = fs
      .readdirSync(lockDir, { recursive: true, encoding: "utf8" })
      .filter((f) => f.includes("lock"));
    expect(seatFiles, "seat lock still held after stop() settled").toEqual([]);
  });

  it("never reports running when the connect beats the abort (checkpoint 2)", async () => {
    // The OTHER window: stop() lands while runner.start() is pending, its abort
    // is fired — but the welcome frame wins the race and start() resolves
    // anyway. stop()'s own tail would clean this up eventually, but between the
    // two the host would broadcast phase "running" for a session the user had
    // already stopped: the renderer flashes 已连接, and anything keying off the
    // status (matchmaking auto-start) sees a live bridge that is being torn
    // down. The post-start re-check is what closes that gap.
    holdStart = true;
    abortLoses = true;
    const phases: string[] = [];
    const host = new BridgeHost({ onStatus: (st) => phases.push(st.phase) });

    const startP = host.start();
    // Let start() get PAST the import window so #runner is set and pending in
    // runner.start() — the sampled-non-null branch of stop().
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(runners, "start should have constructed the runner by now").toHaveLength(1);
    expect(runners[0].started).toBe(true);

    await withinMs(host.stop(), 2000, "stop() mid-connect");
    await withinMs(startP, 2000, "the raced start()");
    expect(phases).not.toContain("running");
    expect(host.getStatus().phase).toBe("stopped");
    expect(runners[0].stopped).toBe(true);
  });

  it("a fresh start() after the aborted one brings the bridge up again", async () => {
    holdStart = true;
    const host = new BridgeHost();

    const startP = host.start();
    await withinMs(host.stop(), 2000, "stop()");
    for (const r of runners) r.releaseStart();
    await withinMs(startP, 2000, "aborted start");

    // The stop intent must not leak into the NEXT start (flag reset), and the
    // seat must be re-acquirable.
    holdStart = false;
    const restarted = await withinMs(host.start(), 2000, "fresh start()");
    expect(restarted.phase).toBe("running");
  });
});
