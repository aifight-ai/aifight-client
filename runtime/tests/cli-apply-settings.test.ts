// "I changed a setting and nothing happened."
//
// The bridge reads bridge.json once at startup and never looks again, so every
// settings command used to end by telling the user to go type
// `aifight service restart` themselves. Owner hit this on a fresh VPS
// (2026-07-29): the Telegram menu told them three separate times, and they had
// to drop out to the shell each time.
//
// applyPendingBridgeRestart() turns that hint into an action — but only where a
// restart is both needed and free. These tests pin the whole decision table,
// because every wrong branch here is either a silent no-op (the original bug)
// or a restart that costs someone a live match.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writeBridgeConfig, type BridgeConfig } from "../src/bridge/config";
import {
  applyPendingBridgeRestart,
  bridgeRestartPending,
  withDeferredApply,
} from "../src/cli/commands/apply-settings";
import { runBridgeSet } from "../src/cli/commands/bridge-set";
import type { HandlerEnv } from "../src/cli/shared";

const ORIGINAL_HOME = process.env.AIFIGHT_RUNTIME_HOME;
const tmpDirs: string[] = [];

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
  else process.env.AIFIGHT_RUNTIME_HOME = ORIGINAL_HOME;
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

const CONTROL_PORT = 45997;

/**
 * A runtime home where bridge.json is NEWER than the port file — i.e. the user
 * just saved a setting while the bridge was already up. The port file is
 * written when the bridge starts, so its mtime is the "started at" we compare
 * against.
 */
function homeWithPendingEdit(opts: { pending: boolean }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-apply-settings-"));
  tmpDirs.push(dir);
  process.env.AIFIGHT_RUNTIME_HOME = dir;
  fs.writeFileSync(path.join(dir, "token"), "a".repeat(64), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "port"), String(CONTROL_PORT), { mode: 0o644 });
  fs.writeFileSync(path.join(dir, "bridge.json"), "{}", { mode: 0o600 });
  // mtimes land in the same millisecond on a fast filesystem, and "equal" must
  // not read as "changed" — set them explicitly so the intent is unambiguous.
  const started = new Date("2026-07-29T10:00:00Z");
  const saved = opts.pending ? new Date("2026-07-29T10:05:00Z") : new Date("2026-07-29T09:55:00Z");
  fs.utimesSync(path.join(dir, "port"), started, started);
  fs.utimesSync(path.join(dir, "bridge.json"), saved, saved);
  return dir;
}

/** An installed launchd service whose `launchctl print` succeeds (= running). */
function serviceDeps(
  root: string,
  calls: string[][],
  opts: { installed?: boolean; running?: boolean; restartFails?: boolean } = {},
) {
  const unitPath = path.join(root, "ai.aifight.service.plist");
  if (opts.installed !== false) fs.writeFileSync(unitPath, "<plist/>");
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
      if (opts.restartFails === true && args.includes("bootstrap")) {
        throw new Error("Load failed: 5: Input/output error");
      }
      return { stdout: "", stderr: "" };
    },
  };
}

/** Answers the /v1/agents probe applyPendingBridgeRestart uses to spot a match. */
function fakeFetch(phase: string | null): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    if (url.includes("/v1/agents")) {
      return new Response(
        JSON.stringify({ agents: [{ name: "a", state: phase === null ? null : { phase } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

function makeEnv(out: string[], deps: unknown, phase: string | null): HandlerEnv {
  return {
    stdout: (s) => out.push(s),
    stderr: (s) => out.push(s),
    fetchImpl: fakeFetch(phase),
    bridgeService: deps as HandlerEnv["bridgeService"],
  };
}

const restarted = (calls: string[][]) => calls.some((c) => c.includes("bootout") || c.includes("bootstrap"));

describe("bridgeRestartPending", () => {
  it("is true when bridge.json was saved after the bridge started", () => {
    homeWithPendingEdit({ pending: true });
    expect(bridgeRestartPending()).toBe(true);
  });

  it("is false when the config predates the running bridge", () => {
    homeWithPendingEdit({ pending: false });
    expect(bridgeRestartPending()).toBe(false);
  });

  it("is false when no bridge is running here (no port file)", () => {
    const dir = homeWithPendingEdit({ pending: true });
    fs.rmSync(path.join(dir, "port"));
    // Nothing is holding stale settings in memory, so there is nothing to apply.
    expect(bridgeRestartPending()).toBe(false);
  });
});

describe("applyPendingBridgeRestart", () => {
  it("restarts on a yes and says the settings are live", async () => {
    const home = homeWithPendingEdit({ pending: true });
    const calls: string[][] = [];
    const out: string[] = [];

    const outcome = await applyPendingBridgeRestart(makeEnv(out, serviceDeps(home, calls), "connected"), {
      interactive: true,
      promptYesNo: async () => true,
    });

    expect(outcome).toBe("restarted");
    expect(restarted(calls)).toBe(true);
    expect(out.join("")).toContain("the new settings are live");
  });

  // 批 U4 (统一交互规范 P4/P6): this is the most-asked question in the whole
  // CLI, so it is also the one that must look like every other confirmation.
  it("asks P4's bare question — the [Y/n] bracket belongs to the prompt, not the text", async () => {
    const home = homeWithPendingEdit({ pending: true });
    const calls: string[][] = [];
    const out: string[] = [];
    const asked: string[] = [];

    await applyPendingBridgeRestart(makeEnv(out, serviceDeps(home, calls), "connected"), {
      interactive: true,
      promptYesNo: async (q) => {
        asked.push(q);
        return true;
      },
    });

    // promptYesNo appends the bracket itself; a question that also spells it
    // renders `... ? [Y/n] [Y/n] ` — the shape U4 removed everywhere.
    expect(asked).toEqual(["Restart the bridge now so it takes effect?"]);
  });

  it("leads the restarted line with the success icon (P6)", async () => {
    const home = homeWithPendingEdit({ pending: true });
    const calls: string[][] = [];
    const out: string[] = [];
    const env: HandlerEnv = {
      ...makeEnv(out, serviceDeps(home, calls), "connected"),
      statusIcons: { ok: "✓", warn: "⚠" },
    };

    expect(await applyPendingBridgeRestart(env, { interactive: true, promptYesNo: async () => true }))
      .toBe("restarted");
    expect(out.join("")).toContain("✓ aifight.service restarted");
  });

  it("does nothing at all when no setting changed since startup", async () => {
    const home = homeWithPendingEdit({ pending: false });
    const calls: string[][] = [];
    const out: string[] = [];

    const outcome = await applyPendingBridgeRestart(makeEnv(out, serviceDeps(home, calls), "connected"), {
      interactive: true,
      promptYesNo: async () => true,
    });

    expect(outcome).toBe("not_needed");
    expect(calls).toEqual([]);
    // No news is good news: an unconditional call after every write must stay
    // silent when there is nothing to apply.
    expect(out.join("")).toBe("");
  });

  it("never restarts mid-match — the agent would miss its turn and lose on time", async () => {
    const home = homeWithPendingEdit({ pending: true });
    const calls: string[][] = [];
    const out: string[] = [];

    const outcome = await applyPendingBridgeRestart(makeEnv(out, serviceDeps(home, calls), "in_match"), {
      interactive: true,
      promptYesNo: async () => true, // even an eager yes must not win here
    });

    expect(outcome).toBe("match_in_progress");
    expect(restarted(calls)).toBe(false);
    expect(out.join("")).toContain("A match is in progress");
    expect(out.join("")).toContain("aifight service restart");
  });

  it("declining leaves the bridge alone and points at the manual command", async () => {
    const home = homeWithPendingEdit({ pending: true });
    const calls: string[][] = [];
    const out: string[] = [];

    const outcome = await applyPendingBridgeRestart(makeEnv(out, serviceDeps(home, calls), "connected"), {
      interactive: true,
      promptYesNo: async () => false,
    });

    expect(outcome).toBe("declined");
    expect(restarted(calls)).toBe(false);
    expect(out.join("")).toContain("aifight service restart");
  });

  it("--json prints nothing and never restarts — scripts keep their old behaviour", async () => {
    const home = homeWithPendingEdit({ pending: true });
    const calls: string[][] = [];
    const out: string[] = [];

    const outcome = await applyPendingBridgeRestart(makeEnv(out, serviceDeps(home, calls), "connected"), {
      jsonMode: true,
      interactive: true,
      promptYesNo: async () => true,
    });

    expect(outcome).toBe("declined");
    expect(restarted(calls)).toBe(false);
    // A JSON consumer parses stdout — one stray English line would break it.
    expect(out.join("")).toBe("");
  });

  it("a non-TTY (pipe, cron) gets the old hint instead of a hung prompt", async () => {
    const home = homeWithPendingEdit({ pending: true });
    const calls: string[][] = [];
    const out: string[] = [];

    const outcome = await applyPendingBridgeRestart(makeEnv(out, serviceDeps(home, calls), "connected"), {
      interactive: false,
      promptYesNo: async () => {
        throw new Error("must not prompt without a terminal");
      },
    });

    expect(outcome).toBe("declined");
    expect(restarted(calls)).toBe(false);
    expect(out.join("")).toContain("aifight service restart");
  });

  it("with the service installed but stopped, it just says the next start picks it up", async () => {
    const home = homeWithPendingEdit({ pending: true });
    const calls: string[][] = [];
    const out: string[] = [];

    const outcome = await applyPendingBridgeRestart(
      makeEnv(out, serviceDeps(home, calls, { running: false }), "connected"),
      { interactive: true, promptYesNo: async () => true },
    );

    expect(outcome).toBe("not_running");
    expect(restarted(calls)).toBe(false);
    expect(out.join("")).toContain("next time it starts");
  });

  it("stays quiet inside withDeferredApply, and works again after it", async () => {
    const home = homeWithPendingEdit({ pending: true });
    const calls: string[][] = [];
    const out: string[] = [];
    const env = makeEnv(out, serviceDeps(home, calls), "connected");
    const opts = { interactive: true, promptYesNo: async () => true };

    const inside = await withDeferredApply(() => applyPendingBridgeRestart(env, opts));
    expect(inside).toBe("deferred");
    expect(restarted(calls)).toBe(false);
    expect(out.join("")).toBe("");

    expect(await applyPendingBridgeRestart(env, opts)).toBe("restarted");
  });

  it("un-defers even when the wrapped action throws", async () => {
    // A failed edit must not leave every later command silently deferred.
    const home = homeWithPendingEdit({ pending: true });
    const calls: string[][] = [];
    const env = makeEnv([], serviceDeps(home, calls), "connected");

    await expect(
      withDeferredApply(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await applyPendingBridgeRestart(env, { interactive: true, promptYesNo: async () => true }))
      .toBe("restarted");
  });

  it("`aifight set game` saves with the connect-edge truth — no restart hint (V3)", async () => {
    // V3 重启精确化: the running bridge re-reads the games list at every
    // connect edge, so `set game` no longer reaches the apply path at all —
    // the after-save line states the truth instead of offering a restart.
    const home = homeWithPendingEdit({ pending: false });
    const calls: string[][] = [];
    const out: string[] = [];
    const config: BridgeConfig = {
      version: 1,
      baseUrl: "https://aifight.ai",
      wsUrl: "wss://aifight.ai/api/ws",
      agentId: "00000000-0000-4000-8000-000000000001",
      agentName: "PokerMind",
      apiKey: "sk-existing-secret",
      runtimeType: "direct",
      runtimeLocalUrl: "direct://local",
      runtimeModel: "direct",
      directAgentSlug: "default",
      autoGames: ["coup"],
      updatedAt: "2026-07-27T00:00:00.000Z",
    };
    writeBridgeConfig(config);
    const mtimeBefore = fs.statSync(path.join(home, "bridge.json")).mtimeMs;

    const rc = await runBridgeSet(
      { positional: ["game", "texas_holdem"], flags: {}, jsonMode: false },
      makeEnv(out, serviceDeps(home, calls), "connected"),
    );

    expect(rc).toBe(0);
    expect(out.join("")).toContain("Automatic match games set to: texas_holdem");
    // No bridge seat in this test home → the "next start" variant of the truth.
    expect(out.join("")).toContain("applies on next bridge start");
    expect(out.join("")).not.toContain("service restart");
    // And the write must not arm the menu's restart offer: preserveMtime
    // restored the pre-write mtime (sub-ms filesystem precision noise aside —
    // a real bump lands milliseconds-to-seconds in the future).
    const mtimeAfter = fs.statSync(path.join(home, "bridge.json")).mtimeMs;
    expect(Math.abs(mtimeAfter - mtimeBefore)).toBeLessThan(2);
  });

  it("an LLM profile config saved after the bridge started counts as pending (V3)", () => {
    homeWithPendingEdit({ pending: false });
    const prev = process.env.AIFIGHT_HOME;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-apply-llm-"));
    tmpDirs.push(dir);
    process.env.AIFIGHT_HOME = dir;
    try {
      const profileDir = path.join(dir, "agents", "default");
      fs.mkdirSync(profileDir, { recursive: true });
      const cfg = path.join(profileDir, "config.json");
      fs.writeFileSync(cfg, "{}");
      // The port file sits at 2026-07-29T10:00 — this edit lands after it.
      const saved = new Date("2026-07-29T10:05:00Z");
      fs.utimesSync(cfg, saved, saved);
      expect(bridgeRestartPending()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.AIFIGHT_HOME;
      else process.env.AIFIGHT_HOME = prev;
    }
  });

  it("an LLM profile config that predates the bridge start is not pending", () => {
    homeWithPendingEdit({ pending: false });
    const prev = process.env.AIFIGHT_HOME;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-apply-llm-"));
    tmpDirs.push(dir);
    process.env.AIFIGHT_HOME = dir;
    try {
      const profileDir = path.join(dir, "agents", "default");
      fs.mkdirSync(profileDir, { recursive: true });
      const cfg = path.join(profileDir, "config.json");
      fs.writeFileSync(cfg, "{}");
      const saved = new Date("2026-07-29T09:55:00Z");
      fs.utimesSync(cfg, saved, saved);
      expect(bridgeRestartPending()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.AIFIGHT_HOME;
      else process.env.AIFIGHT_HOME = prev;
    }
  });

  it("reports a failed restart on stderr and keeps the saved setting", async () => {
    const home = homeWithPendingEdit({ pending: true });
    const calls: string[][] = [];
    const err: string[] = [];
    const env: HandlerEnv = {
      stdout: () => undefined,
      stderr: (s) => err.push(s),
      fetchImpl: fakeFetch("connected"),
      bridgeService: serviceDeps(home, calls, { restartFails: true }) as HandlerEnv["bridgeService"],
    };

    const outcome = await applyPendingBridgeRestart(env, { interactive: true, promptYesNo: async () => true });

    expect(outcome).toBe("failed");
    // P6 (U4): the failure line reads `✗ message`, hint plain underneath.
    expect(err.join("")).toContain("✗ aifight.service could not be restarted");
    // The write already happened — the user must not think their edit was lost.
    expect(err.join("")).toContain("The setting is saved");
  });
});
