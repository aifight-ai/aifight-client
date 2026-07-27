// E2 (windows-loop) — a corrupt config.json must not be mistaken for a fresh
// install. ConfigView.error existed since R12 and nothing read it, so the Models
// page showed the first-run protocol picker over a real (unparseable) config and
// only refused at the save. SSR markup (no jsdom); ./i18n resolves the strings.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import "./i18n";
import { ConfigBrokenBanner, configPageState } from "./views/ConfigBrokenBanner";
import type { ConfigView } from "../shared/ipc";

const base: ConfigView = {
  configured: false,
  slug: "default",
  activeProfile: "",
  routing: { default: "" },
  profiles: [],
};
const broken: ConfigView = {
  ...base,
  error: "config.json is not valid JSON: Unexpected token } in JSON at position 91",
  configPath: "/Users/someone/.aifight/agents/default/config.json",
};

describe("configPageState", () => {
  it("calls a present-but-corrupt config broken, NOT fresh", () => {
    // The whole bug: `configured` is false either way, so a page keying off it
    // alone offers first-run setup — whose save is the thing that would clobber
    // the file the user still needs to recover.
    expect(configPageState(broken)).toBe("broken");
    expect(configPageState(base)).toBe("fresh");
  });

  it("keeps broken ahead of a configured view", () => {
    expect(configPageState({ ...broken, configured: true })).toBe("broken");
  });

  it("distinguishes not-yet-loaded from no-config", () => {
    expect(configPageState(null)).toBe("loading");
    expect(configPageState({ ...base, configured: true })).toBe("ready");
  });
});

describe("ConfigBrokenBanner", () => {
  it("names the file, says setup is off, and shows the parser's own detail", () => {
    const markup = renderToStaticMarkup(createElement(ConfigBrokenBanner, { view: broken }));
    expect(markup).toContain("can&#x27;t be read");
    // The path must come from the payload: it moves with AIFIGHT_HOME and
    // platform, and pointing at the wrong file is worse than pointing at none.
    expect(markup).toContain("/Users/someone/.aifight/agents/default/config.json");
    // The raw cause is what makes the file fixable — position 91, not "invalid".
    expect(markup).toContain("position 91");
    expect(markup).toContain("overwrite");
  });

  it("renders nothing for a healthy or absent config", () => {
    expect(renderToStaticMarkup(createElement(ConfigBrokenBanner, { view: base }))).toBe("");
    expect(renderToStaticMarkup(createElement(ConfigBrokenBanner, { view: null }))).toBe("");
    expect(
      renderToStaticMarkup(createElement(ConfigBrokenBanner, { view: { ...base, configured: true } })),
    ).toBe("");
  });

  it("still renders without a path (the payload's path is optional)", () => {
    const { configPath: _drop, ...noPath } = broken;
    const markup = renderToStaticMarkup(createElement(ConfigBrokenBanner, { view: noPath }));
    expect(markup).toContain("position 91");
  });
});
