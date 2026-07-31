import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { run } from "../src/cli/main";
import { readBridgeConfig, writeBridgeConfig, type BridgeConfig } from "../src/bridge/config";
import {
  readActiveProfileModel,
  resolveEffectiveDeclaredModel,
} from "../src/bridge/declared-model";

// The declared-model commands read + rewrite bridge.json (AIFIGHT_RUNTIME_HOME)
// and the agent profile config (AIFIGHT_HOME/agents/<slug>) — every test gets
// its own empty home pair so none of that touches the developer's real one.
// (The real default path is named nowhere here on purpose: build.sh greps
// tests/ for it.)
let prevRuntimeHome: string | undefined;
let prevAifightHome: string | undefined;
let tmpDir: string | null = null;

function useTempHome(): void {
  prevRuntimeHome = process.env.AIFIGHT_RUNTIME_HOME;
  prevAifightHome = process.env.AIFIGHT_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-cli-declared-model-"));
  process.env.AIFIGHT_HOME = path.join(tmpDir, "home");
  process.env.AIFIGHT_RUNTIME_HOME = path.join(tmpDir, "runtime");
}

afterEach(() => {
  if (prevRuntimeHome === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
  else process.env.AIFIGHT_RUNTIME_HOME = prevRuntimeHome;
  if (prevAifightHome === undefined) delete process.env.AIFIGHT_HOME;
  else process.env.AIFIGHT_HOME = prevAifightHome;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  prevRuntimeHome = undefined;
  prevAifightHome = undefined;
  tmpDir = null;
});

function testBridgeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    version: 1,
    baseUrl: "https://aifight.ai",
    wsUrl: "wss://aifight.ai/api/ws",
    agentId: "00000000-0000-4000-8000-000000000001",
    agentName: "existing-agent",
    apiKey: "sk-existing-secret",
    runtimeType: "direct",
    runtimeLocalUrl: "direct://local",
    runtimeModel: "direct",
    directAgentSlug: "default",
    autoDailyLimit: 2,
    updatedAt: new Date("2026-07-30T00:00:00Z").toISOString(),
    ...overrides,
  };
}

/** Write a minimal valid agents/<slug>/config.json into the temp AIFIGHT_HOME. */
function seedProfileConfig(slug: string, profiles: Record<string, string>, activeProfile: string): void {
  const dir = path.join(process.env.AIFIGHT_HOME!, "agents", slug);
  fs.mkdirSync(dir, { recursive: true });
  const profileDefs = Object.fromEntries(
    Object.entries(profiles).map(([id, model]) => [
      id,
      {
        protocol: "anthropic_messages",
        baseURL: "https://api.anthropic.com",
        apiKeyRef: { type: "env", name: "AIFIGHT_TEST_LLM_KEY" },
        model,
        thinking: { enabled: true, mode: "always", effort: "high" },
        request: { maxTokens: 32000, responseFormat: "json", stream: "auto" },
        timeouts: { requestMs: 270000 },
        retries: { maxAttempts: 2 },
      },
    ]),
  );
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ schemaVersion: 1, activeProfile, profiles: profileDefs, routing: { default: activeProfile } }, null, 2) + "\n",
  );
}

interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCapture(argv: readonly string[], fetchImpl?: typeof fetch): Promise<Captured> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(argv, {
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

interface SeenRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** Mock fetch that records every request and answers by URL suffix. */
function recordingFetch(
  answers: Array<{ readonly urlIncludes: string; readonly response: Response }>,
): { readonly fetchImpl: typeof fetch; readonly seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const textUrl = String(url);
    seen.push({
      url: textUrl,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const match = answers.find((a) => textUrl.includes(a.urlIncludes));
    if (match === undefined) {
      return new Response("not found", { status: 404 });
    }
    return match.response;
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const policyOk = {
  urlIncludes: "/api/agents/me/policy",
  response: new Response(JSON.stringify({ policy: {} }), { status: 200, headers: { "Content-Type": "application/json" } }),
};

/** The version + agent-status answers `aifight status` needs before it prints. */
function statusFetch(): typeof fetch {
  return vi.fn(async (url: string | URL | Request) => {
    const textUrl = String(url);
    if (textUrl.endsWith("/api/bridge/version")) {
      return new Response(JSON.stringify({
        minimum_supported_version: "0.1.0-alpha.1",
        recommended_version: "0.1.0-beta.36",
        latest_version: "0.1.0-beta.36",
        update_command: "npm install -g @aifight/aifight",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (textUrl.endsWith("/api/agents/me/status")) {
      return new Response(JSON.stringify({
        agent_id: "00000000-0000-4000-8000-000000000001",
        name: "existing-agent",
        status: "ready",
        is_claimed: true,
        identity_status: "official",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
}

describe("resolveEffectiveDeclaredModel precedence", () => {
  const noProfile = (): undefined => undefined;

  it("pinned declaredModel wins over the profile model", () => {
    const r = resolveEffectiveDeclaredModel(
      { declaredModel: "My Display Name", directAgentSlug: "default", runtimeType: "direct" },
      () => "claude-opus-4-6",
    );
    expect(r).toEqual({ value: "My Display Name", origin: "custom" });
  });

  it("falls back to the active profile's configured model when not pinned", () => {
    const r = resolveEffectiveDeclaredModel({ directAgentSlug: "default", runtimeType: "direct" }, () => "claude-opus-4-6");
    expect(r).toEqual({ value: "claude-opus-4-6", origin: "model_config" });
  });

  it("a whitespace-only pin is not a pin", () => {
    const r = resolveEffectiveDeclaredModel(
      { declaredModel: "   ", directAgentSlug: "default", runtimeType: "direct" },
      () => "claude-opus-4-6",
    );
    expect(r).toEqual({ value: "claude-opus-4-6", origin: "model_config" });
  });

  it("a pinned value is trimmed", () => {
    const r = resolveEffectiveDeclaredModel({ declaredModel: "  pinned  ", directAgentSlug: "default", runtimeType: "direct" }, noProfile);
    expect(r).toEqual({ value: "pinned", origin: "custom" });
  });

  it("no pin and no profile model → the historical 'direct' label", () => {
    const r = resolveEffectiveDeclaredModel({ directAgentSlug: "default", runtimeType: "direct" }, noProfile);
    expect(r).toEqual({ value: "direct", origin: "default" });
  });

  it("a mock agent never derives from a profile (it runs no LLM)", () => {
    const r = resolveEffectiveDeclaredModel({ directAgentSlug: "default", runtimeType: "mock" }, () => "claude-opus-4-6");
    expect(r).toEqual({ value: "direct", origin: "default" });
    // …but a pin still wins on a mock agent.
    const pinned = resolveEffectiveDeclaredModel({ declaredModel: "pinned", directAgentSlug: "default", runtimeType: "mock" }, () => "claude-opus-4-6");
    expect(pinned).toEqual({ value: "pinned", origin: "custom" });
  });

  it("a missing directAgentSlug defaults to the 'default' agent profile", () => {
    const slugs: string[] = [];
    resolveEffectiveDeclaredModel({ runtimeType: "direct" }, (slug) => {
      slugs.push(slug);
      return undefined;
    });
    expect(slugs).toEqual(["default"]);
  });
});

describe("readActiveProfileModel", () => {
  it("reads the active profile's model from the on-disk config", () => {
    useTempHome();
    seedProfileConfig("default", { claude: "claude-opus-4-6" }, "claude");
    expect(readActiveProfileModel("default")).toBe("claude-opus-4-6");
  });

  it("falls back to routing.default when activeProfile is unknown", () => {
    useTempHome();
    seedProfileConfig("default", { claude: "claude-opus-4-6" }, "claude");
    const configPath = path.join(process.env.AIFIGHT_HOME!, "agents", "default", "config.json");
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8")) as { activeProfile: string };
    cfg.activeProfile = "does-not-exist";
    fs.writeFileSync(configPath, JSON.stringify(cfg));
    expect(readActiveProfileModel("default")).toBe("claude-opus-4-6");
  });

  it("missing or corrupt config yields undefined, never a throw", () => {
    useTempHome();
    expect(readActiveProfileModel("default")).toBeUndefined();
    const dir = path.join(process.env.AIFIGHT_HOME!, "agents", "default");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), "{ not json");
    expect(readActiveProfileModel("default")).toBeUndefined();
  });
});

describe("aifight set declared-model", () => {
  it("writes the pin to bridge.json and syncs it to the platform", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const { fetchImpl, seen } = recordingFetch([policyOk]);

    const r = await runCapture(["set", "declared-model", "claude-opus-4-6"], fetchImpl);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Declared model set to "claude-opus-4-6"');
    expect(r.stdout).toContain("PUBLIC");
    expect(r.stdout).toContain("Leaderboard now shows: claude-opus-4-6 (custom)");
    expect(readBridgeConfig().declaredModel).toBe("claude-opus-4-6");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://aifight.ai/api/agents/me/policy");
    expect(seen[0]!.method).toBe("PATCH");
    expect(seen[0]!.headers["X-API-Key"]).toBe("sk-existing-secret");
    expect(seen[0]!.body).toEqual({ declared_model: "claude-opus-4-6" });
  });

  it("joins a multi-word name into one label", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const { fetchImpl, seen } = recordingFetch([policyOk]);

    const r = await runCapture(["set", "declared-model", "My", "Cool", "Bot"], fetchImpl);

    expect(r.code).toBe(0);
    expect(readBridgeConfig().declaredModel).toBe("My Cool Bot");
    expect(seen[0]!.body).toEqual({ declared_model: "My Cool Bot" });
  });

  it("--clear drops the pin and re-syncs the profile-derived model", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig({ declaredModel: "Pinned Name" }));
    seedProfileConfig("default", { claude: "claude-opus-4-6" }, "claude");
    const { fetchImpl, seen } = recordingFetch([policyOk]);

    const r = await runCapture(["set", "declared-model", "--clear"], fetchImpl);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("cleared");
    expect(r.stdout).toContain("Leaderboard now shows: claude-opus-4-6 (from model config)");
    expect(readBridgeConfig().declaredModel).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).toEqual({ declared_model: "claude-opus-4-6" });
  });

  it('an empty name ("") clears too, falling back to "direct" with no profile', async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig({ declaredModel: "Pinned Name" }));
    const { fetchImpl, seen } = recordingFetch([policyOk]);

    const r = await runCapture(["set", "declared-model", ""], fetchImpl);

    expect(r.code).toBe(0);
    expect(readBridgeConfig().declaredModel).toBeUndefined();
    expect(r.stdout).toContain("Leaderboard now shows: direct (default)");
    expect(seen[0]!.body).toEqual({ declared_model: "direct" });
  });

  it("keeps the local pin and warns when the platform sync fails (exit 0)", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const { fetchImpl } = recordingFetch([
      { urlIncludes: "/api/agents/me/policy", response: new Response(JSON.stringify({ error: "boom" }), { status: 502, headers: { "Content-Type": "application/json" } }) },
    ]);

    const r = await runCapture(["set", "declared-model", "claude-opus-4-6"], fetchImpl);

    expect(r.code).toBe(0);
    expect(readBridgeConfig().declaredModel).toBe("claude-opus-4-6");
    expect(r.stderr).toContain("could not sync the declared model");
    expect(r.stderr).toContain("boom");
  });

  it("reports the sync failure in --json without extra stdout noise", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const { fetchImpl } = recordingFetch([
      { urlIncludes: "/api/agents/me/policy", response: new Response("down", { status: 502 }) },
    ]);

    const r = await runCapture(["set", "declared-model", "x-model", "--json"], fetchImpl);

    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout.trim()) as {
      declaredModel?: unknown;
      effective?: { value?: unknown; origin?: unknown };
      platformSynced?: unknown;
      syncError?: unknown;
    };
    expect(parsed.declaredModel).toBe("x-model");
    expect(parsed.effective).toEqual({ value: "x-model", origin: "custom" });
    expect(parsed.platformSynced).toBe(false);
    expect(typeof parsed.syncError).toBe("string");
  });

  it("rejects an overlong name before writing or syncing", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const { fetchImpl, seen } = recordingFetch([policyOk]);

    const r = await runCapture(["set", "declared-model", "a".repeat(101)], fetchImpl);

    expect(r.code).toBe(2);
    expect(r.stderr).toContain("at most 100 characters");
    expect(readBridgeConfig().declaredModel).toBeUndefined();
    expect(seen).toHaveLength(0);
  });

  it("rejects control characters before writing or syncing", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const { fetchImpl, seen } = recordingFetch([policyOk]);

    const r = await runCapture(["set", "declared-model", "bad\nname"], fetchImpl);

    expect(r.code).toBe(2);
    expect(r.stderr).toContain("control characters");
    expect(readBridgeConfig().declaredModel).toBeUndefined();
    expect(seen).toHaveLength(0);
  });

  it("requires a name or --clear", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const { fetchImpl, seen } = recordingFetch([policyOk]);

    const r = await runCapture(["set", "declared-model"], fetchImpl);

    expect(r.code).toBe(2);
    expect(r.stderr).toContain("usage:");
    expect(seen).toHaveLength(0);
  });

  it("refuses a name AND --clear together", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const { fetchImpl, seen } = recordingFetch([policyOk]);

    const r = await runCapture(["set", "declared-model", "x", "--clear"], fetchImpl);

    expect(r.code).toBe(2);
    expect(seen).toHaveLength(0);
  });
});

describe("aifight status declared model line", () => {
  it("shows the pinned name as custom", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig({ declaredModel: "Pinned Name" }));
    const r = await runCapture(["status"], statusFetch());
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Declared model\s+Pinned Name \(custom\)/);
  });

  it("shows the profile-derived model when not pinned", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    seedProfileConfig("default", { claude: "claude-opus-4-6" }, "claude");
    const r = await runCapture(["status"], statusFetch());
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Declared model\s+claude-opus-4-6 \(from model config\)/);
  });

  it("shows the direct default when neither pin nor profile exists", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const r = await runCapture(["status"], statusFetch());
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Declared model\s+direct \(default\)/);
  });

  it("exposes value + origin in --json", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    seedProfileConfig("default", { claude: "claude-opus-4-6" }, "claude");
    const r = await runCapture(["status", "--json"], statusFetch());
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout.trim()) as { declaredModel?: { value?: unknown; origin?: unknown } };
    expect(parsed.declaredModel).toEqual({ value: "claude-opus-4-6", origin: "model_config" });
  });
});

describe("config update → declared model sync", () => {
  it("syncs when the ACTIVE profile's model changed", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    seedProfileConfig("default", { claude: "model-a" }, "claude");
    const { fetchImpl, seen } = recordingFetch([policyOk]);

    const r = await runCapture(["config", "update", "claude", "--model", "model-b", "--no-test"], fetchImpl);

    expect(r.code).toBe(0);
    const patches = seen.filter((s) => s.url.includes("/api/agents/me/policy"));
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toEqual({ declared_model: "model-b" });
    expect(r.stdout).toContain('the leaderboard now shows "model-b"');
  });

  it("does not sync when the model is unchanged (non-model edit)", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    seedProfileConfig("default", { claude: "model-a" }, "claude");
    const { fetchImpl, seen } = recordingFetch([policyOk]);

    const r = await runCapture(["config", "update", "claude", "--max-tokens", "16000", "--no-test"], fetchImpl);

    expect(r.code).toBe(0);
    expect(seen.filter((s) => s.url.includes("/api/agents/me/policy"))).toHaveLength(0);
  });

  it("does not sync when a NON-active profile's model changed", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    seedProfileConfig("default", { claude: "model-a", other: "other-a" }, "claude");
    const { fetchImpl, seen } = recordingFetch([policyOk]);

    const r = await runCapture(["config", "update", "other", "--model", "other-b", "--no-test"], fetchImpl);

    expect(r.code).toBe(0);
    expect(seen.filter((s) => s.url.includes("/api/agents/me/policy"))).toHaveLength(0);
  });

  it("does not sync when a declaredModel pin overrides the profile model", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig({ declaredModel: "Pinned Name" }));
    seedProfileConfig("default", { claude: "model-a" }, "claude");
    const { fetchImpl, seen } = recordingFetch([policyOk]);

    const r = await runCapture(["config", "update", "claude", "--model", "model-b", "--no-test"], fetchImpl);

    expect(r.code).toBe(0);
    expect(seen.filter((s) => s.url.includes("/api/agents/me/policy"))).toHaveLength(0);
  });

  it("does not sync when the edited slug is not the bridge's agent", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig()); // directAgentSlug: "default"
    seedProfileConfig("other-agent", { claude: "model-a" }, "claude");
    const { fetchImpl, seen } = recordingFetch([policyOk]);

    const r = await runCapture(["config", "update", "claude", "--model", "model-b", "--no-test", "other-agent"], fetchImpl);

    expect(r.code).toBe(0);
    expect(seen.filter((s) => s.url.includes("/api/agents/me/policy"))).toHaveLength(0);
  });
});
