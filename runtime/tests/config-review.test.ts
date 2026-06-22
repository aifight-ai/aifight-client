import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runConfig } from "../src/cli/commands/config";
import type { HandlerArgs, HandlerEnv } from "../src/cli/shared";

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-config-review-"));
  prevHome = process.env.AIFIGHT_HOME;
  process.env.AIFIGHT_HOME = home;
  const dir = path.join(home, "agents", "default");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({
      schemaVersion: 1,
      activeProfile: "p1",
      profiles: {
        p1: { protocol: "anthropic_messages", model: "m", apiKeyRef: { type: "env", name: "X" } },
        cheap: { protocol: "anthropic_messages", model: "h", apiKeyRef: { type: "env", name: "X" } },
      },
      routing: { default: "p1" },
    }),
  );
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.AIFIGHT_HOME;
  else process.env.AIFIGHT_HOME = prevHome;
});

function capture(): { env: HandlerEnv; out: () => string } {
  const buf: string[] = [];
  const env = { stdout: (s: string) => buf.push(s), stderr: () => {} } as unknown as HandlerEnv;
  return { env, out: () => buf.join("") };
}

function args(positional: string[], jsonMode = false): HandlerArgs {
  return { positional, flags: {}, jsonMode };
}

describe("aifight config review", () => {
  it("defaults autoMode to off when no selfReview is set", async () => {
    const { env, out } = capture();
    const code = await runConfig(args(["review"], true), env);
    expect(code).toBe(0);
    expect(JSON.parse(out())).toMatchObject({ selfReview: { autoMode: "off" } });
  });

  it("sets autoMode and persists it", async () => {
    await runConfig(args(["review", "auto", "losses_only"]), capture().env);
    const { env, out } = capture();
    await runConfig(args(["review"], true), env);
    expect(JSON.parse(out()).selfReview.autoMode).toBe("losses_only");
  });

  it("sets and clears the review model", async () => {
    await runConfig(args(["review", "model", "cheap"]), capture().env);
    let cap = capture();
    await runConfig(args(["review"], true), cap.env);
    expect(JSON.parse(cap.out()).selfReview.model).toBe("cheap");

    await runConfig(args(["review", "model", "none"]), capture().env);
    cap = capture();
    await runConfig(args(["review"], true), cap.env);
    expect(JSON.parse(cap.out()).selfReview.model).toBe("");
  });

  it("rejects an invalid auto mode", async () => {
    await expect(runConfig(args(["review", "auto", "sometimes"]), capture().env)).rejects.toThrow();
  });

  it("rejects an unknown review model profile", async () => {
    await expect(runConfig(args(["review", "model", "ghost"]), capture().env)).rejects.toThrow();
  });
});
