// 连接审计 #13 (owner ruling 2026-07-28) — 暂停匹配 survives relaunches, and the
// truth lives in the MAIN process so the connected edge honours it before any
// enrollment can happen. These lock the three properties that make that true:
// read at construction, persisted on set, and persisted even while offline (the
// old code returned early when no runner existed, silently dropping the pause).
//
// 2026-08-06 adds the half that persistence alone never covered: pausing with
// no bridge running has to reach the PLATFORM too (POST /api/queue/leave), or
// the server keeps auto_requeue on and the supply sweep enrolls an agent whose
// owner just switched matching off. The CLI's `aifight pause` has always done
// this; the app used to write the flag and return.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeBridgeConfig, type BridgeConfig } from "@aifight/aifight/bridge/config";

const flags = new Map<string, boolean>();
vi.mock("./ui-flags", () => ({
  getFlag: (key: string) => flags.get(key) === true,
  setFlag: (key: string, value: boolean) => {
    flags.set(key, value);
  },
}));

const { BridgeHost, leaveQueueViaPlatform } = await import("./bridge-host");

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
  vi.unstubAllGlobals();
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

function validConfig(over: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    version: 1,
    baseUrl: "https://aifight.ai",
    wsUrl: "wss://aifight.ai/api/ws",
    agentId: "agent-pause",
    agentName: "Pause Agent",
    apiKey: "sk-not-a-real-key",
    runtimeType: "direct",
    runtimeLocalUrl: "direct://local",
    runtimeLocalToken: "token-not-real",
    updatedAt: "2026-08-06T00:00:00.000Z",
    ...over,
  };
}

/** Record every request the host makes, answering 200. */
function recordingFetch(status = 200): {
  readonly calls: Array<{ url: string; method: string; headers: Record<string, string> }>;
  readonly impl: ReturnType<typeof vi.fn>;
} {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const impl = vi.fn(async (url: string, init: { method: string; headers: Record<string, string> }) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers });
    return { ok: status >= 200 && status < 300, status };
  });
  return { calls, impl };
}

describe("pausing without a bridge still closes the server half", () => {
  it("pausing offline POSTs the platform queue leave with the agent key", async () => {
    writeBridgeConfig(validConfig());
    const { calls, impl } = recordingFetch();
    vi.stubGlobal("fetch", impl);
    const host = new BridgeHost();

    await host.setMatchingPaused(true);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://aifight.ai/api/queue/leave");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["X-API-Key"]).toBe("sk-not-a-real-key");
    // The local half is untouched by whatever the network did.
    expect(flags.get("matchingPaused")).toBe(true);
  });

  it("resuming offline calls nothing — the standby declaration re-opens the server half", async () => {
    writeBridgeConfig(validConfig({ matchingPaused: true }));
    flags.set("matchingPaused", true);
    const { calls, impl } = recordingFetch();
    vi.stubGlobal("fetch", impl);
    const host = new BridgeHost();

    await host.setMatchingPaused(false);

    expect(calls).toEqual([]);
    expect(flags.get("matchingPaused")).toBe(false);
  });

  it("a refused leave is a warning, not a failed pause", async () => {
    writeBridgeConfig(validConfig());
    const { impl } = recordingFetch(503);
    vi.stubGlobal("fetch", impl);
    const logs: Array<{ code: string; level: string }> = [];
    const host = new BridgeHost({ onLog: (e) => logs.push({ code: e.code ?? "", level: e.level }) });

    await expect(host.setMatchingPaused(true)).resolves.toBeUndefined();

    expect(logs.some((e) => e.code === "desktop.pause_platform_leave_failed" && e.level === "warning")).toBe(true);
    expect(flags.get("matchingPaused")).toBe(true);
  });

  it("an unconfigured bridge sends nothing at all", async () => {
    // No bridge.json in the temp home — there is no key to authenticate with,
    // and no agent the platform could be holding a queue slot for.
    const { calls, impl } = recordingFetch();
    vi.stubGlobal("fetch", impl);
    const host = new BridgeHost();

    await host.setMatchingPaused(true);

    expect(calls).toEqual([]);
    expect(flags.get("matchingPaused")).toBe(true);
  });

  it("a config with no API key sends nothing either", async () => {
    writeBridgeConfig(validConfig({ apiKey: "" }));
    const { calls, impl } = recordingFetch();

    const result = await leaveQueueViaPlatform(impl as never);

    expect(result).toEqual({ called: false, ok: false });
    expect(calls).toEqual([]);
  });
});
