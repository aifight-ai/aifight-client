// Batch C — `config update` (D9 + field edits) and `config remove` /
// `config clear-key` (D10 + managed-key handling).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { run } from "../src/cli/main";

let prevHome: string | undefined;
let tmpDir: string;

beforeEach(() => {
  prevHome = process.env.AIFIGHT_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-config-manage-"));
  process.env.AIFIGHT_HOME = tmpDir;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.AIFIGHT_HOME;
  else process.env.AIFIGHT_HOME = prevHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function runCapture(argv: readonly string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(argv, { stdout: (s) => stdout.push(s), stderr: (s) => stderr.push(s) });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

function agentDir(slug = "default") {
  return path.join(tmpDir, "agents", slug);
}
function readConfig(slug = "default") {
  return JSON.parse(fs.readFileSync(path.join(agentDir(slug), "config.json"), "utf8"));
}

/** Scaffold a config with a managed-key profile (key file at keys/<id>.key). */
function scaffoldManaged(id: string, opts: { active?: boolean } = {}) {
  const dir = agentDir();
  fs.mkdirSync(path.join(dir, "keys"), { recursive: true });
  const keyPath = path.join(dir, "keys", `${id}.key`);
  fs.writeFileSync(keyPath, "sk-managed\n", { mode: 0o600 });
  const cfgPath = path.join(dir, "config.json");
  const cfg = fs.existsSync(cfgPath)
    ? readConfig()
    : { schemaVersion: 1, activeProfile: id, profiles: {}, routing: { default: id } };
  cfg.profiles[id] = {
    displayName: id,
    protocol: "anthropic_messages",
    apiKeyRef: { type: "file", path: keyPath },
    model: "claude-sonnet-4-6",
    request: { temperature: null, maxTokens: 32000, responseFormat: "json", stream: "auto" },
    thinking: { enabled: true, mode: "always" },
  };
  if (opts.active) {
    cfg.activeProfile = id;
    cfg.routing.default = id;
  }
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  return keyPath;
}

// ─── update ──────────────────────────────────────────────────────────

describe("config update", () => {
  async function seed() {
    await runCapture(["config", "add", "ds", "--protocol", "compat", "--base-url", "https://api.deepseek.com/v1", "--model", "deepseek-chat", "--env", "DS_KEY", "--no-test"]);
  }

  it("changes the model (--no-test)", async () => {
    await seed();
    const r = await runCapture(["config", "update", "ds", "--model", "deepseek-v4-pro", "--no-test"]);
    expect(r.code).toBe(0);
    expect(readConfig().profiles.ds.model).toBe("deepseek-v4-pro");
  });

  it("refuses --protocol (D9)", async () => {
    await seed();
    const r = await runCapture(["config", "update", "ds", "--protocol", "gpt"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/protocol of an existing profile cannot be changed/);
  });

  it("errors on an unknown profile", async () => {
    await seed();
    const r = await runCapture(["config", "update", "nope", "--model", "x", "--no-test"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unknown profile "nope"/);
  });

  it("a settings-only change auto-skips the test and preserves other fields", async () => {
    await seed();
    // No --no-test: stream is not connectivity-relevant, so D7 skips the probe.
    const r = await runCapture(["config", "update", "ds", "--stream", "never"]);
    expect(r.code).toBe(0);
    const p = readConfig().profiles.ds;
    expect(p.request.stream).toBe("never");
    expect(p.model).toBe("deepseek-chat"); // untouched
    expect(p.apiKeyRef).toEqual({ type: "env", name: "DS_KEY" }); // untouched
  });

  it("updates the key source", async () => {
    await seed();
    await runCapture(["config", "update", "ds", "--file", "/tmp/newkey.txt", "--no-test"]);
    expect(readConfig().profiles.ds.apiKeyRef).toEqual({ type: "file", path: "/tmp/newkey.txt" });
  });

  it("caps --max-tokens to the model ceiling", async () => {
    await runCapture(["config", "add", "c", "--protocol", "claude", "--env", "K", "--no-test"]);
    await runCapture(["config", "update", "c", "--max-tokens", "999999"]);
    expect(readConfig().profiles.c.request.maxTokens).toBe(64000); // claude-sonnet-4-6 ceiling
  });
});

// ─── remove (D10) ────────────────────────────────────────────────────

describe("config remove (D10)", () => {
  it("refuses to remove the active profile", async () => {
    scaffoldManaged("a", { active: true });
    const r = await runCapture(["config", "remove", "a", "--yes"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/is the active profile/);
  });

  it("removes a non-active profile, cleans routing, deletes the managed key", async () => {
    scaffoldManaged("a", { active: true });
    const keyB = scaffoldManaged("b");
    // route a game to b, then remove b
    await runCapture(["config", "route", "texas_holdem", "b"]);
    expect(readConfig().routing.byGame).toEqual({ texas_holdem: "b" });
    const r = await runCapture(["config", "remove", "b", "--yes"]);
    expect(r.code).toBe(0);
    const cfg = readConfig();
    expect(cfg.profiles.b).toBeUndefined();
    expect(cfg.routing.byGame ?? {}).toEqual({}); // route cleaned
    expect(fs.existsSync(keyB)).toBe(false); // managed key deleted
  });

  it("leaves a user's own env key untouched on removal", async () => {
    scaffoldManaged("a", { active: true });
    await runCapture(["config", "add", "envp", "--protocol", "claude", "--env", "MY_KEY", "--no-test"]);
    const r = await runCapture(["config", "remove", "envp", "--yes", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ status: "removed", profile: "envp", keyFileDeleted: false });
  });

  it("errors on an unknown profile", async () => {
    scaffoldManaged("a", { active: true });
    const r = await runCapture(["config", "remove", "nope", "--yes"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unknown profile "nope"/);
  });
});

// ─── clear-key ───────────────────────────────────────────────────────

describe("config clear-key", () => {
  it("deletes an AIFight-managed key file", async () => {
    scaffoldManaged("a", { active: true });
    const keyB = scaffoldManaged("b");
    const r = await runCapture(["config", "clear-key", "b"]);
    expect(r.code).toBe(0);
    expect(fs.existsSync(keyB)).toBe(false);
    // profile remains
    expect(readConfig().profiles.b).toBeDefined();
  });

  it("refuses to touch an env-based key", async () => {
    await runCapture(["config", "add", "envp", "--protocol", "claude", "--env", "MY_KEY", "--no-test"]);
    const r = await runCapture(["config", "clear-key", "envp"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not managed by AIFight/);
    expect(r.stderr).toMatch(/environment variable MY_KEY/);
  });

  it("errors on an unknown profile", async () => {
    scaffoldManaged("a", { active: true });
    const r = await runCapture(["config", "clear-key", "nope"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unknown profile "nope"/);
  });
});
