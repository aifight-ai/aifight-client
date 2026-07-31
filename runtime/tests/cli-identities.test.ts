// The identity store (bridge/identities.ts, V3 ④): one file per agent under
// <runtime-home>/identities/, bridge.json stays the ACTIVE truth, first use
// seeds the store from it (transparent migration), and a switch snapshots the
// outgoing active before overwriting bridge.json.
//
// Isolation: mkdtemp AIFIGHT_RUNTIME_HOME per test.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getBridgeConfigPath,
  readBridgeConfig,
  writeBridgeConfig,
  type BridgeConfig,
} from "../src/bridge/config";
import {
  identitiesDir,
  listIdentities,
  readIdentity,
  switchActiveIdentity,
  writeIdentity,
} from "../src/bridge/identities";

let prevHome: string | undefined;
let tmpDir: string | null = null;

beforeEach(() => {
  prevHome = process.env.AIFIGHT_RUNTIME_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-identities-"));
  process.env.AIFIGHT_RUNTIME_HOME = tmpDir;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
  else process.env.AIFIGHT_RUNTIME_HOME = prevHome;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  prevHome = undefined;
  tmpDir = null;
});

function config(agentId: string, agentName: string, over: Record<string, unknown> = {}): BridgeConfig {
  return {
    version: 1,
    baseUrl: "https://aifight.ai",
    wsUrl: "wss://aifight.ai/api/ws",
    agentId,
    agentName,
    apiKey: `sk-key-for-${agentId}`,
    runtimeType: "direct",
    runtimeLocalUrl: "direct://local",
    runtimeModel: "direct",
    directAgentSlug: "default",
    updatedAt: "2026-07-31T00:00:00.000Z",
    ...over,
  } as BridgeConfig;
}

describe("identity store", () => {
  it("seeds itself from the active bridge.json on first list (transparent migration)", () => {
    writeBridgeConfig(config("agent-1", "Steel Mongoose"));
    expect(fs.existsSync(identitiesDir())).toBe(false);

    const list = listIdentities();

    expect(list.map((i) => i.agentId)).toEqual(["agent-1"]);
    // The seeded file is a real identity file from then on.
    expect(fs.existsSync(path.join(identitiesDir(), "agent-1.json"))).toBe(true);
  });

  it("stays empty when there is no bridge.json to seed from", () => {
    expect(listIdentities()).toEqual([]);
  });

  it("write/read roundtrip, with the api key encrypted at rest like bridge.json", () => {
    writeIdentity(config("agent-2", "Phantom Maverick"));

    const raw = fs.readFileSync(path.join(identitiesDir(), "agent-2.json"), "utf8");
    expect(raw).not.toContain("sk-key-for-agent-2");
    expect(raw).toContain("enc:");

    const back = readIdentity("agent-2");
    expect(back?.agentName).toBe("Phantom Maverick");
    expect(back?.apiKey).toBe("sk-key-for-agent-2");
  });

  it("lists every stored identity in name order and skips damaged files", () => {
    writeIdentity(config("agent-b", "Zulu"));
    writeIdentity(config("agent-a", "Alpha"));
    fs.writeFileSync(path.join(identitiesDir(), "broken.json"), "{not json", { mode: 0o600 });

    const list = listIdentities();
    expect(list.map((i) => i.config.agentName)).toEqual(["Alpha", "Zulu"]);
  });

  it("switch writes the target over bridge.json AND snapshots the outgoing active back", () => {
    // Active agent-1 with a mid-session change (renamed + a daily cap) that
    // its (stale) identity file does not have yet.
    writeIdentity(config("agent-1", "Old Name"));
    writeBridgeConfig(config("agent-1", "New Name", { autoDailyLimit: 7 }));
    writeIdentity(config("agent-2", "Phantom Maverick"));

    switchActiveIdentity(readIdentity("agent-2")!);

    const active = readBridgeConfig();
    expect(active.agentId).toBe("agent-2");
    expect(active.agentName).toBe("Phantom Maverick");
    expect(active.apiKey).toBe("sk-key-for-agent-2");
    // The outgoing active was snapshotted with its LATEST state — rename and
    // cap survive a later switch back.
    const outgoing = readIdentity("agent-1");
    expect(outgoing?.agentName).toBe("New Name");
    expect(outgoing?.autoDailyLimit).toBe(7);
  });

  it("switch bumps bridge.json's mtime — the restart offer's signal", () => {
    writeBridgeConfig(config("agent-1", "Steel Mongoose"));
    writeIdentity(config("agent-2", "Phantom Maverick"));
    const old = new Date("2020-01-01T00:00:00Z");
    fs.utimesSync(getBridgeConfigPath(), old, old);

    switchActiveIdentity(readIdentity("agent-2")!);

    // A preserveMtime write would have restored the 2020 timestamp; the
    // switch deliberately does NOT preserve (identity + LLM are the two true
    // restart-needed changes).
    const after = fs.statSync(getBridgeConfigPath()).mtimeMs;
    expect(after).toBeGreaterThan(old.getTime() + 1000);
  });
});
