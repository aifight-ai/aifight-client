// Render-boundary test for the self-review panel. Mirrors perGameCards.test.tsx:
// react-dom/server static markup (no jsdom), importing ./i18n so labels resolve.
//
// ReviewSection fetches on mount via window.aifight, which is undefined in SSR —
// cliRun returns an error result there and useEffect never runs under
// renderToStaticMarkup, so the initial (pre-effect) render must degrade to the
// "Generate review" empty state rather than throwing or sticking on a spinner.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import "./i18n";
import { ReviewSection } from "./views/ReviewSection";

describe("ReviewSection", () => {
  it("renders the generate empty-state without throwing (no bridge / pre-effect)", () => {
    const markup = renderToStaticMarkup(createElement(ReviewSection, { sessionId: "demo-s1" }));
    // Substantial DOM, not an empty/error render.
    expect(markup.length).toBeGreaterThan(100);
    // Panel chrome + the explicit generate CTA + its cost hint.
    expect(markup).toContain("Review");
    expect(markup).toContain("Generate review");
    expect(markup).toContain("Uses your LLM key");
  });
});
