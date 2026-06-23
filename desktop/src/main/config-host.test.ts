// D10 — config-host: the standalone graphical LLM config editor backend.
// Verifies it reads/writes the SAME agent config the runtime/CLI use (under
// AIFIGHT_HOME/agents) and — critically — that a pasted key is stored to a 0600
// file and NEVER written into config.json.

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getConfig, saveProfile, setKey, setActive, setRoute, deleteProfile } from "./config-host";

const ORIGINAL_HOME = process.env.AIFIGHT_HOME;
const tmpDirs: string[] = [];

function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-config-host-"));
  tmpDirs.push(dir);
  process.env.AIFIGHT_HOME = dir;
  return dir;
}

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.AIFIGHT_HOME;
  else process.env.AIFIGHT_HOME = ORIGINAL_HOME;
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

describe("config-host: standalone graphical config", () => {
  it("starts unconfigured", async () => {
    freshHome();
    const v = await getConfig();
    expect(v.configured).toBe(false);
    expect(v.profiles).toEqual([]);
  });

  it("saveProfile writes config.json only (no strategy.json/soul.md); first profile becomes active+default", async () => {
    const home = freshHome();
    const r = await saveProfile("default", {
      profileId: "claude",
      displayName: "Claude Opus",
      family: "anthropic",
      model: "claude-opus-4-8",
      thinkingEnabled: true,
      effort: "high",
    });
    expect(r.ok).toBe(true);

    const v = await getConfig();
    expect(v.configured).toBe(true);
    expect(v.activeProfile).toBe("claude");
    expect(v.routing.default).toBe("claude");
    const p = v.profiles.find((x) => x.id === "claude")!;
    expect(p.model).toBe("claude-opus-4-8");
    expect(p.thinkingEnabled).toBe(true);
    expect(p.effort).toBe("high");
    expect(p.keyResolvable).toBe(false); // no key yet

    // config.json is the only profile file. Strategy converged to Markdown —
    // the legacy strategy.json + soul.md must NOT be scaffolded anymore.
    const agentDir = path.join(home, "agents", "default");
    expect(fs.existsSync(path.join(agentDir, "config.json"))).toBe(true);
    expect(fs.existsSync(path.join(agentDir, "strategy.json"))).toBe(false);
    expect(fs.existsSync(path.join(agentDir, "soul.md"))).toBe(false);
  });

  it("🔒 setKey stores the key to a 0600 file, NEVER into config.json", async () => {
    const home = freshHome();
    await saveProfile("default", { profileId: "claude", family: "anthropic", model: "claude-opus-4-8", thinkingEnabled: false });
    const SECRET = "sk-ant-super-secret-key-9f";
    const r = await setKey("default", "claude", SECRET);
    expect(r.ok).toBe(true);

    const v = await getConfig();
    const p = v.profiles.find((x) => x.id === "claude")!;
    expect(p.keyResolvable).toBe(true);
    expect(p.keySource.startsWith("file:")).toBe(true);

    // The raw key must NOT appear in config.json…
    const configRaw = fs.readFileSync(path.join(home, "agents", "default", "config.json"), "utf8");
    expect(configRaw).not.toContain(SECRET);
    // …it lives in a 0600 key file.
    const keyFile = path.join(home, "agents", "default", "keys", "claude.key");
    expect(fs.existsSync(keyFile)).toBe(true);
    expect(fs.readFileSync(keyFile, "utf8")).toContain(SECRET);
    if (process.platform !== "win32") {
      expect((fs.statSync(keyFile).mode & 0o777).toString(8)).toBe("600");
    }
  });

  it("custom baseURL is stored; blank baseURL falls back to protocol default", async () => {
    freshHome();
    await saveProfile("default", { profileId: "ds", family: "openai_chat", model: "deepseek-v4-pro", baseURL: "https://api.deepseek.com", thinkingEnabled: true, effort: "max" });
    await saveProfile("default", { profileId: "claude", family: "anthropic", model: "claude-opus-4-8", baseURL: "", thinkingEnabled: false });
    const v = await getConfig();
    expect(v.profiles.find((p) => p.id === "ds")!.baseURL).toBe("https://api.deepseek.com");
    expect(v.profiles.find((p) => p.id === "claude")!.baseURL).toBeNull(); // protocol default
  });

  it("openai_chat family auto-routes to the right concrete adapter; persists knobs", async () => {
    freshHome();
    await saveProfile("default", { profileId: "ds", family: "openai_chat", model: "deepseek-v4-pro", baseURL: "https://api.deepseek.com", thinkingEnabled: true, effort: "max", stream: "always", temperature: null, maxTokens: 20000, features: { jsonObjectMode: true } });
    await saveProfile("default", { profileId: "gpt4o", family: "openai_chat", model: "gpt-4o", thinkingEnabled: false });
    await saveProfile("default", { profileId: "gptr", family: "openai_responses", model: "gpt-5.5", thinkingEnabled: true, effort: "high", verbosity: "low" });
    const v = await getConfig();
    const ds = v.profiles.find((p) => p.id === "ds")!;
    expect(ds.protocol).toBe("deepseek_chat_completions"); // auto-routed by deepseek model
    expect(ds.family).toBe("openai_chat");
    expect(ds.stream).toBe("always");
    expect(ds.maxTokens).toBe(20000);
    expect(ds.features.jsonObjectMode).toBe(true);
    expect(v.profiles.find((p) => p.id === "gpt4o")!.protocol).toBe("openai_chat_completions");
    const gptr = v.profiles.find((p) => p.id === "gptr")!;
    expect(gptr.protocol).toBe("openai_responses");
    expect(gptr.verbosity).toBe("low");
  });

  it("setActive / setRoute / deleteProfile mutate the shared config", async () => {
    freshHome();
    await saveProfile("default", { profileId: "claude", family: "anthropic", model: "claude-opus-4-8", thinkingEnabled: false });
    await saveProfile("default", { profileId: "gpt", family: "openai_responses", model: "gpt-5.5", thinkingEnabled: true, effort: "medium" });

    expect((await setActive("default", "gpt")).ok).toBe(true);
    expect((await getConfig()).activeProfile).toBe("gpt");

    expect((await setRoute("default", "coup", "claude")).ok).toBe(true);
    expect((await getConfig()).routing.byGame?.coup).toBe("claude");

    expect((await deleteProfile("default", "gpt")).ok).toBe(true);
    const v = await getConfig();
    expect(v.profiles.map((p) => p.id)).toEqual(["claude"]);
    expect(v.activeProfile).toBe("claude"); // fell back

    // cannot delete the only profile
    expect((await deleteProfile("default", "claude")).ok).toBe(false);
  });

  it("rejects bad input", async () => {
    freshHome();
    expect((await saveProfile("default", { profileId: "x", family: "not_a_family" as never, model: "m", thinkingEnabled: false })).ok).toBe(false);
    expect((await saveProfile("default", { profileId: "x", family: "anthropic", model: "", thinkingEnabled: false })).ok).toBe(false);
    expect((await setKey("default", "nope", "k")).ok).toBe(false); // no config yet
  });
});
