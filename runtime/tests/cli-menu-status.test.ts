// The panel's boxed status banner: pure line composition plus the provider's
// local-first / remote-enriched lifecycle (owner ask 2026-07-30, 3x-ui style;
// V2 matching line 2026-07-31, owner decision ③).
//
// Isolation: every test gets its own AIFIGHT_RUNTIME_HOME via mkdtemp (the
// real default home path is never named here — build.sh greps for exactly
// that). The provider's remote arms are driven by a stubbed fetchImpl; the
// local online probe by an injected seat-holder seam; the live-queue probe
// by an injected queueProbe seam.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readBridgeConfig, writeBridgeConfig } from "../src/bridge/config";
import {
  composeMenuStatusLines,
  createMenuStatusBox,
  type MenuQueueState,
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
    matching: { state: "idle" },
    ...over,
  };
}

/** Join a composed line's segments into its plain text. */
function plain(lines: ReturnType<typeof composeMenuStatusLines>): string[] {
  return lines.map((line) => line.map((s) => s.text).join(""));
}

describe("composeMenuStatusLines", () => {
  it("composes three lines: identity + matching + model/games", () => {
    const [l1, l2, l3] = plain(composeMenuStatusLines(data()));
    expect(l1).toBe("Phantom Maverick · ✓ claimed · ● online · auto: 2/day");
    expect(l2).toBe("matching: idle · auto: 2/day");
    expect(l3).toBe("claude-opus-4-6 · games: texas_holdem, coup");
  });

  it("always returns exactly three lines, so a refresh repaint never shifts rows", () => {
    for (const d of [
      data(),
      data({ claimed: false }),
      data({ paused: true }),
      data({ updateVersion: "0.2.0-beta.4" }),
      data({ dailyCap: undefined }),
      data({ matching: { state: "not_running" } }),
      data({ matching: { state: "unknown" } }),
      data({ matching: { state: "queued", games: ["coup"] } }),
    ]) {
      expect(composeMenuStatusLines(d)).toHaveLength(3);
    }
  });

  it("styles: name bold, ✓ green, ● green when online, update hint yellow", () => {
    const lines = composeMenuStatusLines(data({ updateVersion: "0.2.0-beta.4" }));
    const styleOf = (text: string): string | undefined =>
      lines.flat().find((s) => s.text === text)?.style;
    expect(styleOf("Phantom Maverick")).toBe("bold");
    expect(styleOf("✓ claimed")).toBe("green");
    expect(styleOf("● online")).toBe("green");
    expect(styleOf("↑ 0.2.0-beta.4")).toBe("yellow");
  });

  it("puts the update hint before the games list, so truncation never eats the version", () => {
    const [, , l3] = plain(composeMenuStatusLines(data({ updateVersion: "0.2.0-beta.4" })));
    expect(l3).toBe("claude-opus-4-6 · ↑ 0.2.0-beta.4 · games: texas_holdem, coup");
  });

  it("unclaimed warns in yellow on line 1", () => {
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

// The V2 matching line (owner decision ③): one line, honest about its source.
// Priority: paused > unclaimed > queue truth (queued / idle / unreachable /
// bridge down).
describe("matching line state machine", () => {
  it("paused wins over everything, even a live queue", () => {
    const lines = composeMenuStatusLines(
      data({ paused: true, claimed: false, matching: { state: "queued", games: ["coup"] } }),
    );
    expect(lines[1]).toEqual([
      { text: "⏸ matching: paused · resume with: aifight resume", style: "yellow" },
    ]);
  });

  it("unclaimed guidance beats the queue truth, but not paused", () => {
    const unclaimed = composeMenuStatusLines(
      data({ claimed: false, matching: { state: "queued", games: ["coup"] } }),
    );
    expect(unclaimed[1]).toEqual([
      { text: "⚠ claim your agent first — menu item 12", style: "yellow" },
    ]);
    const pausedUnclaimed = composeMenuStatusLines(data({ claimed: false, paused: true }));
    expect(plain(pausedUnclaimed)[1]).toContain("⏸ matching: paused");
  });

  it("queued shows the games in cyan, joined with commas", () => {
    const lines = composeMenuStatusLines(
      data({ matching: { state: "queued", games: ["texas_holdem", "coup"] } }),
    );
    expect(lines[1]).toEqual([
      { text: "⚔ matching: queued texas_holdem, coup", style: "cyan" },
    ]);
  });

  it("idle (bridge up, nothing queued) says so with the cap, dim", () => {
    const lines = composeMenuStatusLines(data({ matching: { state: "idle" } }));
    expect(lines[1]).toEqual([{ text: "matching: idle · auto: 2/day", style: "dim" }]);
    expect(plain(composeMenuStatusLines(data({ dailyCap: 0, matching: { state: "idle" } })))[1])
      .toBe("matching: idle · auto: off");
    expect(plain(composeMenuStatusLines(data({ dailyCap: undefined, matching: { state: "idle" } })))[1])
      .toBe("matching: idle · auto: not set");
  });

  it("unreachable control API claims no queue — config truth only", () => {
    const lines = composeMenuStatusLines(data({ matching: { state: "unknown" } }));
    expect(lines[1]).toEqual([{ text: "matching: auto: 2/day", style: "dim" }]);
  });

  it("no live bridge says so plainly, with the cap", () => {
    const lines = composeMenuStatusLines(data({ matching: { state: "not_running" } }));
    expect(lines[1]).toEqual([{ text: "matching: bridge not running · auto: 2/day", style: "dim" }]);
    expect(plain(composeMenuStatusLines(data({ dailyCap: 0, matching: { state: "not_running" } })))[1])
      .toBe("matching: bridge not running · auto: off");
  });
});

// The remote arms the provider fires: the platform status endpoint, the
// update check (npm registry + server version floor) — and, via the seam,
// the queue probe.
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
    const [l1, l2, l3] = box.lines().map((line) => line.map((s) => s.text).join(""));
    expect(l1).toBe("Phantom Maverick · ✓ claimed · ● online · auto: 2/day");
    // Seat exists but the probe has not answered: config truth, no queue claim.
    expect(l2).toBe("matching: auto: 2/day");
    expect(l3).toBe("claude-opus-4-6 · games: texas_holdem, coup");
    expect(box.title).toMatch(/^AIFight · v\d+\.\d+\.\d+-beta\./);
    // The one-shot refresh is still pending.
    const pending = box.refreshed();
    expect(pending).toBeDefined();
    release(new Response("{}", { status: 500 }));
    return pending;
  });

  it("enriches with the remote answers: server name, claim state, update hint", async () => {
    seedBridge();
    const box = createMenuStatusBox({
      fetchImpl: remoteFetch({ claimed: true, name: "Server Name", npmLatest: "0.2.0-beta.4" }),
      seatHolderPid: () => undefined, // no local bridge process
    })!;
    const refresh = box.refreshed();
    expect(refresh).toBeDefined();
    await refresh;
    const [l1, l2, l3] = box.lines().map((line) => line.map((s) => s.text).join(""));
    expect(l1).toContain("Server Name");
    expect(l1).toContain("✓ claimed");
    expect(l1).toContain("○ offline");
    expect(l2).toBe("matching: bridge not running · auto: 2/day");
    expect(l3).toContain("↑ 0.2.0-beta.4");
    // The menu's Update item reads the same fact.
    expect(box.updateVersion?.()).toBe("0.2.0-beta.4");
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
    const [l1, l2, l3] = box.lines().map((line) => line.map((s) => s.text).join(""));
    // Local signals survive: claim URL on file = unclaimed; local name; no
    // update hint (the check never answered).
    expect(l1).toBe("Phantom Maverick · ⚠ unclaimed · ○ offline · auto: 2/day");
    expect(l2).toBe("⚠ claim your agent first — menu item 12");
    expect(l3).not.toContain("available");
    expect(box.updateVersion?.()).toBeUndefined();
  });

  it("shows paused from the local flag even before any remote answer", async () => {
    seedBridge({ matchingPaused: true });
    const box = createMenuStatusBox({
      fetchImpl: remoteFetch({}),
      seatHolderPid: () => 4242,
    })!;
    const [l1, l2] = box.lines().map((line) => line.map((s) => s.text).join(""));
    expect(l1).toContain("● paused");
    expect(l2).toBe("⏸ matching: paused · resume with: aifight resume");
    await box.refreshed();
  });

  it("uses the model the leaderboard shows (effective declared model)", () => {
    seedBridge({ declaredModel: "My Public Model" });
    const box = createMenuStatusBox({ fetchImpl: remoteFetch({}), seatHolderPid: () => undefined })!;
    const [, , l3] = box.lines().map((line) => line.map((s) => s.text).join(""));
    expect(l3).toContain("My Public Model");
    // And the local config was not disturbed by drawing the banner.
    expect(readBridgeConfig().declaredModel).toBe("My Public Model");
  });
});

// The queue probe joins the one-shot remote enrichment: it only runs when a
// bridge seat exists, and its answer lands on the same repaint as the rest.
describe("queue probe", () => {
  const probe = (result: MenuQueueState): (() => Promise<MenuQueueState>) => {
    return () => Promise.resolve(result);
  };

  it("is not asked at all when no bridge seat exists", async () => {
    seedBridge();
    let asked = 0;
    const box = createMenuStatusBox({
      fetchImpl: remoteFetch({}),
      seatHolderPid: () => undefined,
      queueProbe: () => {
        asked += 1;
        return probe({ state: "idle" })();
      },
    })!;
    await box.refreshed();
    expect(asked).toBe(0);
    expect(plain(box.lines())[1]).toBe("matching: bridge not running · auto: 2/day");
  });

  it("queued games land on the repaint when the probe resolves", async () => {
    seedBridge();
    const box = createMenuStatusBox({
      fetchImpl: remoteFetch({}),
      seatHolderPid: () => 4242,
      queueProbe: probe({ state: "queued", games: ["texas_holdem"] }),
    })!;
    // First paint: the probe is still in flight — no queue claim.
    expect(plain(box.lines())[1]).toBe("matching: auto: 2/day");
    await box.refreshed();
    expect(plain(box.lines())[1]).toBe("⚔ matching: queued texas_holdem");
    // The box still has exactly three lines after the refresh.
    expect(box.lines()).toHaveLength(3);
  });

  it("idle lands when the bridge answers with an empty queue", async () => {
    seedBridge();
    const box = createMenuStatusBox({
      fetchImpl: remoteFetch({}),
      seatHolderPid: () => 4242,
      queueProbe: probe({ state: "idle" }),
    })!;
    await box.refreshed();
    expect(plain(box.lines())[1]).toBe("matching: idle · auto: 2/day");
  });

  it("a probe failure leaves the config-truth line, no error noise", async () => {
    seedBridge();
    const box = createMenuStatusBox({
      fetchImpl: remoteFetch({}),
      seatHolderPid: () => 4242,
      queueProbe: () => Promise.reject(new Error("control API down")),
    })!;
    await box.refreshed();
    expect(plain(box.lines())[1]).toBe("matching: auto: 2/day");
    expect(box.lines()).toHaveLength(3);
  });

  it("a paused bridge never shows the queue, even when the probe says queued", async () => {
    seedBridge({ matchingPaused: true });
    const box = createMenuStatusBox({
      fetchImpl: remoteFetch({}),
      seatHolderPid: () => 4242,
      queueProbe: probe({ state: "queued", games: ["coup"] }),
    })!;
    await box.refreshed();
    expect(plain(box.lines())[1]).toBe("⏸ matching: paused · resume with: aifight resume");
  });
});

// The default (un-seamed) probe reads the daemon token/port files and asks
// the control API — here against the same recording-fetch style the pause
// tests use, with the port file pointing at the mock.
describe("default queue probe (control API)", () => {
  function seedDaemonFiles(home: string, port = 45993): void {
    fs.writeFileSync(path.join(home, "token"), "test-control-token", { mode: 0o600 });
    fs.writeFileSync(path.join(home, "port"), String(port), { mode: 0o644 });
  }

  it("reads state.queue.game out of GET /v1/agents, deduped", async () => {
    seedBridge();
    seedDaemonFiles(tmpDir!);
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/v1/agents")) {
        return new Response(JSON.stringify({
          agents: [
            { name: "a", state: { phase: "queued", queue: { game: "coup", mode: "ranked" } } },
            { name: "b", state: { phase: "queued", queue: { game: "coup", mode: "ranked" } } },
            { name: "c", state: null },
          ],
        }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const box = createMenuStatusBox({ fetchImpl, seatHolderPid: () => 4242 })!;
    await box.refreshed();
    expect(plain(box.lines())[1]).toBe("⚔ matching: queued coup");
  });

  it("an unreachable control API degrades to config truth", async () => {
    seedBridge();
    // No token/port files at all → the client cannot even build a request.
    const box = createMenuStatusBox({
      fetchImpl: remoteFetch({}),
      seatHolderPid: () => 4242,
    })!;
    await box.refreshed();
    expect(plain(box.lines())[1]).toBe("matching: auto: 2/day");
  });
});
