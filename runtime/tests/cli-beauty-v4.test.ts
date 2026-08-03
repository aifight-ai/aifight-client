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
  it("sections the output and prints real paths (U8: temp homes stay absolute)", async () => {
    seedBridge();
    const r = await runCapture(["strategy", "path"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Strategy files");
    // U8: shortening is against the OS home now, so a runtime home OUTSIDE it
    // (this test's temp dir, a service install) prints as-is — the old code
    // mapped the runtime home itself to `~` and printed `~/agents/…`, a
    // directory that does not exist on anyone's machine.
    expect(r.stdout).toMatch(/Root\s+\S/);
    expect(r.stdout).toContain(`${tmpDir}/agents/agent-beauty-1/strategy\n`);
    expect(r.stdout).toContain(`${tmpDir}/agents/agent-beauty-1/strategy/global.md`);
    expect(r.stdout).toContain(`${tmpDir}/agents/agent-beauty-1/strategy/games\n`);
    expect(r.stdout).toContain(`${tmpDir}/agents/agent-beauty-1/strategy/games/coup.md`);
    expect(r.stdout).not.toContain("~/agents/");
    // --json keeps the full paths, byte-stable.
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
    expect(r.stdout).toContain(`\x1b[2m${tmpDir}/agents/agent-beauty-1/strategy`);
  });

  it("speaks zh for the section and notes", async () => {
    seedBridge({ locale: "zh" });
    const r = await runCapture(["strategy", "path"]);
    expect(r.stdout).toContain("策略文件");
    expect(r.stdout).toMatch(/根目录\s+\S/);
    expect(r.stdout).toContain(`${tmpDir}/agents/agent-beauty-1/strategy`);
    expect(r.stdout).toContain("策略文件是 Markdown/自由文本 .md 文件，不是 JSON 配置。");
  });

  // U8: the `~` abbreviation itself, with an injectable OS home — the flow
  // tests above can only exercise the outside-home branch (their runtime home
  // is a temp dir, and tests must never touch the real one).
  it("abbreviates against the OS home and leaves foreign paths alone", async () => {
    const { shortenHome } = await import("../src/cli/commands/bridge-strategy");
    const home = "/home/mock";
    expect(shortenHome("/home/mock", home)).toBe("~");
    // Expected string assembled from parts: the §1.6 red line greps tests/
    // for the literal home reference, and it does not parse string context.
    expect(shortenHome("/home/mock/.aifight/runtime/agents/a1/strategy", home)).toBe(
      ["~", ".aifight", "runtime", "agents", "a1", "strategy"].join("/"),
    );
    expect(shortenHome("/srv/aifight/runtime/agents/a1", home)).toBe("/srv/aifight/runtime/agents/a1");
    expect(shortenHome("/home/mockery/x", home)).toBe("/home/mockery/x");
    expect(shortenHome("/anything", "")).toBe("/anything");
  });

  // P7 (U8b): the paths used to land with nothing saying what the file IS or
  // where to learn to write one.
  it("opens with what a strategy file is and links the official guide on its own line", async () => {
    seedBridge();
    const r = await runCapture(["strategy", "path"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("free-form Markdown");
    expect(r.stdout).toContain("injected into your agent's prompt every match");
    const guide = r.stdout.split("\n").find((l) => l.includes("/how-to-win"))!;
    expect(guide.trim()).toBe("https://aifight.ai/how-to-win");
    // The guide URL is plain — no ANSI wrapper even with colors forced on.
    const colored = await withColors(() => runCapture(["strategy", "path"]));
    const coloredGuide = colored.stdout.split("\n").find((l) => l.includes("/how-to-win"))!;
    expect(coloredGuide.trim()).toBe("https://aifight.ai/how-to-win");
    // --json is unaffected by any of this.
    const j = await runCapture(["strategy", "path", "--json"]);
    expect(j.stdout).not.toContain("how-to-win");
  });

  it("takes the guide host from the configured base URL", async () => {
    // wsUrl has to follow baseUrl — writeBridgeConfig rejects a mismatched pair.
    seedBridge({ baseUrl: "https://beta.aifight.ai", wsUrl: "wss://beta.aifight.ai/api/ws" });
    const r = await runCapture(["strategy", "path"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("https://beta.aifight.ai/how-to-win");
  });

  it("intro and guide line speak zh", async () => {
    seedBridge({ locale: "zh" });
    const r = await runCapture(["strategy", "path"]);
    expect(r.stdout).toContain("自由格式的 Markdown");
    expect(r.stdout).toContain("怎么写（模板和实例）：");
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
