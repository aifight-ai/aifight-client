import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_GLOBAL_STRATEGY,
  loadLocalStrategy,
  resolveLocalStrategyPaths,
  scaffoldGlobalStrategy,
} from "../src/strategy/local-strategy";

// Strategy-MD convergence: a fresh agent gets exactly ONE strategy file —
// strategy/global.md — scaffolded at the same path the runtime reads each
// decision. No strategy.json / soul.md. The scaffold is idempotent and never
// clobbers an edited file.
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

  it("creates strategy/global.md with the default template, and nothing else", async () => {
    const result = await scaffoldGlobalStrategy("agent-x");
    expect(result).toBe("created");

    const paths = resolveLocalStrategyPaths("agent-x");
    expect(fs.existsSync(paths.global)).toBe(true);
    expect(fs.readFileSync(paths.global, "utf8")).toBe(DEFAULT_GLOBAL_STRATEGY);

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

  it("the scaffolded file is what the runtime loads as the global section", async () => {
    await scaffoldGlobalStrategy("agent-x");
    const bundle = loadLocalStrategy("agent-x", "texas_holdem");
    const global = bundle.sections.find((s) => s.scope === "global");
    expect(global).toBeDefined();
    expect(global!.content).toBe(DEFAULT_GLOBAL_STRATEGY.trim());
  });
});
