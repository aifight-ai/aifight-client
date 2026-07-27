import { describe, it, expect } from "vitest";

import { classifyEffort, reasoningShape, tierChips } from "./views/ModelsView";
import type { ModelCapabilitiesResult } from "../shared/ipc";

// The Models editor's effort control is a combo box (free text + per-model
// suggestions) so a model newer than this build can still be configured. Free text
// needs to say what will happen BEFORE Save, because there are two very different
// failures and they used to be indistinguishable:
//
//   unstorable — config.json's schema rejects the value, so the write fails after
//                the fact. Block Save instead.
//   clamped    — storable, but this model doesn't list the tier, so the adapter
//                lowers it to high. Worth saying; not worth blocking.

const STORABLE = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];

function caps(over: Partial<ModelCapabilitiesResult> = {}): ModelCapabilitiesResult {
  return {
    efforts: ["low", "medium", "high", "xhigh", "max"],
    protocolEfforts: ["low", "medium", "high", "xhigh", "max"],
    storableEfforts: STORABLE,
    isKnownModel: true,
    thinkingModes: ["adaptive"],
    thinkingAlwaysOn: false,
    thinkingDefaultOn: true,
    ...over,
  };
}

describe("classifyEffort", () => {
  it("is silent for a tier the model lists", () => {
    for (const tier of ["low", "medium", "high", "xhigh", "max"]) {
      expect(classifyEffort(tier, caps()), tier).toBeNull();
    }
  });

  it("is silent for a blank field (blank = the model's default)", () => {
    expect(classifyEffort("", caps())).toBeNull();
    expect(classifyEffort("   ", caps())).toBeNull();
  });

  it("says nothing before capabilities have loaded", () => {
    expect(classifyEffort("max", null)).toBeNull();
  });

  // The screenshot case, inverted: xhigh IS storable, but Opus 4.6 never got the
  // tier, so the adapter clamps it to high. Silently sending high when the user
  // asked for xhigh is the failure mode this whole batch is about.
  it("warns without blocking when the tier is storable but not offered here", () => {
    const r = classifyEffort("xhigh", caps({ efforts: ["low", "medium", "high", "max"] }));
    expect(r).toEqual({ blocking: false, kind: "clamped" });
  });

  it("blocks a tier the config schema cannot store", () => {
    expect(classifyEffort("ultra", caps())).toEqual({ blocking: true, kind: "unstorable" });
    expect(classifyEffort("HIGH", caps())).toEqual({ blocking: true, kind: "unstorable" });
  });

  // An unlisted model has no per-model opinion to contradict, so only the storable
  // check applies — otherwise a model newer than this build would be warned about
  // every tier it has.
  it("does not second-guess a tier on a model the registry doesn't list", () => {
    expect(classifyEffort("max", caps({ isKnownModel: false, efforts: STORABLE }))).toBeNull();
    expect(classifyEffort("minimal", caps({ isKnownModel: false, efforts: STORABLE }))).toBeNull();
  });

  // A model with no effort parameter at all (the 4.5 generation) reports efforts:[].
  // That is "no opinion", not "nothing is allowed".
  it("treats an empty tier list as no opinion rather than a rejection", () => {
    expect(classifyEffort("high", caps({ efforts: [] }))).toBeNull();
  });
});

describe("classifyEffort: the auto tier", () => {
  // auto = "send nothing, provider default" — valid on every model even though no
  // per-model efforts list contains it. Flagging it as clamped would tell the user
  // their default choice is being overridden, which is exactly backwards.
  it("never flags auto", () => {
    expect(classifyEffort("auto", caps())).toBeNull();
    expect(classifyEffort("auto", caps({ efforts: ["low", "high"] }))).toBeNull();
  });
});

describe("tierChips", () => {
  // D2 (owner 2026-07-26): the chip row renders the PROTOCOL vocabulary, so max
  // shows on gpt-5.5 (which lacks it) with a clamp note instead of disappearing.
  it("renders the protocol vocabulary, not the per-model subset", () => {
    const c = caps({
      protocolEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      efforts: ["none", "low", "medium", "high", "xhigh"], // gpt-5.5: no max
    });
    expect(tierChips(c)).toEqual(["auto", "none", "low", "medium", "high", "xhigh", "max"]);
  });

  it("always leads with auto and keeps canonical order", () => {
    const c = caps({ protocolEfforts: ["max", "low", "high"], efforts: [] });
    expect(tierChips(c)).toEqual(["auto", "low", "high", "max"]);
  });

  // A model's own list can EXTEND the protocol vocabulary (a registry entry ahead
  // of the protocol block) — union, so a registry gap can never hide a real tier.
  it("unions in per-model tiers the protocol block lacks", () => {
    const c = caps({ protocolEfforts: ["low", "high"], efforts: ["low", "high", "max"] });
    expect(tierChips(c)).toContain("max");
  });

  it("falls back to the core five with no registry answer", () => {
    expect(tierChips(null)).toEqual(["auto", "low", "medium", "high", "xhigh", "max"]);
  });
});

describe("reasoningShape", () => {
  it("budget for the Anthropic 4.5 generation (extended-only)", () => {
    expect(reasoningShape("anthropic", caps({ thinkingModes: ["extended"] }))).toBe("budget");
  });
  it("tiers for adaptive Anthropic and for unknown models", () => {
    expect(reasoningShape("anthropic", caps())).toBe("tiers");
    expect(reasoningShape("anthropic", caps({ thinkingModes: [], isKnownModel: false }))).toBe("tiers");
    expect(reasoningShape("anthropic", null)).toBe("tiers");
  });
  it("budget for Gemini 2.5 (thinkingBudget), tiers for Gemini 3.x", () => {
    expect(reasoningShape("gemini", caps({ thinkingParam: "thinkingBudget" }))).toBe("budget");
    expect(reasoningShape("gemini", caps({ thinkingParam: "thinkingLevel" }))).toBe("tiers");
  });
});
