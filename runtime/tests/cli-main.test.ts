import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readBridgeConfig, writeBridgeConfig, type BridgeConfig } from "../src/bridge/config";
import type { ServiceExecFile } from "../src/bridge/service";
import { offerBridgeServiceInstall } from "../src/cli/commands/bridge-service";
import { run } from "../src/cli/main";
import { writePort, writeToken } from "../src/daemon/runtime-files-write";
import { RUNTIME_VERSION } from "../src/index";
import { LocalMatchSessionStore } from "../src/session/local-match-session-store";

const cleanupQueue: Array<() => void> = [];

afterEach(() => {
  while (cleanupQueue.length > 0) {
    cleanupQueue.pop()!();
  }
});

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCapture(
  argv: readonly string[],
  extraOpts: Partial<Parameters<typeof run>[1]> = {},
): Promise<RunResult> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const code = await run(argv, {
    stdout: (s) => stdoutChunks.push(s),
    stderr: (s) => stderrChunks.push(s),
    ...extraOpts,
  });
  return { code, stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
}

function withRuntimeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-cli-main-"));
  const prev = process.env.AIFIGHT_RUNTIME_HOME;
  process.env.AIFIGHT_RUNTIME_HOME = home;
  cleanupQueue.push(() => {
    if (prev === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
    else process.env.AIFIGHT_RUNTIME_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
}

function configuredBridge(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  withRuntimeHome();
  const config: BridgeConfig = {
    version: 1,
    baseUrl: "https://beta.aifight.ai",
    wsUrl: "wss://beta.aifight.ai/api/ws",
    agentId: "agent-1",
    agentName: "alpha",
    apiKey: "sk_test_secret",
    runtimeType: "mock",
    runtimeLocalUrl: "mock://local",
    runtimeModel: "mock",
    updatedAt: "2026-05-06T00:00:00.000Z",
    ...overrides,
  };
  writeBridgeConfig(config);
  return config;
}

function tempExecutable(name = "aifight-bin"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-cli-bin-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  cleanupQueue.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return file;
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function versionPolicyResp(): Response {
  return jsonResp({
    minimum_supported_version: "0.1.0-alpha.2",
    recommended_version: "0.1.0-alpha.5",
    latest_version: "0.1.0-alpha.5",
    update_command: "npm install -g @aifight/aifight",
  });
}

function seedLocalSession(home: string): void {
  const config = {
    version: 1,
    baseUrl: "https://aifight.ai",
    wsUrl: "wss://aifight.ai/api/ws",
    agentId: "agent-1",
    agentName: "alpha",
    apiKey: "sk",
    runtimeType: "mock",
    runtimeLocalUrl: "mock://local",
    runtimeModel: "mock",
    updatedAt: "2026-05-18T00:00:00.000Z",
  } as const;
  const store = new LocalMatchSessionStore({
    runtimeHome: home,
    now: () => new Date("2026-05-18T00:00:00.000Z"),
  });
  store.recordServerMessage(config, {
    type: "game_start",
    data: {
      match_id: "session-cli-1",
      game: "coup",
      mode: "ranked",
      your_position: 0,
      your_player_id: "p0",
      players: [],
      rules: {},
      config: {},
    },
  } as never);
}

describe("bridge-first CLI command surface", () => {
  it("prints only the current public command surface", async () => {
    const r = await runCapture(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("aifight setup");
    expect(r.stdout).toContain("aifight connect <PAIRING_CODE>");
    expect(r.stdout).toContain("aifight update");
    expect(r.stdout).toContain("aifight service <command>");
    expect(r.stdout).toContain("aifight sessions <command>");
    expect(r.stdout).toContain("aifight strategy <command>");
    expect(r.stdout).toContain("aifight uninstall");
    expect(r.stdout).toContain("aifight set daily <N>");
    expect(r.stdout).toContain("aifight challenge <game>");
    expect(r.stdout).toContain("aifight accept <url_or_token>");
    expect(r.stdout).toContain("--approved-local-setup");
    expect(r.stdout).not.toMatch(/aifight (serve|agent|join|leave|daily|mcp|shutdown)/);
  });

  it("keeps version independent from local bridge config", async () => {
    withRuntimeHome();
    const r = await runCapture(["version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${RUNTIME_VERSION}\n`);
  });

  it("reports unconfigured status without a catch-all unexpected error", async () => {
    withRuntimeHome();
    const r = await runCapture(["status"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Bridge: not configured");
    expect(r.stdout).toContain("aifight setup");
    expect(r.stdout).toContain("aifight connect <PAIRING_CODE>");
    expect(r.stderr).toBe("");
  });

  it("status uses server claim state instead of the saved local claim token", async () => {
    configuredBridge({
      claimUrl: "https://beta.aifight.ai/claim/ct_SECRET_CLAIM_TOKEN",
      claimToken: "ct_SECRET_CLAIM_TOKEN",
    });
    const calls: Array<{ url: string; apiKey?: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        apiKey: (init?.headers as Record<string, string> | undefined)?.["X-API-Key"],
      });
      if (url.endsWith("/api/bridge/version")) return versionPolicyResp();
      if (url.endsWith("/api/agents/me/status")) {
        // Claim is the only gate now; an older server may still send the retired
        // "needs_official_name" — the client must render it as simply ready.
        return jsonResp({
          agent_id: "agent-1",
          is_claimed: true,
          identity_status: "bootstrap",
          status: "needs_official_name",
        });
      }
      return jsonResp({ error: "unexpected" }, 500);
    };

    const r = await runCapture(["status"], { fetchImpl });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Profile: claimed, ready");
    expect(r.stdout).not.toContain("Profile: unclaimed");
    expect(calls.some((c) => c.url.endsWith("/api/agents/me/status") && c.apiKey === "sk_test_secret")).toBe(true);
  });

  it("rejects removed commands instead of exposing old daemon/controlapi paths", async () => {
    for (const argv of [["serve"], ["agent", "list"], ["daily", "show"], ["join", "coup"], ["mcp"]]) {
      const r = await runCapture(argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.stderr, argv.join(" ")).toMatch(/unknown command/);
    }
  });

  it("documents start as manual match requests", async () => {
    const r = await runCapture(["start", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Request manual ranked match(es) through the running Bridge.");
    expect(r.stdout).toContain("Manual starts do not consume the daily automatic match limit.");
    expect(r.stdout).toContain("N must be between 1 and 20.");
  });

  it("documents run as an advanced foreground bridge command", async () => {
    const r = await runCapture(["run", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Advanced: run the outbound Bridge in this terminal.");
    expect(r.stdout).toContain("aifight.service");
  });

  it("documents approved Agent-assisted setup", async () => {
    const r = await runCapture(["setup", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--approved-local-setup");
    expect(r.stdout).toContain("aifight config");
  });

  it("documents local uninstall without platform identity deletion", async () => {
    const r = await runCapture(["uninstall", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Remove local AIFight bridge setup");
    expect(r.stdout).toContain("does not delete your AIFight Agent");
    expect(r.stdout).toContain("npm uninstall -g @aifight/aifight");
  });

  it("lists and shows local match sessions", async () => {
    const home = withRuntimeHome();
    seedLocalSession(home);

    const list = await runCapture(["sessions", "list"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("session-cli-");
    expect(list.stdout).toContain("coup");

    const show = await runCapture(["sessions", "show", "session-cli-1"]);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain("Session: session-cli-1");
    expect(show.stdout).toContain("Game: coup");
  });

  it("shows and initializes local strategy file paths", async () => {
    configuredBridge({
      agentId: "agent-strategy-1",
      agentName: "Strategy Agent",
    });
    const home = process.env.AIFIGHT_RUNTIME_HOME!;

    const paths = await runCapture(["strategy", "path", "texas_holdem"]);
    expect(paths.code).toBe(0);
    expect(paths.stdout).toContain("Global strategy:");
    expect(paths.stdout).toContain("texas_holdem:");

    const init = await runCapture(["strategy", "init", "texas_holdem"]);
    expect(init.code).toBe(0);
    expect(init.stdout).toContain("Strategy files ready");
    const globalPath = path.join(home, "agents", "agent-strategy-1", "strategy", "global.md");
    const holdemPath = path.join(home, "agents", "agent-strategy-1", "strategy", "games", "texas_holdem.md");
    expect(fs.existsSync(globalPath)).toBe(true);
    expect(fs.existsSync(holdemPath)).toBe(true);

    fs.writeFileSync(globalPath, "Keep output strict and reason about hidden information.\n");
    const validate = await runCapture(["strategy", "validate", "texas_holdem"]);
    expect(validate.code).toBe(0);
    expect(validate.stdout).toContain("global: ok");
    expect(validate.stdout).toContain("game:texas_holdem: empty");
  });

  it("start sends a manual one-shot request through the local control API", async () => {
    configuredBridge({ autoGames: ["liars_dice"] });
    writeToken("a".repeat(64));
    writePort(40123);
    const calls: Array<{ url: string; bodyText: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/bridge/version")) return versionPolicyResp();
      calls.push({
        url,
        bodyText: typeof init?.body === "string" ? init.body : "",
      });
      return new Response(null, { status: 204 });
    };

    const r = await runCapture(["start", "coup", "3"], { fetchImpl });

    expect(r.code).toBe(0);
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:40123/v1/agents/alpha/join",
        bodyText: JSON.stringify({ game: "coup", mode: "ranked", one_shot: true, count: 3 }),
      },
    ]);
    expect(r.stdout).toContain("Requested 3 manual ranked Coup matches");
  });

  it("start explains when the Bridge is not running", async () => {
    configuredBridge();
    const r = await runCapture(["start", "coup"], {
      fetchImpl: async () => versionPolicyResp(),
    });

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("AIFight Bridge is not running");
    expect(r.stderr).toContain("aifight service install");
  });

  it("start explains when the Bridge is not configured", async () => {
    withRuntimeHome();
    const r = await runCapture(["start", "coup"], {
      fetchImpl: async () => versionPolicyResp(),
    });

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("AIFight Bridge is not configured");
    expect(r.stderr).toContain("aifight setup");
    expect(r.stderr).toContain("aifight connect <PAIRING_CODE>");
    expect(r.stderr).toContain("aifight.service");
    expect(r.stderr).not.toContain("unexpected error");
  });
});

describe("aifight service", () => {
  it("approved setup flow restarts an already running service after saving new credentials", async () => {
    configuredBridge();
    const aifightExec = tempExecutable();
    const nodeExec = tempExecutable();
    const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-systemd-running-"));
    cleanupQueue.push(() => fs.rmSync(unitDir, { recursive: true, force: true }));
    const unitPath = path.join(unitDir, "aifight.service");
    fs.writeFileSync(unitPath, "[Unit]\n");
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const execFile: ServiceExecFile = async (file, args) => {
      calls.push({ file, args });
      if (file === "systemctl" && args.includes("is-active")) {
        return { stdout: "active\n", stderr: "" };
      }
      return { stdout: "ok\n", stderr: "" };
    };

    const result = await offerBridgeServiceInstall({
      stdout: (s) => stdout.push(s),
      stderr: (s) => stderr.push(s),
      bridgeService: {
        platform: "linux",
        uid: 0,
        aifightExec,
        nodeExec,
        systemdSystemUnitPath: unitPath,
        execFile,
      },
    }, { approvedLocalSetup: true });

    expect(result).toBe("installed");
    expect(stdout.join("")).toContain("aifight.service is already running");
    expect(stdout.join("")).toContain("restarting aifight.service now");
    expect(stdout.join("")).toContain("aifight.service restarted");
    expect(stderr.join("")).toBe("");
    expect(calls.map((c) => [c.file, ...c.args].join(" "))).toEqual([
      "systemctl --version",
      "systemctl is-active aifight.service",
      "systemctl --version",
      "systemctl restart aifight.service",
    ]);
  });

  it("installs a root Linux systemd service that runs aifight run", async () => {
    configuredBridge();
    const aifightExec = tempExecutable();
    const nodeExec = tempExecutable();
    const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-systemd-"));
    cleanupQueue.push(() => fs.rmSync(unitDir, { recursive: true, force: true }));
    const unitPath = path.join(unitDir, "aifight.service");
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const execFile: ServiceExecFile = async (file, args) => {
      calls.push({ file, args });
      return { stdout: "ok\n", stderr: "" };
    };

    const r = await runCapture(["service", "install"], {
      bridgeService: {
        platform: "linux",
        uid: 0,
        aifightExec,
        nodeExec,
        systemdSystemUnitPath: unitPath,
        execFile,
      },
    });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("aifight.service installed and started");
    const unit = fs.readFileSync(unitPath, "utf8");
    expect(unit).toContain("Description=AIFight Agent Service");
    expect(unit).toContain(`ExecStart=${fs.realpathSync(nodeExec)} ${fs.realpathSync(aifightExec)} run`);
    expect(unit).toContain('Environment="AIFIGHT_SERVICE_RUN=1"');
    expect(unit).toContain("WantedBy=multi-user.target");
    expect(calls.map((c) => [c.file, ...c.args].join(" "))).toEqual([
      "systemctl --version",
      "systemctl daemon-reload",
      "systemctl enable --now aifight.service",
    ]);
  });

  it("supports an explicit CLI path for service install without PATH lookup", async () => {
    configuredBridge();
    const aifightExec = tempExecutable();
    const nodeExec = tempExecutable();
    const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-systemd-path-"));
    cleanupQueue.push(() => fs.rmSync(unitDir, { recursive: true, force: true }));
    const unitPath = path.join(unitDir, "aifight.service");
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const execFile: ServiceExecFile = async (file, args) => {
      calls.push({ file, args });
      return { stdout: "ok\n", stderr: "" };
    };

    const r = await runCapture(["service", "install", "--aifight-path", aifightExec], {
      bridgeService: {
        platform: "linux",
        uid: 0,
        nodeExec,
        systemdSystemUnitPath: unitPath,
        execFile,
      },
    });

    expect(r.code).toBe(0);
    const unit = fs.readFileSync(unitPath, "utf8");
    expect(unit).toContain(`ExecStart=${fs.realpathSync(nodeExec)} ${fs.realpathSync(aifightExec)} run`);
    expect(calls.some((c) => c.file === "sh")).toBe(false);
    expect(calls.map((c) => [c.file, ...c.args].join(" "))).toEqual([
      "systemctl --version",
      "systemctl daemon-reload",
      "systemctl enable --now aifight.service",
    ]);
  });

  it("rejects --aifight-path outside service install", async () => {
    configuredBridge();
    const aifightExec = tempExecutable();
    const r = await runCapture(["service", "status", "--aifight-path", aifightExec]);

    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--aifight-path is only supported");
  });

  it("reports service status with an injected systemd target", async () => {
    configuredBridge();
    const aifightExec = tempExecutable();
    const nodeExec = tempExecutable();
    const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-systemd-status-"));
    cleanupQueue.push(() => fs.rmSync(unitDir, { recursive: true, force: true }));
    const unitPath = path.join(unitDir, "aifight.service");
    fs.writeFileSync(unitPath, "unit\n");
    const execFile: ServiceExecFile = async (file, args) => {
      if (file === "systemctl" && args.includes("is-active")) return { stdout: "active\n", stderr: "" };
      return { stdout: "ok\n", stderr: "" };
    };

    const r = await runCapture(["service", "status"], {
      bridgeService: {
        platform: "linux",
        uid: 0,
        aifightExec,
        nodeExec,
        systemdSystemUnitPath: unitPath,
        execFile,
      },
    });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("aifight.service: running");
    expect(r.stdout).toContain(unitPath);
  });

  it("installs a macOS launchd service when kickstart fails but the service is loaded", async () => {
    configuredBridge();
    const aifightExec = tempExecutable();
    const nodeExec = tempExecutable();
    const plistDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-launchd-"));
    cleanupQueue.push(() => fs.rmSync(plistDir, { recursive: true, force: true }));
    const plistPath = path.join(plistDir, "ai.aifight.service.plist");
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const execFile: ServiceExecFile = async (file, args) => {
      calls.push({ file, args });
      if (file === "launchctl" && args[0] === "kickstart") {
        const err = Object.assign(new Error("kickstart failed"), {
          stderr: "Bootstrap is already in progress\n",
        });
        throw err;
      }
      return { stdout: "ok\n", stderr: "" };
    };

    const r = await runCapture(["service", "install"], {
      bridgeService: {
        platform: "darwin",
        uid: 501,
        aifightExec,
        nodeExec,
        launchdPlistPath: plistPath,
        execFile,
      },
    });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("aifight.service installed and started");
    expect(r.stderr).toContain("warning:");
    expect(r.stderr).toContain("kickstart");
    expect(fs.readFileSync(plistPath, "utf8")).toContain("<string>run</string>");
    expect(calls.map((c) => [c.file, ...c.args].join(" "))).toEqual([
      "launchctl version",
      "launchctl bootout gui/501 " + plistPath,
      "launchctl bootstrap gui/501 " + plistPath,
      "launchctl kickstart -k gui/501/ai.aifight.service",
      "launchctl print gui/501/ai.aifight.service",
    ]);
  });

  it("supports the npm update path with service restart and no re-register", async () => {
    withRuntimeHome();
    const aifightExec = tempExecutable();
    const nodeExec = tempExecutable();
    const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-systemd-restart-"));
    cleanupQueue.push(() => fs.rmSync(unitDir, { recursive: true, force: true }));
    const unitPath = path.join(unitDir, "aifight.service");
    fs.writeFileSync(unitPath, "unit\n");
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const execFile: ServiceExecFile = async (file, args) => {
      calls.push({ file, args });
      return { stdout: "ok\n", stderr: "" };
    };
    const fetchImpl: typeof fetch = async () => {
      throw new Error("service restart must not contact the AIFight platform");
    };

    const r = await runCapture(["service", "restart"], {
      fetchImpl,
      bridgeService: {
        platform: "linux",
        uid: 0,
        aifightExec,
        nodeExec,
        systemdSystemUnitPath: unitPath,
        execFile,
      },
    });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("aifight.service restarted");
    expect(calls.map((c) => [c.file, ...c.args].join(" "))).toEqual([
      "systemctl --version",
      "systemctl restart aifight.service",
    ]);
  });

  it("updates the npm package and restarts a running service", async () => {
    configuredBridge();
    const aifightExec = tempExecutable();
    const nodeExec = tempExecutable();
    const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-systemd-update-"));
    cleanupQueue.push(() => fs.rmSync(unitDir, { recursive: true, force: true }));
    const unitPath = path.join(unitDir, "aifight.service");
    fs.writeFileSync(unitPath, "unit\n");
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const execFile: ServiceExecFile = async (file, args) => {
      calls.push({ file, args });
      if (file === "systemctl" && args.includes("is-active")) {
        return { stdout: "active\n", stderr: "" };
      }
      return { stdout: "ok\n", stderr: "" };
    };
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith("/api/bridge/version")) {
        return jsonResp({
          minimum_supported_version: "0.1.0-alpha.1",
          recommended_version: "0.1.0-beta.9",
          latest_version: "0.1.0-beta.9",
          update_command: "npm install -g @aifight/aifight",
        });
      }
      return jsonResp({ error: "unexpected" }, 500);
    };

    const r = await runCapture(["update", "--yes"], {
      fetchImpl,
      bridgeService: {
        platform: "linux",
        uid: 0,
        aifightExec,
        nodeExec,
        systemdSystemUnitPath: unitPath,
        execFile,
      },
    });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Updating AIFight CLI");
    expect(r.stdout).toContain("aifight.service restarted");
    expect(r.stdout).not.toMatch(/re-register|re-pair/);
    expect(calls.map((c) => [c.file, ...c.args].join(" "))).toEqual([
      "npm install -g @aifight/aifight",
      "systemctl --version",
      "systemctl is-active aifight.service",
      "systemctl --version",
      "systemctl restart aifight.service",
    ]);
  });

  it("does not run npm update when confirmation is missing in non-interactive mode", async () => {
    configuredBridge();
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith("/api/bridge/version")) {
        return jsonResp({
          minimum_supported_version: "0.1.0-alpha.1",
          recommended_version: "0.1.0-beta.9",
          latest_version: "0.1.0-beta.9",
          update_command: "npm install -g @aifight/aifight",
        });
      }
      return jsonResp({ error: "unexpected" }, 500);
    };

    const r = await runCapture(["update"], {
      fetchImpl,
      bridgeService: {
        execFile: async (file, args) => {
          calls.push({ file, args });
          return { stdout: "ok\n", stderr: "" };
        },
      },
    });

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("update requires confirmation");
    expect(calls).toEqual([]);
  });
});

describe("aifight setup", () => {
  it("creates a private bootstrap identity and saves local bridge credentials before claim", async () => {
    withRuntimeHome();
    const prevBase = process.env.AIFIGHT_BASE_URL;
    process.env.AIFIGHT_BASE_URL = "https://beta.aifight.ai";
    cleanupQueue.push(() => {
      if (prevBase === undefined) delete process.env.AIFIGHT_BASE_URL;
      else process.env.AIFIGHT_BASE_URL = prevBase;
    });
    let requestBody: unknown;
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe("https://beta.aifight.ai/api/agents/register");
      requestBody = JSON.parse(String(init?.body));
      return jsonResp({
        agent: {
          id: "11111111-1111-4111-8111-111111111111",
          name: "bootstrap-11111111-1111-4111-8111-111111111111",
          suggested_name: "new-agent",
          identity_status: "bootstrap",
          api_key: "sk_new_agent_secret",
          model: "direct",
          auto_confirm: false,
          webhook_url: "",
        },
        claim_url: "https://beta.aifight.ai/claim/ct_SECRET_CLAIM_TOKEN",
        claim_token: "ct_SECRET_CLAIM_TOKEN",
        important: "Save your api_key!",
      }, 201);
    };

    const r = await runCapture(["setup", "--name", "new-agent", "--json"], { fetchImpl });
    const config = readBridgeConfig();
    const payload = JSON.parse(r.stdout) as { status: string; claimUrl: string };

    expect(r.code).toBe(0);
    expect(requestBody).toEqual({
      name: "new-agent",
      model: "direct",
      description: "AIFight Bridge agent (direct)",
    });
    expect(config.agentId).toBe("11111111-1111-4111-8111-111111111111");
    expect(config.agentName).toBe("bootstrap-11111111-1111-4111-8111-111111111111");
    expect(config.suggestedName).toBe("new-agent");
    expect(config.apiKey).toBe("sk_new_agent_secret");
    expect(config.claimToken).toBe("ct_SECRET_CLAIM_TOKEN");
    expect(config.runtimeType).toBe("direct");
    expect(config.runtimeLocalUrl).toBe("direct://local");
    expect(config.autoDailyLimit).toBe(2);
    expect(config.wsUrl).toBe("wss://beta.aifight.ai/api/ws");
    expect(payload.status).toBe("registered");
    expect(payload.claimUrl).toBe("https://beta.aifight.ai/claim/ct_SECRET_CLAIM_TOKEN");
  });

  it("defaults bare setup to direct-LLM with a generated name", async () => {
    withRuntimeHome();
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { name: string; model: string };
      // New default is an evocative "Adjective Noun" display name, not the old
      // agent-direct-<host>-<hex> slug.
      expect(body.name).toMatch(/^[A-Za-z]+ [A-Za-z]+$/);
      expect(body.model).toBe("direct");
      return jsonResp({
        agent: {
          id: "22222222-2222-4222-8222-222222222222",
          // New server stores the chosen name directly in `name` (no bootstrap
          // slug / suggested_name split) and assigns a numeric public ID.
          name: body.name,
          identity_status: "bootstrap",
          public_no: 1024384756,
          api_key: "sk_direct_secret",
          model: body.model,
          auto_confirm: false,
          webhook_url: "",
        },
        claim_url: "https://aifight.ai/claim/ct_DIRECT",
        claim_token: "ct_DIRECT",
        important: "Save your api_key!",
      }, 201);
    };

    const r = await runCapture(["setup", "--json"], { fetchImpl });
    const config = readBridgeConfig();

    expect(r.code).toBe(0);
    expect(config.runtimeType).toBe("direct");
    expect(config.runtimeLocalUrl).toBe("direct://local");
  });

  it("rejects combining approved local setup with JSON mode", async () => {
    withRuntimeHome();
    let contacted = false;
    const fetchImpl: typeof fetch = async () => {
      contacted = true;
      return jsonResp({});
    };

    const r = await runCapture(["setup", "--approved-local-setup", "--json"], { fetchImpl });

    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--approved-local-setup cannot be combined with --json");
    expect(contacted).toBe(false);
  });

  it("maps registration HTTP failures to ordinary command errors", async () => {
    withRuntimeHome();
    const fetchImpl: typeof fetch = async () => jsonResp({ error: "too many registration attempts" }, 429);
    const r = await runCapture(["setup", "--json"], { fetchImpl });

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("registration_failed");
    expect(r.stderr).toContain("too many registration attempts");
  });

  it("maps registration network failures to ordinary command errors", async () => {
    withRuntimeHome();
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const r = await runCapture(["setup", "--json"], { fetchImpl });

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("registration_failed");
    expect(r.stderr).toContain("fetch failed");
  });

  it("rejects combining --auto with --json", async () => {
    withRuntimeHome();
    let contacted = false;
    const fetchImpl: typeof fetch = async () => {
      contacted = true;
      return jsonResp({});
    };
    const r = await runCapture(["setup", "--auto", "--json"], { fetchImpl });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--auto cannot be combined with --json");
    expect(contacted).toBe(false);
  });

  it("rejects an unknown positional argument", async () => {
    withRuntimeHome();
    let contacted = false;
    const fetchImpl: typeof fetch = async () => {
      contacted = true;
      return jsonResp({});
    };
    const r = await runCapture(["setup", "wat", "--json"], { fetchImpl });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("is not understood");
    expect(contacted).toBe(false);
  });
});

describe("aifight set", () => {
  it("stores daily 0 as disabling daily automatic matches", async () => {
    configuredBridge();
    let policyBody: unknown;
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (String(_input).endsWith("/api/bridge/version")) return versionPolicyResp();
      policyBody = JSON.parse(String(init?.body));
      return jsonResp({ policy: { auto_requeue: false } });
    };
    const r = await runCapture(["set", "daily", "0"], { fetchImpl });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Daily automatic ranked matches disabled");
    expect(policyBody).toEqual({ auto_requeue: false });

    const status = await runCapture(["status"], { fetchImpl });
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("Automatic ranked matches: disabled");
  });

  it("stores positive daily limits and syncs platform max_games_per_day", async () => {
    configuredBridge();
    let policyBody: unknown;
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (String(_input).endsWith("/api/bridge/version")) return versionPolicyResp();
      policyBody = JSON.parse(String(init?.body));
      return jsonResp({ policy: { max_games_per_day: 2, auto_requeue: true } });
    };
    const r = await runCapture(["set", "daily", "2"], { fetchImpl });
    expect(r.code).toBe(0);
    expect(policyBody).toEqual({ max_games_per_day: 2, auto_requeue: true });
  });

  it("maps daily policy sync failures to ordinary command errors", async () => {
    configuredBridge();
    const fetchImpl: typeof fetch = async () => jsonResp({ error: "auto_requeue=true requires max_games_per_day > 0" }, 400);
    const r = await runCapture(["set", "daily", "2", "--json"], { fetchImpl });

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("policy_sync_failed");
    expect(r.stderr).not.toContain("client_unexpected_error");
  });

  // Token-burn guard: >10/day needs explicit confirmation. In a non-TTY run
  // (this test) that means a clear error pointing at --yes; --yes and --json
  // are the programmatic overrides; the threshold itself (10) passes plain.
  it("rejects daily caps above 10 without --yes when not interactive", async () => {
    configuredBridge();
    let contacted = false;
    const fetchImpl: typeof fetch = async () => {
      contacted = true;
      return jsonResp({});
    };
    const r = await runCapture(["set", "daily", "15"], { fetchImpl });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("above the confirmation threshold (10)");
    expect(r.stderr).toContain("aifight set daily 15 --yes");
    expect(contacted).toBe(false); // nothing synced without the confirmation
  });

  it("accepts daily caps above 10 with --yes", async () => {
    configuredBridge();
    let policyBody: unknown;
    const fetchImpl: typeof fetch = async (_input, init) => {
      policyBody = JSON.parse(String(init?.body));
      return jsonResp({ policy: { max_games_per_day: 15, auto_requeue: true } });
    };
    const r = await runCapture(["set", "daily", "15", "--yes"], { fetchImpl });
    expect(r.code).toBe(0);
    expect(policyBody).toEqual({ max_games_per_day: 15, auto_requeue: true });
  });

  it("daily cap of exactly 10 needs no confirmation", async () => {
    configuredBridge();
    const fetchImpl: typeof fetch = async () =>
      jsonResp({ policy: { max_games_per_day: 10, auto_requeue: true } });
    const r = await runCapture(["set", "daily", "10"], { fetchImpl });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Automatic ranked matches set to 10 per day.");
  });

  it("renames the agent via PATCH /api/agents/me/name and caches the new name", async () => {
    configuredBridge();
    let url = "";
    let body: unknown;
    let apiKey: string | undefined;
    let client: string | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      url = String(input);
      const h = init?.headers as Record<string, string> | undefined;
      apiKey = h?.["X-API-Key"];
      client = h?.["X-AIFight-Client"];
      body = JSON.parse(String(init?.body));
      return jsonResp({ name: "Dark Knight", public_no: 1024384756, rename_cooldown_days: 7 });
    };
    const r = await runCapture(["rename", "Dark", "Knight"], { fetchImpl });
    expect(r.code).toBe(0);
    expect(url.endsWith("/api/agents/me/name")).toBe(true);
    expect(apiKey).toBe("sk_test_secret");
    expect(client).toBe("cli");
    expect(body).toEqual({ name: "Dark Knight" }); // multi-word positionals joined
    expect(r.stdout).toContain("Dark Knight");
    expect(r.stdout).toContain("102-438-4756"); // grouped public id
    // Server-authoritative name cached locally for bidirectional sync.
    expect(readBridgeConfig().agentName).toBe("Dark Knight");
  });

  it("surfaces the rename cooldown (HTTP 429) as a command error", async () => {
    configuredBridge();
    const fetchImpl: typeof fetch = async () =>
      jsonResp(
        { error: "display name was changed recently; you can rename again after 2026-06-25T00:00:00Z", next_rename_allowed_at: "2026-06-25T00:00:00Z" },
        429,
      );
    const r = await runCapture(["rename", "Shadow Fox"], { fetchImpl });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("again after"); // server cooldown message surfaced
  });

  it("surfaces an invalid name (HTTP 400) as a command error", async () => {
    configuredBridge();
    const fetchImpl: typeof fetch = async () =>
      jsonResp({ error: "name is reserved; choose a non-brand personal or project name" }, 400);
    const r = await runCapture(["rename", "OpenAI"], { fetchImpl });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("reserved"); // server validation message surfaced
  });

  it("stores automatic game preferences locally", async () => {
    configuredBridge();
    const r = await runCapture(["set", "game", "liars_dice,coup,coup"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("liars_dice, coup");

    const status = await runCapture(["status"], { fetchImpl: async () => versionPolicyResp() });
    expect(status.stdout).toContain("Games: liars_dice, coup");
  });

  it("rejects unsupported automatic games", async () => {
    configuredBridge();
    const r = await runCapture(["set", "game", "mahjong"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unsupported game 'mahjong'");
  });
});

describe("challenge and accept", () => {
  it("creates a single-use friendly challenge URL", async () => {
    const config = configuredBridge();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResp({
        duel: { id: "duel-1", game: "coup", status: "pending" },
        join_url: "https://beta.aifight.ai/challenge/dl_0123456789abcdef0123456789abcdef",
      });
    };

    const r = await runCapture(["challenge", "coup"], { fetchImpl });
    expect(r.code).toBe(0);
    expect(calls[0]?.url).toBe(`${config.baseUrl}/api/challenges`);
    expect(calls[0]?.init?.method).toBe("POST");
    expect((calls[0]?.init?.headers as Record<string, string>)["X-API-Key"]).toBe(config.apiKey);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ game: "coup", accept_mode: "single" });
    expect(r.stdout).toContain("accepted once");
    expect(r.stdout).toContain("does not affect ratings or daily auto-play");
  });

  it("creates Texas Hold'em as a direct two-player friendly challenge", async () => {
    const config = configuredBridge();
    let requestBody = "";
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestBody = String(init?.body ?? "");
      return jsonResp({
        duel: { id: "duel-1", game: "texas_holdem", status: "pending" },
        join_url: "https://beta.aifight.ai/challenge/dl_0123456789abcdef0123456789abcdef",
      });
    };

    const r = await runCapture(["challenge", "texas_holdem"], { fetchImpl });
    expect(r.code).toBe(0);
    expect(JSON.parse(requestBody)).toEqual({ game: "texas_holdem", accept_mode: "single" });
    expect(r.stdout).toContain("two-player friendly table");
    expect(config.baseUrl).toBe("https://beta.aifight.ai");
  });

  it("accepts a received challenge URL by token", async () => {
    const config = configuredBridge();
    const token = "dl_0123456789abcdef0123456789abcdef";
    let calledURL = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      calledURL = String(input);
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>)["X-API-Key"]).toBe(config.apiKey);
      return jsonResp({ match_id: "match-1", message: "accepted" });
    };

    const r = await runCapture([`accept`, `https://beta.aifight.ai/challenge/${token}`], { fetchImpl });
    expect(r.code).toBe(0);
    expect(calledURL).toBe(`${config.baseUrl}/api/challenges/${token}/accept`);
    expect(r.stdout).toContain("Friendly challenge accepted");
    expect(r.stdout).toContain("match-1");
  });

  it("maps offline challenge accept to ordinary command errors with the service hint", async () => {
    configuredBridge();
    const token = "dl_0123456789abcdef0123456789abcdef";
    const fetchImpl: typeof fetch = async () => jsonResp({
      error: "connect your WebSocket before calling accept",
      retryable: true,
    }, 425);

    const r = await runCapture(["accept", token, "--json"], { fetchImpl });

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("challenge_accept_failed");
    expect(r.stderr).toContain("aifight service start");
    expect(r.stderr).not.toContain("client_unexpected_error");
  });
});

describe("doctor", () => {
  it("reports not configured without referring to legacy runtime files", async () => {
    withRuntimeHome();
    const r = await runCapture(["doctor"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("bridge config  : not configured");
    expect(r.stdout).not.toMatch(/daemon|token file|port file/);
  });
});
