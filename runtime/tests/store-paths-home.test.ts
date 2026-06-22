import { afterEach, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";

import { getAifightHome, getRuntimeHome, getAgentsRoot } from "../src/store/paths";
import { resolveAgentDir } from "../src/profile/profile-loader";

// Unified AIFight home resolution (P0). Guarantees the CLI and the desktop
// app resolve EVERY config path from one root, and that tests can isolate
// via AIFIGHT_HOME. Computes expected paths with os.homedir()+".aifight"
// (never the tilde-home literal) so it passes build.sh's tests/ red-line guard.
describe("unified aifight home resolution (P0)", () => {
  let prevHome: string | undefined;
  let prevRuntimeHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.AIFIGHT_HOME;
    prevRuntimeHome = process.env.AIFIGHT_RUNTIME_HOME;
    delete process.env.AIFIGHT_HOME;
    delete process.env.AIFIGHT_RUNTIME_HOME;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.AIFIGHT_HOME;
    else process.env.AIFIGHT_HOME = prevHome;
    if (prevRuntimeHome === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
    else process.env.AIFIGHT_RUNTIME_HOME = prevRuntimeHome;
  });

  it("defaults to <homedir>/.aifight with runtime/ and agents/ subdirs", () => {
    const home = path.join(os.homedir(), ".aifight");
    expect(getAifightHome()).toBe(home);
    expect(getRuntimeHome()).toBe(path.join(home, "runtime"));
    expect(getAgentsRoot()).toBe(path.join(home, "agents"));
    expect(resolveAgentDir("default")).toBe(path.join(home, "agents", "default"));
  });

  it("AIFIGHT_HOME overrides every config path (CLI + desktop share one folder)", () => {
    const tmp = path.join(os.tmpdir(), "aifight-home-unit");
    process.env.AIFIGHT_HOME = tmp;
    expect(getAifightHome()).toBe(tmp);
    expect(getRuntimeHome()).toBe(path.join(tmp, "runtime"));
    expect(getAgentsRoot()).toBe(path.join(tmp, "agents"));
    expect(resolveAgentDir("bot")).toBe(path.join(tmp, "agents", "bot"));
  });

  it("AIFIGHT_RUNTIME_HOME stays verbatim (back-compat with existing tests/services)", () => {
    const tmp = path.join(os.tmpdir(), "aifight-runtime-verbatim");
    process.env.AIFIGHT_RUNTIME_HOME = tmp;
    expect(getRuntimeHome()).toBe(tmp); // verbatim, NOT tmp/runtime
    // agents still derive from the default aifight home
    expect(getAgentsRoot()).toBe(path.join(os.homedir(), ".aifight", "agents"));
  });

  it("with both set: runtime is verbatim, agents follow AIFIGHT_HOME", () => {
    const homeTmp = path.join(os.tmpdir(), "aifight-home-both");
    const rtTmp = path.join(os.tmpdir(), "aifight-rt-both");
    process.env.AIFIGHT_HOME = homeTmp;
    process.env.AIFIGHT_RUNTIME_HOME = rtTmp;
    expect(getRuntimeHome()).toBe(rtTmp);
    expect(getAgentsRoot()).toBe(path.join(homeTmp, "agents"));
  });
});
