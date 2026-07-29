// The claim banner's truth source.
//
// The panel now leads with "⚠ NOT CLAIMED" because an unclaimed agent cannot
// play at all and nothing used to say so (owner, fresh VPS, 2026-07-29). That
// makes a WRONG banner its own bug: bridge.json's claimUrl is only scrubbed
// when some client observes is_claimed=true, so someone who claims in the
// browser and never runs `aifight status` would be warned forever.
//
// So the resolver asks the platform, and treats a claimed answer as the moment
// to scrub. Everything degrades to the local signal when the platform can't be
// reached — a banner is never worth blocking the panel on the network.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readBridgeConfig, writeBridgeConfig, type BridgeConfig } from "../src/bridge/config";
import { resolveClaimState } from "../src/cli/commands/claim-state";

let prevHome: string | undefined;
let tmpDir: string | null = null;

function useTempHome(): void {
  prevHome = process.env.AIFIGHT_RUNTIME_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-claim-state-"));
  process.env.AIFIGHT_RUNTIME_HOME = tmpDir;
}

afterEach(() => {
  if (prevHome === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
  else process.env.AIFIGHT_RUNTIME_HOME = prevHome;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  prevHome = undefined;
  tmpDir = null;
});

function seed(overrides: Partial<BridgeConfig> = {}): void {
  writeBridgeConfig({
    version: 1,
    baseUrl: "https://aifight.ai",
    wsUrl: "wss://aifight.ai/api/ws",
    agentId: "00000000-0000-4000-8000-000000000001",
    agentName: "PokerMind",
    apiKey: "sk-existing-secret",
    runtimeType: "direct",
    runtimeLocalUrl: "direct://local",
    runtimeModel: "direct",
    directAgentSlug: "default",
    updatedAt: "2026-07-27T00:00:00.000Z",
    ...overrides,
  });
}

function statusFetch(body: unknown, status = 200): { impl: typeof fetch; calls: () => number } {
  let calls = 0;
  const impl = (async (input: unknown) => {
    calls += 1;
    const url = String(input);
    if (!url.includes("/api/agents/me/status")) throw new Error(`unexpected fetch: ${url}`);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

const CLAIMED = {
  agent_id: "00000000-0000-4000-8000-000000000001",
  is_claimed: true,
  identity_status: "official",
  status: "ready",
  name: "PokerMind",
};
const UNCLAIMED = { ...CLAIMED, is_claimed: false, identity_status: "bootstrap", status: "pending_claim" };

describe("resolveClaimState", () => {
  it("warns, with the link, while the platform says unclaimed", async () => {
    useTempHome();
    seed({ claimUrl: "https://aifight.ai/claim/abc123" });
    const f = statusFetch(UNCLAIMED);

    const state = await resolveClaimState(f.impl);

    expect(state).toEqual({
      pending: true,
      url: "https://aifight.ai/claim/abc123",
      agentName: "PokerMind",
    });
  });

  it("stops warning — and scrubs — when the platform says it IS claimed", async () => {
    // Claimed in the browser, `aifight status` never run. Without this the
    // banner would be wrong on every single panel draw, forever.
    useTempHome();
    seed({ claimUrl: "https://aifight.ai/claim/abc123", claimToken: "tok-abc123" });
    const f = statusFetch(CLAIMED);

    const state = await resolveClaimState(f.impl);

    expect(state?.pending).toBe(false);
    const after = readBridgeConfig();
    expect(after.claimUrl).toBeUndefined();
    expect(after.claimToken).toBeUndefined();
  });

  it("falls back to the local signal when the platform is unreachable", async () => {
    useTempHome();
    seed({ claimUrl: "https://aifight.ai/claim/abc123" });
    const offline = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const state = await resolveClaimState(offline);

    // Better a possibly-stale warning than a panel that can't open offline.
    expect(state?.pending).toBe(true);
    expect(state?.url).toBe("https://aifight.ai/claim/abc123");
    // ...and nothing was scrubbed on the strength of a failed request.
    expect(readBridgeConfig().claimUrl).toBe("https://aifight.ai/claim/abc123");
  });

  it("falls back on an HTTP error too (old server, proxy, 5xx)", async () => {
    useTempHome();
    seed({ claimUrl: "https://aifight.ai/claim/abc123" });
    const f = statusFetch({}, 503);

    const state = await resolveClaimState(f.impl);

    expect(state?.pending).toBe(true);
  });

  it("makes NO request when there is no claim URL on file", async () => {
    useTempHome();
    seed(); // already claimed at some point — artifacts gone
    const f = statusFetch(CLAIMED);

    const state = await resolveClaimState(f.impl);

    expect(state).toEqual({ pending: false, agentName: "PokerMind" });
    // Drawing the panel must not cost a round trip for an already-claimed agent.
    expect(f.calls()).toBe(0);
  });

  it("returns nothing at all when this machine has no agent", async () => {
    useTempHome();
    const f = statusFetch(CLAIMED);

    expect(await resolveClaimState(f.impl)).toBeUndefined();
    expect(f.calls()).toBe(0);
  });
});
