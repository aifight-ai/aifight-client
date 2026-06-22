// M1-15 daily scheduler tests — Step 2 covers Group 1 (happy),
// Group 6 (error / lifecycle), Group 7 (stop / cleanup). Step 3 will
// add Group 2 (disabled / no-quota), Group 3 (agent state gating),
// Group 4 (health check), Group 5 (minInterval / sleep-wake / timezone),
// Group 8 (no duplicate timer / single in-flight).
//
// Tests use injected fake clock + agent stub + healthCheck mock — never
// vi.useFakeTimers (M1-15 rev1 decision #14 lock).

import { describe, expect, it, vi } from "vitest";

import {
  createDailyScheduler,
  DailySchedulerError,
  type SchedulerAgentTarget,
  type SchedulerClock,
  type SchedulerTimerHandle,
} from "../src/scheduler/daily";
import type {
  DailyScheduleConfig,
  DailySchedulerNotifyEvent,
} from "../src/scheduler/types";
import type { AgentInstanceSnapshot } from "../src/agents/agent";

// ─── Fake clock fixture ──────────────────────────────────────────────────

interface FakeClockHandle {
  readonly clock: SchedulerClock;
  advance(deltaMs: number): void;
  setNow(ms: number): void;
  now(): number;
  pendingTimerCount(): number;
}

function makeFakeClock(
  initialMs: number = Date.UTC(2026, 3, 27, 12, 0, 0),
): FakeClockHandle {
  let nowMs = initialMs;
  const timers = new Map<
    number,
    { fireAt: number; cb: () => void }
  >();
  let nextHandle = 1;
  const handle: FakeClockHandle = {
    clock: {
      now: () => nowMs,
      setTimeout: (cb, ms) => {
        const h = nextHandle++;
        timers.set(h, {
          fireAt: nowMs + Math.max(0, Math.floor(ms)),
          cb,
        });
        return h;
      },
      clearTimeout: (h: SchedulerTimerHandle) => {
        if (typeof h === "number") timers.delete(h);
      },
    },
    advance(deltaMs) {
      const target = nowMs + deltaMs;
      let safety = 200_000;
      while (safety-- > 0) {
        let nextFireAt = Infinity;
        let nextHandleId: number | null = null;
        for (const [h, t] of timers) {
          if (t.fireAt < nextFireAt) {
            nextFireAt = t.fireAt;
            nextHandleId = h;
          }
        }
        if (nextHandleId === null || nextFireAt > target) break;
        nowMs = nextFireAt;
        const t = timers.get(nextHandleId)!;
        timers.delete(nextHandleId);
        t.cb();
      }
      nowMs = target;
    },
    setNow(ms) {
      nowMs = ms;
    },
    now() {
      return nowMs;
    },
    pendingTimerCount() {
      return timers.size;
    },
  };
  return handle;
}

async function flushAsync(): Promise<void> {
  // Drain pending microtasks (chained awaits inside fire()).
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

// ─── Agent stub fixture ──────────────────────────────────────────────────

function makeConnectedSnapshot(
  name = "test-agent",
  overrides: Partial<AgentInstanceSnapshot> = {},
): AgentInstanceSnapshot {
  const base: AgentInstanceSnapshot = {
    name,
    started: true,
    stopped: false,
    state: {
      phase: "connected",
      transport: "connected",
      agentId: "agent-1",
      agentName: name,
      availableGames: ["texas_holdem", "liars_dice", "coup"],
      autoConfirmMatches: false,
    },
    transport: "connected",
  };
  return { ...base, ...overrides };
}

interface AgentStubHandle {
  readonly stub: SchedulerAgentTarget;
  readonly joinQueue: ReturnType<typeof vi.fn>;
  readonly snapshot: ReturnType<typeof vi.fn>;
  readonly onState: ReturnType<typeof vi.fn>;
  triggerStateChange(snap: AgentInstanceSnapshot): void;
  handlerCount(): number;
}

function makeAgentStub(
  opts: {
    name?: string;
    snapshotImpl?: () => AgentInstanceSnapshot;
    joinQueueImpl?: (game: string, mode?: string) => void;
  } = {},
): AgentStubHandle {
  const name = opts.name ?? "test-agent";
  const handlers = new Set<(snap: AgentInstanceSnapshot) => void>();
  const snapshotImpl =
    opts.snapshotImpl ?? (() => makeConnectedSnapshot(name));

  const joinQueue = vi.fn((game: string, mode?: string) => {
    if (opts.joinQueueImpl) opts.joinQueueImpl(game, mode);
  });
  const snapshot = vi.fn(snapshotImpl);
  const onState = vi.fn(
    (h: (snap: AgentInstanceSnapshot) => void) => {
      handlers.add(h);
      return () => {
        handlers.delete(h);
      };
    },
  );

  return {
    stub: { name, joinQueue, snapshot, onState },
    joinQueue,
    snapshot,
    onState,
    triggerStateChange(snap) {
      for (const h of handlers) h(snap);
    },
    handlerCount() {
      return handlers.size;
    },
  };
}

function captureNotify() {
  const events: DailySchedulerNotifyEvent[] = [];
  return {
    onNotify: (event: DailySchedulerNotifyEvent) => {
      events.push(event);
    },
    events,
    codes: () => events.map((e) => e.code),
    clear: () => {
      events.length = 0;
    },
  };
}

// ─── Default config builders ─────────────────────────────────────────────

function texasOnlyCfg(count = 3, minIntervalSec = 60): DailyScheduleConfig {
  return {
    enabled: true,
    timezone: "UTC",
    days: { texas_holdem: { count } },
    minIntervalSec,
  };
}

// ─── Group 1 — happy path (6 case) ───────────────────────────────────────

describe("DailyScheduler — Group 1 happy path", () => {
  it("case 1: start + first fire calls joinQueue once and decrements quota", async () => {
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub();
    const notify = captureNotify();

    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      initialSchedule: texasOnlyCfg(3, 60),
    });

    scheduler.start();
    expect(notify.codes()).toContain("started");

    fakeClock.advance(2);
    await flushAsync();

    expect(agent.joinQueue).toHaveBeenCalledTimes(1);
    expect(agent.joinQueue).toHaveBeenCalledWith("texas_holdem");
    expect(notify.codes()).toContain("join_attempted");
    expect(notify.codes()).toContain("join_succeeded");
    expect(scheduler.snapshot().remaining.texas_holdem).toBe(2);
    scheduler.stop();
  });

  it("case 2: cursor round-robin alternates texas_holdem / liars_dice over 5 fires", async () => {
    // Use a generous cap so 5 fires complete well within the day window
    // (evenSpace ≈ day / 50 ≈ 28.8 min × 5 fires ≈ 2.4h ≪ 24h). We're
    // testing the cursor alternation, not quota exhaustion (Group 2 case
    // 9 covers skip_no_quota).
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub();
    const notify = captureNotify();

    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      initialSchedule: {
        enabled: true,
        timezone: "UTC",
        days: {
          texas_holdem: { count: 30 },
          liars_dice: { count: 20 },
        },
        minIntervalSec: 0,
      },
    });

    scheduler.start();
    for (let i = 0; i < 5; i++) {
      const snap = scheduler.snapshot();
      const delay = Math.max(1, snap.nextFireInMs ?? 1);
      fakeClock.advance(delay);
      await flushAsync();
    }

    const calls = agent.joinQueue.mock.calls.map((c) => c[0]);
    expect(calls).toEqual([
      "texas_holdem",
      "liars_dice",
      "texas_holdem",
      "liars_dice",
      "texas_holdem",
    ]);
    // Cursor advanced precisely 3 texas + 2 liars (no day rollover).
    expect(scheduler.snapshot().remaining.texas_holdem).toBe(27);
    expect(scheduler.snapshot().remaining.liars_dice).toBe(18);
    scheduler.stop();
  });

  it("case 3: setSchedule replaces config; subsequent fire uses new game", async () => {
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub();
    const notify = captureNotify();

    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      initialSchedule: texasOnlyCfg(3, 0),
    });
    scheduler.start();
    fakeClock.advance(2);
    await flushAsync();
    expect(agent.joinQueue.mock.calls[0]?.[0]).toBe("texas_holdem");

    notify.clear();
    scheduler.setSchedule({
      enabled: true,
      timezone: "UTC",
      days: { liars_dice: { count: 2 } },
      minIntervalSec: 0,
    });
    expect(notify.codes()).toContain("schedule_changed");

    const snap = scheduler.snapshot();
    fakeClock.advance(Math.max(1, snap.nextFireInMs ?? 1));
    await flushAsync();

    expect(agent.joinQueue.mock.calls.at(-1)?.[0]).toBe("liars_dice");
    scheduler.stop();
  });

  it("case 4: agent connected at start → first fire goes through immediately", async () => {
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub();
    const notify = captureNotify();

    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      initialSchedule: texasOnlyCfg(1, 0),
    });

    scheduler.start();
    fakeClock.advance(1);
    await flushAsync();

    expect(agent.joinQueue).toHaveBeenCalledTimes(1);
    expect(notify.codes()).toContain("join_succeeded");
    scheduler.stop();
  });

  it("case 5: healthCheck resolved true → join proceeds", async () => {
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub();
    const notify = captureNotify();
    const healthCheck = vi.fn(async () => true);

    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      healthCheck,
      initialSchedule: texasOnlyCfg(1, 0),
    });

    scheduler.start();
    fakeClock.advance(1);
    await flushAsync();

    expect(healthCheck).toHaveBeenCalledTimes(1);
    expect(agent.joinQueue).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("case 6: snapshot.nextFireInMs reflects upcoming fire delay", async () => {
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub();
    const notify = captureNotify();

    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      initialSchedule: texasOnlyCfg(2, 60),
    });

    scheduler.start();
    let snap = scheduler.snapshot();
    expect(snap.nextFireInMs).not.toBeNull();
    expect(snap.nextFireInMs).toBeGreaterThan(0);
    expect(snap.nextFireInMs).toBeLessThanOrEqual(1);

    fakeClock.advance(2);
    await flushAsync();

    snap = scheduler.snapshot();
    expect(snap.nextFireInMs).not.toBeNull();
    // After first fire delay = max(60_000, evenSpaceMs).
    expect(snap.nextFireInMs).toBeGreaterThanOrEqual(60_000);
    scheduler.stop();
  });
});

// ─── Group 6 — error / lifecycle (8 case) ────────────────────────────────

describe("DailyScheduler — Group 6 error / lifecycle", () => {
  it("case 28a: createDailyScheduler with invalid timezone throws DailySchedulerError(invalid_timezone)", () => {
    const agent = makeAgentStub();
    expect(() =>
      createDailyScheduler({
        agent: agent.stub,
        initialSchedule: {
          enabled: true,
          timezone: "Not/A_Real_Zone",
          days: { texas_holdem: { count: 1 } },
        },
      }),
    ).toThrow(DailySchedulerError);
  });

  it("case 28b: setSchedule with invalid timezone throws DailySchedulerError(invalid_timezone)", () => {
    const agent = makeAgentStub();
    const scheduler = createDailyScheduler({ agent: agent.stub });
    let caught: unknown = null;
    try {
      scheduler.setSchedule({
        enabled: true,
        timezone: "Mars/Olympus_Mons",
        days: { texas_holdem: { count: 1 } },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DailySchedulerError);
    expect((caught as DailySchedulerError).kind).toBe("invalid_timezone");
  });

  it("case 29: setSchedule rejects negative / NaN / non-integer counts", () => {
    const agent = makeAgentStub();
    const scheduler = createDailyScheduler({ agent: agent.stub });
    for (const count of [-1, Number.NaN, 1.5]) {
      let caught: unknown = null;
      try {
        scheduler.setSchedule({
          enabled: true,
          timezone: "UTC",
          days: { texas_holdem: { count } },
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(DailySchedulerError);
      expect((caught as DailySchedulerError).kind).toBe("invalid_count");
    }
  });

  it("case 30: setSchedule rejects negative minIntervalSec", () => {
    const agent = makeAgentStub();
    const scheduler = createDailyScheduler({ agent: agent.stub });
    let caught: unknown = null;
    try {
      scheduler.setSchedule({
        enabled: true,
        timezone: "UTC",
        days: { texas_holdem: { count: 1 } },
        minIntervalSec: -10,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DailySchedulerError);
    expect((caught as DailySchedulerError).kind).toBe("invalid_min_interval");
  });

  it("case 31: start() called twice throws invalid_state", () => {
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub();
    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      initialSchedule: texasOnlyCfg(1, 0),
    });
    scheduler.start();
    let caught: unknown = null;
    try {
      scheduler.start();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DailySchedulerError);
    expect((caught as DailySchedulerError).kind).toBe("invalid_state");
    scheduler.stop();
  });

  it("case 32: stop() before start() is a no-op (idempotent + still startable)", () => {
    const agent = makeAgentStub();
    const fakeClock = makeFakeClock();
    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      initialSchedule: texasOnlyCfg(1, 0),
    });
    expect(() => scheduler.stop()).not.toThrow();
    expect(() => scheduler.stop()).not.toThrow();
    // Pre-start stop must not poison state — start should still succeed.
    expect(() => scheduler.start()).not.toThrow();
    scheduler.stop();
  });

  it("case 33: agent.joinQueue throw → notify(join_threw); quota unchanged; reschedules", async () => {
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub({
      joinQueueImpl: () => {
        throw new Error("network blip");
      },
    });
    const notify = captureNotify();
    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      initialSchedule: texasOnlyCfg(2, 0),
    });

    scheduler.start();
    fakeClock.advance(1);
    await flushAsync();

    expect(notify.codes()).toContain("join_threw");
    expect(scheduler.snapshot().remaining.texas_holdem).toBe(2);
    expect(scheduler.snapshot().nextFireInMs).not.toBeNull();
    expect(scheduler.snapshot().running).toBe(true);
    // join_threw outcome captured in lastAttempt (cursor stays untouched).
    const attempt = scheduler.snapshot().lastAttempt;
    expect(attempt?.outcome).toBe("join_threw");
    expect(attempt?.game).toBe("texas_holdem");
    scheduler.stop();
  });

  it("case 34: agent.snapshot throw → notify(snapshot_threw); quota unchanged; reschedules", async () => {
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub({
      snapshotImpl: () => {
        throw new Error("snapshot bug");
      },
    });
    const notify = captureNotify();
    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      initialSchedule: texasOnlyCfg(2, 0),
    });
    scheduler.start();
    fakeClock.advance(1);
    await flushAsync();

    expect(notify.codes()).toContain("snapshot_threw");
    expect(scheduler.snapshot().remaining.texas_holdem).toBe(2);
    expect(scheduler.snapshot().nextFireInMs).not.toBeNull();
    expect(scheduler.snapshot().running).toBe(true);
    scheduler.stop();
  });

  it("case 35: clock.now() throw inside fire → notify(internal_error) + scheduler auto-stops", async () => {
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub();
    const notify = captureNotify();

    let nowCalls = 0;
    const wrappedClock: SchedulerClock = {
      now: () => {
        nowCalls++;
        // 1st call = scheduleNext(1) inside start() — must succeed so we
        // can register the timer that triggers fire. 2nd call = fire body
        // const nowMs = clock.now() — that's where we want to throw.
        if (nowCalls >= 2) throw new Error("clock blew up");
        return fakeClock.now();
      },
      setTimeout: fakeClock.clock.setTimeout,
      clearTimeout: fakeClock.clock.clearTimeout,
    };

    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: wrappedClock,
      onNotify: notify.onNotify,
      initialSchedule: texasOnlyCfg(2, 0),
    });
    scheduler.start();
    fakeClock.advance(2);
    await flushAsync();

    expect(notify.codes()).toContain("internal_error");
    expect(notify.codes()).toContain("stopped");
    expect(scheduler.snapshot().running).toBe(false);
  });
});

// ─── Group 7 — stop / cleanup (3 case) ──────────────────────────────────

describe("DailyScheduler — Group 7 stop / cleanup", () => {
  it("case 36: stop() clears all timers (joinQueue not called after stop)", async () => {
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub();
    const notify = captureNotify();

    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      initialSchedule: texasOnlyCfg(5, 0),
    });

    scheduler.start();
    fakeClock.advance(1);
    await flushAsync();
    const callsBefore = agent.joinQueue.mock.calls.length;
    expect(callsBefore).toBe(1);

    scheduler.stop();
    // Advance 24h — would fire 4 more times if scheduler were alive.
    fakeClock.advance(86_400_000);
    await flushAsync();
    expect(agent.joinQueue.mock.calls.length).toBe(callsBefore);
    expect(fakeClock.pendingTimerCount()).toBe(0);
  });

  it("case 37: stop() releases agent.onState subscription", () => {
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub();
    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      initialSchedule: texasOnlyCfg(1, 0),
    });
    scheduler.start();
    expect(agent.handlerCount()).toBe(1);
    scheduler.stop();
    expect(agent.handlerCount()).toBe(0);
  });

  it("case 38: stop() during in-flight healthCheck cancels join", async () => {
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub();
    const notify = captureNotify();
    let resolveHealth!: (b: boolean) => void;
    const healthPromise = new Promise<boolean>((r) => {
      resolveHealth = r;
    });
    const healthCheck = vi.fn(() => healthPromise);

    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      healthCheck,
      initialSchedule: texasOnlyCfg(1, 0),
    });
    scheduler.start();
    fakeClock.advance(2);
    // Yield enough for fire() to reach `await healthCheck()`.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(healthCheck).toHaveBeenCalledTimes(1);

    scheduler.stop();
    resolveHealth(true);
    await flushAsync();

    expect(agent.joinQueue).not.toHaveBeenCalled();
    expect(scheduler.snapshot().running).toBe(false);
  });
});

// ─── Group 2 — disabled / no-quota (5 case) ─────────────────────────────

describe("DailyScheduler — Group 2 disabled / no-quota", () => {
  it("case 7: enabled=false → repeated skip_disabled, joinQueue never called", async () => {
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub();
    const notify = captureNotify();
    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      initialSchedule: {
        enabled: false,
        timezone: "UTC",
        days: { texas_holdem: { count: 3 } },
      },
    });
    scheduler.start();
    fakeClock.advance(1);
    await flushAsync();
    fakeClock.advance(60_000);
    await flushAsync();

    const skipCount = notify.events.filter((e) => e.code === "skip_disabled")
      .length;
    expect(skipCount).toBeGreaterThanOrEqual(2);
    expect(agent.joinQueue).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it("case 8: days={} → skip_disabled (rev3 fix #5: NOT skip_no_quota)", async () => {
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub();
    const notify = captureNotify();
    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      initialSchedule: {
        enabled: true,
        timezone: "UTC",
        days: {},
      },
    });
    scheduler.start();
    fakeClock.advance(1);
    await flushAsync();

    expect(notify.codes()).toContain("skip_disabled");
    expect(notify.codes()).not.toContain("skip_no_quota");
    expect(agent.joinQueue).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it("case 9: non-empty days but quota exhausted → skip_no_quota (NOT skip_disabled)", async () => {
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub();
    const notify = captureNotify();
    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      initialSchedule: {
        enabled: true,
        timezone: "UTC",
        days: { texas_holdem: { count: 100 } }, // big cap → no day rollover
        minIntervalSec: 0,
      },
    });
    scheduler.start();
    // Fire twice (within day 1 — evenSpace ≈ 7min × 2 ≪ 12h).
    for (let i = 0; i < 2; i++) {
      const snap = scheduler.snapshot();
      fakeClock.advance(Math.max(1, snap.nextFireInMs ?? 1));
      await flushAsync();
    }
    expect(agent.joinQueue.mock.calls.length).toBe(2);

    // Shrink cap to exactly used (=2) so quota is exhausted. setSchedule
    // reschedules the timer to ~midnight+1s (no-quota path), but we
    // don't want to cross the day boundary. Force a quick re-fire via
    // state subscription so fire body runs in day 1 with quota=0.
    scheduler.setSchedule({
      enabled: true,
      timezone: "UTC",
      days: { texas_holdem: { count: 2 } },
      minIntervalSec: 0,
    });

    notify.clear();
    agent.triggerStateChange(makeConnectedSnapshot("test-agent"));
    fakeClock.advance(2);
    await flushAsync();

    expect(notify.codes()).toContain("skip_no_quota");
    expect(notify.codes()).not.toContain("skip_disabled");
    expect(agent.joinQueue.mock.calls.length).toBe(2);
    scheduler.stop();
  });

  it("case 10: day rollover → notify(day_rolled_over) + quota reset", async () => {
    // Start near midnight with cap=2 so fire 1 lands in day 1 and fire 2's
    // timer is scheduled directly into day 2 (evenSpace = remainingDay).
    const startMs = Date.UTC(2026, 3, 27, 23, 59, 30); // 23:59:30Z
    const fakeClock = makeFakeClock(startMs);
    const agent = makeAgentStub();
    const notify = captureNotify();
    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      initialSchedule: {
        enabled: true,
        timezone: "UTC",
        days: { texas_holdem: { count: 2 } },
        minIntervalSec: 0,
      },
    });
    scheduler.start();
    fakeClock.advance(1);
    await flushAsync();
    expect(scheduler.snapshot().today).toBe("2026-04-27");
    expect(scheduler.snapshot().remaining.texas_holdem).toBe(1);
    notify.clear();

    // Advance 1 minute (past midnight UTC). fire 2 timer is at ~24:00:00Z;
    // it will trigger inside advance() in day 2.
    fakeClock.advance(60_000);
    await flushAsync();
    expect(notify.codes()).toContain("day_rolled_over");
    expect(scheduler.snapshot().today).toBe("2026-04-28");
    // Quota reset and day-2 fire 1 used 1 → remaining 1.
    expect(scheduler.snapshot().remaining.texas_holdem).toBe(1);
    scheduler.stop();
  });

  it("case 11: count=0 game is skipped by cursor; non-zero game still fires", async () => {
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub();
    const notify = captureNotify();
    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      initialSchedule: {
        enabled: true,
        timezone: "UTC",
        days: {
          texas_holdem: { count: 0 }, // explicit zero → skip
          liars_dice: { count: 30 },
        },
        minIntervalSec: 0,
      },
    });
    scheduler.start();
    for (let i = 0; i < 3; i++) {
      const snap = scheduler.snapshot();
      fakeClock.advance(Math.max(1, snap.nextFireInMs ?? 1));
      await flushAsync();
    }
    const calls = agent.joinQueue.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["liars_dice", "liars_dice", "liars_dice"]);
    scheduler.stop();
  });
});

// ─── Group 3 — agent state gating (7 case) ──────────────────────────────

describe("DailyScheduler — Group 3 agent state gating", () => {
  function snapshotWithState(
    overrides: Partial<AgentInstanceSnapshot>,
  ): AgentInstanceSnapshot {
    return makeConnectedSnapshot("test-agent", overrides);
  }

  it("case 12: snap.started=false → skip_agent_not_started + no quota consumed", async () => {
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub({
      snapshotImpl: () => snapshotWithState({ started: false }),
    });
    const notify = captureNotify();
    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      initialSchedule: texasOnlyCfg(2, 0),
    });
    scheduler.start();
    fakeClock.advance(1);
    await flushAsync();
    expect(notify.codes()).toContain("skip_agent_not_started");
    expect(agent.joinQueue).not.toHaveBeenCalled();
    expect(scheduler.snapshot().remaining.texas_holdem).toBe(2);
    scheduler.stop();
  });

  it("case 13: snap.stopped=true → skip_agent_stopped + no quota consumed", async () => {
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub({
      snapshotImpl: () => snapshotWithState({ stopped: true }),
    });
    const notify = captureNotify();
    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      initialSchedule: texasOnlyCfg(2, 0),
    });
    scheduler.start();
    fakeClock.advance(1);
    await flushAsync();
    expect(notify.codes()).toContain("skip_agent_stopped");
    expect(agent.joinQueue).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it("case 14: snap.state=null (welcome not received) → skip_state_unavailable", async () => {
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub({
      snapshotImpl: () => snapshotWithState({ state: null }),
    });
    const notify = captureNotify();
    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      initialSchedule: texasOnlyCfg(2, 0),
    });
    scheduler.start();
    fakeClock.advance(1);
    await flushAsync();
    expect(notify.codes()).toContain("skip_state_unavailable");
    expect(agent.joinQueue).not.toHaveBeenCalled();
    expect(scheduler.snapshot().remaining.texas_holdem).toBe(2);
    scheduler.stop();
  });

  it("case 15: snap.transport non-connected (connecting/backoff/closed/idle) → skip_transport_disconnected", async () => {
    for (const transport of ["connecting", "backoff", "closed", "idle"] as const) {
      const fakeClock = makeFakeClock();
      const agent = makeAgentStub({
        snapshotImpl: () => snapshotWithState({ transport }),
      });
      const notify = captureNotify();
      const scheduler = createDailyScheduler({
        agent: agent.stub,
        clock: fakeClock.clock,
        onNotify: notify.onNotify,
        initialSchedule: texasOnlyCfg(2, 0),
      });
      scheduler.start();
      fakeClock.advance(1);
      await flushAsync();
      expect(notify.codes()).toContain("skip_transport_disconnected");
      expect(agent.joinQueue).not.toHaveBeenCalled();
      scheduler.stop();
    }
  });

  it("case 16: snap.state.phase=in_match → skip_state_busy", async () => {
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub({
      snapshotImpl: () => snapshotWithState({
        state: {
          phase: "in_match",
          transport: "connected",
          agentId: "agent-1",
          agentName: "test-agent",
          availableGames: ["texas_holdem"],
          autoConfirmMatches: false,
          activeMatch: {
            sessionId: "sess-1",
            game: "texas_holdem",
            startedAt: 0,
          },
        },
      }),
    });
    const notify = captureNotify();
    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      initialSchedule: texasOnlyCfg(2, 0),
    });
    scheduler.start();
    fakeClock.advance(1);
    await flushAsync();
    expect(notify.codes()).toContain("skip_state_busy");
    expect(agent.joinQueue).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it("case 17: snap.state.phase = queuing/confirming/matching/deciding/reporting/closed → skip_state_busy", async () => {
    for (const phase of [
      "queuing",
      "confirming",
      "matching",
      "deciding",
      "reporting",
      "closed",
    ] as const) {
      const fakeClock = makeFakeClock();
      const agent = makeAgentStub({
        snapshotImpl: () => snapshotWithState({
          state: {
            phase,
            transport: "connected",
            agentId: "agent-1",
            agentName: "test-agent",
            availableGames: ["texas_holdem"],
            autoConfirmMatches: false,
          },
        }),
      });
      const notify = captureNotify();
      const scheduler = createDailyScheduler({
        agent: agent.stub,
        clock: fakeClock.clock,
        onNotify: notify.onNotify,
        initialSchedule: texasOnlyCfg(2, 0),
      });
      scheduler.start();
      fakeClock.advance(1);
      await flushAsync();
      expect(notify.codes()).toContain("skip_state_busy");
      expect(agent.joinQueue).not.toHaveBeenCalled();
      scheduler.stop();
    }
  });

  it("case 18: state phase transitions in_match → connected via onState → quick-fire", async () => {
    const fakeClock = makeFakeClock();
    let phaseRef: "in_match" | "connected" = "in_match";
    const agent = makeAgentStub({
      snapshotImpl: () =>
        makeConnectedSnapshot("test-agent", {
          state: {
            phase: phaseRef,
            transport: "connected",
            agentId: "agent-1",
            agentName: "test-agent",
            availableGames: ["texas_holdem"],
            autoConfirmMatches: false,
          },
        }),
    });
    const notify = captureNotify();
    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      initialSchedule: texasOnlyCfg(2, 0),
    });
    scheduler.start();
    fakeClock.advance(1);
    await flushAsync();
    expect(notify.codes()).toContain("skip_state_busy");
    expect(agent.joinQueue).not.toHaveBeenCalled();

    // Flip phase + emit state change → should reschedule a quick fire.
    phaseRef = "connected";
    agent.triggerStateChange(
      makeConnectedSnapshot("test-agent", {
        state: {
          phase: "connected",
          transport: "connected",
          agentId: "agent-1",
          agentName: "test-agent",
          availableGames: ["texas_holdem"],
          autoConfirmMatches: false,
        },
      }),
    );

    fakeClock.advance(2); // pick up the 1ms quick-fire timer
    await flushAsync();
    expect(agent.joinQueue).toHaveBeenCalledTimes(1);
    expect(agent.joinQueue).toHaveBeenCalledWith("texas_holdem");
    scheduler.stop();
  });
});

// ─── Group 4 — health check (3 case) ────────────────────────────────────

describe("DailyScheduler — Group 4 health check", () => {
  it("case 19: healthCheck returns false → skip_health_check + no quota consumed", async () => {
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub();
    const notify = captureNotify();
    const healthCheck = vi.fn(async () => false);
    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      healthCheck,
      initialSchedule: texasOnlyCfg(2, 0),
    });
    scheduler.start();
    fakeClock.advance(1);
    await flushAsync();
    expect(notify.codes()).toContain("skip_health_check");
    expect(agent.joinQueue).not.toHaveBeenCalled();
    expect(scheduler.snapshot().remaining.texas_holdem).toBe(2);
    scheduler.stop();
  });

  it("case 20: healthCheck throws → health_check_threw notify + no propagation + no quota", async () => {
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub();
    const notify = captureNotify();
    const healthCheck = vi.fn(async () => {
      throw new Error("provider down");
    });
    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      healthCheck,
      initialSchedule: texasOnlyCfg(2, 0),
    });
    scheduler.start();
    fakeClock.advance(1);
    await flushAsync();
    expect(notify.codes()).toContain("health_check_threw");
    expect(notify.codes()).not.toContain("internal_error");
    expect(agent.joinQueue).not.toHaveBeenCalled();
    expect(scheduler.snapshot().remaining.texas_holdem).toBe(2);
    expect(scheduler.snapshot().running).toBe(true);
    scheduler.stop();
  });

  it("case 21: healthCheck not provided (undefined) → skips health probe and joins directly", async () => {
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub();
    const notify = captureNotify();
    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      // no healthCheck
      initialSchedule: texasOnlyCfg(2, 0),
    });
    scheduler.start();
    fakeClock.advance(1);
    await flushAsync();
    expect(agent.joinQueue).toHaveBeenCalledTimes(1);
    expect(notify.codes()).toContain("join_succeeded");
    expect(notify.codes()).not.toContain("skip_health_check");
    expect(notify.codes()).not.toContain("health_check_threw");
    scheduler.stop();
  });
});

// ─── Group 5 — minInterval / sleep-wake / timezone (6 case) ─────────────

describe("DailyScheduler — Group 5 minInterval / sleep-wake / timezone", () => {
  it("case 22: minInterval gate short-circuits when fires would be too close", async () => {
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub();
    const notify = captureNotify();
    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      initialSchedule: {
        enabled: true,
        timezone: "UTC",
        days: { texas_holdem: { count: 100 } },
        minIntervalSec: 0,
      },
    });
    scheduler.start();
    fakeClock.advance(1);
    await flushAsync();
    expect(agent.joinQueue).toHaveBeenCalledTimes(1);

    // Bump minInterval to 1h. setSchedule alone reschedules to a far-future
    // timer (evenSpace ≈ 7min, minInterval=3600s → 1h). Force a quick
    // re-fire via state subscription so fire body runs while still inside
    // the minInterval window (only ~1ms after fire 1).
    scheduler.setSchedule({
      enabled: true,
      timezone: "UTC",
      days: { texas_holdem: { count: 100 } },
      minIntervalSec: 3600,
    });
    notify.clear();
    agent.triggerStateChange(makeConnectedSnapshot("test-agent"));
    fakeClock.advance(2);
    await flushAsync();

    expect(notify.codes()).toContain("skip_min_interval");
    expect(agent.joinQueue).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("case 23: sleep 6h does NOT burst-backfill multiple fires", async () => {
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub();
    const notify = captureNotify();
    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      initialSchedule: {
        enabled: true,
        timezone: "UTC",
        days: { texas_holdem: { count: 100 } },
        minIntervalSec: 0,
      },
    });
    scheduler.start();
    // Single jump of 6h. Inside advance(): first cb triggers fire 1
    // (microtask not yet drained) → no second timer registered yet → loop
    // exits at nowMs += 6h.
    fakeClock.advance(6 * 3600_000);
    await flushAsync();
    expect(agent.joinQueue).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("case 24: sleep across day boundary triggers day_rolled_over and quota reset", async () => {
    // cap=2 + start at 23:00Z so fire 2 timer = 24:00:00Z (day 2). The
    // single advance(2h) crosses midnight and the cb fires in day 2.
    const startMs = Date.UTC(2026, 3, 27, 23, 0, 0); // 23:00Z
    const fakeClock = makeFakeClock(startMs);
    const agent = makeAgentStub();
    const notify = captureNotify();
    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      initialSchedule: {
        enabled: true,
        timezone: "UTC",
        days: { texas_holdem: { count: 2 } },
        minIntervalSec: 0,
      },
    });
    scheduler.start();
    fakeClock.advance(1);
    await flushAsync();
    expect(scheduler.snapshot().today).toBe("2026-04-27");

    notify.clear();
    fakeClock.advance(2 * 3600_000);
    await flushAsync();
    expect(notify.codes()).toContain("day_rolled_over");
    expect(scheduler.snapshot().today).toBe("2026-04-28");
    scheduler.stop();
  });

  it("case 25: minIntervalSec defaults to 60 when caller omits", async () => {
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub();
    const notify = captureNotify();
    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      initialSchedule: {
        enabled: true,
        timezone: "UTC",
        days: { texas_holdem: { count: 100 } },
        // no minIntervalSec → default 60
      },
    });
    scheduler.start();
    fakeClock.advance(1);
    await flushAsync();
    // After first fire delay = max(60_000, evenSpace). With cap=100 +
    // remainingDay ~12h, evenSpace ≈ 432_000 ms (7.2 min) > 60_000, so
    // delay = evenSpace. Either way it should be ≥ 60_000.
    const snap = scheduler.snapshot();
    expect(snap.nextFireInMs).not.toBeNull();
    expect(snap.nextFireInMs).toBeGreaterThanOrEqual(60_000);
    scheduler.stop();
  });

  it("case 26: timezone=UTC at 23:30Z + advance 31min crosses local day", async () => {
    // cap=2 + 23:30Z → fire 2 timer ≈ 24:00:00Z (day 2 boundary).
    const startMs = Date.UTC(2026, 3, 27, 23, 30, 0);
    const fakeClock = makeFakeClock(startMs);
    const agent = makeAgentStub();
    const notify = captureNotify();
    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      initialSchedule: {
        enabled: true,
        timezone: "UTC",
        days: { texas_holdem: { count: 2 } },
        minIntervalSec: 0,
      },
    });
    scheduler.start();
    fakeClock.advance(1);
    await flushAsync();
    expect(scheduler.snapshot().today).toBe("2026-04-27");

    notify.clear();
    fakeClock.advance(31 * 60_000);
    await flushAsync();
    expect(notify.codes()).toContain("day_rolled_over");
    expect(scheduler.snapshot().today).toBe("2026-04-28");
    scheduler.stop();
  });

  it("case 27: non-UTC timezones (Asia/Shanghai + America/New_York DST-window) accept and rollover correctly", async () => {
    // Asia/Shanghai (UTC+8, no DST). Start at 15:00 UTC = 23:00 local.
    // cap=2 → fire 2 timer ≈ 16:00 UTC = 00:00 next-day local.
    {
      const startMs = Date.UTC(2026, 3, 27, 15, 0, 0);
      const fakeClock = makeFakeClock(startMs);
      const agent = makeAgentStub();
      const notify = captureNotify();
      const scheduler = createDailyScheduler({
        agent: agent.stub,
        clock: fakeClock.clock,
        onNotify: notify.onNotify,
        initialSchedule: {
          enabled: true,
          timezone: "Asia/Shanghai",
          days: { texas_holdem: { count: 2 } },
          minIntervalSec: 0,
        },
      });
      scheduler.start();
      fakeClock.advance(1);
      await flushAsync();
      expect(scheduler.snapshot().today).toBe("2026-04-27");

      notify.clear();
      fakeClock.advance(2 * 3600_000); // crosses 16:00 UTC = 00:00 local
      await flushAsync();
      expect(notify.codes()).toContain("day_rolled_over");
      expect(scheduler.snapshot().today).toBe("2026-04-28");
      scheduler.stop();
    }

    // America/New_York around DST spring-forward (2026-03-08 02:00 EST → 03:00 EDT).
    // Start at 04:00 UTC on 2026-03-08 (= 23:00 EST on 2026-03-07).
    // cap=2 → fire 2 timer ≈ 05:00 UTC = 00:00 EST next local day.
    {
      const startMs = Date.UTC(2026, 2, 8, 4, 0, 0);
      const fakeClock = makeFakeClock(startMs);
      const agent = makeAgentStub();
      const notify = captureNotify();
      const scheduler = createDailyScheduler({
        agent: agent.stub,
        clock: fakeClock.clock,
        onNotify: notify.onNotify,
        initialSchedule: {
          enabled: true,
          timezone: "America/New_York",
          days: { texas_holdem: { count: 2 } },
          minIntervalSec: 0,
        },
      });
      expect(() => scheduler.start()).not.toThrow();
      fakeClock.advance(1);
      await flushAsync();
      expect(scheduler.snapshot().today).toBe("2026-03-07");

      notify.clear();
      // Sleep 2h. 04:00 UTC + 2h = 06:00 UTC > 05:00 UTC (= 00:00 EST
      // 2026-03-08, day boundary). Local date rolls over to 2026-03-08;
      // the actual DST jump (02:00 EST → 03:00 EDT) happens later on
      // that same local date and does not affect the day boundary
      // computation.
      fakeClock.advance(2 * 3600_000);
      await flushAsync();
      const dayRollovers = notify.events.filter(
        (e) => e.code === "day_rolled_over",
      ).length;
      expect(dayRollovers).toBe(1);
      expect(scheduler.snapshot().today).toBe("2026-03-08");
      scheduler.stop();
    }
  });
});

// ─── Group 8 — no duplicate timer / single in-flight (2 case) ───────────

describe("DailyScheduler — Group 8 no duplicate timer / single in-flight", () => {
  it("case 39: setSchedule during in-flight fire aborts the in-flight join (M1-15 bugfix)", async () => {
    // BEHAVIOR CHANGE: pre-bugfix, the in-flight fire would proceed with
    // the stale cfg captured at fire entry. Post-bugfix (scheduleVersion
    // drift detection), an in-flight setSchedule cancels the would-be
    // join — the new schedule's timer is the sole authority going forward.
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub();
    const notify = captureNotify();
    let resolveHealth!: (b: boolean) => void;
    const healthPromise = new Promise<boolean>((r) => {
      resolveHealth = r;
    });
    const healthCheck = vi.fn(() => healthPromise);
    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      healthCheck,
      initialSchedule: texasOnlyCfg(5, 0),
    });
    scheduler.start();
    fakeClock.advance(2);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(healthCheck).toHaveBeenCalledTimes(1);

    scheduler.setSchedule({
      enabled: true,
      timezone: "UTC",
      days: { texas_holdem: { count: 5 } },
      minIntervalSec: 0,
    });

    resolveHealth(true);
    await flushAsync();

    expect(agent.joinQueue).not.toHaveBeenCalled();
    expect(notify.codes()).not.toContain("join_attempted");
    expect(notify.codes()).not.toContain("join_succeeded");
    scheduler.stop();
  });

  it("case 40: clock advancing past one fire timer triggers exactly one fire", async () => {
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub();
    const notify = captureNotify();
    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      initialSchedule: {
        enabled: true,
        timezone: "UTC",
        days: { texas_holdem: { count: 5 } },
        minIntervalSec: 0,
      },
    });
    scheduler.start();
    // First fire timer is 1ms; jump 100ms past it. Only one cb is in
    // the queue at this point (next timer is registered inside fire's
    // microtask, AFTER the advance loop exits).
    fakeClock.advance(100);
    await flushAsync();
    expect(agent.joinQueue).toHaveBeenCalledTimes(1);

    // Advance another 50ms. Next fire timer fireAt is far in the future
    // (~24h/4 ≈ 6h), so no second fire should occur.
    fakeClock.advance(50);
    await flushAsync();
    expect(agent.joinQueue).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });
});

// ─── Group 9 — schedule version drift / in-flight setSchedule (M1-15 bugfix) ──
//
// Codex post-closeout review caught a race: fire() captured cfg at entry,
// then ran agent.joinQueue with the stale cfg even if setSchedule(null) /
// setSchedule(disabled) / setSchedule(different days) was called while
// fire was suspended on `await healthCheck()`. Fix: scheduleVersion
// counter; fire re-checks at every await boundary and aborts the join +
// suppresses tail scheduleNext when the version drifts.

describe("DailyScheduler — Group 9 schedule version drift (M1-15 bugfix)", () => {
  it("case 41: setSchedule(null) during in-flight healthCheck cancels join + leaves scheduler running disabled-idle", async () => {
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub();
    const notify = captureNotify();
    let resolveHealth!: (b: boolean) => void;
    const healthPromise = new Promise<boolean>((r) => {
      resolveHealth = r;
    });
    const healthCheck = vi.fn(() => healthPromise);
    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      healthCheck,
      initialSchedule: texasOnlyCfg(1, 0),
    });
    scheduler.start();
    fakeClock.advance(2);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(healthCheck).toHaveBeenCalledTimes(1);

    // Schedule cleared mid-flight. Pre-bugfix the fire body would still
    // call agent.joinQueue with the stale "texas_holdem cap=1" cfg.
    scheduler.setSchedule(null);
    resolveHealth(true);
    await flushAsync();

    expect(agent.joinQueue).not.toHaveBeenCalled();
    expect(notify.codes()).not.toContain("join_attempted");
    expect(notify.codes()).not.toContain("join_succeeded");
    expect(scheduler.snapshot().running).toBe(true);
    // Schedule cleared → snapshot.remaining is empty (no game caps to report).
    expect(Object.keys(scheduler.snapshot().remaining)).toHaveLength(0);
    scheduler.stop();
  });

  it("case 42: setSchedule({enabled:false}) during in-flight healthCheck cancels join", async () => {
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub();
    const notify = captureNotify();
    let resolveHealth!: (b: boolean) => void;
    const healthPromise = new Promise<boolean>((r) => {
      resolveHealth = r;
    });
    const healthCheck = vi.fn(() => healthPromise);
    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      healthCheck,
      initialSchedule: texasOnlyCfg(1, 0),
    });
    scheduler.start();
    fakeClock.advance(2);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(healthCheck).toHaveBeenCalledTimes(1);

    scheduler.setSchedule({
      enabled: false,
      timezone: "UTC",
      days: { texas_holdem: { count: 1 } },
      minIntervalSec: 0,
    });
    resolveHealth(true);
    await flushAsync();

    expect(agent.joinQueue).not.toHaveBeenCalled();
    expect(notify.codes()).not.toContain("join_attempted");
    expect(notify.codes()).not.toContain("join_succeeded");
    expect(scheduler.snapshot().running).toBe(true);
    scheduler.stop();
  });

  it("case 43: setSchedule(different game) during in-flight healthCheck cancels old-game join; later quick-fire uses new schedule", async () => {
    const fakeClock = makeFakeClock();
    const agent = makeAgentStub();
    const notify = captureNotify();
    let resolveHealth!: (b: boolean) => void;
    const healthPromise = new Promise<boolean>((r) => {
      resolveHealth = r;
    });
    const healthCheck = vi.fn(() => healthPromise);
    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      healthCheck,
      initialSchedule: texasOnlyCfg(1, 0), // texas_holdem cap=1
    });
    scheduler.start();
    fakeClock.advance(2);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(healthCheck).toHaveBeenCalledTimes(1);

    // Switch to liars_dice mid-flight. The in-flight fire must NOT join
    // texas_holdem.
    scheduler.setSchedule({
      enabled: true,
      timezone: "UTC",
      days: { liars_dice: { count: 1 } },
      minIntervalSec: 0,
    });
    resolveHealth(true);
    await flushAsync();

    // No join with old game.
    expect(agent.joinQueue).not.toHaveBeenCalledWith("texas_holdem");
    expect(agent.joinQueue).not.toHaveBeenCalled();

    // Now force a fresh fire via state subscription (current state is
    // still connected). A new healthCheck promise must be wired in for
    // the second attempt.
    let resolveHealth2!: (b: boolean) => void;
    const healthPromise2 = new Promise<boolean>((r) => {
      resolveHealth2 = r;
    });
    healthCheck.mockImplementationOnce(() => healthPromise2);

    agent.triggerStateChange(makeConnectedSnapshot("test-agent"));
    fakeClock.advance(2);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(healthCheck).toHaveBeenCalledTimes(2);

    resolveHealth2(true);
    await flushAsync();

    // Second fire uses the new schedule → joins liars_dice (only).
    expect(agent.joinQueue).toHaveBeenCalledTimes(1);
    expect(agent.joinQueue).toHaveBeenCalledWith("liars_dice");
    scheduler.stop();
  });
});
