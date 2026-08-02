// First-run gate (owner ask 2026-08-01): the website's install hint is now
// just `aifight`, so bare `aifight` on an unconfigured machine must walk the
// user into the setup wizard instead of opening a hollow panel. These tests
// pin the gate's wiring in main.ts's openMainPanel: wizard invoked exactly
// once, wizard's exit code respected, and NO panel when the wizard ends
// without creating an identity (quit path). The configured→panel path is
// covered by the existing menu suites via injected deps.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setupSpy = vi.hoisted(() => ({
  calls: 0,
  exitCode: 0,
  onRun: undefined as undefined | (() => void),
}));

vi.mock("../src/cli/commands/setup", () => ({
  runSetup: vi.fn(async () => {
    setupSpy.calls += 1;
    setupSpy.onRun?.();
    return setupSpy.exitCode;
  }),
}));

import { run } from "../src/cli/main";

let prevHome: string | undefined;
let tmpDir: string | null = null;

function useTempHome(): string {
  prevHome = process.env.AIFIGHT_RUNTIME_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-first-run-"));
  process.env.AIFIGHT_RUNTIME_HOME = tmpDir;
  return tmpDir;
}

// Both panel doors are gated on stdin+stdout TTY. Fake BOTH, and restore via
// the saved property descriptor when one exists — isTTY normally has NO own
// descriptor, so the restore must `delete` in that case or the fake leaks
// into later test files (cli-beauty-v4 lesson, 2026-07-31).
const prevDescriptors: Array<[NodeJS.WriteStream | NodeJS.ReadStream, PropertyDescriptor | undefined]> = [];
function fakeTTY(): void {
  for (const stream of [process.stdin, process.stdout] as const) {
    prevDescriptors.push([stream, Object.getOwnPropertyDescriptor(stream, "isTTY")]);
    Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
  }
}

beforeEach(() => {
  setupSpy.calls = 0;
  setupSpy.exitCode = 0;
  setupSpy.onRun = undefined;
});

afterEach(() => {
  while (prevDescriptors.length > 0) {
    const [stream, desc] = prevDescriptors.pop()!;
    if (desc === undefined) delete (stream as unknown as Record<string, unknown>).isTTY;
    else Object.defineProperty(stream, "isTTY", desc);
  }
  if (prevHome === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
  else process.env.AIFIGHT_RUNTIME_HOME = prevHome;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  prevHome = undefined;
  tmpDir = null;
});

describe("bare `aifight` first-run gate", () => {
  it("unconfigured + TTY: invokes the setup wizard once with a guiding banner; quit path opens no panel", async () => {
    useTempHome();
    fakeTTY();
    let out = "";
    const code = await run([], { stdout: (s) => (out += s), stderr: (s) => (out += s) });

    expect(setupSpy.calls, "the wizard must be invoked exactly once").toBe(1);
    // Wizard returned 0 but created no identity (user chose quit) — the gate
    // must exit cleanly without opening a hollow panel.
    expect(code).toBe(0);
    expect(out).toContain("Welcome to AIFight");
    // U7: the banner body is dictionary text now, not a hand-rolled ternary.
    expect(out).toContain("This machine isn't set up yet");
    expect(out).toContain("in the main menu right after.");
    expect(out, "no panel after a quit-without-identity wizard run").not.toContain("Setup complete");
  });

  it("propagates a failing wizard exit code and stops there", async () => {
    useTempHome();
    fakeTTY();
    setupSpy.exitCode = 7;
    let out = "";
    const code = await run([], { stdout: (s) => (out += s), stderr: (s) => (out += s) });

    expect(setupSpy.calls).toBe(1);
    expect(code).toBe(7);
    expect(out).not.toContain("Setup complete");
  });

  it("non-TTY bare `aifight` keeps the scriptable help — the wizard must NOT auto-run headless", async () => {
    useTempHome();
    // No fakeTTY(): vitest streams are not TTYs.
    let out = "";
    const code = await run([], { stdout: (s) => (out += s), stderr: (s) => (out += s) });

    expect(setupSpy.calls, "headless bare run must never enter the wizard").toBe(0);
    expect(code).toBe(0);
    expect(out.length).toBeGreaterThan(0);
  });

  it("zh locale renders the banner in Chinese", async () => {
    useTempHome();
    fakeTTY();
    const prevLang = process.env.AIFIGHT_LANG;
    process.env.AIFIGHT_LANG = "zh";
    try {
      let out = "";
      await run([], { stdout: (s) => (out += s), stderr: (s) => (out += s) });
      expect(setupSpy.calls).toBe(1);
      expect(out).toContain("首次使用 AIFight");
      expect(out).toContain("这台机器还没完成初始配置");
      expect(out).toContain("配置完成后直接进入主菜单。");
      expect(out, "no English half of the banner survives in zh").not.toContain("This machine isn't set up yet");
    } finally {
      if (prevLang === undefined) delete process.env.AIFIGHT_LANG;
      else process.env.AIFIGHT_LANG = prevLang;
    }
  });
});
