// F1 catch-up policy: the live transport never hard-jumps a batch of newly
// arrived steps. A single new step jumps instantly; 2..12 walk one step per
// CATCHUP_STEP_MS like a broadcast; a bigger backlog converges immediately so
// a reconnect replay can't leave the board lagging further and further behind.

import { describe, expect, it } from "vitest";

import { CATCHUP_MAX_QUEUE, CATCHUP_STEP_MS, liveCatchUpPlan } from "./views/CockpitPanel";

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
    expect(CATCHUP_STEP_MS).toBe(600); // the design's ~600ms/step cadence
  });

  it("converges immediately past the queue cap", () => {
    expect(liveCatchUpPlan(CATCHUP_MAX_QUEUE + 1).kind).toBe("jump");
    expect(liveCatchUpPlan(500).kind).toBe("jump");
    expect(CATCHUP_MAX_QUEUE).toBe(12); // the design's backlog threshold
  });
});
