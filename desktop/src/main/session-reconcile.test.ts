// session-reconcile: interrupted local rows ask the server for their real
// outcome and fold it through the store's NORMAL game_over path.
//
// Every test runs against a mkdtemp runtimeHome + injected config/fetch/clock —
// nothing here may ever read or write the real ~/.aifight (that bit us once:
// see the matchingPause.test isolation lesson).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BridgeConfig } from "@aifight/aifight/bridge/config";

import { reconcileInterruptedSessions } from "./session-reconcile";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const OPP_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-08-04T12:00:00.000Z");
const FINISHED_AT = "2026-08-04T02:54:00.000Z";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-reconcile-"));
  tempDirs.push(dir);
  return dir;
}

function seedSession(
  home: string,
  sessionId: string,
  overrides: Record<string, unknown> = {},
): string {
  const dir = path.join(home, "agents", AGENT_ID, "sessions", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const summary = {
    version: 1,
    agent_id: AGENT_ID,
    agent_name: "Tester",
    session_id: sessionId,
    status: "active",
    game: "liars_dice",
    player_id: "p0",
    started_at: "2026-08-04T02:30:00.000Z",
    updated_at: "2026-08-04T02:40:00.000Z", // >30min before NOW → interrupted
    inbound_count: 3,
    outbound_count: 1,
    decision_count: 1,
    final_action_count: 1,
    strategy_hashes: [],
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, "session.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return dir;
}

function readSummary(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8")) as Record<string, unknown>;
}

const config = {
  version: 1,
  baseUrl: "https://aifight.test",
  wsUrl: "wss://aifight.test/ws",
  agentId: AGENT_ID,
  agentName: "Tester",
  apiKey: "sk-test",
  runtimeType: "direct",
  runtimeLocalUrl: "",
} as unknown as BridgeConfig;

type Answer = { status: number; body?: unknown };

/** Fake fetch keyed by session id; records every asked session. */
function fakeFetch(answers: Record<string, Answer>) {
  const asked: string[] = [];
  const impl = async (url: string) => {
    const m = /\/api\/agents\/me\/matches\/([^/]+)\/result$/.exec(url);
    const sessionId = m === null ? "" : decodeURIComponent(m[1]!);
    asked.push(sessionId);
    const answer = answers[sessionId];
    if (answer === undefined) return { ok: false, status: 500, json: async () => ({}) };
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => answer.body ?? {},
    };
  };
  return { impl, asked };
}

function completedForfeitBody(sessionId: string, forfeitedBy: string): unknown {
  return {
    status: "completed",
    finished_at: FINISHED_AT,
    game_over: {
      match_id: "33333333-3333-4333-8333-333333333333",
      session_id: sessionId,
      result: { payoffs: { p0: forfeitedBy === "p0" ? 0 : 1, p1: forfeitedBy === "p1" ? 0 : 1 }, winner: forfeitedBy === "p0" ? "p1" : "p0", is_draw: false },
      players: [
        { agent_id: AGENT_ID, agent_name: "Tester", player_id: "p0", position: 0 },
        { agent_id: OPP_AGENT_ID, agent_name: "Rival", player_id: "p1", position: 1 },
      ],
      replay_url: "/replay/replay_abc123",
      forfeit_reason: "disconnect",
      forfeited_by: forfeitedBy,
    },
  };
}

describe("reconcileInterruptedSessions", () => {
  it("completes an interrupted row with the real outcome, stamped at finished_at", async () => {
    const home = makeHome();
    const sid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const dir = seedSession(home, sid);
    const { impl, asked } = fakeFetch({ [sid]: { status: 200, body: completedForfeitBody(sid, "p1") } });

    const outcome = await reconcileInterruptedSessions({
      config,
      runtimeHome: home,
      fetchImpl: impl,
      now: () => NOW,
      memo: new Set(),
    });

    expect(outcome).toEqual({ checked: 1, updated: 1 });
    expect(asked).toEqual([sid]);
    const summary = readSummary(dir);
    expect(summary.status).toBe("completed");
    expect(summary.result_label).toBe("opponent forfeit");
    expect(summary.real_match_id).toBe("33333333-3333-4333-8333-333333333333");
    expect(summary.replay_url).toBe("https://aifight.test/replay/replay_abc123");
    expect(summary.opponents).toEqual(["Rival"]);
    expect(summary.player_count).toBe(2);
    // The record must live at the REAL end time — no floating to "just now".
    expect(summary.ended_at).toBe(FINISHED_AT);
    expect(summary.updated_at).toBe(FINISHED_AT);
    // The synthesized game_over lands in inbound.jsonl like a live one would.
    const inbound = fs.readFileSync(path.join(dir, "inbound.jsonl"), "utf8");
    expect(inbound).toContain('"type":"game_over"');
  });

  it("labels my own disconnect forfeit as forfeit, not opponent forfeit", async () => {
    const home = makeHome();
    const sid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const dir = seedSession(home, sid);
    const { impl } = fakeFetch({ [sid]: { status: 200, body: completedForfeitBody(sid, "p0") } });

    const outcome = await reconcileInterruptedSessions({
      config,
      runtimeHome: home,
      fetchImpl: impl,
      now: () => NOW,
      memo: new Set(),
    });

    expect(outcome.updated).toBe(1);
    expect(readSummary(dir).result_label).toBe("forfeit");
  });

  it("leaves a still-active match untouched and asks again next run", async () => {
    const home = makeHome();
    const sid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const dir = seedSession(home, sid);
    const memo = new Set<string>();
    const { impl, asked } = fakeFetch({ [sid]: { status: 200, body: { status: "active" } } });

    const first = await reconcileInterruptedSessions({ config, runtimeHome: home, fetchImpl: impl, now: () => NOW, memo });
    const second = await reconcileInterruptedSessions({ config, runtimeHome: home, fetchImpl: impl, now: () => NOW, memo });

    expect(first).toEqual({ checked: 1, updated: 0 });
    expect(second).toEqual({ checked: 1, updated: 0 }); // no memo — retried
    expect(asked).toEqual([sid, sid]);
    expect(readSummary(dir).status).toBe("active");
  });

  it("remembers 404 answers for the app run instead of re-asking", async () => {
    const home = makeHome();
    const sid = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const dir = seedSession(home, sid);
    const memo = new Set<string>();
    const { impl, asked } = fakeFetch({ [sid]: { status: 404 } });

    const first = await reconcileInterruptedSessions({ config, runtimeHome: home, fetchImpl: impl, now: () => NOW, memo });
    const second = await reconcileInterruptedSessions({ config, runtimeHome: home, fetchImpl: impl, now: () => NOW, memo });

    expect(first).toEqual({ checked: 1, updated: 0 });
    expect(second).toEqual({ checked: 0, updated: 0 });
    expect(asked).toEqual([sid]); // exactly once
    expect(readSummary(dir).status).toBe("active");
  });

  it("treats a cancelled match as final for the run and keeps the row interrupted", async () => {
    const home = makeHome();
    const sid = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const dir = seedSession(home, sid);
    const memo = new Set<string>();
    const { impl, asked } = fakeFetch({ [sid]: { status: 200, body: { status: "cancelled" } } });

    await reconcileInterruptedSessions({ config, runtimeHome: home, fetchImpl: impl, now: () => NOW, memo });
    const second = await reconcileInterruptedSessions({ config, runtimeHome: home, fetchImpl: impl, now: () => NOW, memo });

    expect(second.checked).toBe(0);
    expect(asked).toEqual([sid]);
    expect(readSummary(dir).status).toBe("active");
  });

  it("never asks about fresh rows, foreign agents, or completed rows", async () => {
    const home = makeHome();
    seedSession(home, "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1", {
      updated_at: new Date(NOW - 60 * 1000).toISOString(), // 1 min old — could be live
    });
    seedSession(home, "f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2", { status: "completed" });
    const foreignDir = path.join(home, "agents", OPP_AGENT_ID, "sessions", "f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3");
    fs.mkdirSync(foreignDir, { recursive: true });
    fs.writeFileSync(
      path.join(foreignDir, "session.json"),
      JSON.stringify({
        version: 1,
        agent_id: OPP_AGENT_ID,
        agent_name: "Other",
        session_id: "f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3",
        status: "active",
        started_at: "2026-08-04T02:30:00.000Z",
        updated_at: "2026-08-04T02:40:00.000Z",
        inbound_count: 0,
        outbound_count: 0,
        decision_count: 0,
        final_action_count: 0,
        strategy_hashes: [],
      }),
    );
    const { impl, asked } = fakeFetch({});

    const outcome = await reconcileInterruptedSessions({
      config,
      runtimeHome: home,
      fetchImpl: impl,
      now: () => NOW,
      memo: new Set(),
    });

    expect(outcome).toEqual({ checked: 0, updated: 0 });
    expect(asked).toEqual([]);
  });

  it("refuses a payload whose session echo names a different session", async () => {
    const home = makeHome();
    const sid = "a7a7a7a7-a7a7-4a7a-8a7a-a7a7a7a7a7a7";
    const dir = seedSession(home, sid);
    const body = completedForfeitBody("99999999-9999-4999-8999-999999999999", "p1") as {
      game_over: { session_id: string };
    };
    const { impl } = fakeFetch({ [sid]: { status: 200, body } });

    const outcome = await reconcileInterruptedSessions({
      config,
      runtimeHome: home,
      fetchImpl: impl,
      now: () => NOW,
      memo: new Set(),
    });

    expect(outcome.updated).toBe(0);
    expect(readSummary(dir).status).toBe("active");
  });

  it("does nothing without a usable config", async () => {
    const home = makeHome();
    seedSession(home, "abababab-abab-4bab-8bab-abababababab");
    const { impl, asked } = fakeFetch({});
    const outcome = await reconcileInterruptedSessions({
      config: { ...(config as unknown as Record<string, unknown>), apiKey: "" } as unknown as BridgeConfig,
      runtimeHome: home,
      fetchImpl: impl,
      now: () => NOW,
      memo: new Set(),
    });
    expect(outcome).toEqual({ checked: 0, updated: 0 });
    expect(asked).toEqual([]);
  });
});
