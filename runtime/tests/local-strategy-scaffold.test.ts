import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadLocalStrategy,
  resolveLocalStrategyPaths,
  scaffoldGlobalStrategy,
} from "../src/strategy/local-strategy";

// Strategy-MD convergence: a fresh agent gets exactly ONE strategy file —
// strategy/global.md — scaffolded EMPTY at the same path the runtime reads each
// decision. There is no default strategy: an empty file is skipped, so nothing
// is injected until the user writes something. No strategy.json / soul.md. The
// scaffold is idempotent and never clobbers an edited file.
describe("scaffoldGlobalStrategy", () => {
  let home: string;
  let prevRuntimeHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-strategy-scaffold-"));
    prevRuntimeHome = process.env.AIFIGHT_RUNTIME_HOME;
    process.env.AIFIGHT_RUNTIME_HOME = home;
  });

  afterEach(() => {
    if (prevRuntimeHome === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
    else process.env.AIFIGHT_RUNTIME_HOME = prevRuntimeHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("creates an empty strategy/global.md, and nothing else", async () => {
    const result = await scaffoldGlobalStrategy("agent-x");
    expect(result).toBe("created");

    const paths = resolveLocalStrategyPaths("agent-x");
    expect(fs.existsSync(paths.global)).toBe(true);
    // No default strategy — the scaffolded file is empty.
    expect(fs.readFileSync(paths.global, "utf8")).toBe("");

    // Only global.md — no per-game files, no JSON, no soul.
    const entries = fs.readdirSync(paths.root);
    expect(entries).toEqual(["global.md"]);
  });

  it("is idempotent — never clobbers an existing (even edited) file", async () => {
    const paths = resolveLocalStrategyPaths("agent-x");
    await scaffoldGlobalStrategy("agent-x");
    fs.writeFileSync(paths.global, "# My own strategy\nBluff less.\n");

    const result = await scaffoldGlobalStrategy("agent-x");
    expect(result).toBe("exists");
    expect(fs.readFileSync(paths.global, "utf8")).toBe("# My own strategy\nBluff less.\n");
  });

  it("injects nothing until the user writes content into the empty scaffold", async () => {
    await scaffoldGlobalStrategy("agent-x");

    // Empty scaffold → the runtime loads no global section (zero injection).
    const empty = loadLocalStrategy("agent-x", "texas_holdem");
    expect(empty.sections.find((s) => s.scope === "global")).toBeUndefined();

    // Once the user writes something, the global section appears.
    const paths = resolveLocalStrategyPaths("agent-x");
    fs.writeFileSync(paths.global, "# My own strategy\nBluff less.\n");
    const filled = loadLocalStrategy("agent-x", "texas_holdem");
    const global = filled.sections.find((s) => s.scope === "global");
    expect(global).toBeDefined();
    expect(global!.content).toBe("# My own strategy\nBluff less.");
  });
});
