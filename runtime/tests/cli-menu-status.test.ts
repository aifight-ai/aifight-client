// The panel's boxed status banner: pure line composition plus the provider's
// local-first / remote-enriched lifecycle (owner ask 2026-07-30, 3x-ui style).
//
// Isolation: every test gets its own AIFIGHT_RUNTIME_HOME via mkdtemp (the
// real default home path is never named here — build.sh greps for exactly
// that). The provider's remote arm is driven by a stubbed fetchImpl; the
// local online probe by an injected seat-holder seam.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readBridgeConfig, writeBridgeConfig } from "../src/bridge/config";
import {
  composeMenuStatusLines,
  createMenuStatusBox,
  type MenuStatusData,
} from "../src/cli/commands/menu-status";

let prevHome: string | undefined;
let tmpDir: string | null = null;

beforeEach(() => {
  prevHome = process.env.AIFIGHT_RUNTIME_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-menu-status-"));
  process.env.AIFIGHT_RUNTIME_HOME = tmpDir;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
  else process.env.AIFIGHT_RUNTIME_HOME = prevHome;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  prevHome = undefined;
  tmpDir = null;
});

function seedBridge(overrides: Record<string, unknown> = {}): void {
  writeBridgeConfig({
    version: 1,
    baseUrl: "https://aifight.ai",
    wsUrl: "wss://aifight.ai/api/ws",
    agentId: "00000000-0000-4000-8000-000000000001",
    agentName: "Phantom Maverick",
    apiKey: "sk-existing-secret",
    runtimeType: "direct",
    runtimeLocalUrl: "direct://local",
    runtimeModel: "direct",
    directAgentSlug: "default",
    autoDailyLimit: 2,
    autoGames: ["texas_holdem", "coup"],
    updatedAt: "2026-07-27T00:00:00.000Z",
    ...overrides,
  } as never);
}

function data(over: Partial<MenuStatusData> = {}): MenuStatusData {
  return {
    agentName: "Phantom Maverick",
    claimed: true,
    paused: false,
    online: true,
    dailyCap: 2,
    games: ["texas_holdem", "coup"],
    model: "claude-opus-4-6",
    ...over,
  };
}

/** Join a composed line's segments into its plain text. */
function plain(lines: ReturnType<typeof composeMenuStatusLines>): string[] {
  return lines.map((line) => line.map((s) => s.text).join(""));
}

describe("composeMenuStatusLines", () => {
  it("composes two lines: identity line + model/games line", () => {
    const [l1, l2] = plain(composeMenuStatusLines(data()));
    expect(l1).toBe("Phantom Maverick · ✓ claimed · ● online · auto: 2/day");
    expect(l2).toBe("claude-opus-4-6 · games: texas_holdem, coup");
  });

  it("always returns exactly two lines, so a refresh repaint never shifts rows", () => {
    for (const d of [
      data(),
      data({ claimed: false }),
      data({ updateVersion: "0.1.0-beta.40" }),
      data({ dailyCap: undefined }),
    ]) {
      expect(composeMenuStatusLines(d)).toHaveLength(2);
    }
  });

  it("styles: name bold, ✓ green, ● green when online, update hint yellow", () => {
    const lines = composeMenuStatusLines(data({ updateVersion: "0.1.0-beta.40" }));
    const styleOf = (text: string): string | undefined =>
      lines.flat().find((s) => s.text === text)?.style;
    expect(styleOf("Phantom Maverick")).toBe("bold");
    expect(styleOf("✓ claimed")).toBe("green");
    expect(styleOf("● online")).toBe("green");
    expect(styleOf("↑ 0.1.0-beta.40")).toBe("yellow");
  });

  it("puts the update hint before the games list, so truncation never eats the version", () => {
    const [, l2] = plain(composeMenuStatusLines(data({ updateVersion: "0.1.0-beta.40" })));
    expect(l2).toBe("claude-opus-4-6 · ↑ 0.1.0-beta.40 · games: texas_holdem, coup");
  });

  it("unclaimed warns in yellow", () => {
    const lines = composeMenuStatusLines(data({ claimed: false }));
    const seg = lines[0]!.find((s) => s.text === "⚠ unclaimed");
    expect(seg?.style).toBe("yellow");
  });

  it("paused wins over online (yellow ●), offline dims (○)", () => {
    const paused = composeMenuStatusLines(data({ paused: true, online: true }));
    expect(paused[0]!.find((s) => s.text === "● paused")?.style).toBe("yellow");
    expect(paused[0]!.some((s) => s.text === "● online")).toBe(false);
    const offline = composeMenuStatusLines(data({ online: false }));
    expect(offline[0]!.find((s) => s.text === "○ offline")?.style).toBe("dim");
  });

  it("daily cap wording: N/day, off at 0, not set when undefined", () => {
    expect(plain(composeMenuStatusLines(data({ dailyCap: 5 })))[0]).toContain("auto: 5/day");
    expect(plain(composeMenuStatusLines(data({ dailyCap: 0 })))[0]).toContain("auto: off");
    expect(plain(composeMenuStatusLines(data({ dailyCap: undefined })))[0]).toContain("auto: not set");
  });
});

// The two remote arms the provider fires: the platform status endpoint and
// the update check (npm registry + server version floor).
function remoteFetch(opts: {
  claimed?: boolean;
  name?: string;
  npmLatest?: string;
  fail?: boolean;
}): typeof fetch {
  return (async (input: unknown) => {
    if (opts.fail === true) throw new Error("offline");
    const url = String(input);
    if (url.endsWith("/api/agents/me/status")) {
      return new Response(JSON.stringify({
        agent_id: "agent-1",
        is_claimed: opts.claimed ?? true,
        identity_status: "official",
        status: "ready",
        ...(opts.name !== undefined ? { name: opts.name } : {}),
      }), { status: 200 });
    }
    if (url.endsWith("/api/bridge/version")) {
      return new Response(JSON.stringify({
        minimum_supported_version: "0.1.0-beta.1",
        recommended_version: "0.1.0-beta.39",
        latest_version: "0.1.0-beta.39",
      }), { status: 200 });
    }
    if (url.includes("registry.npmjs.org")) {
      return new Response(JSON.stringify({ version: opts.npmLatest ?? "0.1.0-beta.39" }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("createMenuStatusBox", () => {
  it("returns undefined when the bridge is not configured (first run)", () => {
    expect(createMenuStatusBox({ fetchImpl: remoteFetch({}) })).toBeUndefined();
  });

  it("paints local-only lines immediately, before the remote answers", () => {
    seedBridge({ declaredModel: "claude-opus-4-6" });
    let release!: (r: Response) => void;
    const hanging = (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/api/agents/me/status")) {
        return await new Promise<Response>((res) => {
          release = res;
        });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const box = createMenuStatusBox({ fetchImpl: hanging, seatHolderPid: () => 4242 })!;
    expect(box).toBeDefined();
    const [l1, l2] = box.lines().map((line) => line.map((s) => s.text).join(""));
    expect(l1).toBe("Phantom Maverick · ✓ claimed · ● online · auto: 2/day");
    expect(l2).toBe("claude-opus-4-6 · games: texas_holdem, coup");
    expect(box.title).toMatch(/^AIFight · v0\.1\.0-beta\./);
    // The one-shot refresh is still pending.
    const pending = box.refreshed();
    expect(pending).toBeDefined();
    release(new Response("{}", { status: 500 }));
    return pending;
  });

  it("enriches with the remote answers: server name, claim state, update hint", async () => {
    seedBridge();
    const box = createMenuStatusBox({
      fetchImpl: remoteFetch({ claimed: true, name: "Server Name", npmLatest: "0.1.0-beta.41" }),
      seatHolderPid: () => undefined, // no local bridge process
    })!;
    const refresh = box.refreshed();
    expect(refresh).toBeDefined();
    await refresh;
    const [l1, l2] = box.lines().map((line) => line.map((s) => s.text).join(""));
    expect(l1).toContain("Server Name");
    expect(l1).toContain("✓ claimed");
    expect(l1).toContain("○ offline");
    expect(l2).toContain("↑ 0.1.0-beta.41");
    // Settled: no second repaint hook.
    expect(box.refreshed()).toBeUndefined();
  });

  it("degrades to the local-only box when the network is down — no error noise", async () => {
    seedBridge({ claimUrl: "https://aifight.ai/claim/abc" });
    const box = createMenuStatusBox({
      fetchImpl: remoteFetch({ fail: true }),
      seatHolderPid: () => undefined,
    })!;
    await box.refreshed();
    const [l1, l2] = box.lines().map((line) => line.map((s) => s.text).join(""));
    // Local signals survive: claim URL on file = unclaimed; local name; no
    // update hint (the check never answered).
    expect(l1).toBe("Phantom Maverick · ⚠ unclaimed · ○ offline · auto: 2/day");
    expect(l2).not.toContain("available");
  });

  it("shows paused from the local flag even before any remote answer", async () => {
    seedBridge({ matchingPaused: true });
    const box = createMenuStatusBox({
      fetchImpl: remoteFetch({}),
      seatHolderPid: () => 4242,
    })!;
    const [l1] = box.lines().map((line) => line.map((s) => s.text).join(""));
    expect(l1).toContain("● paused");
    await box.refreshed();
  });

  it("uses the model the leaderboard shows (effective declared model)", () => {
    seedBridge({ declaredModel: "My Public Model" });
    const box = createMenuStatusBox({ fetchImpl: remoteFetch({}), seatHolderPid: () => undefined })!;
    const [, l2] = box.lines().map((line) => line.map((s) => s.text).join(""));
    expect(l2).toContain("My Public Model");
    // And the local config was not disturbed by drawing the banner.
    expect(readBridgeConfig().declaredModel).toBe("My Public Model");
  });
});
