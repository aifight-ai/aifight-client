import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { run } from "../src/cli/main";
import { readBridgeConfig, writeBridgeConfig, type BridgeConfig } from "../src/bridge/config";
import { RUNTIME_VERSION } from "../src/index";

let prevHome: string | undefined;
let tmpDir: string | null = null;

function useTempHome(): void {
  prevHome = process.env.AIFIGHT_RUNTIME_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-cli-bridge-"));
  process.env.AIFIGHT_RUNTIME_HOME = tmpDir;
}

afterEach(() => {
  if (prevHome === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
  else process.env.AIFIGHT_RUNTIME_HOME = prevHome;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  prevHome = undefined;
  tmpDir = null;
});

async function runCapture(argv: readonly string[], fetchImpl?: typeof fetch) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(argv, {
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
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
    autoDailyLimit: 2,
    updatedAt: new Date("2026-05-18T00:00:00Z").toISOString(),
    ...overrides,
  };
}

describe("bridge CLI commands", () => {
  it("connect saves config and status redacts the API key", async () => {
    useTempHome();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const textUrl = String(url);
      if (textUrl.endsWith("/api/bridge/version")) {
        return new Response(JSON.stringify({
          minimum_supported_version: "0.1.0-alpha.2",
          recommended_version: "0.1.0-alpha.5",
          latest_version: "0.1.0-alpha.5",
          update_command: "npm install -g @aifight/aifight",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        agent: {
          id: "agent-1",
          name: "alpha",
          api_key: "sk-super-secret-agent-key",
          runtime_type: "hermes",
        },
        ws_url: "wss://aifight.ai/api/ws",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const connected = await runCapture(["connect", "aifp_test"], fetchImpl);
    const cfg = readBridgeConfig();
    const status = await runCapture(["status"], fetchImpl);

    expect(connected.code).toBe(0);
    // A legacy agent may report a non-direct runtime_type; connect coerces to direct.
    expect(cfg.runtimeType).toBe("direct");
    expect(cfg.runtimeLocalUrl).toBe("direct://local");
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("Bridge: configured");
    expect(status.stdout).toContain(`Bridge ${RUNTIME_VERSION} is current enough`);
    expect(status.stdout).not.toContain("sk-super-secret-agent-key");
  });

  it("connect blocks before consuming a pairing code when local identity exists", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const fetchImpl = vi.fn(async () => {
      throw new Error("pairing endpoint should not be called");
    }) as unknown as typeof fetch;

    const connected = await runCapture(["connect", "aifp_test"], fetchImpl);
    const cfg = readBridgeConfig();

    expect(connected.code).toBe(1);
    expect(connected.stderr).toContain("already has local AIFight bridge credentials");
    expect(connected.stderr).toContain("--replace-local-identity");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(cfg.agentId).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("connect can replace local identity after explicit approval flag", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      agent: {
        id: "00000000-0000-4000-8000-000000000002",
        name: "replacement-agent",
        api_key: "sk-new-secret",
        runtime_type: "hermes",
      },
      ws_url: "wss://aifight.ai/api/ws",
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;

    const connected = await runCapture(["connect", "aifp_test", "--replace-local-identity"], fetchImpl);
    const cfg = readBridgeConfig();

    expect(connected.code).toBe(0);
    expect(connected.stdout).toContain("Replaced local bridge identity");
    expect(cfg.agentId).toBe("00000000-0000-4000-8000-000000000002");
    expect(cfg.agentName).toBe("replacement-agent");
    expect(cfg.runtimeType).toBe("direct");
  });

  it("setup refuses to overwrite an existing local identity non-interactively", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const fetchImpl = vi.fn(async () => {
      throw new Error("registration endpoint should not be called");
    }) as unknown as typeof fetch;

    const result = await runCapture(["setup", "--approved-local-setup"], fetchImpl);
    const cfg = readBridgeConfig();

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("already has local AIFight bridge credentials");
    expect(result.stderr).toContain("will not replace an existing local identity");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(cfg.agentId).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("start blocks when the platform minimum bridge version is higher", async () => {
    useTempHome();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const textUrl = String(url);
      if (textUrl.endsWith("/api/bridge/version")) {
        return new Response(JSON.stringify({
          minimum_supported_version: "99.0.0",
          recommended_version: "99.0.0",
          latest_version: "99.0.0",
          update_command: "npm install -g @aifight/aifight",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        agent: {
          id: "agent-1",
          name: "alpha",
          api_key: "sk-super-secret-agent-key",
          runtime_type: "openclaw",
        },
        ws_url: "wss://aifight.ai/api/ws",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    expect((await runCapture(["connect", "aifp_test"], fetchImpl)).code).toBe(0);

    const started = await runCapture(["start"], fetchImpl);

    expect(started.code).toBe(1);
    expect(started.stderr).toContain("below the minimum supported version");
    expect(started.stderr).toContain("npm install -g @aifight/aifight");
  });

  it("status explains npm update plus service restart without re-pairing", async () => {
    useTempHome();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const textUrl = String(url);
      if (textUrl.endsWith("/api/bridge/version")) {
        return new Response(JSON.stringify({
          minimum_supported_version: "0.1.0-alpha.1",
          recommended_version: "0.1.0-beta.12",
          latest_version: "0.1.0-beta.12",
          update_command: "npm install -g @aifight/aifight",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        agent: {
          id: "agent-1",
          name: "alpha",
          api_key: "sk-super-secret-agent-key",
          runtime_type: "openclaw",
        },
        ws_url: "wss://aifight.ai/api/ws",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    expect((await runCapture(["connect", "aifp_test"], fetchImpl)).code).toBe(0);

    const status = await runCapture(["status"], fetchImpl);

    expect(status.code).toBe(0);
    expect(status.stdout).toContain("Update command: aifight update --yes");
    expect(status.stdout).toContain("Manual npm command: npm install -g @aifight/aifight");
    expect(status.stdout).toContain("restarts `aifight.service`");
    expect(status.stdout).not.toMatch(/re-register|re-pair|aifight (setup|serve)/);
  });

  it("doctor reports the direct-LLM runtime and points to config test", async () => {
    useTempHome();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const textUrl = String(url);
      if (textUrl.endsWith("/api/bridge/version")) {
        return new Response(JSON.stringify({
          minimum_supported_version: "0.1.0-alpha.2",
          recommended_version: "0.1.0-alpha.5",
          latest_version: "0.1.0-alpha.5",
          update_command: "npm install -g @aifight/aifight",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (textUrl.endsWith("/api/bridge/pair")) {
        return new Response(JSON.stringify({
          agent: {
            id: "agent-1",
            name: "alpha",
            api_key: "sk-super-secret-agent-key",
            runtime_type: "direct",
          },
          ws_url: "wss://aifight.ai/api/ws",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    expect((await runCapture(["connect", "aifp_test"], fetchImpl)).code).toBe(0);

    const doctor = await runCapture(["doctor"], fetchImpl);

    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain("direct-LLM configured");
    expect(doctor.stdout).toContain("aifight config test");
    expect(doctor.stdout).not.toContain("sk-super-secret-agent-key");
  });
});
