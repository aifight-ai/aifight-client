import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { run } from "../src/cli/main";
import { writeBridgeConfig, type BridgeConfig } from "../src/bridge/config";

let prevHome: string | undefined;
let tmpDir: string | null = null;

function useTempHome(): void {
  prevHome = process.env.AIFIGHT_RUNTIME_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-cli-accept-"));
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
    agentName: "local-fallback-name",
    apiKey: "sk-existing-secret",
    runtimeType: "direct",
    runtimeLocalUrl: "direct://local",
    runtimeModel: "direct",
    directAgentSlug: "default",
    updatedAt: new Date("2026-05-18T00:00:00Z").toISOString(),
    ...overrides,
  };
}

async function runCapture(argv: readonly string[], fetchImpl: typeof fetch) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(argv, {
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
    fetchImpl,
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

interface Call {
  url: string;
  method: string;
  body?: string;
  apiKey?: string;
}

interface StubOpts {
  termsPending?: boolean;
  isClaimed?: boolean;
  acceptOk?: boolean;
  omitVersions?: boolean;
}

function stubFetch(opts: StubOpts = {}): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method,
      body: typeof init?.body === "string" ? init.body : undefined,
      apiKey: headers["X-API-Key"],
    });
    if (url.endsWith("/api/agents/me/status")) {
      const status: Record<string, unknown> = {
        agent_id: "00000000-0000-4000-8000-000000000001",
        is_claimed: opts.isClaimed ?? true,
        identity_status: "official",
        status: "ready",
        terms_pending: opts.termsPending ?? true,
      };
      if (!opts.omitVersions) {
        status.current_terms_version = "2026-06-23";
        status.current_privacy_version = "2026-06-23";
      }
      return new Response(JSON.stringify(status), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/agents/me/accept-legal")) {
      const ok = opts.acceptOk ?? true;
      return new Response(JSON.stringify({ legal: { accepted_current: ok } }), {
        status: ok ? 200 : 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("aifight accept-terms", () => {
  it("--yes records acceptance with the current versions and shows the doc links", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const { impl, calls } = stubFetch({ termsPending: true });

    const { code, stdout } = await runCapture(["accept-terms", "--yes"], impl);

    expect(code).toBe(0);
    // The user can read both documents before agreeing — links must be shown.
    expect(stdout).toContain("https://aifight.ai/terms");
    expect(stdout).toContain("https://aifight.ai/privacy");
    expect(stdout.toLowerCase()).toContain("recorded");

    const post = calls.find((c) => c.url.endsWith("/api/agents/me/accept-legal"));
    expect(post).toBeDefined();
    expect(post?.method).toBe("POST");
    expect(post?.apiKey).toBe("sk-existing-secret");
    const body = JSON.parse(post?.body ?? "{}");
    expect(body).toEqual({ terms_version: "2026-06-23", privacy_version: "2026-06-23" });
  });

  it("does nothing (no accept call) when terms are already accepted", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const { impl, calls } = stubFetch({ termsPending: false });

    const { code, stdout } = await runCapture(["accept-terms", "--yes"], impl);

    expect(code).toBe(0);
    expect(stdout.toLowerCase()).toContain("already accepted");
    expect(calls.some((c) => c.url.endsWith("/api/agents/me/accept-legal"))).toBe(false);
  });

  it("refuses to accept for an unclaimed agent and never POSTs", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const { impl, calls } = stubFetch({ isClaimed: false, termsPending: true });

    const { code, stderr } = await runCapture(["accept-terms", "--yes"], impl);

    expect(code).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("claim");
    expect(calls.some((c) => c.url.endsWith("/api/agents/me/accept-legal"))).toBe(false);
  });

  it("requires confirmation in non-interactive mode (no --yes) and never POSTs", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const { impl, calls } = stubFetch({ termsPending: true });

    // vitest runs with a non-TTY stdin, so the unconfirmed path must bail out.
    const { code } = await runCapture(["accept-terms"], impl);

    expect(code).toBe(1);
    expect(calls.some((c) => c.url.endsWith("/api/agents/me/accept-legal"))).toBe(false);
  });
});
