// V4 beautification, surfaces 3-4: `aifight strategy path` (home-prefix
// shortening + sections) and `aifight config show` (per-profile sections with
// resolvable/error tones). Drives the real commands through main.run with a
// temp runtime home; ANSI sides forced via the process.stdout.isTTY seam (the
// same precedent as the menu-select width tests).
//
// Isolation: mkdtemp AIFIGHT_RUNTIME_HOME per test; agents/ lives under the
// file-level AIFIGHT_HOME provided by tests/_setup.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { run } from "../src/cli/main";
import { stripAnsi } from "../src/cli/ansi";
import { writeBridgeConfig, type BridgeConfig } from "../src/bridge/config";

let prevHome: string | undefined;
let tmpDir: string | null = null;

beforeEach(() => {
  prevHome = process.env.AIFIGHT_RUNTIME_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-beauty-v4-"));
  process.env.AIFIGHT_RUNTIME_HOME = tmpDir;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
  else process.env.AIFIGHT_RUNTIME_HOME = prevHome;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  prevHome = undefined;
  tmpDir = null;
});

async function runCapture(argv: readonly string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(argv, {
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

/** Force the color gate ON for the duration of fn: isTTY true, NO_COLOR
 *  cleared, TERM set (vitest itself exports NO_COLOR=1 + TERM=dumb, so just
 *  faking the TTY is not enough). Restores everything afterwards. */
async function withColors<T>(fn: () => Promise<T>): Promise<T> {
  const prevTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const prevNoColor = process.env.NO_COLOR;
  const prevTerm = process.env.TERM;
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  delete process.env.NO_COLOR;
  process.env.TERM = "xterm-256color";
  try {
    return await fn();
  } finally {
    // isTTY normally has NO own descriptor (undefined off-TTY); restoring
    // means DELETING the property we defined, not skipping — a leaked
    // isTTY:true turns every later plain-output assertion in this file into
    // ANSI-colored output on machines where the runner exports no NO_COLOR.
    if (prevTTY !== undefined) Object.defineProperty(process.stdout, "isTTY", prevTTY);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    if (prevNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prevNoColor;
    if (prevTerm === undefined) delete process.env.TERM;
    else process.env.TERM = prevTerm;
  }
}

function seedBridge(overrides: Record<string, unknown> = {}): void {
  writeBridgeConfig({
    version: 1,
    baseUrl: "https://aifight.ai",
    wsUrl: "wss://aifight.ai/api/ws",
    agentId: "agent-beauty-1",
    agentName: "Steel Mongoose",
    apiKey: "sk-existing-secret",
    runtimeType: "direct",
    runtimeLocalUrl: "direct://local",
    runtimeModel: "direct",
    directAgentSlug: "default",
    updatedAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  } as BridgeConfig);
}

describe("aifight strategy path (V4 styled)", () => {
  it("sections the output and shortens the runtime-home prefix to ~", async () => {
    seedBridge();
    const r = await runCapture(["strategy", "path"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Strategy files");
    expect(r.stdout).toMatch(/Root\s+~\/agents\/agent-beauty-1\/strategy/);
    expect(r.stdout).toMatch(/Global\s+~\/agents\/agent-beauty-1\/strategy\/global\.md/);
    expect(r.stdout).toMatch(/Games dir\s+~\/agents\/agent-beauty-1\/strategy\/games/);
    expect(r.stdout).toMatch(/coup\s+~\/agents\/agent-beauty-1\/strategy\/games\/coup\.md/);
    // The raw absolute home never leaks into the human output…
    expect(r.stdout).not.toContain(tmpDir!);
    // …but --json keeps the full paths, byte-stable.
    const j = await runCapture(["strategy", "path", "--json"]);
    expect(j.stdout).toContain(tmpDir!);
    // The two trailing notes.
    expect(r.stdout).toContain("Strategy files are Markdown/free-text .md files, not JSON config files.");
    expect(r.stdout).toContain("Missing or empty strategy files are skipped during matches.");
  });

  it("renders the same layout with colors forced on (section bold, paths dim)", async () => {
    seedBridge();
    const r = await withColors(() => runCapture(["strategy", "path"]));
    expect(r.stdout).toContain("\x1b[1mStrategy files\x1b[22m");
    expect(r.stdout).toContain("\x1b[2m~/agents/agent-beauty-1/strategy");
  });

  it("speaks zh for the section and notes", async () => {
    seedBridge({ locale: "zh" });
    const r = await runCapture(["strategy", "path"]);
    expect(r.stdout).toContain("策略文件");
    expect(r.stdout).toMatch(/根目录\s+~\//);
    expect(r.stdout).toContain("策略文件是 Markdown/自由文本 .md 文件，不是 JSON 配置。");
  });
});

describe("aifight config show (V4 styled)", () => {
  const KEY_PRESENT = "V4_CFG_ALPHA";
  const KEY_MISSING = "V4_CFG_BETA";

  function seedLlmConfig(): void {
    process.env[KEY_PRESENT] = "v4-test-value";
    delete process.env[KEY_MISSING];
    const dir = path.join(process.env.AIFIGHT_HOME!, "agents", "default");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        schemaVersion: 1,
        activeProfile: "main",
        profiles: {
          main: {
            displayName: "Claude main",
            protocol: "anthropic_messages",
            apiKeyRef: { type: "env", name: KEY_PRESENT },
            model: "claude-opus-4-6",
          },
          broken: {
            displayName: "GPT backup",
            protocol: "openai_chat_completions",
            baseURL: "https://api.openai.com",
            apiKeyRef: { type: "env", name: KEY_MISSING },
            model: "gpt-5.2",
          },
        },
        routing: { default: "main" },
      }) + "\n",
      { mode: 0o600 },
    );
  }

  it("sections each profile; the key row is green when resolvable, yellow when not", async () => {
    seedBridge();
    seedLlmConfig();
    const plain = await runCapture(["config", "show"]);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain('LLM config · agent "default"');
    expect(plain.stdout).toMatch(/Active profile\s+main/);
    expect(plain.stdout).toContain("(resolvable)");
    expect(plain.stdout).toContain("(NOT resolvable)");
    // The raw key value never prints.
    expect(plain.stdout).not.toContain("v4-test-value");

    const colored = await withColors(() => runCapture(["config", "show"]));
    const ansiText = colored.stdout;
    // resolvable → green, NOT resolvable → yellow; identical layout modulo ANSI.
    expect(ansiText).toContain("\x1b[32m");
    expect(ansiText).toContain("\x1b[33m");
    expect(stripAnsi(ansiText)).toBe(plain.stdout);
  });

  it("keeps --json byte-stable (no kit involved)", async () => {
    seedBridge();
    seedLlmConfig();
    const j = await runCapture(["config", "show", "--json"]);
    const parsed = JSON.parse(j.stdout);
    expect(parsed.activeProfile).toBe("main");
    expect(parsed.profiles).toHaveLength(2);
    expect(j.stdout).not.toContain("\x1b[");
  });
});
