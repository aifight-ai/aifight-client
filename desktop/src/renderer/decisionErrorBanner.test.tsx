// Batch D — DecisionErrorBanner shows (live only) when a decision fell back on a
// FATAL API error (auth / quota / config / content_filter), and stays hidden in
// replay or for transient classes. SSR markup (no jsdom); ./i18n resolves the
// translated strings.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import "./i18n";
import { DecisionErrorBanner } from "./views/DecisionErrorBanner";
import type { BridgeDecisionTrace } from "../shared/ipc";

const authFail: BridgeDecisionTrace = { type: "runtime_failure", matchId: "m1", attempt: 1, error: "401", errorClass: "auth", profileId: "claude" };
const serverFail: BridgeDecisionTrace = { type: "runtime_failure", matchId: "m1", attempt: 1, error: "503", errorClass: "server" };

describe("DecisionErrorBanner", () => {
  it("shows a live warning for a fatal class (auth), with the profile", () => {
    const markup = renderToStaticMarkup(createElement(DecisionErrorBanner, { traces: [authFail], isLive: true }));
    expect(markup).toContain("API key"); // en auth message
    expect(markup).toContain("claude"); // failing profile appended
  });

  it("is hidden in replay (isLive false)", () => {
    const markup = renderToStaticMarkup(createElement(DecisionErrorBanner, { traces: [authFail], isLive: false }));
    expect(markup).toBe("");
  });

  it("is hidden for a transient (non-fatal) class like server", () => {
    const markup = renderToStaticMarkup(createElement(DecisionErrorBanner, { traces: [serverFail], isLive: true }));
    expect(markup).toBe("");
  });
});
