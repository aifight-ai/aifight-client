// 批 U4 (统一交互规范 P4/P6): the confirmations that live OUTSIDE the menu.
//
// Before U4 each of these commands hand-rolled its own stdin read and spelled
// the `[y/N]` bracket into its own English question. They now all go through
// onboard-io's promptYesNo (P4) with i18n text, and their failures through
// output.fail (P6). What has to hold, and is pinned here:
//
//   * every confirmation actually branches — a yes acts, a no changes nothing;
//   * the destructive ones (uninstall, credential deletion, a second
//     foreground bridge, an unrequested update) default to NO;
//   * no question text carries the bracket — P4 appends it, so a question that
//     also spells it shows it twice.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getBridgeConfigPath, writeBridgeConfig, type BridgeConfig } from "../src/bridge/config";
import { runAcceptTerms } from "../src/cli/commands/accept-terms";
import { runBridgeRun } from "../src/cli/commands/bridge-run";
import { offerBridgeServiceInstall } from "../src/cli/commands/bridge-service";
import { runBridgeUninstall } from "../src/cli/commands/bridge-uninstall";
import { runBridgeUpdate } from "../src/cli/commands/bridge-update";
import { runConfigRemove } from "../src/cli/commands/config-manage";
import { en, type I18nKey } from "../src/cli/i18n-en";
import { zh } from "../src/cli/i18n-zh";
import type { HandlerArgs, HandlerEnv } from "../src/cli/shared";

const ORIGINAL_RUNTIME_HOME = process.env.AIFIGHT_RUNTIME_HOME;
const ORIGINAL_HOME = process.env.AIFIGHT_HOME;
const tmpDirs: string[] = [];

afterEach(() => {
  if (ORIGINAL_RUNTIME_HOME === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
  else process.env.AIFIGHT_RUNTIME_HOME = ORIGINAL_RUNTIME_HOME;
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

function tempHome(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  process.env.AIFIGHT_RUNTIME_HOME = dir;
  return dir;
}

function seedBridgeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  const config: BridgeConfig = {
    version: 1,
    baseUrl: "https://aifight.ai",
    wsUrl: "wss://aifight.ai/api/ws",
    agentId: "00000000-0000-4000-8000-0000000abc123",
    agentName: "Steel Mongoose",
    apiKey: "sk-existing-secret",
    runtimeType: "direct",
    runtimeLocalUrl: "direct://local",
    runtimeModel: "direct",
    directAgentSlug: "default",
    updatedAt: "2026-08-02T00:00:00.000Z",
    ...overrides,
  } as BridgeConfig;
  writeBridgeConfig(config);
  return config;
}

/** A launchd service manager whose every call is recorded. `installed: false`
 *  leaves the plist absent, so status reports "not installed". */
function serviceDeps(
  root: string,
  calls: string[][],
  opts: { installed?: boolean; running?: boolean } = {},
) {
  const unitPath = path.join(root, "ai.aifight.service.plist");
  if (opts.installed === true) fs.writeFileSync(unitPath, "<plist/>");
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "bin", "node"), "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(path.join(root, "bin", "aifight"), "#!/bin/sh\n", { mode: 0o755 });
  return {
    platform: "darwin" as NodeJS.Platform,
    uid: 501,
    homeDir: path.join(root, "home"),
    runtimeHome: path.join(root, "runtime"),
    nodeExec: path.join(root, "bin", "node"),
    aifightExec: path.join(root, "bin", "aifight"),
    launchdPlistPath: unitPath,
    launchdReadyTimeoutMs: 0,
    execFile: async (file: string, args: readonly string[]) => {
      calls.push([file, ...args]);
      if (opts.running === false && args[0] === "print") throw new Error("Could not find service");
      return { stdout: "", stderr: "" };
    },
  } as HandlerEnv["bridgeService"];
}

/** Records what P4 was asked, and answers with a fixed yes/no. */
function recordingConfirm(answer: boolean) {
  const asked: Array<{ question: string; defaultYes: boolean }> = [];
  return {
    asked,
    confirm: async (question: string, defaultYes: boolean) => {
      asked.push({ question, defaultYes });
      return answer;
    },
  };
}

// ── aifight update ───────────────────────────────────────────────────

describe("aifight update — npm confirmation (P4)", () => {
  function updateFetch(): typeof fetch {
    return (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/bridge/version")) {
        return new Response(
          JSON.stringify({
            minimum_supported_version: "0.0.1",
            recommended_version: "9.9.9",
            latest_version: "9.9.9",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.startsWith("https://registry.npmjs.org/")) {
        return new Response(JSON.stringify({ version: "9.9.9" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/v1/agents")) {
        return new Response(JSON.stringify({ agents: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
  }

  const ARGS: HandlerArgs = { positional: [], flags: {}, jsonMode: false };

  async function runUpdate(answer: boolean) {
    const home = tempHome("aifight-u4-update-");
    seedBridgeConfig();
    const calls: string[][] = [];
    const out: string[] = [];
    const { asked, confirm } = recordingConfirm(answer);
    const env: HandlerEnv = {
      stdout: (s) => out.push(s),
      stderr: (s) => out.push(s),
      fetchImpl: updateFetch(),
      bridgeService: serviceDeps(home, calls),
    };
    const rc = await runBridgeUpdate(ARGS, env, confirm);
    return { rc, text: out.join(""), calls, asked };
  }

  const installed = (calls: string[][]) => calls.some((c) => c[0] === "npm" && c.includes("install"));

  it("a no skips the npm install entirely", async () => {
    const { rc, text, calls, asked } = await runUpdate(false);
    expect(rc).toBe(0);
    expect(text).toContain("Update skipped.");
    expect(installed(calls)).toBe(false);
    // An update nobody asked for must not happen on a bare Enter.
    expect(asked[0]?.defaultYes).toBe(false);
  });

  it("a yes runs the npm install", async () => {
    const { rc, calls, asked } = await runUpdate(true);
    expect(rc).toBe(0);
    expect(installed(calls)).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.question).toBe(en["confirm.update.ask"]);
  });
});

// ── aifight uninstall ────────────────────────────────────────────────

describe("aifight uninstall — both confirmations (P4/P6)", () => {
  const ARGS: HandlerArgs = { positional: [], flags: {}, jsonMode: false };

  /** The uninstall flow asks the platform for a profile label first. */
  function statusFetch(): typeof fetch {
    return (async () =>
      new Response(JSON.stringify({ status: "ready" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
  }

  async function runUninstall(opts: {
    outer: boolean;
    credentials?: boolean;
    typed?: string;
  }) {
    const home = tempHome("aifight-u4-uninstall-");
    const config = seedBridgeConfig();
    const calls: string[][] = [];
    const out: string[] = [];
    const asked: Array<{ question: string; defaultYes: boolean }> = [];
    const env: HandlerEnv = {
      stdout: (s) => out.push(s),
      stderr: (s) => out.push(s),
      fetchImpl: statusFetch(),
      bridgeService: serviceDeps(home, calls, { installed: true }),
    };
    const rc = await runBridgeUninstall(ARGS, env, {
      confirm: async (question, defaultYes) => {
        asked.push({ question, defaultYes });
        return asked.length === 1 ? opts.outer : opts.credentials === true;
      },
      promptLine: async () => opts.typed ?? "",
    });
    return {
      rc,
      text: out.join(""),
      asked,
      configStillThere: fs.existsSync(getBridgeConfigPath()),
      suffix: config.agentId.slice(-6),
    };
  }

  it("a no on the first question changes nothing at all", async () => {
    const r = await runUninstall({ outer: false });
    expect(r.rc).toBe(0);
    expect(r.text).toContain("Uninstall cancelled.");
    expect(r.configStillThere).toBe(true);
    // Destructive: a bare Enter must never uninstall.
    expect(r.asked[0]?.defaultYes).toBe(false);
    expect(r.asked[0]?.question).toBe(en["confirm.uninstall.ask"]);
  });

  it("a yes uninstalls the service but keeps credentials when the second question is a no", async () => {
    const r = await runUninstall({ outer: true, credentials: false });
    expect(r.rc).toBe(0);
    expect(r.text).toContain("Kept local bridge credentials.");
    expect(r.configStillThere).toBe(true);
    expect(r.asked).toHaveLength(2);
    // The credential deletion is the most destructive step in the CLI —
    // its default must stay NO.
    expect(r.asked[1]?.defaultYes).toBe(false);
  });

  it("deleting credentials still needs the typed Agent-ID suffix — a yes alone is not enough", async () => {
    const wrong = await runUninstall({ outer: true, credentials: true, typed: "nope42" });
    expect(wrong.rc).toBe(0);
    // P6: the refusal reads `✗ message`, with what actually happened underneath.
    expect(wrong.text).toContain("✗ Confirmation did not match.");
    expect(wrong.text).toContain("Kept local bridge credentials.");
    expect(wrong.configStillThere).toBe(true);
  });

  it("the matching suffix deletes the credentials", async () => {
    const home = tempHome("aifight-u4-uninstall-ok-");
    const config = seedBridgeConfig();
    const calls: string[][] = [];
    const out: string[] = [];
    const env: HandlerEnv = {
      stdout: (s) => out.push(s),
      stderr: (s) => out.push(s),
      fetchImpl: statusFetch(),
      bridgeService: serviceDeps(home, calls, { installed: true }),
      statusIcons: { ok: "✓", warn: "⚠" },
    };
    const rc = await runBridgeUninstall(ARGS, env, {
      confirm: async () => true,
      promptLine: async () => config.agentId.slice(-6),
    });
    expect(rc).toBe(0);
    expect(out.join("")).toContain("✓ Local bridge credentials removed from this machine.");
    expect(fs.existsSync(getBridgeConfigPath())).toBe(false);
  });
});

// ── aifight accept-terms ─────────────────────────────────────────────

describe("aifight accept-terms — the agreement confirmation (P4)", () => {
  function legalFetch(posts: string[]): typeof fetch {
    return (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/agents/me/status")) {
        return new Response(
          JSON.stringify({
            is_claimed: true,
            terms_pending: true,
            current_terms_version: "2026-06-23",
            current_privacy_version: "2026-06-23",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/api/agents/me/accept-legal")) {
        posts.push(String(init?.body ?? ""));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
  }

  async function runTerms(answer: boolean) {
    tempHome("aifight-u4-terms-");
    seedBridgeConfig();
    const posts: string[] = [];
    const out: string[] = [];
    const { asked, confirm } = recordingConfirm(answer);
    const rc = await runAcceptTerms(
      { positional: [], flags: {}, jsonMode: false },
      { stdout: (s) => out.push(s), stderr: (s) => out.push(s), fetchImpl: legalFetch(posts) },
      confirm,
    );
    return { rc, text: out.join(""), posts, asked };
  }

  it("a no records nothing and says the agent stays inactive", async () => {
    const r = await runTerms(false);
    expect(r.rc).toBe(0);
    expect(r.text).toContain("Not accepted.");
    expect(r.posts).toHaveLength(0);
    // Agreeing to a legal document is never what a bare Enter means.
    expect(r.asked[0]?.defaultYes).toBe(false);
    expect(r.asked[0]?.question).toBe(en["confirm.terms.ask"]);
  });

  it("a yes records the acceptance", async () => {
    const r = await runTerms(true);
    expect(r.rc).toBe(0);
    expect(r.posts).toHaveLength(1);
    expect(JSON.parse(r.posts[0]!)).toEqual({
      terms_version: "2026-06-23",
      privacy_version: "2026-06-23",
    });
  });
});

// ── aifight run --force ──────────────────────────────────────────────

describe("aifight run --force — the second-bridge confirmation (P4)", () => {
  const ARGS: HandlerArgs = { positional: [], flags: { force: true }, jsonMode: false };

  it("a no backs out and says so instead of exiting silently", async () => {
    tempHome("aifight-u4-run-");
    const out: string[] = [];
    const { asked, confirm } = recordingConfirm(false);
    const rc = await runBridgeRun(
      ARGS,
      { stdout: (s) => out.push(s), stderr: (s) => out.push(s) },
      confirm,
    );
    expect(rc).toBe(0);
    expect(out.join("")).toContain("Foreground bridge not started.");
    // Two bridges double-handle matches — a bare Enter must not start one.
    expect(asked[0]?.defaultYes).toBe(false);
    expect(asked[0]?.question).toBe(en["confirm.run.ask"]);
  });

  it("a yes carries on past the confirmation into the normal startup path", async () => {
    // No bridge.json in this home, so the very next step fails with the
    // configuration error — which is exactly the proof that the yes was
    // honoured and the flow continued.
    tempHome("aifight-u4-run-yes-");
    const out: string[] = [];
    await expect(
      runBridgeRun(
        ARGS,
        { stdout: (s) => out.push(s), stderr: (s) => out.push(s) },
        async () => true,
      ),
    ).rejects.toThrow(/not configured/i);
    expect(out.join("")).not.toContain("Foreground bridge not started.");
  });
});

// ── the service offer (setup / connect) ──────────────────────────────

describe("offerBridgeServiceInstall — install & restart confirmations (P4)", () => {
  const installed = (calls: string[][]) => calls.some((c) => c.includes("bootstrap"));
  const restarted = (calls: string[][]) => calls.some((c) => c.includes("bootout") || c.includes("bootstrap"));

  it("declining the install leaves the machine untouched", async () => {
    const home = tempHome("aifight-u4-service-");
    const calls: string[][] = [];
    const out: string[] = [];
    const { asked, confirm } = recordingConfirm(false);
    const result = await offerBridgeServiceInstall(
      { stdout: (s) => out.push(s), stderr: (s) => out.push(s), bridgeService: serviceDeps(home, calls) },
      { confirm },
    );
    expect(result).toBe("declined");
    expect(installed(calls)).toBe(false);
    expect(asked[0]?.question).toBe(en["confirm.service.install.ask"]);
    // The banner has just made the case for it, so Enter means yes here.
    expect(asked[0]?.defaultYes).toBe(true);
  });

  it("accepting the install runs it", async () => {
    const home = tempHome("aifight-u4-service-yes-");
    const calls: string[][] = [];
    const out: string[] = [];
    const result = await offerBridgeServiceInstall(
      { stdout: (s) => out.push(s), stderr: (s) => out.push(s), bridgeService: serviceDeps(home, calls) },
      { confirm: async () => true },
    );
    expect(result).toBe("installed");
    expect(installed(calls)).toBe(true);
  });

  it("declining the restart of an already-running service leaves it running", async () => {
    const home = tempHome("aifight-u4-service-restart-");
    const calls: string[][] = [];
    const out: string[] = [];
    const { asked, confirm } = recordingConfirm(false);
    const result = await offerBridgeServiceInstall(
      {
        stdout: (s) => out.push(s),
        stderr: (s) => out.push(s),
        bridgeService: serviceDeps(home, calls, { installed: true, running: true }),
      },
      { confirm },
    );
    expect(result).toBe("declined");
    expect(restarted(calls)).toBe(false);
    expect(asked[0]?.question).toBe(en["confirm.service.restart.ask"]);
    expect(asked[0]?.defaultYes).toBe(true);
  });

  it("accepting the restart restarts it", async () => {
    const home = tempHome("aifight-u4-service-restart-yes-");
    const calls: string[][] = [];
    const out: string[] = [];
    const result = await offerBridgeServiceInstall(
      {
        stdout: (s) => out.push(s),
        stderr: (s) => out.push(s),
        bridgeService: serviceDeps(home, calls, { installed: true, running: true }),
      },
      { confirm: async () => true },
    );
    expect(result).toBe("installed");
    expect(restarted(calls)).toBe(true);
  });
});

// ── aifight config remove ────────────────────────────────────────────

describe("aifight config remove — the typed confirmation", () => {
  function seedProfiles(root: string): void {
    const dir = path.join(root, "agents", "default");
    fs.mkdirSync(dir, { recursive: true });
    const profile = {
      displayName: "x",
      protocol: "anthropic_messages",
      apiKeyRef: { type: "env", name: "K" },
      model: "claude-sonnet-4-6",
      request: { temperature: null, maxTokens: 32000, responseFormat: "json", stream: "auto" },
      thinking: { enabled: true, mode: "always" },
    };
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          activeProfile: "keep",
          profiles: { keep: profile, doomed: profile },
          routing: { default: "keep" },
        },
        null,
        2,
      ) + "\n",
    );
  }

  async function removeWithAnswer(typed: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-u4-remove-"));
    tmpDirs.push(dir);
    process.env.AIFIGHT_HOME = dir;
    seedProfiles(dir);
    const out: string[] = [];
    const asked: string[] = [];
    const rc = await runConfigRemove(
      { positional: ["doomed"], flags: {}, jsonMode: false },
      { stdout: (s) => out.push(s), stderr: (s) => out.push(s) },
      async (question) => {
        asked.push(question);
        return typed;
      },
    );
    const config = JSON.parse(fs.readFileSync(path.join(dir, "agents", "default", "config.json"), "utf8"));
    return { rc, text: out.join(""), asked, profiles: Object.keys(config.profiles) };
  }

  it("anything other than the exact profile id cancels and removes nothing", async () => {
    const r = await removeWithAnswer("doome");
    expect(r.rc).toBe(0);
    expect(r.text).toContain("Cancelled — nothing removed.");
    expect(r.profiles.sort()).toEqual(["doomed", "keep"]);
    expect(r.asked[0]).toContain('Type "doomed" to confirm removal');
  });

  it("typing the profile id removes it", async () => {
    const r = await removeWithAnswer("doomed");
    expect(r.rc).toBe(0);
    expect(r.profiles).toEqual(["keep"]);
  });
});

// ── the P4 dictionary rule ───────────────────────────────────────────

describe("confirm.* dictionary entries", () => {
  it("never spell the [Y/n] bracket — promptYesNo appends it", () => {
    // A question that carries its own bracket renders it twice, which is how
    // this whole family looked before U4 unified it.
    const offenders: string[] = [];
    for (const [table, dict] of [["en", en], ["zh", zh]] as const) {
      for (const key of Object.keys(dict) as I18nKey[]) {
        if (!key.startsWith("confirm.")) continue;
        if (/\[[YyNn]\/[YyNn]\]/.test(dict[key])) offenders.push(`${table}:${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
