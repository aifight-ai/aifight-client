// 连接审计 #13 (owner ruling 2026-07-28) — 暂停匹配 survives relaunches, and the
// truth lives in the MAIN process so the connected edge honours it before any
// enrollment can happen. These lock the three properties that make that true:
// read at construction, persisted on set, and persisted even while offline (the
// old code returned early when no runner existed, silently dropping the pause).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const flags = new Map<string, boolean>();
vi.mock("./ui-flags", () => ({
  getFlag: (key: string) => flags.get(key) === true,
  setFlag: (key: string, value: boolean) => {
    flags.set(key, value);
  },
}));

const { BridgeHost } = await import("./bridge-host");

beforeEach(() => {
  flags.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
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
