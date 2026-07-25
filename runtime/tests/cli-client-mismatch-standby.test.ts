import { describe, expect, it, vi } from "vitest";

import {
  isServerRefusal,
  resetRefusalLogThrottleForTests,
  shouldWriteRefusalLog,
  standByAfterClientMismatch,
  startWithinAttemptWindow,
} from "../src/cli/commands/bridge-run";
import { BridgeClientMismatchError, BridgeDeviceMismatchError } from "../src/bridge/runner";
import type { LockHandle } from "../src/daemon/runtime-files-write";
import type { HandlerEnv } from "../src/cli/shared";

// A supervised `aifight run` that the SERVER refuses (the agent belongs to the
// desktop app) must not exit — launchd/systemd would respawn it every few seconds
// forever. It stands by instead. But standing by while still holding the machine's
// agent lockfile is worse than the restart loop: the app it is waiting for cannot
// start without that lock, so both sides wait and the agent never plays. These
// tests pin the ordering that makes standby safe.

function fakeLock(onRelease: () => void): LockHandle {
  return { release: onRelease } as unknown as LockHandle;
}

function fakeEnv(sink: string[]): HandlerEnv {
  return { stderr: (s: string) => sink.push(s), stdout: () => {} } as unknown as HandlerEnv;
}

describe("standByAfterClientMismatch", () => {
  it("releases the local seat BEFORE it starts waiting", async () => {
    const order: string[] = [];
    const lock = fakeLock(() => order.push("release"));
    const sleepFn = vi.fn(async () => {
      order.push("sleep");
    });

    await standByAfterClientMismatch({
      lock,
      env: fakeEnv([]),
      message: "bound elsewhere",
      waitedMs: 0,
      announcedAtMs: -1,
      sleepFn,
      unlinkFn: () => order.push("unlink"),
    });

    // If release ever moves after the wait, the desktop app is locked out for the
    // whole standby interval and the two clients deadlock.
    expect(order).toEqual(["unlink", "release", "sleep"]);
  });

  it("clears the runtime files it owns, so a stale pid can't strand the next start", async () => {
    const unlinkFn = vi.fn();
    await standByAfterClientMismatch({
      lock: fakeLock(() => {}),
      env: fakeEnv([]),
      message: "bound elsewhere",
      waitedMs: 0,
      announcedAtMs: -1,
      sleepFn: async () => {},
      unlinkFn,
    });
    expect(unlinkFn).toHaveBeenCalledTimes(1);
  });

  it("says why on entry, then stays quiet until the hourly heartbeat", async () => {
    const out: string[] = [];
    const env = fakeEnv(out);
    const step = (waitedMs: number, announcedAtMs: number) =>
      standByAfterClientMismatch({
        lock: fakeLock(() => {}),
        env,
        message: "This agent runs through the AIFight desktop app on this computer.",
        waitedMs,
        announcedAtMs,
        sleepFn: async () => {},
        unlinkFn: () => {},
      });

    let s = await step(0, -1);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("desktop app");
    expect(out[0]).toContain("Standing by");

    // Quiet through the next hour of polling — a log line every minute would bury
    // everything else in the service log.
    for (let i = 0; i < 30; i++) s = await step(s.waitedMs, s.announcedAtMs);
    expect(out).toHaveLength(1);

    // Past the hour it repeats, so a service that has been parked all day is
    // distinguishable from one that has wedged.
    for (let i = 0; i < 31; i++) s = await step(s.waitedMs, s.announcedAtMs);
    expect(out.length).toBeGreaterThan(1);
    expect(out.at(-1)).toContain("Still standing by after");
  });

  it("advances the wait clock by one poll interval per step", async () => {
    const first = await standByAfterClientMismatch({
      lock: fakeLock(() => {}),
      env: fakeEnv([]),
      message: "m",
      waitedMs: 0,
      announcedAtMs: -1,
      sleepFn: async () => {},
      unlinkFn: () => {},
    });
    expect(first.waitedMs).toBeGreaterThan(0);
    const second = await standByAfterClientMismatch({
      lock: fakeLock(() => {}),
      env: fakeEnv([]),
      message: "m",
      waitedMs: first.waitedMs,
      announcedAtMs: first.announcedAtMs,
      sleepFn: async () => {},
      unlinkFn: () => {},
    });
    expect(second.waitedMs).toBe(first.waitedMs * 2);
  });
});

// A supervised service that is refused must also survive the OTHER two failure
// shapes v1 got wrong: holding the machine's seat through a dead network, and
// clutching credentials that a re-pair has already replaced.

describe("isServerRefusal", () => {
  it("treats both refusals as the same terminal answer, and nothing else", () => {
    expect(isServerRefusal(new BridgeClientMismatchError("m", "desktop"))).toBe(true);
    expect(isServerRefusal(new BridgeDeviceMismatchError("m"))).toBe(true);
    // A transient failure must keep its own handling — standing by on a dropped
    // connection would park the service instead of reconnecting.
    expect(isServerRefusal(new Error("fetch failed"))).toBe(false);
    expect(isServerRefusal(undefined)).toBe(false);
  });
});

describe("startWithinAttemptWindow", () => {
  it("reports success when the bridge comes up in time", async () => {
    const runner = { start: vi.fn(async () => ({})), stop: vi.fn(async () => {}) };
    expect(await startWithinAttemptWindow(runner, 1_000)).toBe(true);
    expect(runner.stop).not.toHaveBeenCalled();
  });

  // The reconnect loop never gives up on a transient failure, which is right for
  // a service and wrong while holding the machine's only agent seat: a laptop
  // with no network would sit on it for hours and the desktop app could not
  // start. The attempt is abandoned so the seat can go back.
  it("gives up on an attempt that never resolves", async () => {
    const runner = { start: vi.fn(() => new Promise<never>(() => {})), stop: vi.fn(async () => {}) };
    expect(await startWithinAttemptWindow(runner, 10)).toBe(false);
  });

  // The subtle half: a connect that lands just after we stopped waiting would
  // leave a live socket while another client holds the lock — exactly the
  // two-bridges-one-agent state the lock exists to prevent. So the runner is
  // stopped before the caller is told it may release the seat.
  it("stops the runner before reporting the attempt abandoned", async () => {
    const order: string[] = [];
    const runner = {
      start: vi.fn(() => new Promise<never>(() => {})),
      stop: vi.fn(async () => {
        order.push("stop");
      }),
    };
    const result = await startWithinAttemptWindow(runner, 10);
    order.push("reported");
    expect(result).toBe(false);
    expect(order).toEqual(["stop", "reported"]);
  });

  it("lets a real failure through instead of swallowing it as a timeout", async () => {
    const runner = {
      start: vi.fn(async () => {
        throw new BridgeClientMismatchError("bound elsewhere", "desktop");
      }),
      stop: vi.fn(async () => {}),
    };
    await expect(startWithinAttemptWindow(runner, 1_000)).rejects.toBeInstanceOf(
      BridgeClientMismatchError,
    );
  });
});

describe("refusal log throttle", () => {
  // v1 reprinted the whole dozen-line refusal every minute. launchd does not
  // rotate service logs, so that was 1.4 MB a day of the same paragraph.
  it("says a refusal once, then not again until the hour is up", () => {
    resetRefusalLogThrottleForTests();
    const t0 = 1_000_000;

    expect(shouldWriteRefusalLog("bridge.client_mismatch", t0)).toBe(true);
    for (let m = 1; m <= 59; m++) {
      expect(shouldWriteRefusalLog("bridge.client_mismatch", t0 + m * 60_000)).toBe(false);
    }
    // Past the hour it repeats, so a parked service is distinguishable from a
    // wedged one.
    expect(shouldWriteRefusalLog("bridge.client_mismatch", t0 + 61 * 60_000)).toBe(true);
  });

  it("throttles each refusal kind on its own clock", () => {
    resetRefusalLogThrottleForTests();
    const t0 = 2_000_000;
    expect(shouldWriteRefusalLog("bridge.client_mismatch", t0)).toBe(true);
    // A different refusal is different news and must not be swallowed by the
    // first one's cooldown.
    expect(shouldWriteRefusalLog("bridge.device_mismatch", t0 + 1)).toBe(true);
  });

  it("never throttles ordinary log lines", () => {
    resetRefusalLogThrottleForTests();
    for (let i = 0; i < 50; i++) {
      expect(shouldWriteRefusalLog("bridge.match_complete", 3_000_000 + i)).toBe(true);
    }
  });
});
