// `aifight update` must never take the agent off the table mid-hand.
//
// The npm install is harmless — a running Bridge already has its code in memory.
// Restarting the service is what drops the WebSocket, and doing that during a
// match makes the agent miss its turn and lose on time. So the install always
// runs and only the restart waits, using the same "busy" definition the
// unattended auto-updater uses, asked over the local control API.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runBridgeUpdate } from "../src/cli/commands/bridge-update";
import type { HandlerArgs, HandlerEnv } from "../src/cli/shared";

const ORIGINAL_HOME = process.env.AIFIGHT_RUNTIME_HOME;
const ORIGINAL_BASE_URL = process.env.AIFIGHT_BASE_URL;
const tmpDirs: string[] = [];

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
  else process.env.AIFIGHT_RUNTIME_HOME = ORIGINAL_HOME;
  if (ORIGINAL_BASE_URL === undefined) delete process.env.AIFIGHT_BASE_URL;
  else process.env.AIFIGHT_BASE_URL = ORIGINAL_BASE_URL;
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

const CONTROL_PORT = 45999;

/** A runtime home with the token+port a control client needs to reach us. */
function freshHomeWithControlFiles(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-update-guard-"));
  tmpDirs.push(dir);
  process.env.AIFIGHT_RUNTIME_HOME = dir;
  fs.writeFileSync(path.join(dir, "token"), "a".repeat(64), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "port"), String(CONTROL_PORT), { mode: 0o644 });
  return dir;
}

/** An installed + running launchd service, so the restart path is reachable. */
function installedServiceDeps(root: string, calls: string[][]) {
  const unitPath = path.join(root, "ai.aifight.service.plist");
  fs.writeFileSync(unitPath, "<plist/>");
  // The service resolver lstat()s these before it will touch the unit.
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
      return { stdout: "", stderr: "" };
    },
  };
}

/** Answers the version check (so an update is pending) and the agents probe.
 *  `npmVersion` controls the npm registry arm: a string = registry answers
 *  with that latest (the manual update then pins it exactly); "fail" =
 *  registry unreachable (the degraded server-only arm → unpinned install). */
function fakeFetch(phase: string | null, npmVersion: string | "fail"): typeof fetch {
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
      if (npmVersion === "fail") throw new Error("registry unreachable");
      return new Response(JSON.stringify({ version: npmVersion }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/v1/agents")) {
      return new Response(
        JSON.stringify({ agents: [{ name: "a", state: phase === null ? null : { phase } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

function makeEnv(out: string[], deps: ReturnType<typeof installedServiceDeps>, phase: string | null, npmVersion: string | "fail"): HandlerEnv {
  return {
    stdout: (s) => out.push(s),
    stderr: (s) => out.push(s),
    fetchImpl: fakeFetch(phase, npmVersion),
    bridgeService: deps,
  };
}

const ARGS: HandlerArgs = { positional: [], flags: { yes: true }, jsonMode: false };

describe("aifight update — match-in-progress guard", () => {
  it("installs the package but does NOT restart while a match is being played", async () => {
    const home = freshHomeWithControlFiles();
    const calls: string[][] = [];
    const out: string[] = [];
    const deps = installedServiceDeps(home, calls);

    const rc = await runBridgeUpdate(ARGS, makeEnv(out, deps, "in_match", "9.9.9"));

    expect(rc).toBe(0);
    const text = out.join("");
    expect(text).toContain("A match is in progress");
    expect(text).toContain("aifight service restart");
    // The package IS updated — waiting must not cost the user the update.
    expect(calls.some((c) => c[0] === "npm" && c.includes("install"))).toBe(true);
    // ...but the service keeps playing.
    expect(calls.some((c) => c.includes("bootout") || c.includes("bootstrap"))).toBe(false);
  });

  it("restarts normally when the agent is idle, pinning the npm registry latest", async () => {
    const home = freshHomeWithControlFiles();
    const calls: string[][] = [];
    const out: string[] = [];
    const deps = installedServiceDeps(home, calls);

    const rc = await runBridgeUpdate(ARGS, makeEnv(out, deps, "connected", "9.9.9"));

    expect(rc).toBe(0);
    const text = out.join("");
    expect(text).not.toContain("A match is in progress");
    expect(text).toContain("aifight.service restarted.");
    // The registry answered, so the manual update installs that EXACT version
    // (owner decision 2026-07-30: the CLI asks npm for the latest, not the server).
    expect(calls.some((c) => c.join(" ") === "npm install -g @aifight/aifight@9.9.9")).toBe(true);
  });

  it("installs unpinned when the registry is unreachable (degraded server-only arm)", async () => {
    const home = freshHomeWithControlFiles();
    const calls: string[][] = [];
    const out: string[] = [];
    const deps = installedServiceDeps(home, calls);

    const rc = await runBridgeUpdate(ARGS, makeEnv(out, deps, "connected", "fail"));

    expect(rc).toBe(0);
    expect(out.join("")).toContain("aifight.service restarted.");
    // No exact version from npm → the user-initiated update falls back to
    // npm's own latest dist-tag.
    expect(calls.some((c) => c.join(" ") === "npm install -g @aifight/aifight")).toBe(true);
  });

  it("--force restarts even mid-match", async () => {
    const home = freshHomeWithControlFiles();
    const calls: string[][] = [];
    const out: string[] = [];
    const deps = installedServiceDeps(home, calls);

    const rc = await runBridgeUpdate(
      { ...ARGS, flags: { yes: true, force: true } },
      makeEnv(out, deps, "in_match", "9.9.9"),
    );

    expect(rc).toBe(0);
    expect(out.join("")).toContain("aifight.service restarted.");
  });

  it("does not block the update when no Bridge answers the probe", async () => {
    // A wedged or stopped Bridge is exactly when updating matters most, so an
    // unanswered probe must never be read as "busy".
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-update-guard-"));
    tmpDirs.push(home);
    process.env.AIFIGHT_RUNTIME_HOME = home; // no token/port written
    const calls: string[][] = [];
    const out: string[] = [];
    const deps = installedServiceDeps(home, calls);

    const rc = await runBridgeUpdate(ARGS, makeEnv(out, deps, null, "9.9.9"));

    expect(rc).toBe(0);
    expect(out.join("")).toContain("aifight.service restarted.");
  });

  // V2 (2026-07-31): the update-completed line leads with a green ✓ (ASCII
  // "OK" when colors are off); --json never carries it.
  it("leads the completed update with ✓ in human output, never in --json", async () => {
    const home = freshHomeWithControlFiles();
    const calls: string[][] = [];
    const out: string[] = [];
    const deps = installedServiceDeps(home, calls);

    const env: HandlerEnv = {
      ...makeEnv(out, deps, "connected", "9.9.9"),
      statusIcons: { ok: "✓", warn: "⚠" },
    };
    const rc = await runBridgeUpdate(ARGS, env);
    expect(rc).toBe(0);
    expect(out.join("")).toContain("✓ AIFight CLI package updated.");

    const jsonOut: string[] = [];
    const jsonRc = await runBridgeUpdate(
      { ...ARGS, jsonMode: true },
      { ...makeEnv(jsonOut, deps, "connected", "9.9.9"), statusIcons: { ok: "✓", warn: "⚠" } },
    );
    expect(jsonRc).toBe(0);
    expect(jsonOut.join("")).not.toContain("✓");
    expect(JSON.parse(jsonOut.join("").trim())).toMatchObject({ status: "updated" });
  });
});
