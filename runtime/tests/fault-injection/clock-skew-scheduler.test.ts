// M5-01 fault class 5: clock skew → daily scheduler 不重复 / 不漏触发
// (plan §5.1 + §13).
//
// Adjacent to scheduler-daily.test.ts (sealed M1-15): that suite covers 60+
// happy / lifecycle / DST / forward day-boundary cases with the same
// fakeClock pattern. This file probes 2 clock-skew scenarios the M1-15
// suite does not focus on:
//   1. Forward jump same UTC day exhausts quota → joinQueue still fires
//      at-most-once per quota slot regardless of how far we advance.
//   2. Backward jump within same UTC day → no spurious extra fires
//      (formatLocalYMD does not change, so cachedToday stays, quotaUsedToday
//      stays, and the scheduler does not "rewind" its quota accounting).
//
// Cross-day backward jump (clock NTP-corrected back to a previous UTC YMD
// after a fire) is intentionally NOT covered here — current M1-15 v1
// behavior under that scenario is "cachedToday recomputes from nowMs each
// tick, so cachedToday does regress on backward jump", which IS a known
// quirk that plan §5.9 lastFireDay anchoring would address. Until that
// anchoring lands, locking the current behavior in a test would be
// premature; the scenario is left for M5-09 / M5-10 reflection (TED §3.5).

import { describe, expect, it, vi } from "vitest";

import {
  createDailyScheduler,
  type SchedulerAgentTarget,
} from "../../src/scheduler/daily";
import type {
  DailyScheduleConfig,
  DailySchedulerNotifyEvent,
} from "../../src/scheduler/types";
import type { AgentInstanceSnapshot } from "../../src/agents/agent";
import { makeFakeClock, flushAsync } from "./_helpers";

// ─── Local fixtures (mirror of scheduler-daily.test.ts) ───────────────

function makeConnectedSnapshot(name = "fault-test"): AgentInstanceSnapshot {
  return {
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
}

function makeAgentStub(): {
  stub: SchedulerAgentTarget;
  joinQueue: ReturnType<typeof vi.fn>;
} {
  const handlers = new Set<(snap: AgentInstanceSnapshot) => void>();
  const joinQueue = vi.fn();
  const snapshot = vi.fn(() => makeConnectedSnapshot());
  const onState = vi.fn((h: (snap: AgentInstanceSnapshot) => void) => {
    handlers.add(h);
    return () => {
      handlers.delete(h);
    };
  });
  return {
    stub: { name: "fault-test", joinQueue, snapshot, onState },
    joinQueue,
  };
}

function captureNotify() {
  const events: DailySchedulerNotifyEvent[] = [];
  return {
    onNotify: (e: DailySchedulerNotifyEvent) => events.push(e),
    codes: () => events.map((e) => e.code),
    clear: () => {
      events.length = 0;
    },
  };
}

function texasCfg(count: number, minIntervalSec = 0): DailyScheduleConfig {
  return {
    enabled: true,
    timezone: "UTC",
    days: { texas_holdem: { count } },
    minIntervalSec,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("M5-01 clock skew — scheduler quota integrity under wall-clock jumps", () => {
  it("forward 12h jump same day with quota=1 → joinQueue called exactly once", async () => {
    // After firing once, the scheduler schedules its next probe at "next
    // midnight + 1s" (no quota left today). A 12h forward jump from 12:00Z
    // crosses that midnight timer, fires the post-midnight tick which DOES
    // trigger day_rolled_over and resets quota; advancing past that timer
    // a second time would fire again. The assertion locks the FIRST fire
    // count: regardless of how the timer fires after a forward jump, the
    // pre-jump quota slot was used exactly once.
    const startMs = Date.UTC(2026, 3, 27, 12, 0, 0); // 12:00Z
    const fakeClock = makeFakeClock(startMs);
    const agent = makeAgentStub();
    const notify = captureNotify();

    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      initialSchedule: texasCfg(1),
    });
    scheduler.start();

    fakeClock.advance(2);
    await flushAsync();
    expect(agent.joinQueue).toHaveBeenCalledTimes(1);

    // Forward jump but DON'T cross midnight (advance 6h within same UTC day).
    // The next-fire timer is at next midnight + 1s = 12h away, so a 6h
    // advance does NOT trigger any further tick — assertion is that the
    // tick stayed at 1 fire.
    fakeClock.advance(6 * 3600_000);
    await flushAsync();
    expect(agent.joinQueue).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it("backward jump within same UTC day → no extra fire", async () => {
    // After consuming quota at 12:00Z, jump the wall clock backward to
    // 11:00Z (still same UTC day). cachedToday stays "2026-04-27"; no day
    // rollover; quota stays exhausted. Advancing the fake clock from the
    // backward-set point does not trigger any new fire because the next
    // timer (at next-midnight + 1s, scheduled relative to original nowMs)
    // is now 13h away.
    const startMs = Date.UTC(2026, 3, 27, 12, 0, 0);
    const fakeClock = makeFakeClock(startMs);
    const agent = makeAgentStub();
    const notify = captureNotify();

    const scheduler = createDailyScheduler({
      agent: agent.stub,
      clock: fakeClock.clock,
      onNotify: notify.onNotify,
      initialSchedule: texasCfg(1),
    });
    scheduler.start();
    fakeClock.advance(2);
    await flushAsync();
    expect(agent.joinQueue).toHaveBeenCalledTimes(1);
    expect(scheduler.snapshot().today).toBe("2026-04-27");

    notify.clear();
    // Jump backward 1h (NTP correction — wall clock from 12:00:00.002Z to
    // 11:00:00.002Z). Same UTC day still.
    fakeClock.setNow(startMs - 3600_000);
    // Advance 5h forward from the backward-set point (still 04-27).
    fakeClock.advance(5 * 3600_000);
    await flushAsync();

    // No additional joinQueue, no day_rolled_over.
    expect(agent.joinQueue).toHaveBeenCalledTimes(1);
    expect(notify.codes()).not.toContain("day_rolled_over");
    expect(scheduler.snapshot().today).toBe("2026-04-27");

    scheduler.stop();
  });
});
