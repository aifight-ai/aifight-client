// F4 "thinking" placeholder: a trailing decision_request with no outcome row
// yet means the agent's LLM call is still in flight (decision_request is
// emitted BEFORE the call) — the event log renders a spinner + elapsed seconds
// at the end of that embedded decision group, and the result trace replaces it.
// Replay badge is exempt: a stored session is complete, so a spinner there
// would spin forever over a settled decision. SSR technique as traceSync.
// (Moved off the retired ReasoningTracePanel onto EventLogPanel in D11.)

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { MatchEvent } from "@aifight/api-types";
import "./i18n";
import { EventLogPanel } from "./views/EventLogPanel";
import type { TraceBadge } from "./views/ReasoningTracePanel";
import type { StampedTrace } from "./liveStore";

const players = [{ agent_id: "a0", agent_name: "Claude Opus", player_id: "p0", position: 0 }];

const events: MatchEvent[] = [
  { seq: 0, type: "action", data: { action: "income" }, created_at: "", player_id: "p0" },
  { seq: 1, type: "action", data: { action: "tax", claimed_role: "Duke" }, created_at: "", player_id: "p0" },
];

const decision = (extra: Partial<StampedTrace> = {}): StampedTrace =>
  ({
    type: "decision_request",
    matchId: "m1",
    game: "coup",
    legalActionCount: 3,
    timeoutMs: 1000,
    step: 1,
    ...extra,
  }) as unknown as StampedTrace;

const finalAction: StampedTrace = {
  type: "final_action",
  matchId: "m1",
  source: "runtime",
  action: { type: "income" },
  step: 1,
} as unknown as StampedTrace;

const failure: StampedTrace = {
  type: "runtime_failure",
  matchId: "m1",
  attempt: 1,
  error: "boom",
  step: 1,
} as unknown as StampedTrace;

function render(traces: readonly StampedTrace[], badge: TraceBadge) {
  return renderToStaticMarkup(
    createElement(EventLogPanel, {
      game: "coup",
      events,
      traces,
      players,
      ownerPlayerId: "p0",
      badge,
      isLive: badge !== "replay",
      transportStep: events.length,
      following: true,
      onJumpToStep: () => {},
    }),
  );
}

describe("F4 — thinking placeholder (embedded in the event log)", () => {
  it("shows while the trailing decision has no outcome (live badge)", () => {
    const markup = render([decision()], "live");
    expect(markup).toContain("Thinking…");
    expect(markup).toContain("v3-tr-pending");
    expect(markup).toContain("animate-spin");
  });

  it("counts elapsed seconds from the decision's arrival stamp", () => {
    const markup = render([decision({ at: Date.now() - 3200 })], "live");
    expect(markup).toContain("Thinking… 3s");
  });

  it("shows for the demo badge too (same live-fed stream semantics)", () => {
    expect(render([decision()], "demo")).toContain("Thinking…");
  });

  it("disappears once the outcome trace lands (same group)", () => {
    expect(render([decision(), finalAction], "live")).not.toContain("Thinking…");
    expect(render([decision(), failure], "live")).not.toContain("Thinking…");
  });

  it("stays up across an illegal_retry (the corrective attempt is still thinking)", () => {
    const retry = {
      type: "illegal_retry",
      matchId: "m1",
      attempt: 1,
      reason: "unparseable_runtime_text",
      priorPreview: "garbage",
      step: 1,
    } as unknown as StampedTrace;
    expect(render([decision(), retry], "live")).toContain("Thinking…");
  });

  it("never shows in a replay — a stored session is complete", () => {
    expect(render([decision()], "replay")).not.toContain("Thinking…");
  });

  it("an earlier settled group + in-flight decision shows exactly one placeholder", () => {
    const markup = render([decision(), finalAction, decision({ step: 2 })], "live");
    expect(markup.match(/v3-tr-pending/g)).toHaveLength(1);
  });
});
