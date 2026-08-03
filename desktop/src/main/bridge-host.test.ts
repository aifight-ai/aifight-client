// D10 — the "most critical" cross-check (per the P3 taskbook): the desktop and
// the CLI must read/write ONE shared config. Here the runtime's writeBridgeConfig
// (exactly what `aifight register`/`connect` do) writes bridge.json under a temp
// AIFIGHT_RUNTIME_HOME, and the desktop's BridgeHost.readConfigSummary() reads it
// back — proving they agree on location AND that the renderer-facing summary
// carries no secrets.
//
// Runs in node (vitest): BridgeHost's static surface is only readBridgeConfig
// (clean — no electron, no native modules), so importing it here is safe.

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readBridgeConfig, writeBridgeConfig, type BridgeConfig } from "@aifight/aifight/bridge/config";
import { FALLBACK_LIVE_GAMES } from "../shared/games";
import { BridgeHost, safeExternalClaimUrl } from "./bridge-host";

const ORIGINAL_HOME = process.env.AIFIGHT_RUNTIME_HOME;
const tmpDirs: string[] = [];

/** Point the runtime home at a fresh temp dir (getRuntimeHome reads this at call time). */
function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-desktop-xcheck-"));
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

const SECRET_KEY = "sk-secret-must-not-leak-7f3a9c";
const SECRET_TOKEN = "runtime-token-must-not-leak-22b1";

// Mirrors the runtime's own known-valid bridge-config fixture + the optional
// daily/games fields the desktop summary surfaces.
function validConfig(): BridgeConfig {
  return {
    version: 1,
    baseUrl: "https://aifight.ai",
    wsUrl: "wss://aifight.ai/api/ws",
    agentId: "agent-xcheck",
    agentName: "CrossCheck Agent",
    apiKey: SECRET_KEY,
    runtimeType: "direct",
    runtimeLocalUrl: "direct://local",
    runtimeLocalToken: SECRET_TOKEN,
    autoDailyLimit: 7,
    autoGames: ["texas_holdem", "coup"],
    updatedAt: "2026-06-02T00:00:00.000Z",
  };
}

describe("shared-config cross-check (CLI writes ↔ desktop reads)", () => {
  it("BridgeHost reads the SAME bridge.json the runtime writes", () => {
    freshHome();
    writeBridgeConfig(validConfig()); // what `aifight register`/`connect` do

    const status = new BridgeHost().readConfigSummary();

    expect(status.phase).not.toBe("unconfigured");
    expect(status.config).toBeDefined();
    expect(status.config?.agentId).toBe("agent-xcheck");
    expect(status.config?.agentName).toBe("CrossCheck Agent");
    expect(status.config?.baseUrl).toBe("https://aifight.ai");
    expect(status.config?.runtimeType).toBe("direct");
    expect(status.config?.autoDailyLimit).toBe(7);
    expect(status.config?.autoGames).toEqual(["texas_holdem", "coup"]);
  });

  it("🔒 the renderer-facing summary carries NO secrets", () => {
    freshHome();
    writeBridgeConfig(validConfig());

    const status = new BridgeHost().readConfigSummary();
    const serialized = JSON.stringify(status.config);

    expect(serialized).not.toContain(SECRET_KEY);
    expect(serialized).not.toContain(SECRET_TOKEN);
    const keys = Object.keys(status.config ?? {});
    expect(keys).not.toContain("apiKey");
    expect(keys).not.toContain("runtimeLocalToken");
    expect(keys).not.toContain("claimToken");
  });

  it("reports unconfigured cleanly when no bridge.json exists", () => {
    freshHome(); // empty home, no config written
    const status = new BridgeHost().readConfigSummary();
    expect(status.phase).toBe("unconfigured");
    expect(status.config).toBeUndefined();
  });

  it("connection-health starts idle/empty before the bridge runs (no false 'alive')", () => {
    freshHome();
    const health = new BridgeHost().getConnectionHealth();
    expect(health.phase).toBe("idle");
    expect(health.connectedAt).toBeNull();
    expect(health.reconnects).toBe(0);
    expect(health.lastActivityAt).toBeNull();
  });
});

// ── removeLocalIdentity (device-mismatch takeover, button 2) ─────────────────
// The takeover's "Remove this device's identity" action archives + removes the
// LOCAL bridge.json so the app returns to onboarding and can re-pair. The
// server-side agent is never touched (this is a pure local-credential clear).
describe("removeLocalIdentity (device-mismatch takeover, button 2)", () => {
  it("archives then removes the local identity → unconfigured, recoverable", async () => {
    const home = freshHome();
    writeBridgeConfig(validConfig());
    const host = new BridgeHost();
    expect(host.readConfigSummary().phase).not.toBe("unconfigured"); // sanity: configured

    const r = await host.removeLocalIdentity();

    expect(r.ok).toBe(true);
    expect(r.status?.phase).toBe("unconfigured");
    expect(r.status?.config).toBeUndefined();
    // The shared bridge.json is gone → a fresh read also reports unconfigured.
    expect(new BridgeHost().readConfigSummary().phase).toBe("unconfigured");
    // A redacted archive is kept on disk (recoverable pointer; carries no secrets).
    const archivePath = path.join(home, "bridge.replaced-agent-xcheck.json");
    expect(fs.existsSync(archivePath)).toBe(true);
    const archived = fs.readFileSync(archivePath, "utf8");
    expect(archived).toContain("agent-xcheck");
    expect(archived).not.toContain(SECRET_KEY);
    expect(archived).not.toContain(SECRET_TOKEN);
  });

  it("is a no-op success when there is no local identity", async () => {
    freshHome(); // empty home — nothing to remove
    const r = await new BridgeHost().removeLocalIdentity();
    expect(r.ok).toBe(true);
    expect(r.status?.phase).toBe("unconfigured");
  });

  it("quarantines an unreadable bridge.json instead of pretending there was no identity", async () => {
    const home = freshHome();
    fs.writeFileSync(path.join(home, "bridge.json"), "{not json", { mode: 0o600 });
    const logs: Array<{ code: string }> = [];

    const r = await new BridgeHost({ onLog: (event) => logs.push(event) }).removeLocalIdentity();

    expect(r.ok).toBe(true);
    expect(r.status?.phase).toBe("unconfigured");
    expect(fs.existsSync(path.join(home, "bridge.json"))).toBe(false);
    const quarantined = fs.readdirSync(home).filter((name) => name.startsWith("bridge.unreadable-"));
    expect(quarantined).toHaveLength(1);
    expect(fs.readFileSync(path.join(home, quarantined[0]!), "utf8")).toBe("{not json");
    expect(logs.some((event) => event.code === "desktop.bridge_identity_quarantined")).toBe(true);
  });
});

// ── Daily-cap two-ledger sync (setAgentPolicy → local bridge.json) ───────────
// The desktop's cap control writes the SERVER policy (source of truth) AND the
// local bridge.json autoDailyLimit, so `aifight status` + the diagnostics card
// (which read the LOCAL field) never disagree with what the user just set. The
// desktop used to write the local field only at `aifight setup`, pinning it at
// the default while the server cap moved.

describe("setAgentPolicy reconciles the LOCAL bridge.json cap after the server accepts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes autoDailyLimit back to bridge.json when the server PATCH succeeds", async () => {
    freshHome();
    writeBridgeConfig(validConfig()); // starts at autoDailyLimit: 7
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);

    const host = new BridgeHost();
    const r = await host.setAgentPolicy({ maxGamesPerDay: 6 });

    expect(r.ok).toBe(true);
    // PATCH hit the policy endpoint...
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://aifight.ai/api/agents/me/policy");
    // ...and the local ledger the diagnostics card reads now agrees with it.
    expect(readBridgeConfig().autoDailyLimit).toBe(6);
  });

  it("disabling auto-match (cap 0) is mirrored locally too", async () => {
    freshHome();
    writeBridgeConfig(validConfig()); // autoDailyLimit: 7
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => "" }));

    const r = await new BridgeHost().setAgentPolicy({ maxGamesPerDay: 0 });

    expect(r.ok).toBe(true);
    expect(readBridgeConfig().autoDailyLimit).toBe(0);
  });

  it("does NOT touch the local cap when the server PATCH fails (no half-applied state)", async () => {
    freshHome();
    writeBridgeConfig(validConfig()); // autoDailyLimit: 7
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);

    const r = await new BridgeHost().setAgentPolicy({ maxGamesPerDay: 6 });

    expect(r.ok).toBe(false);
    expect(readBridgeConfig().autoDailyLimit).toBe(7); // unchanged
  });
});

// ── Live-game list (the backend is the single source) ───────────────────────
// The desktop must never pin its own live list: getLiveGames serves the host
// cache (welcome frame / earlier fetch) → GET /api/games → local fallback, and
// a fallback answer must NOT stick (a later real answer wins).

describe("live-game list follows the backend", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("liveGamesSync serves the local fallback before any backend answer", () => {
    freshHome();
    expect(new BridgeHost().liveGamesSync()).toEqual(FALLBACK_LIVE_GAMES);
  });

  it("getLiveGames fetches GET /api/games once, then serves the cache (incl. a 4th game)", async () => {
    freshHome();
    writeBridgeConfig(validConfig());
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        games: [{ name: "texas_holdem" }, { name: "liars_dice" }, { name: "coup" }, { name: "bocce_ball" }],
        count: 4,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const host = new BridgeHost();
    const first = await host.getLiveGames();
    expect(first).toEqual(["texas_holdem", "liars_dice", "coup", "bocce_ball"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://aifight.ai/api/games");

    // Cached: no second network call; sync view agrees.
    expect(await host.getLiveGames()).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(host.liveGamesSync()).toEqual(first);
  });

  it("falls back when the platform is unreachable, then recovers on the next call", async () => {
    freshHome();
    writeBridgeConfig(validConfig());
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ games: [{ name: "coup" }] }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const host = new BridgeHost();
    expect(await host.getLiveGames()).toEqual(FALLBACK_LIVE_GAMES); // offline → fallback, NOT cached
    expect(await host.getLiveGames()).toEqual(["coup"]); // retried and replaced
    expect(host.liveGamesSync()).toEqual(["coup"]);
  });

  it("returns the fallback without any network when unconfigured", async () => {
    freshHome(); // no bridge.json
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await new BridgeHost().getLiveGames()).toEqual(FALLBACK_LIVE_GAMES);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// pickAutoGame's suite retired with the function itself (D1/U8d, owner ruling
// 2026-08-03): the desktop no longer chooses a game for any automatic path, so
// there is no local picker left to pin. The live-game list above still matters
// — it is the standby POOL the platform picks from. See resumeStandby.test.ts.

// F41/AIF-11: the claim URL comes from tamperable local config — only http(s)
// on the paired host may ever reach shell.openExternal.
describe("safeExternalClaimUrl (F41)", () => {
  it("accepts the platform claim link on the paired host", () => {
    expect(
      safeExternalClaimUrl("https://aifight.ai/claim/abc123", "https://aifight.ai"),
    ).toBe("https://aifight.ai/claim/abc123");
  });

  it("accepts the bare baseUrl fallback", () => {
    expect(safeExternalClaimUrl("https://aifight.ai", "https://aifight.ai")).toBe(
      "https://aifight.ai/",
    );
  });

  it("rejects non-http(s) schemes outright", () => {
    expect(safeExternalClaimUrl("file:///etc/passwd", "https://aifight.ai")).toBeNull();
    expect(safeExternalClaimUrl("smb://evil/share", "https://aifight.ai")).toBeNull();
    expect(safeExternalClaimUrl("javascript:alert(1)", "https://aifight.ai")).toBeNull();
  });

  it("rejects a claim link pointing at a different host than baseUrl", () => {
    expect(
      safeExternalClaimUrl("https://evil.example.com/claim/abc", "https://aifight.ai"),
    ).toBeNull();
  });

  it("rejects remote plain http but tolerates loopback dev", () => {
    expect(safeExternalClaimUrl("http://aifight.ai/claim/x", "http://aifight.ai")).toBeNull();
    expect(
      safeExternalClaimUrl("http://localhost:8080/claim/x", "http://localhost:8080"),
    ).toBe("http://localhost:8080/claim/x");
  });

  it("rejects garbage and unparseable baseUrl", () => {
    expect(safeExternalClaimUrl("not a url", "https://aifight.ai")).toBeNull();
    expect(safeExternalClaimUrl("https://aifight.ai/claim/x", "::::")).toBeNull();
  });
});

// getDashboardTarget reuses safeExternalClaimUrl as the allowlist for BOTH the
// minted SSO URL and the bare-dashboard fallback, so a tampered/misconfigured
// server cannot redirect shell.openExternal to an arbitrary origin. These pin
// that the real console-handoff URL shape (with ?ot=) clears the boundary
// on-host and is rejected off-host.
describe("SSO console-handoff URL passes the same external-open allowlist", () => {
  it("accepts the minted /api/auth/console URL on the paired host", () => {
    expect(
      safeExternalClaimUrl("https://aifight.ai/api/auth/console?ot=abc-123_DEF", "https://aifight.ai"),
    ).toBe("https://aifight.ai/api/auth/console?ot=abc-123_DEF");
  });

  it("accepts the bare-dashboard fallback on the paired host", () => {
    expect(safeExternalClaimUrl("https://aifight.ai/dashboard", "https://aifight.ai")).toBe(
      "https://aifight.ai/dashboard",
    );
  });

  it("rejects a handoff URL whose host differs from the configured baseUrl", () => {
    expect(
      safeExternalClaimUrl("https://evil.example.com/api/auth/console?ot=stolen", "https://aifight.ai"),
    ).toBeNull();
  });
});

// 2026-07-24 connect/evict storm. The platform keeps ONE live connection per
// agent, and the desktop app and the CLI service share one agent identity under
// the runtime home — so when both ran, each kicked the other off about once a
// second and neither ever played a match. The lockfile is how they now take
// turns: whoever starts first owns the seat, the other says so and stops.
describe("agent seat — one Bridge per machine", () => {
  /** Impersonate a live foreign Bridge. The lock carries the owner stamp a real
   *  bridge writes; the pid is our own, since the liveness probe only asks
   *  whether the process exists. */
  function foreignBridgeHoldsSeat(home: string): void {
    fs.writeFileSync(
      path.join(home, "lock"),
      JSON.stringify({ pid: process.pid, boot: Date.now() }),
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(home, "pid"), `${process.pid}\n`, { mode: 0o600 });
  }

  it("start() refuses instead of connecting, and names the process holding it", async () => {
    const home = freshHome();
    writeBridgeConfig(validConfig());
    foreignBridgeHoldsSeat(home);

    const status = await new BridgeHost().start();

    expect(status.phase).toBe("error");
    expect(status.code).toBe("lockHeld");
    expect(status.codeParams?.pid).toBe(process.pid);
    // The runtime's own sentence rides along: for a lock left by a crash whose
    // pid the OS has since reused, it is the only text that says what helps.
    expect(String(status.codeParams?.detail)).toContain(String(process.pid));
    // English fallback for an untranslated locale; the UI prefers bridgeError.*.
    expect(status.message).toContain("already running this agent");
    // 审查 #7: pid-reuse-safe advice — the lock file is named explicitly, so
    // the user never goes hunting for a process that isn't there.
    expect(String(status.codeParams?.lockPath)).toBe(path.join(home, "lock"));
    expect(status.message).toContain("delete the lock file at");
    // The seat holder's files are untouched — deleting them would strand it.
    expect(fs.existsSync(path.join(home, "lock"))).toBe(true);
    expect(fs.existsSync(path.join(home, "pid"))).toBe(true);
  });

  it("passes through the runtime's recovery advice for a lock left by a crash", async () => {
    // Hard kill leaves the lock behind; after a reboot the OS can hand that pid
    // to an unrelated process, which probes as alive. Telling the user to stop a
    // service that isn't running is a dead end — the lock file has to be named.
    const home = freshHome();
    writeBridgeConfig(validConfig());
    fs.writeFileSync(
      path.join(home, "lock"),
      JSON.stringify({ pid: process.pid, boot: Date.now() - 7 * 24 * 60 * 60 * 1000 }),
      { mode: 0o600 },
    );

    const status = await new BridgeHost().start();

    expect(status.code).toBe("lockHeld");
    expect(String(status.codeParams?.detail)).toContain("before the last restart");
    expect(String(status.codeParams?.detail)).toContain(path.join(home, "lock"));
  });

  it("claims nothing when it never gets as far as connecting", async () => {
    const home = freshHome(); // no bridge.json — start() bails out early
    const host = new BridgeHost();

    const status = await host.start();
    expect(status.phase).toBe("unconfigured");
    // A lock left behind here would lock the CLI service out of an agent this
    // app is not even running.
    expect(fs.existsSync(path.join(home, "lock"))).toBe(false);

    // stop()/quit release the seat unconditionally; with nothing held that has
    // to be a silent no-op, not a throw on the app's shutdown path.
    await host.stop();
    host.releaseAgentSeatSync();
    expect(fs.existsSync(path.join(home, "lock"))).toBe(false);
  });
});
