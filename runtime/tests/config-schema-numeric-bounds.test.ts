// R13-F06: config numeric fields (maxTokens / timeouts / retries) are
// range/finite/integer validated, not just typed — a copied/typo'd profile can't
// silently drive an absurd token request, an unbounded timeout, or endless retry.

import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, validateConfig } from "../src/profile/config-schema.js";

// Built as a plain object (NOT JSON round-tripped) so NaN/Infinity survive into
// the validator — exactly what a hand-built/parsed-lenient value could look like.
function baseConfig(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    activeProfile: "main",
    profiles: {
      main: {
        protocol: "anthropic_messages",
        apiKeyRef: { type: "env", name: "K" },
        model: "claude-x",
        request: { maxTokens: 32000 },
        timeouts: { requestMs: 30000 },
        retries: { maxAttempts: 2 },
      },
    },
    routing: { default: "main" },
  };
}

function withMain(mutate: (profile: Record<string, unknown>) => void): unknown {
  const cfg = baseConfig();
  mutate((cfg.profiles as Record<string, Record<string, unknown>>).main);
  return cfg;
}

function errorsFor(config: unknown): string[] {
  const res = validateConfig(config);
  return res.ok ? [] : res.errors;
}

describe("config numeric bounds (R13-F06)", () => {
  it("accepts the shipped DEFAULT_CONFIG and the base fixture", () => {
    expect(validateConfig(DEFAULT_CONFIG).ok).toBe(true);
    expect(validateConfig(baseConfig()).ok).toBe(true);
  });

  it("accepts valid mid-range values", () => {
    expect(
      validateConfig(
        withMain((p) => {
          (p.request as Record<string, unknown>).maxTokens = 64000;
          (p.retries as Record<string, unknown>).maxAttempts = 5;
          (p.timeouts as Record<string, unknown>).requestMs = 120000;
        }),
      ).ok,
    ).toBe(true);
  });

  it("rejects NaN / Infinity token counts", () => {
    expect(errorsFor(withMain((p) => ((p.request as Record<string, unknown>).maxTokens = Number.NaN))).join("\n")).toMatch(
      /maxTokens: must be a finite number/,
    );
    expect(
      errorsFor(withMain((p) => ((p.request as Record<string, unknown>).maxTokens = Number.POSITIVE_INFINITY))).join("\n"),
    ).toMatch(/maxTokens: must be a finite number/);
  });

  it("rejects negative / zero / non-integer maxTokens", () => {
    expect(errorsFor(withMain((p) => ((p.request as Record<string, unknown>).maxTokens = -1))).join("\n")).toMatch(
      /maxTokens: must be >= 1/,
    );
    expect(errorsFor(withMain((p) => ((p.request as Record<string, unknown>).maxTokens = 0))).join("\n")).toMatch(
      /maxTokens: must be >= 1/,
    );
    expect(errorsFor(withMain((p) => ((p.request as Record<string, unknown>).maxTokens = 1.5))).join("\n")).toMatch(
      /maxTokens: must be an integer/,
    );
  });

  it("rejects a maxTokens above the ceiling", () => {
    expect(
      errorsFor(withMain((p) => ((p.request as Record<string, unknown>).maxTokens = 10_000_000))).join("\n"),
    ).toMatch(/maxTokens: must be .* <= 1000000/);
  });

  it("bounds timeouts.requestMs (>= 1, <= 300000 — a turn is 300s)", () => {
    expect(errorsFor(withMain((p) => ((p.timeouts as Record<string, unknown>).requestMs = 0))).join("\n")).toMatch(
      /timeouts.requestMs: must be >= 1/,
    );
    // 300000 (5 min) is the ceiling — accepted at the boundary, rejected above it.
    expect(validateConfig(withMain((p) => ((p.timeouts as Record<string, unknown>).requestMs = 300000))).ok).toBe(true);
    expect(
      errorsFor(withMain((p) => ((p.timeouts as Record<string, unknown>).requestMs = 300001))).join("\n"),
    ).toMatch(/timeouts.requestMs: must be .* <= 300000/);
  });

  it("bounds retries.maxAttempts (>= 0, <= 10, integer) — 0 means no retry", () => {
    // 0 is now VALID (no retry); only a negative value is rejected.
    expect(validateConfig(withMain((p) => ((p.retries as Record<string, unknown>).maxAttempts = 0))).ok).toBe(true);
    expect(errorsFor(withMain((p) => ((p.retries as Record<string, unknown>).maxAttempts = -1))).join("\n")).toMatch(
      /retries.maxAttempts: must be >= 0/,
    );
    expect(errorsFor(withMain((p) => ((p.retries as Record<string, unknown>).maxAttempts = 999))).join("\n")).toMatch(
      /retries.maxAttempts: must be .* <= 10/,
    );
    expect(errorsFor(withMain((p) => ((p.retries as Record<string, unknown>).maxAttempts = 2.5))).join("\n")).toMatch(
      /retries.maxAttempts: must be an integer/,
    );
  });

});
