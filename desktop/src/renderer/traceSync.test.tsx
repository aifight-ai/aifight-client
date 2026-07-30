// Replay board↔panel sync: in replay/demo mode the reasoning panel must only
// show traces whose step the transport has reached — a replay parked at frame 0
// showing every later decision was both a desync and a spoiler. Live mode keeps
// the full arrival-ordered stream. Same SSR technique as cockpitFill.test.tsx.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import "./i18n";
import { CockpitPanel } from "./views/CockpitPanel";
import type { StampedTrace } from "./liveStore";
import type { MatchDetail, MatchEvent } from "@aifight/api-types";

const match: MatchDetail = {
  id: "m-trace-sync",
  game: "coup",
  status: "finished",
  players: [
    { position: 0, name: "Player 1", player_id: "p0" },
    { position: 1, name: "Player 2", player_id: "p1" },
  ],
} as unknown as MatchDetail;

const events: MatchEvent[] = [
  { seq: 0, type: "game_setup", data: {}, created_at: "" },
  { seq: 1, type: "player_action", data: { action: "income" }, created_at: "", player_id: "p0" },
  { seq: 2, type: "player_action", data: { action: "income" }, created_at: "", player_id: "p1" },
] as unknown as MatchEvent[];

const traces: StampedTrace[] = [
  { type: "decision_request", matchId: "m-trace-sync", game: "coup", legalActionCount: 3, timeoutMs: 1000, step: 1 },
  { type: "runtime_success", matchId: "m-trace-sync", attempt: 1, raw: { kind: "text", sha256: "aaa", bytes: 9, preview: "early-thought" }, step: 1 },
  { type: "runtime_success", matchId: "m-trace-sync", attempt: 2, raw: { kind: "text", sha256: "bbb", bytes: 9, preview: "late-thought" }, step: 3 },
  { type: "runtime_success", matchId: "m-trace-sync", attempt: 3, raw: { kind: "text", sha256: "ccc", bytes: 9, preview: "unstamped-thought" } },
] as unknown as StampedTrace[];

function render(opts: { isLive: boolean; initialStep?: number }) {
  return renderToStaticMarkup(
    createElement(CockpitPanel, {
      game: "coup",
      match,
      events,
      ownerPlayerId: "p0",
      ownerPrivate: {},
      traces,
      isLive: opts.isLive,
      badge: opts.isLive ? "live" : "replay",
      note: "note",
      headerLeft: null,
      ...(opts.initialStep === undefined ? {} : { initialStep: opts.initialStep }),
    }),
  );
}

describe("replay trace↔transport sync", () => {
  it("a replay parked at frame 0 shows no stamped traces (unstamped stay visible)", () => {
    const markup = render({ isLive: false, initialStep: 0 });
    expect(markup).not.toContain("early-thought");
    expect(markup).not.toContain("late-thought");
    expect(markup).toContain("unstamped-thought");
    // No decision visible → nothing to mark as the current group.
    expect(markup).not.toContain("v3-tr-cur");
  });

  it("a replay mid-way shows only traces at or before the current step", () => {
    const markup = render({ isLive: false, initialStep: 1 });
    expect(markup).toContain("early-thought");
    expect(markup).not.toContain("late-thought");
    // The visible trailing decision group is marked as current.
    expect(markup).toContain("v3-tr-cur");
  });

  it("a replay at the tip shows everything", () => {
    const markup = render({ isLive: false });
    expect(markup).toContain("early-thought");
    expect(markup).toContain("late-thought");
    expect(markup).toContain("unstamped-thought");
  });

  it("live mode never filters — arrival order IS the live experience", () => {
    // Live following pins the transport to the tip anyway, but even parked
    // earlier the live stream must stay complete.
    const markup = render({ isLive: true, initialStep: 0 });
    expect(markup).toContain("early-thought");
    expect(markup).toContain("late-thought");
  });

  it("F5: the transport slider carries the played-fill percentage", () => {
    // Parked at step 1 of 3 → --v3-fill = 33.3…% drives the track's gradient.
    const markup = render({ isLive: false, initialStep: 1 });
    expect(markup).toContain(`--v3-fill:${(1 / 3) * 100}%`);
  });
});

// F3: the panel's "current" anchor follows the transport step (last decision
// group at or before it), in live AND replay — scrubbing back mid-live
// re-anchors to the decision of that step instead of staying on the latest.
describe("F3 — trace anchor follows the transport", () => {
  // Two decision groups: d1 (step 1) and d2 (step 3).
  const twoGroups: StampedTrace[] = [
    { type: "decision_request", matchId: "m-trace-sync", game: "coup", legalActionCount: 3, timeoutMs: 1000, step: 1 },
    { type: "runtime_success", matchId: "m-trace-sync", attempt: 1, raw: { kind: "text", sha256: "a1", bytes: 9, preview: "thought-one" }, step: 1 },
    { type: "decision_request", matchId: "m-trace-sync", game: "coup", legalActionCount: 4, timeoutMs: 1000, step: 3 },
    { type: "runtime_success", matchId: "m-trace-sync", attempt: 2, raw: { kind: "text", sha256: "b2", bytes: 9, preview: "thought-two" }, step: 3 },
  ] as unknown as StampedTrace[];

  function renderGroups(opts: { isLive: boolean; initialStep?: number }) {
    return renderToStaticMarkup(
      createElement(CockpitPanel, {
        game: "coup",
        match,
        events,
        ownerPlayerId: "p0",
        ownerPrivate: {},
        traces: twoGroups,
        isLive: opts.isLive,
        badge: opts.isLive ? "live" : "replay",
        note: "note",
        headerLeft: null,
        ...(opts.initialStep === undefined ? {} : { initialStep: opts.initialStep }),
      }),
    );
  }

  const curCount = (markup: string) => markup.match(/v3-tr-cur/g)?.length ?? 0;

  it("live at the tip anchors the latest group (pre-F3 behavior preserved)", () => {
    // No initialStep → transport starts at the tip (events.length = 3).
    const markup = renderGroups({ isLive: true });
    expect(curCount(markup)).toBe(2); // d2's decision row + its card
    expect(markup).toContain("thought-one"); // live never filters the stream
    expect(markup).toContain("thought-two");
  });

  it("live scrubbed back to step 1 anchors THAT step's group, not the latest", () => {
    const markup = renderGroups({ isLive: true, initialStep: 1 });
    expect(markup).toContain("thought-two"); // stream stays complete in live…
    expect(curCount(markup)).toBe(2); // …but the highlight sits on d1's group
    // d1's card carries the highlight (bounded: no other card crossed); d2's
    // card (step 3 > transport 1) renders with the plain, un-highlighted class.
    expect(markup).toMatch(/class="v3-tr-card v3-tr-cur">(?:(?!v3-tr-card)[\s\S])*?thought-one/);
    expect(markup).toMatch(/class="v3-tr-card">(?:(?!v3-tr-card)[\s\S])*?thought-two/);
  });

  it("live parked before the first decision has no anchor at all", () => {
    const markup = renderGroups({ isLive: true, initialStep: 0 });
    expect(curCount(markup)).toBe(0);
    expect(markup).toContain("thought-one");
    expect(markup).toContain("thought-two");
  });

  it("replay mid-way anchors the visible trailing group (unchanged semantics)", () => {
    const markup = renderGroups({ isLive: false, initialStep: 1 });
    expect(markup).toContain("thought-one");
    expect(markup).not.toContain("thought-two"); // filtered out by the transport
    expect(curCount(markup)).toBe(2);
  });
});
