// §6.3 acceptance — the battle-style radar's four-state machine and the §6.0
// render contract, asserted at the DOM layer (same SSR technique as
// cockpitRender.test.tsx: the hexagon is pure SVG, no window needed).
//   1. enabled:false / null (old server, fetch error) → "hidden";
//   2. enabled but all axes dark → "placeholder";
//   3. some axes lit → "partial" (lit solid, dark dashed);
//   4. all lit → "full" + signature = highest axis.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { HEXAGON_DIMS, StyleHexagon, radarSignature, radarView } from "./views/StyleRadarCard";
import type { HexagonData } from "../shared/ipc";

const t = (key: string, opts?: Record<string, unknown>) =>
  opts === undefined ? key : `${key} ${JSON.stringify(opts)}`;

const full: HexagonData = {
  enabled: true,
  board: "community",
  dimensions: { bluff: 72, aggression: 58, execution: 44, survival: 66, insight: 81, versatility: 61 },
  samples: { bluff: 120, aggression: 300, execution: 24, survival: 40, insight: 90, versatility: 40 },
  rates: { bluff: 0.41, aggression: 0.33, insight: 0.52 },
};

const partial: HexagonData = {
  enabled: true,
  dimensions: { bluff: null, aggression: 64, execution: null, survival: 70, insight: 55, versatility: null },
  samples: { bluff: 4, aggression: 45, execution: 6, survival: 12, insight: 31, versatility: 12 },
  rates: { aggression: 0.38, insight: 0.48 },
};

const dark: HexagonData = {
  enabled: true,
  dimensions: { bluff: null, aggression: null, execution: null, survival: null, insight: null, versatility: null },
  samples: { bluff: 0, aggression: 0, execution: 0, survival: 0, insight: 0, versatility: 0 },
};

describe("radarView state machine (§6.3)", () => {
  it("hides on old server / fetch failure / switch off", () => {
    expect(radarView(null)).toBe("hidden");
    expect(radarView({ enabled: false })).toBe("hidden");
    expect(radarView({ enabled: true })).toBe("hidden"); // malformed: no dimensions
  });
  it("classifies dark → placeholder, some lit → partial, all lit → full", () => {
    expect(radarView(dark)).toBe("placeholder");
    expect(radarView(partial)).toBe("partial");
    expect(radarView(full)).toBe("full");
  });
});

describe("radarSignature", () => {
  it("picks the highest lit axis", () => {
    expect(radarSignature(full)).toEqual({ dim: "insight", value: 81 });
    expect(radarSignature(partial)).toEqual({ dim: "survival", value: 70 });
    expect(radarSignature(dark)).toBeNull();
  });
});

describe("StyleHexagon render contract (§6.0)", () => {
  it("draws 5 grid rings, the brand-orange layer, and six axis labels when lit", () => {
    const html = renderToStaticMarkup(createElement(StyleHexagon, { data: full, t }));
    // 5 rings + 1 data polygon
    expect(html.match(/<polygon/g)?.length).toBe(6);
    expect(html).toContain('stroke="#FF700A"');
    expect(html).toContain('fill="#FF700A"');
    for (const k of HEXAGON_DIMS) {
      expect(html).toContain(`radar.dims.${k}`);
    }
    // All axes lit → no dashed axis lines
    expect(html).not.toContain("stroke-dasharray");
    // Every lit vertex prints its numeric score outside the corner
    // (value texts are the only font-weight:600 elements).
    expect(html.match(/font-weight="600"/g)?.length).toBe(6);
    for (const k of HEXAGON_DIMS) {
      expect(html).toContain(`>${full.dimensions![k]}</text>`);
    }
  });

  it("dashes dark axes and keeps lit ones solid on a partial radar", () => {
    const html = renderToStaticMarkup(createElement(StyleHexagon, { data: partial, t }));
    // 4 dark axes dashed (bluff, execution, versatility, and... exactly the null dims)
    const dashed = html.match(/stroke-dasharray="4 4"/g)?.length ?? 0;
    expect(dashed).toBe(3); // bluff, execution, versatility
    // Data polygon still drawn (some axes lit)
    expect(html).toContain('stroke="#FF700A"');
    // Dark-axis tooltip carries the "N more to light up" copy
    expect(html).toContain("radar.needMore");
    // Lit rate axis carries its core rate (owner ruling #2: hover shows rates)
    expect(html).toContain("radar.rate.insight");
    // Only the 3 lit vertices print numbers; dark corners stay name-only.
    expect(html.match(/font-weight="600"/g)?.length).toBe(3);
    for (const v of [64, 70, 55]) {
      expect(html).toContain(`>${v}</text>`);
    }
  });

  it("renders the empty placeholder grid with every axis dashed and no data layer", () => {
    const html = renderToStaticMarkup(createElement(StyleHexagon, { data: dark, t }));
    expect(html.match(/stroke-dasharray="4 4"/g)?.length).toBe(6);
    expect(html).not.toContain("#FF700A");
    expect(html.match(/<polygon/g)?.length).toBe(5); // grid only
    expect(html).not.toContain('font-weight="600"'); // no vertex numbers in the dark
  });
});
