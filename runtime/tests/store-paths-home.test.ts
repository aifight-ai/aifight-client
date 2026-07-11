import { afterEach, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";

import { getAifightHome, getRuntimeHome, getAgentsRoot, safePathSegment } from "../src/store/paths";
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

// R13 F-10: resolveAgentDir takes an untrusted agent slug and joins it under
// the agents root. A slug containing "..", separators, or an absolute path must
// never resolve outside the agents root — it is sanitized to a single safe
// segment and, defense-in-depth, containment is asserted (escapes throw).
describe("resolveAgentDir slug containment (R13 F-10)", () => {
  let prevHome: string | undefined;
  const tmpHome = path.join(os.tmpdir(), "aifight-slug-containment");
  const agentsRoot = () => path.resolve(path.join(tmpHome, "agents"));

  beforeEach(() => {
    prevHome = process.env.AIFIGHT_HOME;
    process.env.AIFIGHT_HOME = tmpHome;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.AIFIGHT_HOME;
    else process.env.AIFIGHT_HOME = prevHome;
  });

  it("keeps a normal slug directly under the agents root", () => {
    expect(resolveAgentDir("my-bot")).toBe(path.join(tmpHome, "agents", "my-bot"));
  });

  it("throws for a pure-traversal slug that would escape via '..'", () => {
    expect(() => resolveAgentDir("..")).toThrow(/escapes the agents root/);
  });

  it.each(["/etc/passwd", "../../etc/passwd", "a/../../../etc", "..\\..\\windows", "/", "."])(
    "sanitizes/contains traversal payload %j under the agents root",
    (slug) => {
      const resolved = path.resolve(resolveAgentDir(slug));
      const contained = resolved === agentsRoot() || resolved.startsWith(agentsRoot() + path.sep);
      expect(contained).toBe(true);
      // Sanitized to a single segment: parent is always the agents root itself.
      if (resolved !== agentsRoot()) {
        expect(path.dirname(resolved)).toBe(agentsRoot());
      }
    },
  );

  it("falls back to 'unknown' for an empty slug (still contained)", () => {
    expect(resolveAgentDir("")).toBe(path.join(tmpHome, "agents", "unknown"));
  });
});

describe("safePathSegment (R13 F-10)", () => {
  it("replaces path separators and other unsafe chars with underscore", () => {
    expect(safePathSegment("a/b\\c:d e")).toBe("a_b_c_d_e");
  });

  it("caps length at 128 chars", () => {
    expect(safePathSegment("x".repeat(500)).length).toBe(128);
  });

  it("returns 'unknown' for empty or fully-stripped input", () => {
    expect(safePathSegment("")).toBe("unknown");
  });

  it("preserves already-safe segments verbatim", () => {
    expect(safePathSegment("my-bot_1.2")).toBe("my-bot_1.2");
  });
});
