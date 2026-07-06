// Batch B2 — TruncationBanner renders (live only) when decisions were token-
// truncated, and stays hidden in replay / when nothing truncated. SSR markup
// (no jsdom); importing ./i18n resolves the translated strings.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import "./i18n";
import { TruncationBanner } from "./views/TruncationBanner";
import type { BridgeDecisionTrace } from "../shared/ipc";

const truncated: BridgeDecisionTrace = {
  type: "runtime_success",
  matchId: "m1",
  attempt: 1,
  raw: { kind: "text", sha256: "x", bytes: 1, preview: "…" },
  truncated: true,
  profileId: "claude",
};
const normal: BridgeDecisionTrace = {
  type: "runtime_success",
  matchId: "m1",
  attempt: 1,
  raw: { kind: "text", sha256: "y", bytes: 1, preview: "ok" },
};

describe("TruncationBanner", () => {
  it("shows a live warning + raise button when a decision was truncated", () => {
    const markup = renderToStaticMarkup(createElement(TruncationBanner, { traces: [truncated], isLive: true }));
    expect(markup).toContain("cut off");
    expect(markup).toContain("Raise max tokens");
  });

  it("is hidden in replay (isLive false), even with truncation", () => {
    const markup = renderToStaticMarkup(createElement(TruncationBanner, { traces: [truncated], isLive: false }));
    expect(markup).toBe("");
  });

  it("is hidden when no decision truncated", () => {
    const markup = renderToStaticMarkup(createElement(TruncationBanner, { traces: [normal], isLive: true }));
    expect(markup).toBe("");
  });

  it("counts a token-limit failure too", () => {
    const fail: BridgeDecisionTrace = { type: "runtime_failure", matchId: "m1", attempt: 1, error: "400 max_tokens", tokenLimit: true };
    const markup = renderToStaticMarkup(createElement(TruncationBanner, { traces: [fail], isLive: true }));
    expect(markup).toContain("Raise max tokens");
  });

  it("shows the auto-healed 'save it' variant when a decision self-healed (Batch C)", () => {
    const healed: BridgeDecisionTrace = {
      type: "runtime_success", matchId: "m1", attempt: 1,
      raw: { kind: "text", sha256: "z", bytes: 1, preview: "ok" },
      selfHealed: { from: 32000, to: 128000 }, profileId: "claude",
    };
    const markup = renderToStaticMarkup(createElement(TruncationBanner, { traces: [healed], isLive: true }));
    expect(markup).toContain("Auto-raised");
    expect(markup).toContain("Save it");
  });
});
