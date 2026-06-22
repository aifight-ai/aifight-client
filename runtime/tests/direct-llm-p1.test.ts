import { afterEach, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { protocolDefaultBaseURL, resolveLLMProfile } from "../src/llm/resolve-profile";
import { clearAdapters, registerAdapter } from "../src/llm/adapter-registry";
import type { LLMAdapter } from "../src/llm/adapters/types";
import { createDirectLLMRuntimeProvider } from "../src/bridge/direct-llm-provider";
import type { BridgeRuntimeDecisionRequest } from "../src/bridge/provider";
import type { LLMConfig, LLMProfile } from "../src/profile/config-schema";
import { run } from "../src/cli/main";
import { writeBridgeConfig, readBridgeConfig, type BridgeConfig } from "../src/bridge/config";

// ── helpers ──────────────────────────────────────────────────────────

/** A fake adapter that echoes the resolved profile + prompt as JSON text. */
function echoAdapter(protocol: LLMProfile["protocol"]): LLMAdapter {
  return {
    protocol,
    validateProfile: () => ({ ok: true, errors: [], warnings: [] }),
    probe: async (p) => ({ success: true, latencyMs: 1, model: p.model, protocol, jsonValid: true }),
    generateDecision: async (input, p) => ({
      text: JSON.stringify({ model: p.model, baseURL: p.baseURL, system: input.systemPrompt }),
      latencyMs: 1,
    }),
    estimateUsage: (_o, p) => ({ protocol, providerLabel: protocol, model: p.model, latencyMs: 1, timestamp: "" }),
    redact: (raw) => raw,
  };
}

function makeConfig(profiles: Record<string, LLMProfile>, active: string, byGame?: Record<string, string>): LLMConfig {
  return {
    schemaVersion: 1,
    activeProfile: active,
    profiles,
    routing: { default: active, ...(byGame ? { byGame } : {}) },
  };
}

function decisionRequest(game: BridgeRuntimeDecisionRequest["game"]): BridgeRuntimeDecisionRequest {
  return {
    game,
    matchId: "m1",
    legalActions: [{ type: "noop" }] as unknown as BridgeRuntimeDecisionRequest["legalActions"],
    publicState: { your_player_id: "p0" },
    timeoutMs: 0,
  };
}

// ── resolve-profile (T2) ─────────────────────────────────────────────

describe("resolve-profile: protocol default baseURL (P1 baseURL fix)", () => {
  it("returns canonical endpoints for native protocols", () => {
    expect(protocolDefaultBaseURL("anthropic_messages")).toBe("https://api.anthropic.com");
    expect(protocolDefaultBaseURL("openai_chat_completions")).toBe("https://api.openai.com/v1");
    expect(protocolDefaultBaseURL("deepseek_chat_completions")).toBe("https://api.deepseek.com");
  });
  it("returns empty for compat protocols (baseURL must be explicit)", () => {
    expect(protocolDefaultBaseURL("openai_chat_compat")).toBe("");
  });

  it("resolveLLMProfile fills a default baseURL when the config omits it", () => {
    const def: LLMProfile = { protocol: "anthropic_messages", apiKeyRef: { type: "env", name: "X" }, model: "claude-x" };
    const resolved = resolveLLMProfile("p", def, "secret");
    expect(resolved.baseURL).toBe("https://api.anthropic.com");
    expect(resolved.apiKey).toBe("secret");
    expect(resolved.model).toBe("claude-x");
  });

  it("resolveLLMProfile passes through an explicit baseURL", () => {
    const def: LLMProfile = {
      protocol: "openai_chat_compat",
      apiKeyRef: { type: "env", name: "X" },
      model: "gemini-2.0-flash",
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    };
    const resolved = resolveLLMProfile("p", def, "k");
    expect(resolved.baseURL).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
  });
});

// ── direct-llm-provider (T3) ─────────────────────────────────────────

describe("direct-llm-provider", () => {
  afterEach(() => clearAdapters());

  const registerEchos = async () => {
    clearAdapters();
    registerAdapter(echoAdapter("anthropic_messages"));
    registerAdapter(echoAdapter("openai_chat_compat"));
  };

  it("decide() routes to the default profile and returns the adapter text", async () => {
    const config = makeConfig(
      { main: { protocol: "anthropic_messages", apiKeyRef: { type: "env", name: "K" }, model: "claude-main" } },
      "main",
    );
    process.env.K = "sk-test";
    const provider = createDirectLLMRuntimeProvider({
      agentSlug: "x",
      loadConfig: async () => config,
      registerAdapters: registerEchos,
    });
    const out = await provider.decide(decisionRequest("coup"));
    delete process.env.K;
    // §7A: decide() now returns {raw, usage} so the runner can record token
    // counts; the decision pipeline unwraps it.
    const result = out as { raw: string; usage?: { model: string; provider: string } };
    expect(JSON.parse(result.raw).model).toBe("claude-main");
    expect(result.usage?.model).toBe("claude-main");
    expect(result.usage?.provider).toBe("anthropic_messages");
  });

  it("decide() honors per-game routing (byGame wins over default)", async () => {
    const config = makeConfig(
      {
        main: { protocol: "anthropic_messages", apiKeyRef: { type: "env", name: "K" }, model: "claude-main" },
        gem: {
          protocol: "openai_chat_compat",
          apiKeyRef: { type: "env", name: "K" },
          model: "gemini-flash",
          baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
        },
      },
      "main",
      { coup: "gem" },
    );
    process.env.K = "sk-test";
    const provider = createDirectLLMRuntimeProvider({
      agentSlug: "x",
      loadConfig: async () => config,
      registerAdapters: registerEchos,
    });
    const unwrap = (o: unknown) => JSON.parse((o as { raw: string }).raw);
    const coup = unwrap(await provider.decide(decisionRequest("coup")));
    const poker = unwrap(await provider.decide(decisionRequest("texas_holdem")));
    delete process.env.K;
    expect(coup.model).toBe("gemini-flash"); // routed
    expect(poker.model).toBe("claude-main"); // default
  });

  it("healthCheck() probes the active profile", async () => {
    const config = makeConfig(
      { main: { protocol: "anthropic_messages", apiKeyRef: { type: "env", name: "K" }, model: "claude-main" } },
      "main",
    );
    process.env.K = "sk-test";
    const provider = createDirectLLMRuntimeProvider({
      agentSlug: "x",
      loadConfig: async () => config,
      registerAdapters: registerEchos,
    });
    expect(await provider.healthCheck!()).toBe(true);
    delete process.env.K;
  });

  it("healthCheck() returns false when the key cannot be resolved", async () => {
    const config = makeConfig(
      { main: { protocol: "anthropic_messages", apiKeyRef: { type: "env", name: "MISSING_KEY_XYZ" }, model: "m" } },
      "main",
    );
    const provider = createDirectLLMRuntimeProvider({
      agentSlug: "x",
      loadConfig: async () => config,
      registerAdapters: registerEchos,
    });
    expect(await provider.healthCheck!()).toBe(false);
  });
});

// ── config CLI round-trip (T6) + shared config folder ────────────────

describe("aifight config CLI (shared config folder)", () => {
  let home: string;
  let prevHome: string | undefined;
  let prevRuntimeHome: string | undefined;
  let prevKey: string | undefined;
  let out: string;
  const stdout = (s: string) => { out += s; };
  const stderr = (s: string) => { out += s; };

  beforeEach(async () => {
    prevHome = process.env.AIFIGHT_HOME;
    prevRuntimeHome = process.env.AIFIGHT_RUNTIME_HOME;
    prevKey = process.env.ANTHROPIC_API_KEY;
    home = await fs.mkdtemp(path.join(os.tmpdir(), "aifight-cfg-"));
    process.env.AIFIGHT_HOME = home;
    delete process.env.AIFIGHT_RUNTIME_HOME;
    process.env.ANTHROPIC_API_KEY = "sk-secret-value";
    out = "";
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.AIFIGHT_HOME; else process.env.AIFIGHT_HOME = prevHome;
    if (prevRuntimeHome === undefined) delete process.env.AIFIGHT_RUNTIME_HOME; else process.env.AIFIGHT_RUNTIME_HOME = prevRuntimeHome;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
  });

  const readDefaultConfig = async (): Promise<LLMConfig> =>
    JSON.parse(await fs.readFile(path.join(home, "agents", "default", "config.json"), "utf8"));

  it("init writes a neutral scaffold WITH baseURL and never sniffs the env", async () => {
    // ANTHROPIC_API_KEY is set in beforeEach; init must NOT read it or derive a
    // provider profile from it — it only scaffolds the neutral DEFAULT_CONFIG.
    const code = await run(["config", "init"], { stdout, stderr });
    expect(code).toBe(0);
    const config = await readDefaultConfig();
    expect(config.profiles["anthropic"]).toBeUndefined(); // no env-detected profile
    const def = config.profiles["claude-default"];
    expect(def).toBeDefined();
    expect(def!.baseURL).toBe("https://api.anthropic.com"); // not empty (the P1 blocker fix)
  });

  it("show describes the key source but never prints the value", async () => {
    await run(["config", "init"], { stdout, stderr });
    out = "";
    const code = await run(["config", "show"], { stdout, stderr });
    expect(code).toBe(0);
    expect(out).toContain("env:ANTHROPIC_API_KEY");
    expect(out).toContain("(resolvable)");
    expect(out).not.toContain("sk-secret-value"); // raw key never shown
  });

  it("set-key rewrites only the apiKeyRef indirection (no raw key in argv/file)", async () => {
    await run(["config", "init"], { stdout, stderr });
    const code = await run(["config", "set-key", "claude-default", "--env", "MY_OTHER_KEY"], { stdout, stderr });
    expect(code).toBe(0);
    const config = await readDefaultConfig();
    expect(config.profiles["claude-default"]!.apiKeyRef).toEqual({ type: "env", name: "MY_OTHER_KEY" });
  });

  it("route + use persist to the shared config.json", async () => {
    await run(["config", "init"], { stdout, stderr });
    expect(await run(["config", "route", "coup", "claude-default"], { stdout, stderr })).toBe(0);
    expect(await run(["config", "use", "claude-default"], { stdout, stderr })).toBe(0);
    const config = await readDefaultConfig();
    expect(config.routing.byGame?.coup).toBe("claude-default");
    expect(config.activeProfile).toBe("claude-default");
    expect(config.routing.default).toBe("claude-default");
  });

  it("set-key requires exactly one source (usage error otherwise)", async () => {
    await run(["config", "init"], { stdout, stderr });
    const code = await run(["config", "set-key", "claude-default"], { stdout, stderr });
    expect(code).toBe(2); // UsageError -> exit 2
  });
});

// ── bridge config "direct" (T4) ──────────────────────────────────────

describe("bridge config: direct runtime type", () => {
  let home: string;
  let prevHome: string | undefined;
  beforeEach(async () => {
    prevHome = process.env.AIFIGHT_HOME;
    home = await fs.mkdtemp(path.join(os.tmpdir(), "aifight-bc-"));
    process.env.AIFIGHT_HOME = home;
    delete process.env.AIFIGHT_RUNTIME_HOME;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.AIFIGHT_HOME; else process.env.AIFIGHT_HOME = prevHome;
  });

  it("round-trips a direct config with directAgentSlug", () => {
    const config: BridgeConfig = {
      version: 1,
      baseUrl: "https://aifight.ai",
      wsUrl: "wss://aifight.ai/api/ws",
      agentId: "a1",
      agentName: "agent-direct-test",
      apiKey: "key",
      runtimeType: "direct",
      runtimeLocalUrl: "direct://local",
      directAgentSlug: "default",
      updatedAt: new Date().toISOString(),
    };
    writeBridgeConfig(config);
    const read = readBridgeConfig();
    expect(read.runtimeType).toBe("direct");
    expect(read.directAgentSlug).toBe("default");
    expect(read.runtimeLocalUrl).toBe("direct://local");
  });
});

// ── F22/AIF-07: config hot reload ────────────────────────────────────
//
// A model/key change saved by the desktop or CLI must take effect on the
// NEXT decision of the already-running bridge, not after a restart. The
// provider keys its cache on config.json mtime+size.
describe("direct-llm-provider: config.json edits hot-reload (F22)", () => {
  let home: string;
  let prevHome: string | undefined;
  beforeEach(async () => {
    prevHome = process.env.AIFIGHT_HOME;
    home = await fs.mkdtemp(path.join(os.tmpdir(), "aifight-hot-"));
    process.env.AIFIGHT_HOME = home;
    process.env.K = "sk-test";
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.AIFIGHT_HOME; else process.env.AIFIGHT_HOME = prevHome;
    delete process.env.K;
    clearAdapters();
  });

  // Rewrites ONLY config.json (atomic tmp+rename, mirroring the real
  // CLI/desktop write path); the rest of the profile comes from the real
  // `config init` scaffold in the test body.
  const writeAgentConfig = async (model: string) => {
    const dir = path.join(home, "agents", "hot");
    const cfg = makeConfig(
      { main: { protocol: "anthropic_messages", apiKeyRef: { type: "env", name: "K" }, model } },
      "main",
    );
    const tmp = path.join(dir, "config.json.tmp");
    await fs.writeFile(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    await fs.rename(tmp, path.join(dir, "config.json"));
  };

  it("uses the new model on the decision after a config save", async () => {
    const sink = () => {};
    expect(await run(["config", "init", "hot"], { stdout: sink, stderr: sink })).toBe(0);
    await writeAgentConfig("claude-before");
    const provider = createDirectLLMRuntimeProvider({
      agentSlug: "hot",
      registerAdapters: async () => {
        clearAdapters();
        registerAdapter(echoAdapter("anthropic_messages"));
      },
    });
    const unwrap = (o: unknown) => JSON.parse((o as { raw: string }).raw);

    expect(unwrap(await provider.decide(decisionRequest("coup"))).model).toBe("claude-before");
    // Same provider instance, config saved mid-run (longer model name so
    // size differs even on filesystems with coarse mtime granularity).
    await writeAgentConfig("claude-after-the-change");
    expect(unwrap(await provider.decide(decisionRequest("coup"))).model).toBe(
      "claude-after-the-change",
    );
    // Unchanged file keeps being served (from cache or re-read — same value).
    expect(unwrap(await provider.decide(decisionRequest("coup"))).model).toBe(
      "claude-after-the-change",
    );
  });
});
