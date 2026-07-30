// F1 catch-up policy: the live transport never hard-jumps a batch of newly
// arrived steps. A single new step jumps instantly; 2..12 walk one step per
// catchUpStepMs(speed) like a broadcast — 1× = 3s/step (the old 600ms cadence
// "flashed by"; owner ruling 2026-07-30, dial shared with replay playback);
// a bigger backlog converges immediately so a reconnect replay can't leave
// the board lagging further and further behind.

import { describe, expect, it } from "vitest";

import { CATCHUP_MAX_QUEUE, CATCHUP_STEP_MS, catchUpStepMs, liveCatchUpPlan } from "./views/CockpitPanel";

describe("liveCatchUpPlan (F1 catch-up)", () => {
  it("does nothing when already at the tip", () => {
    expect(liveCatchUpPlan(0).kind).toBe("none");
    expect(liveCatchUpPlan(-3).kind).toBe("none");
  });

  it("jumps a single new step instantly", () => {
    expect(liveCatchUpPlan(1).kind).toBe("jump");
  });

  it("walks a small batch at the catch-up cadence", () => {
    expect(liveCatchUpPlan(2).kind).toBe("wait");
    expect(liveCatchUpPlan(CATCHUP_MAX_QUEUE).kind).toBe("wait");
    expect(CATCHUP_STEP_MS).toBe(3000); // the design's 3s/step cadence at 1×
  });

  it("converges immediately past the queue cap", () => {
    expect(liveCatchUpPlan(CATCHUP_MAX_QUEUE + 1).kind).toBe("jump");
    expect(liveCatchUpPlan(500).kind).toBe("jump");
    expect(CATCHUP_MAX_QUEUE).toBe(12); // the design's backlog threshold
  });
});

describe("catchUpStepMs (shared 0.5/1/2/3 speed dial)", () => {
  it("maps the four gears to their step pacing", () => {
    expect(catchUpStepMs(0.5)).toBe(6000);
    expect(catchUpStepMs(1)).toBe(3000);
    expect(catchUpStepMs(2)).toBe(1500);
    expect(catchUpStepMs(3)).toBe(1000);
  });
});
