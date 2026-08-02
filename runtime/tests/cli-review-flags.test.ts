// H1 (Kimi K3 review) — `aifight review` flags must be registered in FLAG_SPEC.
// beta.19 shipped with --regen/--no-generate/--locale missing, so every use —
// including the desktop replay panel's read-only probe (cli-host sends
// ["review", <id>, "--json", "--no-generate"]) — died at the parser with
// "unknown flag" (exit 2) before reaching the handler. The pre-existing
// self-review tests call the handler directly with pre-parsed flags, which is
// exactly how this escaped: these tests drive the real run() entry instead.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { run } from "../src/cli/main";
import { LocalMatchSessionStore } from "../src/session/local-match-session-store";
import type { BridgeConfig } from "../src/bridge/config";
import type { MsgActionRequest } from "../src/protocol/types";

let prevHome: string | undefined;
let tmpDir: string;

beforeEach(() => {
  prevHome = process.env.AIFIGHT_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-review-flags-"));
  process.env.AIFIGHT_HOME = tmpDir;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.AIFIGHT_HOME;
  else process.env.AIFIGHT_HOME = prevHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function runCapture(argv: readonly string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

function bridgeConfig(): BridgeConfig {
  return {
    version: 1, baseUrl: "https://aifight.ai", wsUrl: "wss://aifight.ai/api/ws",
    agentId: "agent-1", agentName: "alpha", apiKey: "sk-x",
    runtimeType: "direct", runtimeLocalUrl: "mock://local", runtimeModel: "m",
    updatedAt: "2026-05-18T00:00:00.000Z",
  };
}

function actionRequest(matchId: string): MsgActionRequest {
  return {
    type: "action_request",
    data: { match_id: matchId, state: { your_player_id: "p0" }, legal_actions: [{ type: "challenge" }], players: [], timeout_ms: 300000, new_events: [] },
  } as unknown as MsgActionRequest;
}

function seedSession(matchId: string): void {
  const store = new LocalMatchSessionStore({ runtimeHome: path.join(tmpDir, "runtime"), now: () => new Date("2026-05-18T01:00:00Z") });
  store.recordDecision({
    config: bridgeConfig(),
    context: { actionRequest: actionRequest(matchId), matchId, game: "liars_dice", state: null } as never,
    startedAt: new Date("2026-05-18T01:00:00Z"), completedAt: new Date("2026-05-18T01:00:01Z"),
    traces: [{ type: "final_action", matchId, source: "fallback", action: { type: "challenge" } } as never],
    action: { type: "challenge" },
  });
}

describe("review command flags (H1 — Kimi K3 review)", () => {
  it("desktop probe shape `review <id> --json --no-generate` returns {review:null} with exit 0", async () => {
    seedSession("sess-rev-1");
    const r = await runCapture(["review", "sess-rev-1", "--json", "--no-generate"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ review: null });
  });

  it("--regen parses and reaches the handler (session_not_found, not a usage error)", async () => {
    const r = await runCapture(["review", "no-such-session", "--regen"]);
    expect(r.stderr).not.toMatch(/unknown flag/);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/local match session not found/);
  });

  it("--locale parses and reaches the handler (session_not_found, not a usage error)", async () => {
    const r = await runCapture(["review", "no-such-session", "--locale", "zh"]);
    expect(r.stderr).not.toMatch(/unknown flag/);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/local match session not found/);
  });
});

// ── Markdown output (2026-08-02): --md prints, --out writes ──────────
describe("review --md / --out", () => {
  function storedReview(): unknown {
    return {
      schema: 1, generated_at: "2026-08-02T13:05:00.000Z", trigger: "manual",
      model: "test-model", locale: "en", prompt_version: "sr-v1",
      report_text: "A stored review.", suggestion: { scope: "liars_dice", text: "Bid later." },
      token_usage: { input: 10, output: 20 }, source_strategy_hashes: [],
    };
  }
  function seedReviewed(matchId: string): void {
    seedSession(matchId);
    const store = new LocalMatchSessionStore({ runtimeHome: path.join(tmpDir, "runtime"), now: () => new Date("2026-05-18T01:00:00Z") });
    const item = store.getSession(matchId)!;
    store.writeSelfReview(item.session_id, storedReview());
  }

  it("--md prints the stored review as Markdown without any LLM call", async () => {
    seedReviewed("sess-md-1");
    const r = await runCapture(["review", "sess-md-1", "--md"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith("---\n")).toBe(true);
    expect(r.stdout).toContain('model: "test-model"');
    expect(r.stdout).toContain("A stored review.");
    expect(r.stdout).toContain("## Suggested improvement (scope: liars_dice)");
  });

  it("--out <dir> writes a dated file and prints its path", async () => {
    seedReviewed("sess-md-2");
    const outDir = path.join(tmpDir, "exports");
    const r = await runCapture(["review", "sess-md-2", "--out", outDir]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const file = r.stdout.trim();
    expect(file.startsWith(outDir)).toBe(true);
    expect(file.endsWith(".md")).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain("A stored review.");
  });

  it("--out <file.md> writes exactly that file", async () => {
    seedReviewed("sess-md-3");
    const outFile = path.join(tmpDir, "deep", "one.md");
    const r = await runCapture(["review", "sess-md-3", "--out", outFile]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(outFile);
    expect(fs.existsSync(outFile)).toBe(true);
  });

  it("refuses --md together with --json", async () => {
    seedReviewed("sess-md-4");
    const r = await runCapture(["review", "sess-md-4", "--md", "--json"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--md\/--out cannot be combined with --json/);
  });
});
