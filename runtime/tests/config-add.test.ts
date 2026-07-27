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

// POSIX permission bits are not meaningful on Windows (access is governed by
// NTFS ACLs), matching the platform split the product itself documents in
// src/profile/secret-ref.ts. Unlike secret-ref-file-perms.test.ts, whose
// perms-only cases it.skipIf(isWin) entirely, here only the mode assertion is
// gated so the managed-path/content checks still run on Windows.
const isWin = process.platform === "win32";

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

  it("caps maxTokens to the model ceiling (claude-sonnet-4-6 = 128000)", () => {
    const s = resolveProfileSettings("anthropic_messages", "claude-sonnet-4-6", { "max-tokens": 999999 }, undefined);
    expect(s.maxTokens).toBe(128000);
    // Claude 5 ceilings, absent from the registry until 2026-07-26.
    expect(resolveProfileSettings("anthropic_messages", "claude-opus-5", { "max-tokens": 999999 }, undefined).maxTokens).toBe(128000);
    // The 4.5 generation really is 64000 — the value Sonnet 4.6 used to inherit.
    expect(resolveProfileSettings("anthropic_messages", "claude-sonnet-4-5", { "max-tokens": 999999 }, undefined).maxTokens).toBe(64000);
  });

  it("rejects max-tokens below the floor", () => {
    expect(() => resolveProfileSettings("anthropic_messages", "claude-sonnet-4-6", { "max-tokens": 10 }, undefined)).toThrow(/max-tokens/);
  });

  it("compat protocol defaults thinking off but no longer forces it", () => {
    // Default OFF: the endpoint's model may not reason at all.
    const s = resolveProfileSettings("openai_chat_compat", "deepseek-chat", {}, undefined);
    expect(s.thinkingEnabled).toBe(false);
    // But an explicit opt-in now sticks — the old code force-disabled it AFTER
    // reading the flag, so a reasoning model behind a proxy could never be
    // configured with an effort at all.
    const on = resolveProfileSettings("openai_chat_compat", "gpt-5.6-sol", { thinking: "on", effort: "high" }, undefined);
    expect(on.thinkingEnabled).toBe(true);
    expect(on.effort).toBe("high");
  });

  it("accepts a listed effort silently and an unlisted-but-storable one with a clamp note", () => {
    const listed = resolveProfileSettings("anthropic_messages", "claude-sonnet-4-6", { effort: "high" }, undefined);
    expect(listed.effort).toBe("high");
    expect(listed.notes).toBeUndefined();
    // claude-sonnet-4-6 doesn't list xhigh — same rule as the app editor and the
    // wizard (redesign §4.4): storable ⇒ accept + note, the adapter clamps at send.
    const unlisted = resolveProfileSettings("anthropic_messages", "claude-sonnet-4-6", { effort: "xhigh" }, undefined);
    expect(unlisted.effort).toBe("xhigh");
    expect(unlisted.notes?.join(" ")).toMatch(/clamped/);
  });

  it("rejects an effort outside the storable set, and never flags auto", () => {
    // "ultra" would fail config.json's schema after the fact — block it up front.
    expect(() => resolveProfileSettings("anthropic_messages", "claude-sonnet-4-6", { effort: "ultra" }, undefined)).toThrow(/can save/);
    // auto = send nothing (provider default): valid everywhere, no clamp note.
    const auto = resolveProfileSettings("anthropic_messages", "claude-sonnet-4-6", { effort: "auto" }, undefined);
    expect(auto.effort).toBe("auto");
    expect(auto.notes).toBeUndefined();
  });

  it("is permissive about effort for an unknown/new model (new models keep arriving)", () => {
    // A future Anthropic model not yet in the capability registry: any effort is
    // accepted as-is; the auto-test — not a stale registry — is the source of truth.
    // NB: this used to say "claude-opus-5-2027" — which stopped being hypothetical.
    const s = resolveProfileSettings("anthropic_messages", "claude-opus-9-2031", { effort: "minimal" }, undefined);
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
    // The managed path and its contents are asserted everywhere; only the 0600
    // mode check is POSIX-only. Node's chmod on Windows can toggle just the
    // read-only bit, so a 0600 write reads back as 0666 there.
    if (!isWin) {
      expect((fs.statSync(p).mode & 0o777).toString(8)).toBe("600");
    }
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
