// D10 — config-host: the standalone graphical LLM config editor backend.
// Verifies it reads/writes the SAME agent config the runtime/CLI use (under
// AIFIGHT_HOME/agents) and — critically — that a pasted key is stored to a 0600
// file and NEVER written into config.json.

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getConfig, saveProfile, setKey, clearKey, setActive, setRoute, deleteProfile } from "./config-host";

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

  it("clamps requestTimeoutMs into the runtime schema's [1ms, 300s] bounds — an over-cap save must not brick profile loading", async () => {
    freshHome();
    await saveProfile("default", { profileId: "slow", family: "anthropic", model: "claude-opus-4-8", thinkingEnabled: false, requestTimeoutMs: 600_000 });
    let v = await getConfig();
    expect(v.profiles.find((p) => p.id === "slow")!.requestTimeoutMs).toBe(300_000);

    // In-range values pass through untouched; omitting it keeps the 270s default.
    await saveProfile("default", { profileId: "slow", family: "anthropic", model: "claude-opus-4-8", thinkingEnabled: false, requestTimeoutMs: 30_000 });
    v = await getConfig();
    expect(v.profiles.find((p) => p.id === "slow")!.requestTimeoutMs).toBe(30_000);

    await saveProfile("default", { profileId: "fresh", family: "anthropic", model: "claude-opus-4-8", thinkingEnabled: false });
    v = await getConfig();
    expect(v.profiles.find((p) => p.id === "fresh")!.requestTimeoutMs).toBe(270_000);
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

  it("R14-F06: clearKey deletes the managed key file and resets the ref", async () => {
    const home = freshHome();
    await saveProfile("default", { profileId: "claude", family: "anthropic", model: "claude-opus-4-8", thinkingEnabled: false });
    await setKey("default", "claude", "sk-ant-clear-me");
    const keyFile = path.join(home, "agents", "default", "keys", "claude.key");
    expect(fs.existsSync(keyFile)).toBe(true);

    const r = await clearKey("default", "claude");
    expect(r.ok).toBe(true);
    expect(fs.existsSync(keyFile)).toBe(false);
    const p = (await getConfig()).profiles.find((x) => x.id === "claude")!;
    expect(p.keyResolvable).toBe(false);
  });

  it("🔒 R14-F06: clearKey must NOT report success when the key file survives deletion", async () => {
    const home = freshHome();
    await saveProfile("default", { profileId: "claude", family: "anthropic", model: "claude-opus-4-8", thinkingEnabled: false });
    await setKey("default", "claude", "sk-ant-stuck");
    const keyFile = path.join(home, "agents", "default", "keys", "claude.key");
    // Make deletion fail deterministically on every platform: replace the key
    // file with a non-empty directory of the same name (fs.rm without
    // `recursive` refuses to remove a directory).
    fs.rmSync(keyFile);
    fs.mkdirSync(keyFile);
    fs.writeFileSync(path.join(keyFile, "stuck.txt"), "x");

    const r = await clearKey("default", "claude");
    expect(r.ok).toBe(false);
    expect(r.error).toContain(keyFile); // actionable: names the retained path
    // The ref was cleared FIRST — the app no longer resolves the key even
    // though the path could not be removed.
    const p = (await getConfig()).profiles.find((x) => x.id === "claude")!;
    expect(p.keyResolvable).toBe(false);
  });

  it("🔒 R14-F06: deleteProfile removes the profile's managed key file (no orphaned raw key)", async () => {
    const home = freshHome();
    await saveProfile("default", { profileId: "claude", family: "anthropic", model: "claude-opus-4-8", thinkingEnabled: false });
    await saveProfile("default", { profileId: "gpt", family: "openai_responses", model: "gpt-5.5", thinkingEnabled: false });
    await setKey("default", "gpt", "sk-oai-orphan-me");
    const keyFile = path.join(home, "agents", "default", "keys", "gpt.key");
    expect(fs.existsSync(keyFile)).toBe(true);

    expect((await deleteProfile("default", "gpt")).ok).toBe(true);
    expect(fs.existsSync(keyFile)).toBe(false);
  });

  it("R14-F06: external file refs are unreferenced but never deleted by the GUI", async () => {
    const home = freshHome();
    await saveProfile("default", { profileId: "claude", family: "anthropic", model: "claude-opus-4-8", thinkingEnabled: false });
    await saveProfile("default", { profileId: "ext", family: "anthropic", model: "claude-opus-4-8", thinkingEnabled: false });
    // Simulate a CLI/hand-edited config pointing at a key file OUTSIDE keys/.
    const externalKey = path.join(home, "external-secret.key");
    fs.writeFileSync(externalKey, "sk-ant-external", { mode: 0o600 });
    const configPath = path.join(home, "agents", "default", "config.json");
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    cfg.profiles.ext.apiKeyRef = { type: "file", path: externalKey };
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");

    expect((await clearKey("default", "ext")).ok).toBe(true);
    expect(fs.existsSync(externalKey)).toBe(true); // not the GUI's file to delete

    // Re-point and delete the whole profile — still untouched.
    const cfg2 = JSON.parse(fs.readFileSync(configPath, "utf8"));
    cfg2.profiles.ext.apiKeyRef = { type: "file", path: externalKey };
    fs.writeFileSync(configPath, JSON.stringify(cfg2, null, 2) + "\n");
    expect((await deleteProfile("default", "ext")).ok).toBe(true);
    expect(fs.existsSync(externalKey)).toBe(true);
  });

  // R14 coverage gap: config-host had no concurrent-call coverage. The renderer
  // can fire IPC mutations that interleave at await points in the main process.
  // writeConfig is atomic per write (tmp + rename), so whole-file last-write-wins
  // may drop a concurrent update (single-user GUI tolerates that), but the file
  // must NEVER be left torn, unparseable, invalid, or with a stray .tmp; and the
  // active/default references must always point at existing profiles.
  it("survives concurrent mutations: config stays valid, references stay consistent", async () => {
    const home = freshHome();
    await saveProfile("default", { profileId: "base", family: "anthropic", model: "claude-opus-4-8", thinkingEnabled: false });

    const ops: Array<Promise<unknown>> = [];
    for (let i = 0; i < 12; i++) {
      ops.push(saveProfile("default", { profileId: `p${i}`, family: "anthropic", model: "claude-opus-4-8", thinkingEnabled: false }));
    }
    ops.push(setKey("default", "base", "sk-ant-concurrent"));
    ops.push(setActive("default", "base"));
    ops.push(setRoute("default", "coup", "base"));
    await Promise.all(ops);

    const configPath = path.join(home, "agents", "default", "config.json");
    expect(fs.existsSync(configPath)).toBe(true);
    const strayTmp = fs.readdirSync(path.dirname(configPath)).filter((f) => f.endsWith(".tmp"));
    expect(strayTmp).toEqual([]); // no stray temp files
    // Parseable and structurally sound (a torn write would fail here).
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(typeof cfg.profiles).toBe("object");
    expect(Object.keys(cfg.profiles).length).toBeGreaterThan(0);
    // References always resolve to a real profile.
    expect(cfg.profiles[cfg.activeProfile]).toBeDefined();
    expect(cfg.profiles[cfg.routing.default]).toBeDefined();
    // And the view layer accepts it end-to-end.
    const v = await getConfig();
    expect(v.configured).toBe(true);
    expect(v.profiles.length).toBe(Object.keys(cfg.profiles).length);
  });

  it("survives a concurrent delete + save on the same config", async () => {
    freshHome();
    await saveProfile("default", { profileId: "keep", family: "anthropic", model: "claude-opus-4-8", thinkingEnabled: false });
    await saveProfile("default", { profileId: "victim", family: "anthropic", model: "claude-opus-4-8", thinkingEnabled: false });
    await setKey("default", "victim", "sk-ant-victim");

    await Promise.all([
      deleteProfile("default", "victim"),
      saveProfile("default", { profileId: "newcomer", family: "openai_responses", model: "gpt-5.5", thinkingEnabled: false }),
    ]);

    const v = await getConfig();
    expect(v.configured).toBe(true);
    // Whichever write won, the surviving config must be internally consistent.
    expect(v.profiles.some((p) => p.id === v.activeProfile)).toBe(true);
    expect(v.profiles.length).toBeGreaterThan(0);
  });

  it("rejects bad input", async () => {
    freshHome();
    expect((await saveProfile("default", { profileId: "x", family: "not_a_family" as never, model: "m", thinkingEnabled: false })).ok).toBe(false);
    expect((await saveProfile("default", { profileId: "x", family: "anthropic", model: "", thinkingEnabled: false })).ok).toBe(false);
    expect((await setKey("default", "nope", "k")).ok).toBe(false); // no config yet
  });
});
