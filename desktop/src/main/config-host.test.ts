// D10 — config-host: the standalone graphical LLM config editor backend.
// Verifies it reads/writes the SAME agent config the runtime/CLI use (under
// AIFIGHT_HOME/agents) and — critically — that a pasted key is stored to a 0600
// file and NEVER written into config.json.

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getConfig, saveProfile, setKey, clearKey, setActive, setRoute, deleteProfile, modelCapabilitiesForFamily, discoverModelsForFamily } from "./config-host";

const ORIGINAL_HOME = process.env.AIFIGHT_HOME;
const tmpDirs: string[] = [];

function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-config-host-"));
  tmpDirs.push(dir);
  process.env.AIFIGHT_HOME = dir;
  return dir;
}

// The managed key filename is derived (safeSegment + a hash suffix, so distinct
// ids never collide onto one file), so tests resolve the actual path from the
// profile's stored apiKeyRef rather than assuming "<id>.key".
function keyPathOf(home: string, profileId: string, slug = "default"): string {
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "agents", slug, "config.json"), "utf8"));
  const ref = cfg.profiles?.[profileId]?.apiKeyRef;
  const p = typeof ref?.path === "string" ? ref.path : "";
  // R14 audit: resolving via apiKeyRef must not un-pin WHERE keys live — a
  // regression writing key files outside the managed keys/ dir has to fail here.
  if (p !== "") {
    expect(p.startsWith(path.join(home, "agents", slug, "keys") + path.sep)).toBe(true);
  }
  return p;
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
    const keyFile = keyPathOf(home, "claude");
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
    const keyFile = keyPathOf(home, "claude");
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
    const keyFile = keyPathOf(home, "claude");
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
    const keyFile = keyPathOf(home, "gpt");
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

  // R12 (2026-07-26): a prototype-chain profile id must be rejected outright, not
  // silently phantom-succeed (mutating the prototype instead of creating a profile
  // and orphaning a plaintext key file). See config-host review §12.
  it("🔒 rejects prototype-chain profile ids (__proto__, constructor)", async () => {
    const home = freshHome();
    await saveProfile("default", { profileId: "real", family: "anthropic", model: "claude-opus-4-8", thinkingEnabled: false });
    for (const bad of ["__proto__", "constructor", "toString"]) {
      const r = await saveProfile("default", { profileId: bad, family: "anthropic", model: "claude-opus-4-8", thinkingEnabled: false });
      expect(r.ok).toBe(false);
      // setKey must also refuse (never write an orphaned key file for it).
      const rk = await setKey("default", bad, "sk-ant-proto");
      expect(rk.ok).toBe(false);
    }
    // Only the real profile exists; no key file was written for the bad ids.
    const v = await getConfig();
    expect(v.profiles.map((p) => p.id)).toEqual(["real"]);
    const keysDir = path.join(home, "agents", "default", "keys");
    const keyFiles = fs.existsSync(keysDir) ? fs.readdirSync(keysDir) : [];
    expect(keyFiles).toEqual([]);
  });

  // R12: two ids that sanitize to the same segment must NOT share one key file
  // (else one profile's key is sent to the other's endpoint, or a live key is
  // deleted out from under the other profile).
  it("🔒 sanitize-colliding profile ids get distinct key files", async () => {
    freshHome();
    await saveProfile("default", { profileId: "gpt/mini", family: "openai_chat", model: "gpt-4o-mini", thinkingEnabled: false });
    await saveProfile("default", { profileId: "gpt_mini", family: "anthropic", model: "claude-opus-4-8", thinkingEnabled: false });
    expect((await setKey("default", "gpt/mini", "sk-A-aaaaaaaa")).ok).toBe(true);
    expect((await setKey("default", "gpt_mini", "sk-B-bbbbbbbb")).ok).toBe(true);

    const v = await getConfig();
    const a = v.profiles.find((p) => p.id === "gpt/mini")!;
    const b = v.profiles.find((p) => p.id === "gpt_mini")!;
    expect(a.keyResolvable).toBe(true);
    expect(b.keyResolvable).toBe(true);
    // Distinct backing files, each holding its own key.
    const pa = path.join(process.env.AIFIGHT_HOME!, "agents", "default", "config.json");
    const cfg = JSON.parse(fs.readFileSync(pa, "utf8"));
    const refA = cfg.profiles["gpt/mini"].apiKeyRef.path as string;
    const refB = cfg.profiles["gpt_mini"].apiKeyRef.path as string;
    expect(refA).not.toBe(refB);
    expect(fs.readFileSync(refA, "utf8")).toContain("sk-A-aaaaaaaa");
    expect(fs.readFileSync(refB, "utf8")).toContain("sk-B-bbbbbbbb");
  });

  // R12: a present-but-invalid config.json must be reported as an error (not
  // "unconfigured"), and saveProfile must refuse rather than overwrite it — the
  // old code silently rebuilt from empty and wiped every other profile.
  it("🔒 present-but-invalid config is not silently overwritten", async () => {
    const home = freshHome();
    await saveProfile("default", { profileId: "keep-a", family: "anthropic", model: "claude-opus-4-8", thinkingEnabled: false });
    await saveProfile("default", { profileId: "keep-b", family: "openai_responses", model: "gpt-5.5", thinkingEnabled: false });
    const configPath = path.join(home, "agents", "default", "config.json");
    // Corrupt it two ways in turn: unparseable garbage, then wrong schemaVersion.
    for (const bad of ["}{ not json", JSON.stringify({ schemaVersion: 999, profiles: {} })]) {
      fs.writeFileSync(configPath, bad);
      const before = fs.readFileSync(configPath, "utf8");

      const v = await getConfig();
      expect(v.configured).toBe(false);
      expect(typeof v.error).toBe("string");
      expect(v.error!.length).toBeGreaterThan(0);

      const r = await saveProfile("default", { profileId: "newcomer", family: "anthropic", model: "claude-opus-4-8", thinkingEnabled: false });
      expect(r.ok).toBe(false);
      // The invalid file is left exactly as-is — no wipe, no partial write.
      expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    }
  });

  // R12: absent config (ENOENT) is still the normal fresh-setup path — saveProfile
  // must create it, unlike the invalid case above.
  it("absent config still bootstraps on first saveProfile", async () => {
    freshHome();
    const v0 = await getConfig();
    expect(v0.configured).toBe(false);
    expect(v0.error).toBeUndefined();
    expect((await saveProfile("default", { profileId: "first", family: "anthropic", model: "claude-opus-4-8", thinkingEnabled: false })).ok).toBe(true);
    expect((await getConfig()).configured).toBe(true);
  });
});

// 2026-07-26: the app's Models editor kept its OWN regex table of effort tiers, so
// claude-opus-5 — which takes all five — offered only low/medium/high, while the CLI
// (registry-driven) offered the full ladder. The fix routes the UI through this
// function; these pin what it must report.
// B3. The GUI shows four families but config.json stores one of six concrete
// protocols, and saveProfile re-derives the concrete one from
// (family, model, baseURL). For the three protocols that share the openai_chat
// family that derivation is a heuristic, so a profile the CLI wrote can be moved
// onto a different adapter by a GUI edit that had nothing to do with the protocol.
//
// (The reviewer's original framing — "an UNKNOWN protocol is folded into
// openai_chat and rewritten" — does not reach this code: validateConfig rejects any
// protocol outside its six, so readConfigState returns state:"invalid", getConfig
// reports configured:false with an error, and saveProfile refuses to write at all.
// That is strictly more conservative than preserving the field would have been.)
describe("B3: an unrelated edit must not move a profile onto another adapter", () => {
  function writeCLIConfig(home: string, profile: Record<string, unknown>): void {
    const dir = path.join(home, "agents", "default");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        schemaVersion: 1,
        activeProfile: "p",
        profiles: { p: profile },
        routing: { default: "p" },
      }),
    );
  }

  function storedProtocol(home: string): string {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, "agents", "default", "config.json"), "utf8"));
    return cfg.profiles.p.protocol;
  }

  // DeepSeek behind a gateway: neither the model name nor the URL says "deepseek",
  // so the heuristic cannot re-derive what the CLI already recorded. Losing this
  // silently downgrades the profile to the generic compat adapter — same endpoint,
  // but none of DeepSeek's thinking / reasoning_content handling.
  it("keeps deepseek_chat_completions when only max tokens changed", async () => {
    const home = freshHome();
    writeCLIConfig(home, {
      displayName: "gw",
      protocol: "deepseek_chat_completions",
      model: "v4-pro",
      baseURL: "https://gateway.example.com/v1",
      apiKeyRef: { type: "env", name: "GW_KEY" },
      request: { maxTokens: 4096, responseFormat: "json", stream: "auto" },
    });

    const before = await getConfig();
    const view = before.profiles[0]!;
    expect(view.protocol).toBe("deepseek_chat_completions");
    expect(view.family).toBe("openai_chat");

    // Echo the view back with one unrelated field changed — what the UI does when
    // the user edits max tokens and saves.
    const r = await saveProfile("default", {
      profileId: view.id,
      displayName: view.displayName,
      family: view.family,
      model: view.model,
      baseURL: view.baseURL ?? "",
      maxTokens: 8192,
      thinkingEnabled: view.thinkingEnabled,
    });
    expect(r.ok).toBe(true);
    expect(storedProtocol(home)).toBe("deepseek_chat_completions");
  });

  // The flip side: the heuristic still has to fire when the user actually changes
  // the thing it keys off. Preserving unconditionally would strand a profile on the
  // generic adapter after it was pointed at a DeepSeek model.
  it("still re-routes when the model itself changes", async () => {
    const home = freshHome();
    writeCLIConfig(home, {
      displayName: "gw",
      protocol: "openai_chat_compat",
      model: "gpt-4o",
      baseURL: "https://gateway.example.com/v1",
      apiKeyRef: { type: "env", name: "GW_KEY" },
      request: { maxTokens: 4096, responseFormat: "json", stream: "auto" },
    });

    const r = await saveProfile("default", {
      profileId: "p",
      displayName: "gw",
      family: "openai_chat",
      model: "deepseek-v4-pro",
      baseURL: "https://gateway.example.com/v1",
      maxTokens: 4096,
      thinkingEnabled: false,
    });
    expect(r.ok).toBe(true);
    expect(storedProtocol(home)).toBe("deepseek_chat_completions");
  });
});

describe("modelCapabilitiesForFamily", () => {
  it("reports the full effort ladder and real ceiling for Claude 5", () => {
    for (const model of ["claude-opus-5", "claude-sonnet-5", "claude-fable-5"]) {
      const caps = modelCapabilitiesForFamily({ family: "anthropic", model });
      expect(caps, model).not.toBeNull();
      expect(caps?.isKnownModel, model).toBe(true);
      expect(caps?.efforts, model).toEqual(["low", "medium", "high", "xhigh", "max"]);
      // 65536 was the unknown-model fallback the whole family used to land on.
      expect(caps?.maxOutputTokens, model).toBe(128000);
      expect(caps?.thinkingModes, model).toContain("adaptive");
    }
  });

  it("does not offer xhigh where the model lacks it", () => {
    for (const model of ["claude-opus-4-6", "claude-sonnet-4-6"]) {
      expect(modelCapabilitiesForFamily({ family: "anthropic", model })?.efforts, model)
        .toEqual(["low", "medium", "high", "max"]);
    }
  });

  it("marks Fable 5 as always reasoning (the on/off toggle is meaningless)", () => {
    expect(modelCapabilitiesForFamily({ family: "anthropic", model: "claude-fable-5" })?.thinkingAlwaysOn).toBe(true);
    expect(modelCapabilitiesForFamily({ family: "anthropic", model: "claude-opus-5" })?.thinkingAlwaysOn).toBe(false);
  });

  it("keeps the 4.5 generation on manual budget with no effort tiers", () => {
    const caps = modelCapabilitiesForFamily({ family: "anthropic", model: "claude-sonnet-4-5" });
    expect(caps?.thinkingModes).toEqual(["extended"]);
    expect(caps?.efforts).toEqual([]);
    expect(caps?.maxOutputTokens).toBe(64000);
  });

  // An unlisted model must stay CONFIGURABLE: suggestions fall back to the whole
  // protocol vocabulary and isKnownModel:false tells the UI to say so, rather than
  // narrowing the user to whatever this build happens to know.
  it("degrades to the protocol vocabulary for an unlisted model", () => {
    const caps = modelCapabilitiesForFamily({ family: "anthropic", model: "claude-opus-9-imaginary" });
    expect(caps?.isKnownModel).toBe(false);
    expect(caps?.efforts).toContain("max");
    expect(caps?.maxOutputTokens).toBeUndefined();
  });

  it("exposes the storable union so the UI can tell unsavable from clamped", () => {
    const caps = modelCapabilitiesForFamily({ family: "anthropic", model: "claude-opus-4-6" });
    expect(caps?.storableEfforts).toContain("xhigh"); // storable everywhere…
    expect(caps?.efforts).not.toContain("xhigh"); // …but not offered on THIS model
  });

  it("returns null on malformed input", () => {
    expect(modelCapabilitiesForFamily({ family: 1 as never, model: "m" })).toBeNull();
  });
});

describe("registry answers powering the reasoning row (2026-07-26 batch)", () => {
  it("responses protocol vocabulary carries max even where the model lacks it", () => {
    const c = modelCapabilitiesForFamily({ family: "openai_responses", model: "gpt-5.5" });
    expect(c?.protocolEfforts).toContain("max"); // chip renders (D2)
    expect(c?.efforts).not.toContain("max"); // …with a clamp annotation
    const c56 = modelCapabilitiesForFamily({ family: "openai_responses", model: "gpt-5.6-sol" });
    expect(c56?.efforts).toContain("max"); // real tier since GPT-5.6
  });

  it("chat family: thinking available but default off (pass-through)", () => {
    const c = modelCapabilitiesForFamily({ family: "openai_chat", model: "gpt-4o" });
    expect(c?.thinkingDefaultOn).toBe(false);
    expect(c?.protocolEfforts).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
  });

  it("gemini 2.5 reports its budget parameter so the UI shows a number editor", () => {
    expect(modelCapabilitiesForFamily({ family: "gemini", model: "gemini-2.5-pro" })?.thinkingParam).toBe("thinkingBudget");
    expect(modelCapabilitiesForFamily({ family: "gemini", model: "gemini-3.6-flash" })?.thinkingParam).toBe("thinkingLevel");
  });
});

describe("manual thinking budget round-trip", () => {
  it("saves, surfaces, preserves and clears maxReasoningTokens", async () => {
    freshHome();
    const base = { profileId: "legacy", family: "anthropic" as const, model: "claude-sonnet-4-5", thinkingEnabled: true };
    expect((await saveProfile("default", { ...base, maxReasoningTokens: 8192 })).ok).toBe(true);
    let v = await getConfig();
    expect(v.profiles.find((p) => p.id === "legacy")?.maxReasoningTokens).toBe(8192);

    // Absent field on a later save PRESERVES the stored budget (temperature convention).
    expect((await saveProfile("default", base)).ok).toBe(true);
    v = await getConfig();
    expect(v.profiles.find((p) => p.id === "legacy")?.maxReasoningTokens).toBe(8192);

    // Explicit null clears it — what the app sends when the model is not budget-shaped,
    // so a stale budget never rides along after a model switch.
    expect((await saveProfile("default", { ...base, maxReasoningTokens: null })).ok).toBe(true);
    v = await getConfig();
    expect(v.profiles.find((p) => p.id === "legacy")?.maxReasoningTokens).toBeNull();
  });
});

describe("discoverModelsForFamily input hygiene", () => {
  it("returns null on malformed input / no key instead of throwing", async () => {
    freshHome();
    expect(await discoverModelsForFamily("default", { family: 1 as never, model: "m" })).toBeNull();
    // Valid shape but no key anywhere → null (falls back to seeds), no network.
    expect(await discoverModelsForFamily("default", { family: "anthropic", model: "claude-opus-5" })).toBeNull();
  });
});
