// Batch B2 — `aifight sessions show` / `list` surface a token-truncated match
// with a "raise max tokens" fix line. Seeds the local store, then drives run().

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-sess-trunc-"));
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
function actionRequest(): MsgActionRequest {
  return {
    type: "action_request",
    data: { match_id: "sess-1", state: { your_player_id: "p0" }, legal_actions: [{ type: "challenge" }], players: [], timeout_ms: 300000, new_events: [] },
  } as unknown as MsgActionRequest;
}

function seedTruncatedSession() {
  // Config with a claude profile so the fix line can compute the model ceiling.
  const dir = path.join(tmpDir, "agents", "default");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    schemaVersion: 1, activeProfile: "claude",
    profiles: { claude: { protocol: "anthropic_messages", apiKeyRef: { type: "env", name: "K" }, model: "claude-opus-4-7" } },
    routing: { default: "claude" },
  }));
  const store = new LocalMatchSessionStore({ runtimeHome: path.join(tmpDir, "runtime"), now: () => new Date("2026-05-18T01:00:00Z") });
  store.recordDecision({
    config: bridgeConfig(),
    context: { actionRequest: actionRequest(), matchId: "sess-1", game: "liars_dice", state: null } as never,
    startedAt: new Date("2026-05-18T01:00:00Z"), completedAt: new Date("2026-05-18T01:00:01Z"),
    traces: [{ type: "runtime_success", matchId: "sess-1", attempt: 1, raw: { kind: "text", preview: "…" }, truncated: true, profileId: "claude" } as never],
    action: { type: "challenge" },
  });
}

function seedAuthErrorSession() {
  const store = new LocalMatchSessionStore({ runtimeHome: path.join(tmpDir, "runtime"), now: () => new Date("2026-05-18T03:00:00Z") });
  store.recordDecision({
    config: bridgeConfig(),
    context: { actionRequest: actionRequest(), matchId: "sess-auth", game: "liars_dice", state: null } as never,
    startedAt: new Date("2026-05-18T03:00:00Z"), completedAt: new Date("2026-05-18T03:00:01Z"),
    traces: [
      { type: "runtime_failure", matchId: "sess-auth", attempt: 1, error: "HTTP 401 invalid key", errorClass: "auth" } as never,
      { type: "final_action", matchId: "sess-auth", source: "fallback", action: { type: "challenge" } } as never,
    ],
    action: { type: "challenge" },
  });
}

describe("sessions truncation surfacing (Batch B2)", () => {
  it("`sessions show` prints the truncation warning + the ceiling fix command", async () => {
    seedTruncatedSession();
    const r = await runCapture(["sessions", "show", "sess-1"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Truncated: 1 decision/);
    // claude-opus-4-7 ceiling is 128000
    expect(r.stdout).toMatch(/config update claude --max-tokens 128000/);
  });

  it("`sessions list` shows truncated=N", async () => {
    seedTruncatedSession();
    const r = await runCapture(["sessions", "list"]);
    expect(r.stdout).toMatch(/truncated=1/);
  });

  it("no truncation → no warning line", async () => {
    const store = new LocalMatchSessionStore({ runtimeHome: path.join(tmpDir, "runtime"), now: () => new Date("2026-05-18T02:00:00Z") });
    store.recordDecision({
      config: bridgeConfig(),
      context: { actionRequest: actionRequest(), matchId: "sess-2", game: "liars_dice", state: null } as never,
      startedAt: new Date("2026-05-18T02:00:00Z"), completedAt: new Date("2026-05-18T02:00:01Z"),
      traces: [{ type: "runtime_success", matchId: "sess-2", attempt: 1, raw: { kind: "text", preview: "ok" } } as never],
      action: { type: "challenge" },
    });
    const r = await runCapture(["sessions", "show", "sess-2"]);
    expect(r.stdout).not.toMatch(/Truncated:/);
  });

  it("`sessions show` classifies a fell-back API error with an actionable hint (Batch D)", async () => {
    seedAuthErrorSession();
    const r = await runCapture(["sessions", "show", "sess-auth"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/fell back to a safe move after an API error/);
    expect(r.stdout).toMatch(/auth ×1/);
    expect(r.stdout).toMatch(/aifight config test/);
  });

  it("`sessions list` shows errors=N (Batch D)", async () => {
    seedAuthErrorSession();
    const r = await runCapture(["sessions", "list"]);
    expect(r.stdout).toMatch(/errors=1/);
  });
});
