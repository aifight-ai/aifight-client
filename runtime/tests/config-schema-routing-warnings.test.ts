// R15 (2026-07-26): unknown game names in routing.byGame are forward-compat
// WARNINGS, not errors — the server can ship a 4th game before this build knows
// it, and a valid config routing that game must keep loading (CLI and desktop
// share this schema). Shape violations (empty game name, bad profile refs)
// stay hard errors, and warnings ride along on both result arms.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { validateConfig } from "../src/profile/config-schema.js";
import { loadAgentProfile } from "../src/profile/profile-loader.js";

function baseConfig(byGame?: unknown): Record<string, unknown> {
  return {
    schemaVersion: 1,
    activeProfile: "main",
    profiles: {
      main: {
        protocol: "anthropic_messages",
        apiKeyRef: { type: "env", name: "K" },
        model: "claude-x",
      },
    },
    routing: { default: "main", ...(byGame !== undefined ? { byGame } : {}) },
  };
}

describe("routing.byGame unknown-game warning channel (R15)", () => {
  it("accepts a config routing an unknown (future) game and reports a warning", () => {
    const res = validateConfig(baseConfig({ chess: "main" }));
    expect(res.ok).toBe(true);
    expect(res.warnings.join("\n")).toMatch(/routing\.byGame: unknown game "chess"/);
  });

  it("known-game routes stay warning-free (behavior unchanged)", () => {
    const res = validateConfig(
      baseConfig({ texas_holdem: "main", liars_dice: "main", coup: "main" }),
    );
    expect(res.ok).toBe(true);
    expect(res.warnings).toEqual([]);
  });

  it("garbage shapes are still hard errors", () => {
    // byGame itself not an object
    expect(validateConfig(baseConfig("nope")).ok).toBe(false);

    // empty game name
    const emptyKey = validateConfig(baseConfig({ "": "main" }));
    expect(emptyKey.ok).toBe(false);
    if (!emptyKey.ok) {
      expect(emptyKey.errors.join("\n")).toMatch(/game name must be a non-empty string/);
    }

    // unknown game routed to a non-string profile name
    expect(validateConfig(baseConfig({ chess: 7 })).ok).toBe(false);

    // unknown game routed to a nonexistent profile
    const ghost = validateConfig(baseConfig({ chess: "ghost" }));
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) {
      expect(ghost.errors.join("\n")).toMatch(/references unknown profile "ghost"/);
    }
  });

  it("a failed validation still carries the warnings alongside errors", () => {
    const res = validateConfig(baseConfig({ chess: "ghost" }));
    expect(res.ok).toBe(false);
    expect(res.warnings.join("\n")).toMatch(/unknown game "chess"/);
  });

  it("loadAgentProfile loads a warned config and logs the warning", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aifight-profile-warn-"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await fs.writeFile(
        path.join(dir, "config.json"),
        JSON.stringify(baseConfig({ chess: "main" })),
        "utf8",
      );
      const { profile } = await loadAgentProfile(dir);
      expect(profile.config.routing.default).toBe("main");
      const logged = warnSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toMatch(/unknown game "chess"/);
    } finally {
      warnSpy.mockRestore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
