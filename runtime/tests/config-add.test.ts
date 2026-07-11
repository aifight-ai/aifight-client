// Batch B — `aifight config add` + settings resolution.
//   - resolveProfileSettings: pure capability-aware validation (D5/D12)
//   - resolveKeyRef: key-source rules (D4)
//   - end-to-end via run(): add / dup guard (D6) / compat required (D3) /
//     bad protocol + did-you-mean / --json shape / D8 active semantics.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { run } from "../src/cli/main";
import { resolveProfileSettings, resolveKeyRef } from "../src/cli/commands/config-edit";
import type { HandlerArgs } from "../src/cli/shared";

let prevHome: string | undefined;
let tmpDir: string;

beforeEach(() => {
  prevHome = process.env.AIFIGHT_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-config-add-"));
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

function readConfig(slug = "default") {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, "agents", slug, "config.json"), "utf8"));
}

// ─── resolveProfileSettings (pure, D5/D12) ───────────────────────────

describe("resolveProfileSettings (D5 defaults)", () => {
  it("add defaults: thinking on, maxTokens 32000, stream auto, temp omitted", () => {
    const s = resolveProfileSettings("anthropic_messages", "claude-sonnet-4-6", {}, undefined);
    expect(s.thinkingEnabled).toBe(true);
    expect(s.maxTokens).toBe(32000);
    expect(s.stream).toBe("auto");
    expect(s.temperature).toBeNull();
  });

  it("caps maxTokens to the model ceiling (claude-sonnet-4-6 = 64000)", () => {
    const s = resolveProfileSettings("anthropic_messages", "claude-sonnet-4-6", { "max-tokens": 999999 }, undefined);
    expect(s.maxTokens).toBe(64000);
  });

  it("rejects max-tokens below the floor", () => {
    expect(() => resolveProfileSettings("anthropic_messages", "claude-sonnet-4-6", { "max-tokens": 10 }, undefined)).toThrow(/max-tokens/);
  });

  it("compat protocol forces thinking off (no reasoning mode)", () => {
    const s = resolveProfileSettings("openai_chat_compat", "deepseek-chat", {}, undefined);
    expect(s.thinkingEnabled).toBe(false);
  });

  it("accepts a valid effort and rejects one the model does not list", () => {
    expect(resolveProfileSettings("anthropic_messages", "claude-sonnet-4-6", { effort: "high" }, undefined).effort).toBe("high");
    // claude-sonnet-4-6 lists [low, medium, high, max] — xhigh is not valid for it
    expect(() => resolveProfileSettings("anthropic_messages", "claude-sonnet-4-6", { effort: "xhigh" }, undefined)).toThrow(/effort/);
  });

  it("is permissive about effort for an unknown/new model (new models keep arriving)", () => {
    // A future Anthropic model not yet in the capability registry: any effort is
    // accepted as-is; the auto-test — not a stale registry — is the source of truth.
    const s = resolveProfileSettings("anthropic_messages", "claude-opus-5-2027", { effort: "minimal" }, undefined);
    expect(s.effort).toBe("minimal");
    expect(s.thinkingEnabled).toBe(true);
  });

  it("temperature is rejected while thinking is on, allowed when off", () => {
    expect(() => resolveProfileSettings("anthropic_messages", "claude-sonnet-4-6", { temperature: 0.2 }, undefined)).toThrow(/thinking is on/);
    const s = resolveProfileSettings("anthropic_messages", "claude-sonnet-4-6", { thinking: "off", temperature: 0.2 }, undefined);
    expect(s.thinkingEnabled).toBe(false);
    expect(s.temperature).toBe(0.2);
  });

  it("verbosity only applies to openai_responses (D12)", () => {
    expect(resolveProfileSettings("openai_responses", "gpt-5.5", { verbosity: "low" }, undefined).verbosity).toBe("low");
    expect(() => resolveProfileSettings("anthropic_messages", "claude-sonnet-4-6", { verbosity: "low" }, undefined)).toThrow(/verbosity/);
  });

  it("features gate to capability-legal keys (D12)", () => {
    const s = resolveProfileSettings("openai_chat_compat", "deepseek-v4-pro", { feature: "jsonObjectMode=on" }, undefined);
    expect(s.features).toEqual({ jsonObjectMode: true });
    // deepseek-chat is not a v4 model → no special features
    expect(() => resolveProfileSettings("openai_chat_compat", "deepseek-chat", { feature: "jsonObjectMode=on" }, undefined)).toThrow(/feature/);
  });

  it("effort with thinking off is rejected", () => {
    expect(() => resolveProfileSettings("anthropic_messages", "claude-sonnet-4-6", { thinking: "off", effort: "high" }, undefined)).toThrow(/effort/);
  });
});

// ─── resolveKeyRef (D4) ──────────────────────────────────────────────

describe("resolveKeyRef (D4 key source)", () => {
  const baseArgs = (flags: Record<string, string | number | boolean>): HandlerArgs => ({
    positional: [],
    flags,
    jsonMode: false,
  });
  const env = { stdout: () => {}, stderr: () => {} };

  it("maps --env to an env SecretRef", async () => {
    const ref = await resolveKeyRef({ slug: "default", profileId: "p", args: baseArgs({ env: "MY_KEY" }), env });
    expect(ref).toEqual({ type: "env", name: "MY_KEY" });
  });

  it("maps --file to a file SecretRef", async () => {
    const ref = await resolveKeyRef({ slug: "default", profileId: "p", args: baseArgs({ file: "/tmp/k.txt" }), env });
    expect(ref).toEqual({ type: "file", path: "/tmp/k.txt" });
  });

  it("stores --key-stdin value 0600 and returns a managed file ref", async () => {
    const ref = await resolveKeyRef({
      slug: "default",
      profileId: "deepseek",
      args: baseArgs({ "key-stdin": true }),
      env,
      stdinValue: "sk-secret-xyz\n",
    });
    expect(ref.type).toBe("file");
    const p = (ref as { path: string }).path;
    expect(p).toContain(path.join("agents", "default", "keys", "deepseek.key"));
    expect(fs.readFileSync(p, "utf8").trim()).toBe("sk-secret-xyz");
    expect((fs.statSync(p).mode & 0o777).toString(8)).toBe("600");
  });

  it("rejects zero sources and multiple sources", async () => {
    await expect(resolveKeyRef({ slug: "default", profileId: "p", args: baseArgs({}), env })).rejects.toThrow(/key source/);
    await expect(
      resolveKeyRef({ slug: "default", profileId: "p", args: baseArgs({ env: "A", file: "/b" }), env }),
    ).rejects.toThrow(/key source/);
  });

  it("rejects an empty --key-stdin", async () => {
    await expect(
      resolveKeyRef({ slug: "default", profileId: "p", args: baseArgs({ "key-stdin": true }), env, stdinValue: "\n" }),
    ).rejects.toThrow(/stdin/);
  });
});

// ─── end-to-end via run() ────────────────────────────────────────────

describe("config add (end-to-end)", () => {
  it("adds a compat profile and writes a schema-valid config", async () => {
    const r = await runCapture([
      "config", "add", "deepseek",
      "--protocol", "compat",
      "--base-url", "https://api.deepseek.com/v1",
      "--model", "deepseek-chat",
      "--env", "DEEPSEEK_API_KEY",
      "--no-test",
    ]);
    expect(r.code).toBe(0);
    const cfg = readConfig();
    expect(cfg.profiles.deepseek.protocol).toBe("openai_chat_compat");
    expect(cfg.profiles.deepseek.baseURL).toBe("https://api.deepseek.com/v1");
    expect(cfg.profiles.deepseek.apiKeyRef).toEqual({ type: "env", name: "DEEPSEEK_API_KEY" });
    expect(cfg.activeProfile).toBe("deepseek");
  });

  it("refuses to overwrite an existing profile (D6)", async () => {
    const add = ["config", "add", "deepseek", "--protocol", "compat", "--base-url", "https://api.deepseek.com/v1", "--model", "deepseek-chat", "--env", "K", "--no-test"];
    await runCapture(add);
    const r = await runCapture(add);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/already exists/);
    expect(r.stderr).toMatch(/config update deepseek/);
  });

  it("compat without base-url/model lists the four required flags (D3)", async () => {
    const r = await runCapture(["config", "add", "x", "--protocol", "compat", "--env", "K", "--no-test"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--base-url and --model/);
    expect(r.stderr).toMatch(/Example:/);
  });

  it("official provider defaults base-url + model (claude)", async () => {
    const r = await runCapture(["config", "add", "claude", "--protocol", "claude", "--env", "ANTHROPIC_API_KEY", "--no-test"]);
    expect(r.code).toBe(0);
    const cfg = readConfig();
    expect(cfg.profiles.claude.protocol).toBe("anthropic_messages");
    expect(cfg.profiles.claude.baseURL).toBeUndefined(); // omitted → protocol default
    expect(typeof cfg.profiles.claude.model).toBe("string");
    expect(cfg.profiles.claude.model.length).toBeGreaterThan(0);
  });

  it("bad --protocol errors with a did-you-mean", async () => {
    const r = await runCapture(["config", "add", "x", "--protocol", "claud", "--env", "K", "--no-test"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unknown --protocol/);
    expect(r.stderr).toMatch(/Did you mean --protocol claude/);
  });

  it("second add does not steal active when the first profile's key resolves (D8)", async () => {
    // Write a real, private (0600) key file so the first profile resolves.
    // R13 F-07: a group/other-readable secret file is now refused, so the file
    // must be chmod 600 for its key to resolve (matches storeSecretFile).
    const keyFile = path.join(tmpDir, "k1.txt");
    fs.writeFileSync(keyFile, "sk-first\n", { mode: 0o600 });
    fs.chmodSync(keyFile, 0o600);
    await runCapture(["config", "add", "first", "--protocol", "claude", "--file", keyFile, "--no-test"]);
    await runCapture(["config", "add", "second", "--protocol", "claude", "--file", keyFile, "--no-test"]);
    const cfg = readConfig();
    expect(cfg.activeProfile).toBe("first"); // second did not steal
    // …unless --use is passed
    await runCapture(["config", "add", "third", "--protocol", "claude", "--file", keyFile, "--no-test", "--use"]);
    expect(readConfig().activeProfile).toBe("third");
  });

  it("--json --no-test emits status:saved with test:null", async () => {
    const r = await runCapture(["config", "add", "deepseek", "--protocol", "compat", "--base-url", "https://api.deepseek.com/v1", "--model", "deepseek-chat", "--env", "K", "--no-test", "--json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out).toMatchObject({ status: "saved", action: "add", profile: "deepseek", test: null });
  });

  it("rejects an invalid profile id", async () => {
    const r = await runCapture(["config", "add", "bad id!", "--protocol", "claude", "--env", "K", "--no-test"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/invalid profile id/);
  });
});
