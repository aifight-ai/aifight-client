// 连接审计 #13 (owner ruling 2026-07-28) — 暂停匹配 survives relaunches, and the
// truth lives in the MAIN process so the connected edge honours it before any
// enrollment can happen. These lock the three properties that make that true:
// read at construction, persisted on set, and persisted even while offline (the
// old code returned early when no runner existed, silently dropping the pause).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const flags = new Map<string, boolean>();
vi.mock("./ui-flags", () => ({
  getFlag: (key: string) => flags.get(key) === true,
  setFlag: (key: string, value: boolean) => {
    flags.set(key, value);
  },
}));

const { BridgeHost } = await import("./bridge-host");

// setMatchingPaused mirrors the flag into the SHARED bridge.json. Without a
// throwaway AIFIGHT_RUNTIME_HOME that lands in the developer's own
// ~/.aifight/runtime/bridge.json — flipping their live agent's pause bit and
// bumping updatedAt (which a running bridge reads as "restart pending"). Same
// temp-home discipline as bridgeStartGuards.test.ts / config-host.test.ts.
const ORIGINAL_HOME = process.env.AIFIGHT_RUNTIME_HOME;
const tmpDirs: string[] = [];

beforeEach(() => {
  flags.clear();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-matching-pause-"));
  tmpDirs.push(dir);
  process.env.AIFIGHT_RUNTIME_HOME = dir;
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  if (ORIGINAL_HOME === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
  else process.env.AIFIGHT_RUNTIME_HOME = ORIGINAL_HOME;
});

describe("matching pause persistence", () => {
  it("a host constructed after a paused session starts paused", async () => {
    flags.set("matchingPaused", true);
    const statuses: Array<boolean | undefined> = [];
    const host = new BridgeHost({ onStatus: (s) => statuses.push(s.matchingPaused) });
    // No runner: this is exactly the launch window the audit flagged. The flag
    // must already be in force, and must be visible to the renderer.
    await host.setMatchingPaused(true);
    expect(statuses.at(-1)).toBe(true);
    expect(flags.get("matchingPaused")).toBe(true);
  });

  it("pausing while offline still persists and reports (no early return)", async () => {
    const statuses: Array<boolean | undefined> = [];
    const host = new BridgeHost({ onStatus: (s) => statuses.push(s.matchingPaused) });
    await host.setMatchingPaused(true);
    expect(flags.get("matchingPaused")).toBe(true);
    expect(statuses.at(-1)).toBe(true);
  });

  it("resuming clears the persisted flag", async () => {
    flags.set("matchingPaused", true);
    const host = new BridgeHost();
    await host.setMatchingPaused(false);
    expect(flags.get("matchingPaused")).toBe(false);
  });
});
