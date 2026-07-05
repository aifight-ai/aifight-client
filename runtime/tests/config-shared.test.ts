// Batch A — unit tests for the headless config helpers (config-shared.ts):
// protocol alias resolution (D2), four-part error (D13), did-you-mean (D14),
// and --feature parsing (D12). Pure logic — no fs / no network.

import { describe, it, expect } from "vitest";

import {
  resolveProtocol,
  protocolRequiresBaseURLAndModel,
  protocolChoicesHint,
  configError,
  levenshtein,
  suggestClosest,
  parseFeatureFlags,
  onOffFlag,
  stringFlag,
  numberFlag,
  boolFlag,
} from "../src/cli/commands/config-shared";

describe("resolveProtocol (D2)", () => {
  it("maps the four friendly aliases", () => {
    expect(resolveProtocol("claude")).toBe("anthropic_messages");
    expect(resolveProtocol("gpt")).toBe("openai_responses");
    expect(resolveProtocol("compat")).toBe("openai_chat_compat");
    expect(resolveProtocol("gemini")).toBe("gemini_generate_content");
  });

  it("is case-insensitive and trims", () => {
    expect(resolveProtocol("  Claude ")).toBe("anthropic_messages");
    expect(resolveProtocol("COMPAT")).toBe("openai_chat_compat");
  });

  it("accepts canonical protocol names as a pass-through", () => {
    expect(resolveProtocol("anthropic_messages")).toBe("anthropic_messages");
    expect(resolveProtocol("deepseek_chat_completions")).toBe("deepseek_chat_completions");
    expect(resolveProtocol("gemini_openai_compat")).toBe("gemini_openai_compat");
  });

  it("returns undefined for an unknown value", () => {
    expect(resolveProtocol("claud")).toBeUndefined();
    expect(resolveProtocol("openai")).toBeUndefined();
    expect(resolveProtocol("")).toBeUndefined();
  });
});

describe("protocolRequiresBaseURLAndModel (D3)", () => {
  it("is true only for the compat protocols", () => {
    expect(protocolRequiresBaseURLAndModel("openai_chat_compat")).toBe(true);
    expect(protocolRequiresBaseURLAndModel("gemini_openai_compat")).toBe(true);
    expect(protocolRequiresBaseURLAndModel("anthropic_messages")).toBe(false);
    expect(protocolRequiresBaseURLAndModel("openai_responses")).toBe(false);
    expect(protocolRequiresBaseURLAndModel("gemini_generate_content")).toBe(false);
  });
});

describe("protocolChoicesHint", () => {
  it("lists all four friendly aliases with provider hints", () => {
    const hint = protocolChoicesHint();
    for (const alias of ["claude", "gpt", "compat", "gemini"]) {
      expect(hint).toContain(alias);
    }
    expect(hint).toMatch(/DeepSeek/);
  });
});

describe("configError (D13)", () => {
  it("composes problem + valid + example + next into message and hint", () => {
    const e = configError("test_code", {
      problem: "bad thing",
      valid: "Valid: a, b, c",
      example: "aifight config add x --protocol claude --env K",
      next: "then run aifight config test",
    });
    expect(e.code).toBe("test_code");
    expect(e.message).toBe("bad thing");
    expect(e.hint).toContain("Valid: a, b, c");
    expect(e.hint).toContain("Example: aifight config add x --protocol claude --env K");
    expect(e.hint).toContain("then run aifight config test");
  });

  it("omits the hint entirely when no guidance parts are given", () => {
    const e = configError("bare", { problem: "nope" });
    expect(e.hint).toBeUndefined();
  });
});

describe("levenshtein + suggestClosest (D14)", () => {
  it("computes edit distance", () => {
    expect(levenshtein("", "")).toBe(0);
    expect(levenshtein("ad", "add")).toBe(1);
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });

  it("suggests within distance 2, else undefined", () => {
    const cmds = ["add", "update", "models", "remove", "clear-key"];
    expect(suggestClosest("ad", cmds)).toBe("add");
    expect(suggestClosest("updat", cmds)).toBe("update");
    expect(suggestClosest("remov", cmds)).toBe("remove");
    // "zzzzzz" is far from everything → no suggestion
    expect(suggestClosest("zzzzzz", cmds)).toBeUndefined();
  });

  it("honors a custom max distance", () => {
    expect(suggestClosest("ad", ["add"], 0)).toBeUndefined();
    expect(suggestClosest("add", ["add"], 0)).toBe("add");
  });
});

describe("parseFeatureFlags (D12)", () => {
  it("parses a single key=on", () => {
    const r = parseFeatureFlags("jsonObjectMode=on");
    expect(r).toEqual({ ok: true, features: { jsonObjectMode: true } });
  });

  it("parses comma-joined multiples with on/off/true/false", () => {
    const r = parseFeatureFlags("a=on,b=off,c=true,d=false");
    expect(r).toEqual({ ok: true, features: { a: true, b: false, c: true, d: false } });
  });

  it("returns {} for empty / undefined", () => {
    expect(parseFeatureFlags(undefined)).toEqual({ ok: true, features: {} });
    expect(parseFeatureFlags("")).toEqual({ ok: true, features: {} });
  });

  it("rejects malformed items", () => {
    expect(parseFeatureFlags("bogus")).toMatchObject({ ok: false });
    expect(parseFeatureFlags("k=maybe")).toMatchObject({ ok: false });
    expect(parseFeatureFlags("=on")).toMatchObject({ ok: false });
  });
});

describe("onOffFlag", () => {
  it("parses on/off/true/false", () => {
    expect(onOffFlag({ thinking: "on" }, "thinking")).toEqual({ ok: true, value: true });
    expect(onOffFlag({ thinking: "off" }, "thinking")).toEqual({ ok: true, value: false });
    expect(onOffFlag({ thinking: "true" }, "thinking")).toEqual({ ok: true, value: true });
  });
  it("returns ok with no value when absent", () => {
    expect(onOffFlag({}, "thinking")).toEqual({ ok: true });
  });
  it("errors on garbage", () => {
    expect(onOffFlag({ thinking: "maybe" }, "thinking")).toMatchObject({ ok: false });
  });
});

describe("typed flag getters", () => {
  it("stringFlag trims and drops empties", () => {
    expect(stringFlag({ a: "  x " }, "a")).toBe("x");
    expect(stringFlag({ a: "   " }, "a")).toBeUndefined();
    expect(stringFlag({ a: 3 }, "a")).toBeUndefined();
  });
  it("numberFlag returns finite numbers only", () => {
    expect(numberFlag({ a: 5 }, "a")).toBe(5);
    expect(numberFlag({ a: "5" }, "a")).toBeUndefined();
  });
  it("boolFlag is strict true", () => {
    expect(boolFlag({ a: true }, "a")).toBe(true);
    expect(boolFlag({ a: "true" }, "a")).toBe(false);
    expect(boolFlag({}, "a")).toBe(false);
  });
});
