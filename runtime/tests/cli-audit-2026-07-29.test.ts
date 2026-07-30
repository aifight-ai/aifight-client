// Regression tests for the 2026-07-29 adversarial CLI review (branch
// audit/2026-07-29-runtime-cli-review). Each test names the finding it pins.
//
// Covered here (the command-level fixes):
//   P1-3  rename offers the bridge restart like every other settings write
//   P1-5  status / record surface the real claim link for an unclaimed agent
//   P1-6  a live seat holder without the control API = the desktop app's
//         in-process bridge, not "bridge not running"
//   P1-7  set/challenge/accept/rename/run on an unconfigured machine exit 1
//         with a hint, never the exit-99 catchall
//   P2-8  `config reasonng` did-you-mean suggests `config reasoning`
//   P2-10 `config add --key-stdin` refuses a terminal stdin instead of
//         reading to EOF (looking hung)
//   P2-12 accept-terms reports 401/403 (dead credentials) separately from
//         "could not reach the server"

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { run } from "../src/cli/main";
import { readBridgeConfig, writeBridgeConfig, type BridgeConfig } from "../src/bridge/config";
import type { BridgeServiceDeps } from "../src/bridge/service";
import { resolveKeyRef } from "../src/cli/commands/config-edit";
import type { HandlerEnv } from "../src/cli/shared";

let prevHome: string | undefined;
let tmpDir: string | null = null;

function useTempHome(): string {
  prevHome = process.env.AIFIGHT_RUNTIME_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-cli-audit-"));
  process.env.AIFIGHT_RUNTIME_HOME = tmpDir;
  return tmpDir;
}

afterEach(() => {
  if (prevHome === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
  else process.env.AIFIGHT_RUNTIME_HOME = prevHome;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  prevHome = undefined;
  tmpDir = null;
});

async function runCapture(
  argv: readonly string[],
  fetchImpl?: typeof fetch,
  bridgeService?: BridgeServiceDeps,
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(argv, {
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    ...(bridgeService !== undefined ? { bridgeService } : {}),
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

/** A service-manager view that always answers "not installed" without
 *  spawning platform tools (launchctl/systemctl), so tests are
 *  platform-independent and never touch the developer's real service. */
function noServiceDeps(dir: string): BridgeServiceDeps {
  return {
    execFile: async () => ({ stdout: "", stderr: "" }),
    launchdPlistPath: path.join(dir, "ai.aifight.service.plist"),
    systemdUserUnitPath: path.join(dir, "aifight.service"),
    systemdSystemUnitPath: path.join(dir, "aifight.service"),
  };
}

function testBridgeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    version: 1,
    baseUrl: "https://aifight.ai",
    wsUrl: "wss://aifight.ai/api/ws",
    agentId: "00000000-0000-4000-8000-000000000001",
    agentName: "existing-agent",
    apiKey: "sk-existing-secret",
    runtimeType: "direct",
    runtimeLocalUrl: "direct://local",
    runtimeModel: "direct",
    directAgentSlug: "default",
    updatedAt: new Date("2026-05-18T00:00:00Z").toISOString(),
    ...overrides,
  };
}

/** The "you are current" answer for the update check that `start`/`status` run. */
function versionOkResponse(): Response {
  return new Response(JSON.stringify({
    minimum_supported_version: "0.1.0-alpha.1",
    recommended_version: "0.1.0-alpha.5",
    latest_version: "0.1.0-alpha.5",
    update_command: "npm install -g @aifight/aifight",
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function platformStatusResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    agent_id: "00000000-0000-4000-8000-000000000001",
    is_claimed: true,
    identity_status: "official",
    status: "ready",
    terms_pending: false,
    ...overrides,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** Write the runtime-home lock + pid files the way a live in-process bridge
 *  (the desktop app) leaves them: stamped lock, plain pid file, NO token/port.
 *  The stamp carries THIS boot's time — a stamp from another boot is a crash
 *  leftover and must NOT be reported as a live seat (see the cross-boot test). */
function seedDesktopSeat(dir: string, pid: number, bootMs?: number): void {
  const boot = bootMs ?? Date.now() - Math.round(os.uptime() * 1000);
  fs.writeFileSync(path.join(dir, "lock"), JSON.stringify({ pid, boot }), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "pid"), String(pid), { mode: 0o644 });
}

// ── P1-7: unconfigured machine → exit 1 + hint, never exit 99 ────────────

describe("P1-7: bridge commands on an unconfigured machine fail with exit 1 + hint", () => {
  const cases: Array<{ name: string; argv: readonly string[] }> = [
    { name: "rename", argv: ["rename", "New Name"] },
    { name: "challenge", argv: ["challenge", "coup"] },
    { name: "accept", argv: ["accept", "dl_00000000000000000000000000000001"] },
    { name: "set daily", argv: ["set", "daily", "2"] },
    { name: "set game", argv: ["set", "game", "coup"] },
    { name: "run", argv: ["run"] },
  ];
  for (const c of cases) {
    it(`aifight ${c.name}`, async () => {
      const dir = useTempHome();
      const r = await runCapture(c.argv, undefined, noServiceDeps(dir));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("not configured");
      expect(r.stderr).toContain("aifight setup");
      expect(r.stderr).not.toContain("unexpected error");
    });
  }
});

// ── P1-3: rename joins the settings-write restart flow ───────────────────

describe("P1-3: rename offers the pending bridge restart", () => {
  function renameFetch(): typeof fetch {
    return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const textUrl = String(url);
      if (textUrl.endsWith("/api/agents/me/name") && init?.method === "PATCH") {
        return new Response(JSON.stringify({ name: "Dark Knight", public_no: 42 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${textUrl}`);
    }) as unknown as typeof fetch;
  }

  it("writes the new name and tells the user the running bridge picks it up on restart", async () => {
    const dir = useTempHome();
    writeBridgeConfig(testBridgeConfig());
    // A port file OLDER than bridge.json = a bridge started before this edit.
    fs.writeFileSync(path.join(dir, "port"), "45995", { mode: 0o644 });
    const old = new Date("2020-01-01T00:00:00Z");
    fs.utimesSync(path.join(dir, "port"), old, old);

    const r = await runCapture(["rename", "Dark Knight"], renameFetch(), noServiceDeps(dir));

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Display name set to: Dark Knight");
    expect(readBridgeConfig().agentName).toBe("Dark Knight");
    // The restart offer every other settings write makes — rename used to be
    // the one command that wrote bridge.json and never offered it.
    expect(r.stdout).toMatch(/next time it starts|service restart/);
  });

  it("--json output carries restartPending", async () => {
    const dir = useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const r = await runCapture(["rename", "Dark Knight", "--json"], renameFetch(), noServiceDeps(dir));
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout.trim()) as Record<string, unknown>;
    expect(parsed.status).toBe("ok");
    expect(parsed.name).toBe("Dark Knight");
    expect(parsed).toHaveProperty("restartPending");
  });
});

// ── P1-6: a live seat holder without the control API is the desktop app ──

describe("P1-6: desktop app's in-process bridge is reported, not 'not running'", () => {
  it("aifight start names the running bridge (PID) and points at the app", async () => {
    const dir = useTempHome();
    writeBridgeConfig(testBridgeConfig());
    seedDesktopSeat(dir, process.pid);
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/api/bridge/version")) return versionOkResponse();
      throw new Error(`unexpected fetch ${String(url)}`);
    }) as unknown as typeof fetch;

    const r = await runCapture(["start"], fetchImpl, noServiceDeps(dir));

    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`PID ${process.pid}`);
    expect(r.stderr).toContain("desktop app");
    // The old advice — install the service — would have built a second bridge
    // queuing on the app's lock; it must not be suggested here.
    expect(r.stderr).not.toContain("service install");
  });

  it("aifight status --live says the same, in text and JSON", async () => {
    const dir = useTempHome();
    seedDesktopSeat(dir, process.pid);

    const text = await runCapture(["status", "--live"], undefined, noServiceDeps(dir));
    expect(text.code).toBe(1);
    expect(text.stdout).toContain(`PID ${process.pid}`);
    expect(text.stdout).toContain("desktop app");

    const json = await runCapture(["status", "--live", "--json"], undefined, noServiceDeps(dir));
    expect(json.code).toBe(1);
    const parsed = JSON.parse(json.stdout.trim()) as Record<string, unknown>;
    expect(parsed.status).toBe("bridge_running_without_control_api");
    expect(parsed.pid).toBe(process.pid);
  });

  it("a dead seat holder falls back to the ordinary 'not running' answer", async () => {
    const dir = useTempHome();
    // A pid that cannot be alive on this machine.
    seedDesktopSeat(dir, 2_000_000_000 - 1);

    const r = await runCapture(["status", "--live"], undefined, noServiceDeps(dir));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Bridge not running on this machine");
    expect(r.stdout).not.toContain("desktop app");
  });

  it("a stamp from a previous boot is a crash leftover, not a live desktop seat", async () => {
    const dir = useTempHome();
    // Live pid (ours), but the lock stamp says it was taken in a DIFFERENT
    // boot: the original holder died with the machine and the pid has been
    // recycled. Reporting "desktop app is running (PID N)" here strands the
    // user chasing a process that is not a bridge; the authoritative lock
    // probe (acquireDaemonLock) owns the recovery message instead.
    seedDesktopSeat(dir, process.pid, 1_000_000);

    const r = await runCapture(["status", "--live"], undefined, noServiceDeps(dir));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Bridge not running on this machine");
    expect(r.stdout).not.toContain("desktop app");
  });
});

// ── P1-5: unclaimed agent sees the real claim link ───────────────────────

describe("P1-5: the claim link is surfaced where the user is told to find it", () => {
  const CLAIM_URL = "https://aifight.ai/claim/test-claim-token-123";

  function statusFetch(claimed: boolean): typeof fetch {
    return vi.fn(async (url: string | URL | Request) => {
      const textUrl = String(url);
      if (textUrl.endsWith("/api/bridge/version")) return versionOkResponse();
      if (textUrl.endsWith("/api/agents/me/status")) {
        return platformStatusResponse(
          claimed
            ? {}
            : { is_claimed: false, identity_status: "bootstrap", status: "pending_claim" },
        );
      }
      throw new Error(`unexpected fetch ${textUrl}`);
    }) as unknown as typeof fetch;
  }

  it("status prints the locally saved claim link while the agent is unclaimed", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig({
      claimUrl: CLAIM_URL,
      claimToken: "test-claim-token-123",
    }));

    const r = await runCapture(["status"], statusFetch(false));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("not claimed yet");
    expect(r.stdout).toContain(CLAIM_URL);
  });

  it("status --json carries claimUrl while unclaimed, null once claimed", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig({
      claimUrl: CLAIM_URL,
      claimToken: "test-claim-token-123",
    }));

    const unclaimed = await runCapture(["status", "--json"], statusFetch(false));
    expect(JSON.parse(unclaimed.stdout.trim()).claimUrl).toBe(CLAIM_URL);

    // The platform now says claimed: the single-use credentials are scrubbed
    // from disk and the link leaves the output.
    const claimed = await runCapture(["status", "--json"], statusFetch(true));
    expect(JSON.parse(claimed.stdout.trim()).claimUrl).toBeNull();
    expect(readBridgeConfig().claimUrl).toBeUndefined();
  });

  it("record points an unclaimed agent at its claim link, not the bare dashboard", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig({
      claimUrl: CLAIM_URL,
      claimToken: "test-claim-token-123",
    }));
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/api/agents/") && String(url).endsWith("/profile")) {
        return new Response(JSON.stringify({
          agent: { name: "existing-agent", is_claimed: false },
          summary: { total_games: 0 },
          ratings: [],
          recent_matches: [],
          achievements: [],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    }) as unknown as typeof fetch;

    const r = await runCapture(["record"], fetchImpl);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(CLAIM_URL);
    expect(r.stdout).not.toContain("verify your email");
  });

  it("record falls back to `aifight status` when no claim link is on file", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/api/agents/") && String(url).endsWith("/profile")) {
        return new Response(JSON.stringify({
          agent: { name: "existing-agent", is_claimed: false },
          summary: { total_games: 0 },
          ratings: [],
          recent_matches: [],
          achievements: [],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    }) as unknown as typeof fetch;

    const r = await runCapture(["record"], fetchImpl);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("aifight status");
    expect(r.stdout).toContain("/dashboard");
  });
});

// ── P2-12: accept-terms separates dead credentials from network failure ──

describe("P2-12: accept-terms 401/403 vs network failure", () => {
  it("401 → re-link guidance, not 'check your connection'", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const fetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;

    const r = await runCapture(["accept-terms", "--yes"], fetchImpl);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("rejected");
    expect(r.stderr).toContain("aifight connect");
    expect(r.stderr).not.toContain("Check your connection");
  });

  it("403 → the same credentials treatment", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch;

    const r = await runCapture(["accept-terms", "--yes"], fetchImpl);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("rejected");
    expect(r.stderr).not.toContain("Check your connection");
  });

  it("500 → still the network-failure message", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;

    const r = await runCapture(["accept-terms", "--yes"], fetchImpl);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Could not reach AIFight");
    expect(r.stderr).toContain("Check your connection");
  });
});

// ── P2-8: did-you-mean knows `config reasoning` ──────────────────────────

describe("P2-8: config did-you-mean covers reasoning", () => {
  it("`config reasonng` suggests `config reasoning`", async () => {
    useTempHome();
    const r = await runCapture(["config", "reasonng"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Did you mean 'config reasoning'?");
  });
});

// ── P2-10: --key-stdin refuses a terminal stdin ──────────────────────────

describe("P2-10: config add --key-stdin with a TTY stdin refuses instead of hanging", () => {
  it("rejects with pipe guidance", async () => {
    useTempHome();
    const env: HandlerEnv = { stdout: () => {}, stderr: () => {} };
    const prevTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      await expect(
        resolveKeyRef({
          slug: "default",
          profileId: "claude",
          args: { positional: [], flags: { "key-stdin": true }, jsonMode: false },
          env,
        }),
      ).rejects.toThrow(/pipe/i);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: prevTTY, configurable: true });
    }
  });
});
