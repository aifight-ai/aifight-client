// First-run SetupGuide progress persistence. This is the fix for the reported
// bug where naming the agent + setting the daily cap, then navigating to Models
// (step 3) and back, reset every step and re-locked "Enter" — because the guide
// re-mounts on each return and its state was ephemeral. These helpers persist the
// per-agent progress so a remount restores it. Pin the behaviour so a refactor
// can't silently reintroduce the "everything looks unset again" regression.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { armFirstRunGuide, clearGuideProgress, readGuideProgress, saveGuideProgress } from "./views/PlayView";

const GUIDE_PENDING_KEY = "aifight.guide.pending";
const PAUSE_KEY = "aifight.play.paused";
const POLICY_CACHE_KEY = "aifight.play.policy";

// Minimal in-memory localStorage (the desktop vitest env is "node", no DOM).
function memStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => void m.set(k, String(v)),
    removeItem: (k: string): void => void m.delete(k),
    clear: (): void => m.clear(),
    key: (i: number): string | null => Array.from(m.keys())[i] ?? null,
    get length(): number {
      return m.size;
    },
  };
}

beforeEach(() => vi.stubGlobal("localStorage", memStorage()));
afterEach(() => vi.unstubAllGlobals());

describe("SetupGuide progress persistence", () => {
  it("round-trips the applied cap — the value that unlocks Enter after a remount", () => {
    expect(readGuideProgress("agent-A")).toBeNull(); // nothing yet
    saveGuideProgress("agent-A", { cap: 5 });
    // capChosen = applied !== null → this must come back as 5, not null.
    expect(readGuideProgress("agent-A")).toEqual({ agentId: "agent-A", nameDone: false, cap: 5 });
  });

  it("cap 0 (manual-only) is a real choice — persists as 0, not treated as unset", () => {
    saveGuideProgress("agent-A", { cap: 0 });
    expect(readGuideProgress("agent-A")?.cap).toBe(0);
  });

  it("merges independent step patches (name then cap) instead of clobbering", () => {
    saveGuideProgress("agent-A", { nameDone: true });
    saveGuideProgress("agent-A", { cap: 2 });
    expect(readGuideProgress("agent-A")).toEqual({ agentId: "agent-A", nameDone: true, cap: 2 });
  });

  it("is keyed by agent — a different/replaced agent starts fresh", () => {
    saveGuideProgress("agent-A", { nameDone: true, cap: 5 });
    expect(readGuideProgress("agent-B")).toBeNull();
  });

  it("clearGuideProgress wipes it (called when the guide is finished/skipped)", () => {
    saveGuideProgress("agent-A", { cap: 5 });
    clearGuideProgress();
    expect(readGuideProgress("agent-A")).toBeNull();
  });

  it("no agentId → no read, no write, no throw (guards the pre-registration window)", () => {
    expect(readGuideProgress(undefined)).toBeNull();
    expect(() => saveGuideProgress(undefined, { cap: 5 })).not.toThrow();
    expect(readGuideProgress("agent-A")).toBeNull(); // nothing was written
  });

  it("survives a JSON reload (simulates a fresh remount reading the store)", () => {
    saveGuideProgress("agent-A", { nameDone: true, cap: 7 });
    // A remount just calls readGuideProgress again against the same store.
    const restored = readGuideProgress("agent-A");
    expect(restored?.nameDone).toBe(true);
    expect(restored?.cap).toBe(7);
  });
});

describe("armFirstRunGuide (fresh registration / replace identity)", () => {
  it("arms the guide-pending flag for the new agent", () => {
    armFirstRunGuide("agent-NEW");
    // guidePendingFor(agent-NEW) reads this exact value → guide will show.
    expect(localStorage.getItem(GUIDE_PENDING_KEY)).toBe("agent-NEW");
  });

  it("scrubs the replaced identity's per-machine state (F: no inherited pause)", () => {
    // Old agent left a pause, a cached policy, and half-finished guide progress.
    localStorage.setItem(PAUSE_KEY, "1");
    localStorage.setItem(POLICY_CACHE_KEY, JSON.stringify({ maxGamesPerDay: 50 }));
    saveGuideProgress("agent-OLD", { nameDone: true, cap: 50 });

    armFirstRunGuide("agent-NEW");

    // The new identity must NOT inherit the old pause (the reported re-pause bug),
    // nor a stale policy cache, nor the old agent's guide progress.
    expect(localStorage.getItem(PAUSE_KEY)).toBeNull();
    expect(localStorage.getItem(POLICY_CACHE_KEY)).toBeNull();
    expect(readGuideProgress("agent-OLD")).toBeNull();
    // ...but it IS armed for onboarding.
    expect(localStorage.getItem(GUIDE_PENDING_KEY)).toBe("agent-NEW");
  });

  it("no-ops on a missing/empty agentId (guards the pre-registration window)", () => {
    localStorage.setItem(PAUSE_KEY, "1");
    armFirstRunGuide(undefined);
    armFirstRunGuide("");
    // Nothing armed, nothing scrubbed — a failed/absent registration is inert.
    expect(localStorage.getItem(GUIDE_PENDING_KEY)).toBeNull();
    expect(localStorage.getItem(PAUSE_KEY)).toBe("1");
  });
});
