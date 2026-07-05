// Batch B — `aifight config models` (D11).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { run } from "../src/cli/main";

let prevHome: string | undefined;
let tmpDir: string;

beforeEach(() => {
  prevHome = process.env.AIFIGHT_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-config-models-"));
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

async function addProfile(argv: readonly string[]) {
  await runCapture(argv);
}

describe("config models (D11)", () => {
  it("errors clearly when there is no config yet", async () => {
    const r = await runCapture(["config", "models"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no LLM config/);
  });

  it("gives a helpful message for Gemini (no list endpoint)", async () => {
    await addProfile(["config", "add", "gem", "--protocol", "gemini", "--env", "GEMINI_API_KEY", "--no-test"]);
    const r = await runCapture(["config", "models", "gem"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/not available for gemini_generate_content/);
    expect(r.stdout).toMatch(/config update gem --model/);
  });

  it("Gemini --json reports supported:false", async () => {
    await addProfile(["config", "add", "gem", "--protocol", "gemini", "--env", "GEMINI_API_KEY", "--no-test"]);
    const r = await runCapture(["config", "models", "gem", "--json"]);
    const out = JSON.parse(r.stdout.trim());
    expect(out).toMatchObject({ profile: "gem", supported: false, models: null });
  });

  it("errors on an unknown profile with the available list", async () => {
    await addProfile(["config", "add", "claude", "--protocol", "claude", "--env", "K", "--no-test"]);
    const r = await runCapture(["config", "models", "nope"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unknown profile "nope"/);
    expect(r.stderr).toMatch(/Available profiles: claude/);
  });

  it("surfaces a key-resolution failure without crashing", async () => {
    await addProfile(["config", "add", "ds", "--protocol", "compat", "--base-url", "https://api.deepseek.com/v1", "--model", "deepseek-chat", "--env", "DEFINITELY_UNSET_KEY_VAR", "--no-test"]);
    const r = await runCapture(["config", "models", "ds"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/cannot resolve the API key/);
  });
});
