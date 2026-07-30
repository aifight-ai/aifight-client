// Declared-model feature (owner decision 2026-07-30) — main-process half.
// The desktop pins the agent's PUBLIC leaderboard model name into the shared
// bridge.json (`declaredModel`) through the runtime's own writer, then
// best-effort PATCHes the platform with the EFFECTIVE name
// (pin || active profile's model || "direct"). These tests run in node
// (vitest) against a temp AIFIGHT_HOME/AIFIGHT_RUNTIME_HOME, following the
// bridge-host.test.ts cross-check pattern: real files, mocked fetch.

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readBridgeConfig, writeBridgeConfig, type BridgeConfig } from "@aifight/aifight/bridge/config";
import { BridgeHost, effectiveDeclaredModel, sanitizeDeclaredModel } from "./bridge-host";
import { saveProfile } from "./config-host";
import { DECLARED_MODEL_MAX_LEN } from "../shared/ipc";

const ORIGINAL_HOME = process.env.AIFIGHT_HOME;
const ORIGINAL_RUNTIME_HOME = process.env.AIFIGHT_RUNTIME_HOME;
const tmpDirs: string[] = [];

/** Point the unified home AND the runtime home at a fresh temp dir. */
function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-desktop-declared-"));
  tmpDirs.push(dir);
  process.env.AIFIGHT_HOME = dir;
  process.env.AIFIGHT_RUNTIME_HOME = path.join(dir, "runtime");
  return dir;
}

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.AIFIGHT_HOME;
  else process.env.AIFIGHT_HOME = ORIGINAL_HOME;
  if (ORIGINAL_RUNTIME_HOME === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
  else process.env.AIFIGHT_RUNTIME_HOME = ORIGINAL_RUNTIME_HOME;
  vi.unstubAllGlobals();
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

const SECRET_KEY = "sk-secret-must-not-leak-7f3a9c";

function validConfig(): BridgeConfig {
  return {
    version: 1,
    baseUrl: "https://aifight.ai",
    wsUrl: "wss://aifight.ai/api/ws",
    agentId: "agent-declared",
    agentName: "Declared Agent",
    apiKey: SECRET_KEY,
    runtimeType: "direct",
    runtimeLocalUrl: "direct://local",
    updatedAt: "2026-06-02T00:00:00.000Z",
  };
}

/** The pinned value as the runtime's own reader hands it back (proving the CLI
 *  sees the same pin through the same reader). */
function readPin(): string | undefined {
  return readBridgeConfig().declaredModel;
}

function mockFetchOk(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => ({ ok: true, status: 200, text: async () => "" }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** The (url, init) the policy PATCH went out with, from the fetch mock. */
function patchCall(mock: ReturnType<typeof vi.fn>): { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } } {
  expect(mock).toHaveBeenCalledTimes(1);
  const [url, init] = mock.mock.calls[0] as [string, { method?: string; headers?: Record<string, string>; body?: string }];
  return { url, init };
}

describe("sanitizeDeclaredModel", () => {
  it("trims and keeps a real name", () => {
    expect(sanitizeDeclaredModel("  My Model v2 ")).toEqual({ ok: true, value: "My Model v2" });
  });
  it("empty / whitespace / absent = unpinned (null)", () => {
    expect(sanitizeDeclaredModel("")).toEqual({ ok: true, value: null });
    expect(sanitizeDeclaredModel("   ")).toEqual({ ok: true, value: null });
    expect(sanitizeDeclaredModel(undefined)).toEqual({ ok: true, value: null });
  });
  it(`accepts exactly ${DECLARED_MODEL_MAX_LEN} chars, rejects more`, () => {
    expect(sanitizeDeclaredModel("x".repeat(DECLARED_MODEL_MAX_LEN))).toEqual({
      ok: true,
      value: "x".repeat(DECLARED_MODEL_MAX_LEN),
    });
    const over = sanitizeDeclaredModel("x".repeat(DECLARED_MODEL_MAX_LEN + 1));
    expect(over.ok).toBe(false);
  });
  it("rejects non-strings", () => {
    expect(sanitizeDeclaredModel(42).ok).toBe(false);
  });
});

describe("effectiveDeclaredModel", () => {
  it("pin wins over the active profile's model", () => {
    expect(effectiveDeclaredModel("Pinned Name", "claude-opus-5")).toBe("Pinned Name");
  });
  it("unpinned → the active profile's configured model", () => {
    expect(effectiveDeclaredModel(null, "claude-opus-5")).toBe("claude-opus-5");
  });
  it("neither → the platform's direct fallback", () => {
    expect(effectiveDeclaredModel(null, null)).toBe("direct");
    expect(effectiveDeclaredModel(null, "  ")).toBe("direct");
  });
});

describe("BridgeHost.setDeclaredModel", () => {
  it("persists the pin to bridge.json and PATCHes the effective value", async () => {
    freshHome();
    writeBridgeConfig(validConfig());
    await saveProfile("default", { profileId: "anthropic", family: "anthropic", model: "claude-opus-5", thinkingEnabled: true });
    const fetchMock = mockFetchOk();

    const res = await new BridgeHost().setDeclaredModel({ declaredModel: "  My Display  " });

    expect(res).toEqual({ ok: true, effective: "My Display" });
    expect(readPin()).toBe("My Display");
    const { url, init } = patchCall(fetchMock);
    expect(url).toBe("https://aifight.ai/api/agents/me/policy");
    expect(init.method).toBe("PATCH");
    expect(init.headers?.["X-API-Key"]).toBe(SECRET_KEY);
    expect(JSON.parse(init.body ?? "")).toEqual({ declared_model: "My Display" });
  });

  it("empty input unpins: the key leaves bridge.json and the sync sends the profile model", async () => {
    freshHome();
    writeBridgeConfig({ ...validConfig(), declaredModel: "Old Pin" });
    await saveProfile("default", { profileId: "anthropic", family: "anthropic", model: "claude-opus-5", thinkingEnabled: true });
    expect(readPin()).toBe("Old Pin");
    const fetchMock = mockFetchOk();

    const res = await new BridgeHost().setDeclaredModel({ declaredModel: "" });

    expect(res).toEqual({ ok: true, effective: "claude-opus-5" });
    expect(readPin()).toBeUndefined();
    expect(JSON.parse(patchCall(fetchMock).init.body ?? "")).toEqual({ declared_model: "claude-opus-5" });
  });

  it("no pin and no LLM config syncs the direct fallback", async () => {
    freshHome();
    writeBridgeConfig(validConfig());
    const fetchMock = mockFetchOk();

    const res = await new BridgeHost().setDeclaredModel({ declaredModel: "" });

    expect(res).toEqual({ ok: true, effective: "direct" });
    expect(JSON.parse(patchCall(fetchMock).init.body ?? "")).toEqual({ declared_model: "direct" });
  });

  it("the status summary carries the pin + active profile model for the hero", async () => {
    freshHome();
    writeBridgeConfig(validConfig());
    await saveProfile("default", { profileId: "anthropic", family: "anthropic", model: "claude-opus-5", thinkingEnabled: true });
    mockFetchOk();

    const host = new BridgeHost();
    await host.setDeclaredModel({ declaredModel: "Board Name" });
    const cfg = host.getStatus().config;
    expect(cfg?.declaredModel).toBe("Board Name");
    expect(cfg?.profileModel).toBe("claude-opus-5");
  });

  it("a failed PATCH is a warning, never a failed save", async () => {
    freshHome();
    writeBridgeConfig(validConfig());
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" })));

    const res = await new BridgeHost().setDeclaredModel({ declaredModel: "Pinned" });

    expect(res.ok).toBe(true);
    expect(res.effective).toBe("Pinned");
    expect(res.syncError).toContain("HTTP 500");
    expect(readPin()).toBe("Pinned"); // the local save stands
  });

  it("a network error is likewise non-blocking", async () => {
    freshHome();
    writeBridgeConfig(validConfig());
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("socket hangup"))));

    const res = await new BridgeHost().setDeclaredModel({ declaredModel: "Pinned" });

    expect(res.ok).toBe(true);
    expect(res.syncError).toContain("socket hangup");
    expect(readPin()).toBe("Pinned");
  });

  it("over-length input refuses BEFORE touching disk or network", async () => {
    freshHome();
    writeBridgeConfig(validConfig());
    const fetchMock = mockFetchOk();

    const res = await new BridgeHost().setDeclaredModel({ declaredModel: "x".repeat(DECLARED_MODEL_MAX_LEN + 1) });

    expect(res.ok).toBe(false);
    expect(readPin()).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an unchanged pin skips the bridge.json rewrite but still re-syncs", async () => {
    freshHome();
    writeBridgeConfig({ ...validConfig(), declaredModel: "Same" });
    const fetchMock = mockFetchOk();

    const res = await new BridgeHost().setDeclaredModel({ declaredModel: "Same" });

    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // No rewrite → updatedAt keeps the fixture value instead of bumping to now.
    expect(readBridgeConfig().updatedAt).toBe("2026-06-02T00:00:00.000Z");
  });

  it("reports not-configured instead of throwing when bridge.json is absent", async () => {
    freshHome();
    mockFetchOk();

    const res = await new BridgeHost().setDeclaredModel({ declaredModel: "Pinned" });

    expect(res.ok).toBe(false);
  });
});
