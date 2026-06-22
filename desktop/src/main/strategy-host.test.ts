// Tests for the strategy scope gate after the live-list change: scopes follow
// the caller-provided (backend-fed) live list, and the path-safety rules that
// used to come from a fixed allow-list must still hold — scope strings become
// file-path segments, so traversal/malformed values stay rejected.

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeBridgeConfig, type BridgeConfig } from "@aifight/aifight/bridge/config";
import { readStrategy, writeStrategy } from "./strategy-host";

const ORIGINAL_HOME = process.env.AIFIGHT_RUNTIME_HOME;
const tmpDirs: string[] = [];

function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-desktop-strategy-"));
  tmpDirs.push(dir);
  process.env.AIFIGHT_RUNTIME_HOME = dir;
  return dir;
}

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
  else process.env.AIFIGHT_RUNTIME_HOME = ORIGINAL_HOME;
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function validConfig(): BridgeConfig {
  return {
    version: 1,
    baseUrl: "https://aifight.ai",
    wsUrl: "wss://aifight.ai/api/ws",
    agentId: "agent-strategy-test",
    agentName: "Strategy Test Agent",
    apiKey: "sk-test",
    runtimeType: "direct",
    runtimeLocalUrl: "direct://local",
    runtimeLocalToken: "tok-test",
    updatedAt: "2026-06-02T00:00:00.000Z",
  };
}

const LIVE = ["texas_holdem", "liars_dice", "coup", "bocce_ball"] as const;

describe("strategy scopes follow the live list", () => {
  it("readStrategy lists global + every live game (incl. a 4th game, no desktop edit)", () => {
    freshHome();
    writeBridgeConfig(validConfig());
    const r = readStrategy([...LIVE]);
    expect(r.error).toBeUndefined();
    expect(r.docs.map((d) => d.scope)).toEqual(["global", ...LIVE]);
  });

  it("writeStrategy accepts a live game and round-trips through readStrategy", () => {
    const home = freshHome();
    writeBridgeConfig(validConfig());
    const w = writeStrategy([...LIVE], "bocce_ball", "# bocce tactics");
    expect(w.ok).toBe(true);

    const doc = readStrategy([...LIVE]).docs.find((d) => d.scope === "bocce_ball");
    expect(doc?.exists).toBe(true);
    expect(doc?.content).toBe("# bocce tactics");
    // The file lives under the agent's strategy/games dir inside the temp home.
    expect(doc?.path.startsWith(home)).toBe(true);
    expect(doc?.path.endsWith(path.join("strategy", "games", "bocce_ball.md"))).toBe(true);
  });

  it("rejects a game outside the live list", () => {
    freshHome();
    writeBridgeConfig(validConfig());
    const w = writeStrategy([...LIVE], "retired_game", "x");
    expect(w.ok).toBe(false);
  });

  it("🔒 rejects path-unsafe scopes regardless of the list (traversal gate)", () => {
    freshHome();
    writeBridgeConfig(validConfig());
    // Even if a hostile list smuggled these in, the safe-name gate must hold.
    const evil = ["../escape", "a/b", "a\\b", "..", ".", "A", ""];
    for (const scope of evil) {
      expect(writeStrategy([...LIVE, ...evil], scope, "x").ok).toBe(false);
    }
    // And readStrategy must silently drop them from the doc list.
    const scopes = readStrategy([...LIVE, ...evil]).docs.map((d) => d.scope);
    expect(scopes).toEqual(["global", ...LIVE]);
  });
});
