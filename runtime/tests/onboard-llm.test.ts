import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { ONBOARD_PROVIDERS, onboardDirectLLM, type OnboardIO } from "../src/cli/commands/onboard-llm.js";
import { DEFAULT_CONFIG, validateConfig } from "../src/profile/config-schema.js";
import { protocolDefaultBaseURL } from "../src/llm/resolve-profile.js";
import type { HandlerEnv } from "../src/cli/shared.js";

// Drives onboardDirectLLM with scripted answers so the decision flow is
// exercised without a TTY or network.
interface Script {
  lines?: string[];
  hidden?: string[];
  yesno?: boolean[];
  models?: string[] | null;
  probe?: boolean[]; // consumed per probe() call
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

describe("onboardDirectLLM", () => {
  beforeEach(() => {
    prevHome = process.env.AIFIGHT_HOME;
    home = path.join(os.tmpdir(), `aifight-onboard-${randomBytes(4).toString("hex")}`);
    process.env.AIFIGHT_HOME = home;
    fs.mkdirSync(agentDir(), { recursive: true });
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.AIFIGHT_HOME;
    else process.env.AIFIGHT_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("uses an existing, resolvable config without prompting (env key path)", async () => {
    process.env.ONBOARD_TEST_KEY = "sk-test-existing";
    try {
      fs.writeFileSync(
        path.join(agentDir(), "config.json"),
        JSON.stringify({
          schemaVersion: 1,
          activeProfile: "claude",
          profiles: {
            claude: {
              displayName: "Claude",
              protocol: "anthropic_messages",
              apiKeyRef: { type: "env", name: "ONBOARD_TEST_KEY" },
              model: "claude-sonnet-4-6",
            },
          },
          routing: { default: "claude" },
        }),
      );
      const { io } = makeIO({ probe: [true] });
      const { env, out } = captureEnv();
      const result = await onboardDirectLLM({ slug: SLUG, env, io });
      expect(result).toBe("configured");
      expect(out()).toContain("Found a saved LLM config");
      expect(out()).not.toContain("Which LLM");
    } finally {
      delete process.env.ONBOARD_TEST_KEY;
    }
  });

  it("guides a fresh setup: pick Claude, official base URL, paste key, default model, test passes", async () => {
    const { io, stored } = makeIO({
      lines: ["1", "", ""], // provider 1, base URL Enter (official), model Enter (default)
      hidden: ["sk-ant-xyz"],
      models: null,
      probe: [true],
    });
    const { env, out } = captureEnv();
    const result = await onboardDirectLLM({ slug: SLUG, env, io });
    expect(result).toBe("configured");

    const cfg = readConfig();
    const active = cfg.profiles[cfg.activeProfile];
    expect(active.protocol).toBe("anthropic_messages");
    // The wizard's Enter-accepts default for Claude. Kept in step with the desktop
    // presets and model-capabilities.json; a legacy model here starts new users a
    // generation behind.
    expect(active.model).toBe("claude-sonnet-5");
    expect(active.apiKeyRef.type).toBe("file");
    expect(cfg.routing.default).toBe(cfg.activeProfile);
    // Interop: the desktop app validates config.json on read with the SAME
    // schema, so a CLI-written config must pass validateConfig (and vice versa).
    expect(validateConfig(cfg).ok).toBe(true);
    // ...and the key lives in the shared `keys/` dir the desktop also uses.
    // path.sep, not a literal "/": the path comes from path.join, so on Windows
    // it is separated by backslashes.
    expect(Object.keys(stored)[0]).toContain(`${path.sep}keys${path.sep}`);
    // key stored to a 0600 file, never echoed
    expect(Object.values(stored)).toContain("sk-ant-xyz");
    expect(out()).not.toContain("sk-ant-xyz");
    expect(out()).toContain("✓ model responded");
  });

  it("requires a base URL for the OpenAI-compatible provider and saves it", async () => {
    const { io } = makeIO({
      lines: ["3", "https://api.deepseek.com/v1", "deepseek-chat"],
      hidden: ["sk-deepseek"],
      models: null,
      probe: [true],
    });
    const { env } = captureEnv();
    const result = await onboardDirectLLM({ slug: SLUG, env, io });
    expect(result).toBe("configured");
    const cfg = readConfig();
    const active = cfg.profiles[cfg.activeProfile];
    expect(active.protocol).toBe("openai_chat_compat");
    expect(active.baseURL).toBe("https://api.deepseek.com/v1");
    expect(validateConfig(cfg).ok).toBe(true); // desktop-readable

  });

  it("rejects a plaintext-http base URL with a reason and re-prompts, before the key is typed", async () => {
    const { io } = makeIO({
      lines: ["3", "http://api.deepseek.com/v1", "https://api.deepseek.com/v1", "deepseek-chat"],
      hidden: ["sk-deepseek"],
      models: null,
      probe: [true],
    });
    const { env, out } = captureEnv();
    const result = await onboardDirectLLM({ slug: SLUG, env, io });
    expect(result).toBe("configured");
    expect(out()).toContain("unencrypted");
    const cfg = readConfig();
    expect(cfg.profiles[cfg.activeProfile].baseURL).toBe("https://api.deepseek.com/v1");
  });

  it("re-prompts on an unsafe custom base URL for an official-URL provider", async () => {
    const { io } = makeIO({
      lines: ["1", "http://claude-proxy.example.com", "https://claude-proxy.example.com", ""],
      hidden: ["sk-ant-abc"],
      models: null,
      probe: [true],
    });
    const { env, out } = captureEnv();
    const result = await onboardDirectLLM({ slug: SLUG, env, io });
    expect(result).toBe("configured");
    expect(out()).toContain("unencrypted");
    const cfg = readConfig();
    expect(cfg.profiles[cfg.activeProfile].baseURL).toBe("https://claude-proxy.example.com");
  });

  it("offers discovered models and records the picked one", async () => {
    const { io } = makeIO({
      lines: ["2", "", "2"], // provider 2 (GPT), base URL Enter, pick model #2
      hidden: ["sk-openai"],
      models: ["gpt-4o", "gpt-4.1", "o3"],
      probe: [true],
    });
    const { env } = captureEnv();
    const result = await onboardDirectLLM({ slug: SLUG, env, io });
    expect(result).toBe("configured");
    const cfg = readConfig();
    expect(cfg.profiles[cfg.activeProfile].model).toBe("gpt-4.1");
  });

  it("retries after a failed probe, then succeeds", async () => {
    const { io } = makeIO({
      // per attempt: provider, baseURL, model, effort, SUMMARY (Enter = save).
      // Thinking (on), advanced (no) and re-enter (yes) all take their defaults
      // from an empty yesno script.
      lines: ["1", "", "", "", "", "1", "", "", "", ""],
      hidden: ["bad-key", "good-key"],
      models: null,
      probe: [false, true],
    });
    const { env, out } = captureEnv();
    const result = await onboardDirectLLM({ slug: SLUG, env, io });
    expect(result).toBe("configured");
    expect(out()).toContain("did not respond");
  });

  it("gives up gracefully when the user declines to retry (config still saved)", async () => {
    const { io } = makeIO({
      lines: ["1", "", "", ""], // provider, baseURL, model, effort
      hidden: ["bad-key"],
      yesno: [true, false, false], // thinking on, no advanced, decline re-enter
      models: null,
      probe: [false],
    });
    const { env, out } = captureEnv();
    const result = await onboardDirectLLM({ slug: SLUG, env, io });
    expect(result).toBe("failed");
    expect(out()).toContain("aifight config test");
    // config was still written so the user can fix it later
    expect(readConfig().profiles[readConfig().activeProfile].protocol).toBe("anthropic_messages");
  });

  it("defaults thinking ON with effort, 32000 max tokens, auto streaming, omitted temperature", async () => {
    const { io } = makeIO({
      lines: ["1", "", "", ""], // provider, baseURL, model, effort (Enter = high)
      hidden: ["sk-ant-xyz"],
      models: null,
      probe: [true],
    });
    const { env } = captureEnv();
    const result = await onboardDirectLLM({ slug: SLUG, env, io });
    expect(result).toBe("configured");
    const active = readConfig().profiles[readConfig().activeProfile];
    expect(active.thinking).toEqual({ enabled: true, mode: "always", effort: "high" });
    expect(active.request.maxTokens).toBe(32000);
    expect(active.request.stream).toBe("auto");
    expect(active.request.temperature).toBeNull(); // never defaulted
  });

  it("offers to raise max tokens when the user explicitly picks max effort (D4)", async () => {
    const { io } = makeIO({
      lines: ["1", "", "", "max"], // provider, baseURL, model(default sonnet), effort = max (explicit)
      hidden: ["sk-ant-xyz"],
      yesno: [true, true, false], // thinking on, raise-to-ceiling YES, advanced no
      models: null,
      probe: [true],
    });
    const { env } = captureEnv();
    const result = await onboardDirectLLM({ slug: SLUG, env, io });
    expect(result).toBe("configured");
    const active = readConfig().profiles[readConfig().activeProfile];
    expect(active.thinking.effort).toBe("max");
    expect(active.request.maxTokens).toBe(128000); // raised to claude-sonnet-4-6 ceiling
  });

  it("does NOT nag about max tokens when the effort is left at default", async () => {
    const { io } = makeIO({
      lines: ["1", "", "", ""], // effort = Enter (default) → no raise prompt
      hidden: ["sk-ant-xyz"],
      yesno: [true, false], // thinking on, advanced no (only two yes/no — no raise prompt)
      models: null,
      probe: [true],
    });
    const { env } = captureEnv();
    await onboardDirectLLM({ slug: SLUG, env, io });
    expect(readConfig().profiles[readConfig().activeProfile].request.maxTokens).toBe(32000);
  });

  it("offers the thinking toggle on OpenAI-compatible, defaulting OFF", async () => {
    const { io } = makeIO({
      // provider 3 (compat): baseURL required, model; the thinking toggle now
      // appears (pass-through since 2026-07-26) — Enter accepts the OFF default,
      // so no effort prompt follows.
      lines: ["3", "https://api.deepseek.com/v1", "deepseek-chat"],
      hidden: ["sk-d"],
      models: null,
      probe: [true],
    });
    const { env } = captureEnv();
    const result = await onboardDirectLLM({ slug: SLUG, env, io });
    expect(result).toBe("configured");
    expect(readConfig().profiles[readConfig().activeProfile].thinking.enabled).toBe(false);
  });

  it("advanced: turning thinking off lets you set a low temperature for rigour", async () => {
    const { io } = makeIO({
      // provider, baseURL, model, then advanced: maxTokens(Enter), stream(Enter), temperature
      lines: ["1", "", "", "", "", "0.2"],
      hidden: ["sk-ant-xyz"],
      yesno: [false, true], // thinking OFF, advanced YES
      models: null,
      probe: [true],
    });
    const { env } = captureEnv();
    const result = await onboardDirectLLM({ slug: SLUG, env, io });
    expect(result).toBe("configured");
    const active = readConfig().profiles[readConfig().activeProfile];
    expect(active.thinking.enabled).toBe(false);
    expect(active.request.temperature).toBe(0.2);
  });

  function seedCompatProfile(): void {
    fs.writeFileSync(
      path.join(agentDir(), "config.json"),
      JSON.stringify({
        schemaVersion: 1,
        activeProfile: "compat",
        profiles: {
          compat: {
            displayName: "OpenAI-compatible provider",
            protocol: "openai_chat_compat",
            baseURL: "https://api.deepseek.com/v1",
            apiKeyRef: { type: "file", path: path.join(agentDir(), "keys", "compat.key") },
            model: "deepseek-chat",
          },
        },
        routing: { default: "compat" },
      }),
    );
  }

  it("asks before overwriting an existing provider and keeps it on No", async () => {
    // Every OpenAI-compatible provider shares the fixed id "compat", so adding a
    // second one (e.g. GLM after DeepSeek) would silently clobber the first.
    seedCompatProfile();
    const { io } = makeIO({
      lines: ["3"], // re-pick provider 3 (compat) → clashes with the existing "compat"
      yesno: [false], // decline the overwrite
    });
    const { env, out } = captureEnv();
    const result = await onboardDirectLLM({ slug: SLUG, env, io, reconfigure: true });
    expect(result).toBe("failed");
    expect(out()).toContain("Kept your existing");
    // The existing profile is untouched (still DeepSeek), nothing added.
    const cfg = readConfig();
    expect(cfg.profiles.compat.model).toBe("deepseek-chat");
    expect(Object.keys(cfg.profiles)).toEqual(["compat"]);
  });

  it("overwrites an existing provider after the user confirms", async () => {
    seedCompatProfile();
    const { io } = makeIO({
      lines: ["3", "https://open.bigmodel.cn/api/paas/v4", "glm-4.6"], // provider, base URL, model
      hidden: ["sk-glm"],
      yesno: [true], // confirm the overwrite (advanced gate then defaults to No)
      models: null,
      probe: [true],
    });
    const { env } = captureEnv();
    const result = await onboardDirectLLM({ slug: SLUG, env, io, reconfigure: true });
    expect(result).toBe("configured");
    const cfg = readConfig();
    expect(cfg.profiles.compat.model).toBe("glm-4.6"); // overwritten in place
    expect(cfg.profiles.compat.baseURL).toBe("https://open.bigmodel.cn/api/paas/v4");
  });

  it("prunes leftover unresolvable placeholder profiles after a successful setup", async () => {
    const prevAnthropic = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY; // make the placeholder's env ref unresolvable
    try {
      // Simulate `config init` having written DEFAULT_CONFIG's placeholder.
      fs.writeFileSync(
        path.join(agentDir(), "config.json"),
        JSON.stringify({
          schemaVersion: 1,
          activeProfile: "claude-default",
          profiles: {
            "claude-default": {
              displayName: "Claude Sonnet (default)",
              protocol: "anthropic_messages",
              apiKeyRef: { type: "env", name: "ANTHROPIC_API_KEY" },
              model: "claude-sonnet-4-6",
            },
          },
          routing: { default: "claude-default" },
        }),
      );
      const { io } = makeIO({
        lines: ["1", "", ""],
        hidden: ["sk-ant-new"],
        models: null,
        probe: [true],
      });
      const { env } = captureEnv();
      const result = await onboardDirectLLM({ slug: SLUG, env, io });
      expect(result).toBe("configured");
      const cfg = readConfig();
      expect(Object.keys(cfg.profiles)).toEqual(["claude"]); // dead placeholder removed
      expect(cfg.activeProfile).toBe("claude");
      expect(cfg.routing.default).toBe("claude");
    } finally {
      if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropic;
    }
  });
});

// Anti-drift guards: the wizard's Enter-accepts defaults and the non-wizard
// paths (config init's DEFAULT_CONFIG scaffold, resolve-profile's baseURL
// fallback) must be the SAME facts, not hand-synced copies.
//   - drift-6: the Gemini official URL carried /v1beta while the adapter
//     appends /v1beta itself → doubled request path for wizard users.
//   - drift-12: DEFAULT_CONFIG shipped claude-sonnet-4-6 while the wizard
//     shipped claude-sonnet-5 → config-init users parked a generation behind.
describe("ONBOARD_PROVIDERS defaults stay aligned with the non-wizard paths", () => {
  it("every provider's official base URL equals the resolve-profile default", () => {
    for (const provider of ONBOARD_PROVIDERS) {
      if (provider.officialBaseURL === undefined) continue; // compat: user-supplied
      expect(provider.officialBaseURL, provider.id).toBe(protocolDefaultBaseURL(provider.protocol));
    }
  });

  it("the wizard's Claude default model equals DEFAULT_CONFIG's starter model", () => {
    const claude = ONBOARD_PROVIDERS.find((p) => p.id === "claude");
    expect(claude?.defaultModel).toBe(DEFAULT_CONFIG.profiles["claude-default"]!.model);
  });
});

// ── The 2026-07-26 phase machine: back-navigation + the summary hub ──

describe("onboard wizard navigation", () => {
  beforeEach(() => {
    prevHome = process.env.AIFIGHT_HOME;
    home = path.join(os.tmpdir(), `aifight-onboard-${randomBytes(4).toString("hex")}`);
    process.env.AIFIGHT_HOME = home;
    fs.mkdirSync(agentDir(), { recursive: true });
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.AIFIGHT_HOME;
    else process.env.AIFIGHT_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("b at the model prompt returns to the key step (fresh key wins)", async () => {
    const { io, stored } = makeIO({
      // provider, baseURL, model="b" (→ back to key), model again, effort, summary
      lines: ["1", "", "b", "", "", ""],
      hidden: ["first-key", "second-key"],
      models: null,
      probe: [true],
    });
    const { env } = captureEnv();
    expect(await onboardDirectLLM({ slug: SLUG, env, io })).toBe("configured");
    // The re-entered key overwrote the first one on disk.
    const paths = Object.keys(stored);
    expect(paths).toHaveLength(1);
    expect(stored[paths[0]!]).toBe("second-key");
  });

  it("summary '2' jumps to the model step, then returns to the summary", async () => {
    const { io } = makeIO({
      // provider, baseURL, model(default), effort, summary=2 → model edit → summary save
      lines: ["1", "", "", "", "2", "claude-opus-4-8", ""],
      hidden: ["sk-x"],
      models: null,
      probe: [true],
    });
    const { env, out } = captureEnv();
    expect(await onboardDirectLLM({ slug: SLUG, env, io })).toBe("configured");
    const cfg = readConfig();
    expect(cfg.profiles[cfg.activeProfile].model).toBe("claude-opus-4-8");
    // The jump went model → summary directly, not back through settings: the
    // effort menu printed exactly once. (Prompt QUESTIONS don't reach stdout in
    // this harness — the menu header does.)
    expect(out().split("Reasoning effort:").length - 1).toBe(1);
  });

  it("q at the summary cancels without writing a profile", async () => {
    const { io } = makeIO({
      lines: ["1", "", "", "", "q"],
      hidden: ["sk-x"],
      models: null,
      probe: [],
    });
    const { env, out } = captureEnv();
    expect(await onboardDirectLLM({ slug: SLUG, env, io })).toBe("failed");
    expect(out()).toContain("Cancelled");
  });

  it("Enter on the effort prompt stores an explicit high (owner default)", async () => {
    const { io } = makeIO({
      lines: ["1", "", "", "", ""],
      hidden: ["sk-x"],
      models: null,
      probe: [true],
    });
    const { env } = captureEnv();
    expect(await onboardDirectLLM({ slug: SLUG, env, io })).toBe("configured");
    const cfg = readConfig();
    expect(cfg.profiles[cfg.activeProfile].thinking.effort).toBe("high");
  });

  it("the auto tier is accepted and stored as auto", async () => {
    const { io } = makeIO({
      lines: ["1", "", "", "auto", ""],
      hidden: ["sk-x"],
      models: null,
      probe: [true],
    });
    const { env } = captureEnv();
    expect(await onboardDirectLLM({ slug: SLUG, env, io })).toBe("configured");
    const cfg = readConfig();
    expect(cfg.profiles[cfg.activeProfile].thinking.effort).toBe("auto");
  });
});
