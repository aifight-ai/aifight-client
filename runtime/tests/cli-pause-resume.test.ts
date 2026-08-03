import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { run } from "../src/cli/main";
import { readBridgeConfig, writeBridgeConfig, type BridgeConfig } from "../src/bridge/config";

// The pause/resume commands read + rewrite bridge.json and probe the daemon
// token/port files — every test gets its own empty runtime home so none of
// that touches the developer's real one. (The real default path is named
// nowhere here on purpose: build.sh greps tests/ for it.)
let prevHome: string | undefined;
let tmpDir: string | null = null;

function useTempHome(): void {
  prevHome = process.env.AIFIGHT_RUNTIME_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-cli-pause-"));
  process.env.AIFIGHT_RUNTIME_HOME = tmpDir;
}

afterEach(() => {
  if (prevHome === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
  else process.env.AIFIGHT_RUNTIME_HOME = prevHome;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  prevHome = undefined;
  tmpDir = null;
});

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
    autoDailyLimit: 2,
    updatedAt: new Date("2026-07-30T00:00:00Z").toISOString(),
    ...overrides,
  };
}

interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCapture(
  argv: readonly string[],
  fetchImpl?: typeof fetch,
  extraEnv?: Record<string, unknown>,
): Promise<Captured> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(argv, {
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    ...(extraEnv ?? {}),
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

interface SeenRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** Mock fetch that records every request and answers by URL suffix. */
function recordingFetch(
  answers: Array<{ readonly urlIncludes: string; readonly response: Response }>,
): { readonly fetchImpl: typeof fetch; readonly seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const textUrl = String(url);
    seen.push({
      url: textUrl,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const match = answers.find((a) => textUrl.includes(a.urlIncludes));
    if (match === undefined) {
      return new Response("not found", { status: 404 });
    }
    return match.response;
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

/** The token/port files of a running CLI bridge, so the control client finds
 *  it (at a port the mock fetch intercepts — no real server is ever started). */
function seedRunningBridge(home: string, port = 45991, token = "test-control-token"): void {
  fs.writeFileSync(path.join(home, "token"), token, { mode: 0o600 });
  fs.writeFileSync(path.join(home, "port"), String(port), { mode: 0o644 });
}

describe("aifight pause", () => {
  it("writes the flag and calls the platform leave endpoint when no bridge is running", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const { fetchImpl, seen } = recordingFetch([
      {
        urlIncludes: "/api/queue/leave",
        response: new Response(JSON.stringify({ status: "left queue" }), { status: 200 }),
      },
    ]);

    const r = await runCapture(["pause"], fetchImpl);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Automatic matching paused");
    expect(r.stdout).toContain("aifight resume");
    // No token/port files → control API unreachable → platform endpoint,
    // with the agent key, as a POST.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://aifight.ai/api/queue/leave");
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.headers["X-API-Key"]).toBe("sk-existing-secret");
    expect(readBridgeConfig().matchingPaused).toBe(true);
  });

  it("prefers the control-plane leave when a bridge is running (no platform call)", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    seedRunningBridge(tmpDir!);
    const { fetchImpl, seen } = recordingFetch([
      { urlIncludes: "/v1/agents/existing-agent/leave", response: new Response(null, { status: 204 }) },
    ]);

    const r = await runCapture(["pause"], fetchImpl);

    expect(r.code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("http://127.0.0.1:45991/v1/agents/existing-agent/leave");
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.headers.Authorization).toBe("Bearer test-control-token");
    expect(readBridgeConfig().matchingPaused).toBe(true);
  });

  it("is idempotent: a second pause says so and makes no network calls", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig({ matchingPaused: true }));
    const { fetchImpl, seen } = recordingFetch([]);

    const r = await runCapture(["pause"], fetchImpl);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("already paused");
    expect(seen).toHaveLength(0);
    expect(readBridgeConfig().matchingPaused).toBe(true);
  });

  it("does not save the flag when the platform leave fails", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const { fetchImpl } = recordingFetch([
      { urlIncludes: "/api/queue/leave", response: new Response("down", { status: 502 }) },
    ]);

    const r = await runCapture(["pause"], fetchImpl);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("HTTP 502");
    expect(readBridgeConfig().matchingPaused).toBeUndefined();
  });

  it("refuses cleanly when the bridge was never configured", async () => {
    useTempHome();
    const { fetchImpl, seen } = recordingFetch([]);

    const r = await runCapture(["pause"], fetchImpl);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not configured");
    expect(r.stderr).toContain("aifight setup");
    expect(seen).toHaveLength(0);
  });
});

/** The control API's answer to POST /v1/agents/:name/resume-matching. */
function resumeAnswer(resume: unknown): Response {
  return new Response(JSON.stringify({ resume }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** A control-plane error envelope (the shape the client parses; an unparseable
 *  body would be reported as contract drift instead). */
function controlError(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { code, message: "nope" } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// U8d (owner ruling 2026-08-03): resume no longer picks a game. It asks the
// running bridge to restore its POSTURE — standing by by default, self-joining
// only behind the explicit `standbyFallbackJoinMinutes` escape hatch.
describe("aifight resume", () => {
  it("asks the running bridge to resume, and reports standing by (no game picked)", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig({ matchingPaused: true }));
    seedRunningBridge(tmpDir!);
    const { fetchImpl, seen } = recordingFetch([
      {
        urlIncludes: "/v1/agents/existing-agent/resume-matching",
        response: resumeAnswer({ mode: "standby", games: ["texas_holdem", "liars_dice", "coup"] }),
      },
    ]);

    const r = await runCapture(["resume"], fetchImpl);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("standing by; the platform picks the game");
    // The old behavior — POST /join with a locally chosen game — is gone.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("http://127.0.0.1:45991/v1/agents/existing-agent/resume-matching");
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.headers.Authorization).toBe("Bearer test-control-token");
    expect(seen[0]!.body).toBeUndefined(); // body-free, like /leave
    const cfg = readBridgeConfig();
    expect(cfg.matchingPaused).toBeUndefined();
    expect(cfg.autoDailyLimit).toBe(2); // the cap survives a pause/resume round trip
  });

  // The escape hatch stays whole: a user who set standbyFallbackJoinMinutes
  // keeps the pre-U8a self-join, and the receipt names the game it joined.
  it("reports the re-joined game when the bridge is in the legacy posture", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig({ matchingPaused: true, standbyFallbackJoinMinutes: 5 }));
    seedRunningBridge(tmpDir!);
    const { fetchImpl, seen } = recordingFetch([
      {
        urlIncludes: "/v1/agents/existing-agent/resume-matching",
        response: resumeAnswer({ mode: "joined", game: "liars_dice" }),
      },
    ]);

    const r = await runCapture(["resume"], fetchImpl);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("re-joined the Liar's Dice queue");
    expect(seen).toHaveLength(1);
  });

  // An older bridge is still running with the previous build: the route does
  // not exist there. Nothing to do but be honest — the cleared flag gets there
  // on its own at the next connect edge.
  it("degrades honestly when the running bridge does not know the endpoint", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig({ matchingPaused: true }));
    seedRunningBridge(tmpDir!);
    const { fetchImpl, seen } = recordingFetch([
      {
        urlIncludes: "/v1/agents/existing-agent/resume-matching",
        response: controlError(404, "not_found"),
      },
    ]);

    const r = await runCapture(["resume"], fetchImpl);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Automatic matching resumed.");
    expect(r.stdout).toContain("goes back on standby the next time it connects");
    expect(seen).toHaveLength(1);
    expect(readBridgeConfig().matchingPaused).toBeUndefined();
  });

  // A newer host that registered the route but wired a router without the
  // capability answers 501 — same user-visible outcome as the 404 above.
  it("treats a 501 from the bridge the same way as a missing route", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig({ matchingPaused: true }));
    seedRunningBridge(tmpDir!);
    const { fetchImpl } = recordingFetch([
      {
        urlIncludes: "/v1/agents/existing-agent/resume-matching",
        response: controlError(501, "not_implemented"),
      },
    ]);

    const r = await runCapture(["resume"], fetchImpl);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("goes back on standby the next time it connects");
  });

  it("clears the flag without reaching a bridge when none is running", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig({ matchingPaused: true }));
    const { fetchImpl, seen } = recordingFetch([]);

    const r = await runCapture(["resume"], fetchImpl);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("the next time one starts");
    expect(r.stdout).toContain("goes back on standby the next time it connects");
    expect(seen).toHaveLength(0);
    expect(readBridgeConfig().matchingPaused).toBeUndefined();
  });

  it("--json says what actually happened, per outcome", async () => {
    useTempHome();

    writeBridgeConfig(testBridgeConfig({ matchingPaused: true }));
    seedRunningBridge(tmpDir!);
    const standby = recordingFetch([
      {
        urlIncludes: "/resume-matching",
        response: resumeAnswer({ mode: "standby", games: ["coup"] }),
      },
    ]);
    const a = await runCapture(["resume", "--json"], standby.fetchImpl);
    expect(JSON.parse(a.stdout.trim())).toEqual({
      status: "resumed",
      matchingPaused: false,
      matching: "standby",
      games: ["coup"],
    });

    writeBridgeConfig(testBridgeConfig({ matchingPaused: true }));
    const joined = recordingFetch([
      { urlIncludes: "/resume-matching", response: resumeAnswer({ mode: "joined", game: "coup" }) },
    ]);
    const b = await runCapture(["resume", "--json"], joined.fetchImpl);
    expect(JSON.parse(b.stdout.trim())).toEqual({
      status: "resumed",
      matchingPaused: false,
      matching: "joined",
      game: "coup",
    });

    writeBridgeConfig(testBridgeConfig({ matchingPaused: true }));
    const old = recordingFetch([
      { urlIncludes: "/resume-matching", response: controlError(404, "not_found") },
    ]);
    const c = await runCapture(["resume", "--json"], old.fetchImpl);
    expect(JSON.parse(c.stdout.trim())).toEqual({
      status: "resumed",
      matchingPaused: false,
      matching: "pending",
      bridge: "unsupported",
    });

    writeBridgeConfig(testBridgeConfig({ matchingPaused: true, autoDailyLimit: 0 }));
    const d = await runCapture(["resume", "--json"], recordingFetch([]).fetchImpl);
    expect(JSON.parse(d.stdout.trim())).toEqual({
      status: "resumed",
      matchingPaused: false,
      matching: "cap_off",
    });

    // No control files left → no bridge to ask.
    fs.rmSync(path.join(tmpDir!, "token"));
    fs.rmSync(path.join(tmpDir!, "port"));
    writeBridgeConfig(testBridgeConfig({ matchingPaused: true }));
    const e = await runCapture(["resume", "--json"], recordingFetch([]).fetchImpl);
    expect(JSON.parse(e.stdout.trim())).toEqual({
      status: "resumed",
      matchingPaused: false,
      matching: "pending",
      bridge: "not_running",
    });
  });

  it("does not queue by itself when the daily cap is 0", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig({ matchingPaused: true, autoDailyLimit: 0 }));
    seedRunningBridge(tmpDir!);
    const { fetchImpl, seen } = recordingFetch([]);

    const r = await runCapture(["resume"], fetchImpl);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("daily cap is 0");
    expect(seen).toHaveLength(0);
    expect(readBridgeConfig().matchingPaused).toBeUndefined();
  });

  it("is idempotent when matching was never paused", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const { fetchImpl, seen } = recordingFetch([]);

    const r = await runCapture(["resume"], fetchImpl);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("not paused");
    expect(seen).toHaveLength(0);
  });
});

// V2 (2026-07-31): human feedback leads with the status icons — a green ✓ on
// success, a yellow ⚠ on warnings; "OK"/"!" when colors are off. --json stays
// byte-stable: no icons, ever.
describe("status icons (V2)", () => {
  const ICONS = { statusIcons: { ok: "✓", warn: "⚠" } };

  it("pause: ✓ on the pause, ⚠ on the no-bridge note — but never in --json", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const { fetchImpl } = recordingFetch([
      { urlIncludes: "/api/queue/leave", response: new Response("{}", { status: 200 }) },
    ]);

    const human = await runCapture(["pause"], fetchImpl, ICONS);
    expect(human.stdout).toContain("✓ Automatic matching paused");
    expect(human.stdout).toContain("⚠ No bridge is running");

    writeBridgeConfig(testBridgeConfig()); // unpause for the json round
    const json = await runCapture(["pause", "--json"], fetchImpl);
    expect(json.stdout).not.toContain("✓");
    expect(json.stdout).not.toContain("⚠");
    expect(JSON.parse(json.stdout.trim())).toMatchObject({ status: "paused", matchingPaused: true });
  });

  it("resume: ✓ on the re-join, ⚠ on the cap-0 advisory", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig({ matchingPaused: true, autoDailyLimit: 0 }));

    const capOff = await runCapture(["resume"], undefined, ICONS);
    expect(capOff.stdout).toContain("✓ Automatic matching resumed.");
    expect(capOff.stdout).toContain("⚠ The daily cap is 0");

    const json = await runCapture(["resume", "--json"]);
    expect(json.stdout).not.toContain("✓");
    expect(JSON.parse(json.stdout.trim())).toMatchObject({ status: "not_paused", matchingPaused: false });
  });

  it("ASCII fallback without a TTY: OK / ! instead of the glyphs", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const { fetchImpl } = recordingFetch([
      { urlIncludes: "/api/queue/leave", response: new Response("{}", { status: 200 }) },
    ]);
    // No statusIcons injected and vitest's stdout is no TTY → the gate picks
    // the plain pair.
    const r = await runCapture(["pause"], fetchImpl);
    expect(r.stdout).toContain("OK Automatic matching paused");
    expect(r.stdout).toContain("! No bridge is running");
    expect(r.stdout).not.toContain("✓");
    expect(r.stdout).not.toContain("⚠");
  });
});

describe("aifight status with a pause flag", () => {
  const statusFetch = (): typeof fetch =>
    vi.fn(async (url: string | URL | Request) => {
      const textUrl = String(url);
      if (textUrl.endsWith("/api/bridge/version")) {
        return new Response(JSON.stringify({
          minimum_supported_version: "0.1.0-alpha.1",
          recommended_version: "0.1.0-beta.36",
          latest_version: "0.1.0-beta.36",
          update_command: "npm install -g @aifight/aifight",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (textUrl.endsWith("/api/agents/me/status")) {
        return new Response(JSON.stringify({
          agent_id: "00000000-0000-4000-8000-000000000001",
          name: "existing-agent",
          status: "ready",
          is_claimed: true,
          identity_status: "official",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

  it("prints 'Matching: paused' only while paused", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const unpaused = await runCapture(["status"], statusFetch());
    expect(unpaused.code).toBe(0);
    expect(unpaused.stdout).not.toContain("Matching: paused");

    writeBridgeConfig({ ...testBridgeConfig(), matchingPaused: true });
    const paused = await runCapture(["status"], statusFetch());
    expect(paused.code).toBe(0);
    expect(paused.stdout).toContain("Matching: paused");
    expect(paused.stdout).toContain("aifight resume");
  });

  it("exposes matchingPaused in --json", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig({ matchingPaused: true }));
    const r = await runCapture(["status", "--json"], statusFetch());
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout.trim()) as { matchingPaused?: unknown };
    expect(parsed.matchingPaused).toBe(true);
  });
});
