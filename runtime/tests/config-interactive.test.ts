// Batch 1 — the interactive `aifight config` LLM manager (⑦). Drives
// manageLLMProfiles / configureLLMInteractive with a SCRIPTED OnboardIO (no TTY,
// no network) and a temp AIFIGHT_HOME, mirroring onboard-llm.test.ts. Every menu
// action delegates to the headless handlers, so these tests assert that the menu
// wires the choice + changed fields through correctly — not the handlers' own
// logic (covered by config-manage / onboard-llm tests).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import {
  manageLLMProfiles,
  configureLLMInteractive,
} from "../src/cli/commands/config.js";
import type { OnboardIO } from "../src/cli/commands/onboard-llm.js";
import type { HandlerEnv } from "../src/cli/shared.js";

interface Script {
  lines?: string[];
  hidden?: string[];
  yesno?: boolean[];
  models?: string[] | null;
  probe?: boolean[];
}

function makeIO(script: Script): { io: OnboardIO; stored: Record<string, string> } {
  const lines = [...(script.lines ?? [])];
  const hidden = [...(script.hidden ?? [])];
  const yesno = [...(script.yesno ?? [])];
  const probe = [...(script.probe ?? [])];
  const stored: Record<string, string> = {};
  const io: OnboardIO = {
    promptLine: async () => lines.shift() ?? "",
    promptHidden: async () => hidden.shift() ?? "",
    promptYesNo: async (_q, d) => (yesno.length ? (yesno.shift() as boolean) : d),
    discoverModels: async () => script.models ?? null,
    storeKey: async (filePath, value) => {
      stored[filePath] = value;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, value, { mode: 0o600 });
    },
    probe: async () => (probe.length ? (probe.shift() as boolean) : false),
  };
  return { io, stored };
}

function captureEnv(): { env: HandlerEnv; out: () => string } {
  let buf = "";
  return {
    env: { stdout: (s: string) => (buf += s), stderr: () => {} },
    out: () => buf,
  };
}

let home: string;
let prevHome: string | undefined;
const SLUG = "default";

function agentDir(): string {
  return path.join(home, "agents", SLUG);
}
function readConfig(): any {
  return JSON.parse(fs.readFileSync(path.join(agentDir(), "config.json"), "utf8"));
}

/** Write a valid config.json holding `ids`, each with a resolvable 0600 file key.
 *  The first id is the active profile. */
function scaffold(ids: string[]): void {
  fs.mkdirSync(path.join(agentDir(), "keys"), { recursive: true });
  const profiles: Record<string, unknown> = {};
  for (const id of ids) {
    const keyPath = path.join(agentDir(), "keys", `${id}.key`);
    fs.writeFileSync(keyPath, "sk-managed\n", { mode: 0o600 });
    profiles[id] = {
      displayName: id,
      protocol: "anthropic_messages",
      apiKeyRef: { type: "file", path: keyPath },
      model: "claude-sonnet-4-6",
      request: { temperature: null, maxTokens: 32000, responseFormat: "json", stream: "auto" },
      thinking: { enabled: true, mode: "always" },
    };
  }
  const cfg = {
    schemaVersion: 1,
    activeProfile: ids[0],
    profiles,
    routing: { default: ids[0] },
  };
  fs.writeFileSync(path.join(agentDir(), "config.json"), JSON.stringify(cfg, null, 2) + "\n");
}

describe("interactive config — multi-profile manager (⑦)", () => {
  beforeEach(() => {
    prevHome = process.env.AIFIGHT_HOME;
    home = path.join(os.tmpdir(), `aifight-cfg-int-${randomBytes(4).toString("hex")}`);
    process.env.AIFIGHT_HOME = home;
    fs.mkdirSync(agentDir(), { recursive: true });
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.AIFIGHT_HOME;
    else process.env.AIFIGHT_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("lists every profile with the active marker and returns on q", async () => {
    scaffold(["alpha", "beta"]);
    const { io } = makeIO({ lines: ["q"] });
    const { env, out } = captureEnv();
    await manageLLMProfiles(SLUG, io, env);
    const text = out();
    expect(text).toContain("Your LLM configurations:");
    expect(text).toContain("alpha — claude-sonnet-4-6 (anthropic_messages)");
    expect(text).toContain("beta — claude-sonnet-4-6 (anthropic_messages)");
    expect(text).toMatch(/alpha[^\n]*\[active\]/); // first profile flagged active
    expect(text).toContain("1) Switch which one is active");
  });

  it("switches the active profile (option 1) via config use", async () => {
    scaffold(["alpha", "beta"]);
    // Choose 1 (switch) → pick profile 2 (beta) → decline the offered test → q.
    const { io } = makeIO({ lines: ["1", "2", "q"], yesno: [false] });
    const { env } = captureEnv();
    await manageLLMProfiles(SLUG, io, env);
    const cfg = readConfig();
    expect(cfg.activeProfile).toBe("beta");
    expect(cfg.routing.default).toBe("beta"); // config use keeps routing.default in sync
  });

  it("edits a field (stream) while keeping the rest, via one config update call", async () => {
    scaffold(["alpha"]);
    // Choose 2 (edit) → pick 1 → don't list models → keep model/thinking/effort/
    // maxTokens/request-timeout/baseURL (Enter ×6) → stream = never → decline test → q.
    const { io } = makeIO({
      lines: ["2", "1", "", "", "", "", "", "", "never", "q"],
      yesno: [false /* list models? */, false /* test now? */],
    });
    const { env } = captureEnv();
    await manageLLMProfiles(SLUG, io, env);
    const p = readConfig().profiles.alpha;
    expect(p.request.stream).toBe("never"); // changed
    expect(p.model).toBe("claude-sonnet-4-6"); // Enter kept the original
    expect(p.request.maxTokens).toBe(32000); // untouched
  });

  it("makes no write when the edit changes nothing (all Enter)", async () => {
    scaffold(["alpha"]);
    const before = fs.readFileSync(path.join(agentDir(), "config.json"), "utf8");
    // edit alpha, keep every field (model/thinking/effort/maxTokens/request-timeout/
    // baseURL/stream = Enter ×7), no test, then q.
    const { io } = makeIO({
      lines: ["2", "1", "", "", "", "", "", "", "", "q"],
      yesno: [false /* list models? */],
    });
    const { env, out } = captureEnv();
    await manageLLMProfiles(SLUG, io, env);
    expect(out()).toContain("No changes made.");
    expect(fs.readFileSync(path.join(agentDir(), "config.json"), "utf8")).toBe(before);
  });

  it("treats re-typing the current values as no change (no update write)", async () => {
    scaffold(["alpha"]);
    const before = fs.readFileSync(path.join(agentDir(), "config.json"), "utf8");
    // edit alpha → don't list models → re-type each field's CURRENT value verbatim
    // instead of pressing Enter (model, thinking on, effort none, maxTokens,
    // request-timeout 270 = the default shown, baseURL none, stream) → q.
    // Nothing changed, so no write.
    const { io } = makeIO({
      lines: ["2", "1", "claude-sonnet-4-6", "on", "", "32000", "270", "", "auto", "q"],
      yesno: [false /* list models? */],
    });
    const { env, out } = captureEnv();
    await manageLLMProfiles(SLUG, io, env);
    expect(out()).toContain("No changes made.");
    expect(fs.readFileSync(path.join(agentDir(), "config.json"), "utf8")).toBe(before);
  });

  it("refuses to remove the active profile and keeps the loop alive (delete guard)", async () => {
    scaffold(["alpha", "beta"]);
    // Choose 4 (remove) → pick 1 (alpha = active) → guard fires → q.
    const { io } = makeIO({ lines: ["4", "1", "q"] });
    const { env, out } = captureEnv();
    await manageLLMProfiles(SLUG, io, env);
    expect(out()).toMatch(/is the active profile/);
    expect(readConfig().profiles.alpha).toBeDefined(); // still there
  });

  it("removes a non-active profile (option 4)", async () => {
    scaffold(["alpha", "beta"]);
    // Choose 4 → pick 2 (beta, non-active) → removed (non-TTY skips re-type) → q.
    const { io } = makeIO({ lines: ["4", "2", "q"] });
    const { env } = captureEnv();
    await manageLLMProfiles(SLUG, io, env);
    const cfg = readConfig();
    expect(cfg.profiles.beta).toBeUndefined();
    expect(cfg.profiles.alpha).toBeDefined();
  });

  it("cancels a picked action cleanly when the pick is empty", async () => {
    scaffold(["alpha", "beta"]);
    // Choose 1 (switch) → Enter (cancel pick) → q. Nothing changes.
    const { io } = makeIO({ lines: ["1", "", "q"] });
    const { env } = captureEnv();
    await manageLLMProfiles(SLUG, io, env);
    expect(readConfig().activeProfile).toBe("alpha"); // unchanged
  });
});

describe("interactive config — fresh machine falls through to onboarding (A5)", () => {
  let prevAnthropic: string | undefined;
  beforeEach(() => {
    prevHome = process.env.AIFIGHT_HOME;
    home = path.join(os.tmpdir(), `aifight-cfg-fresh-${randomBytes(4).toString("hex")}`);
    process.env.AIFIGHT_HOME = home;
    fs.mkdirSync(agentDir(), { recursive: true });
    prevAnthropic = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY; // the default scaffold's env key must NOT resolve
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.AIFIGHT_HOME;
    else process.env.AIFIGHT_HOME = prevHome;
    if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevAnthropic;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("no resolvable profile → guided onboarding, not the manager", async () => {
    // Fresh onboarding: provider 1 (Claude), official base URL, default model.
    const { io } = makeIO({ lines: ["1", "", ""], hidden: ["sk-ant-xyz"], models: null, probe: [true] });
    const { env, out } = captureEnv();
    await configureLLMInteractive(SLUG, io, env);
    expect(out()).toContain("Which LLM will your agent play with?"); // onboarding, not the manager
    const cfg = readConfig();
    expect(cfg.profiles[cfg.activeProfile].protocol).toBe("anthropic_messages");
  });
});
