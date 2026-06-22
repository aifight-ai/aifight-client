import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { run } from "../src/cli/main";
import { writeBridgeConfig, type BridgeConfig } from "../src/bridge/config";

let prevHome: string | undefined;
let tmpDir: string | null = null;

function useTempHome(): void {
  prevHome = process.env.AIFIGHT_RUNTIME_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-cli-record-"));
  process.env.AIFIGHT_RUNTIME_HOME = tmpDir;
}

afterEach(() => {
  if (prevHome === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
  else process.env.AIFIGHT_RUNTIME_HOME = prevHome;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  prevHome = undefined;
  tmpDir = null;
});

async function runCapture(argv: readonly string[], fetchImpl?: typeof fetch) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(argv, {
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

function testBridgeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    version: 1,
    baseUrl: "https://aifight.ai",
    wsUrl: "wss://aifight.ai/api/ws",
    agentId: "00000000-0000-4000-8000-000000000001",
    agentName: "local-fallback-name",
    apiKey: "sk-existing-secret",
    runtimeType: "direct",
    runtimeLocalUrl: "direct://local",
    runtimeModel: "direct",
    directAgentSlug: "default",
    updatedAt: new Date("2026-05-18T00:00:00Z").toISOString(),
    ...overrides,
  };
}

interface ProfileOverrides {
  agent?: Record<string, unknown>;
  summary?: Record<string, unknown> | null;
  ratings?: unknown[];
  recent_matches?: unknown[];
  achievements?: unknown[];
}

function profileJson(over: ProfileOverrides = {}): Record<string, unknown> {
  return {
    agent: {
      id: "00000000-0000-4000-8000-000000000001",
      name: "Night Owl",
      model: "claude-opus-4-8",
      identity_status: "official",
      is_claimed: true,
      ...over.agent,
    },
    summary:
      over.summary === null
        ? null
        : {
            total_games: 38,
            total_wins: 24,
            total_losses: 11,
            total_draws: 3,
            overall_win_rate: 0.63,
            games_active: 3,
            qualified_games: 3,
            leaderboard_min_games: 5,
            leaderboard_games_needed: 0,
            leaderboard_eligible: true,
            global_rank: 12,
            best_game: "texas_holdem",
            best_display_rating: 1342,
            ...over.summary,
          },
    ratings:
      over.ratings ?? [
        { game: "texas_holdem", display_rating: 1342, rating: 1342, games_played: 18, wins: 12, losses: 5, draws: 1, win_rate: 0.66 },
        { game: "coup", display_rating: 1095, rating: 1095, games_played: 8, wins: 5, losses: 2, draws: 1, win_rate: 0.62 },
      ],
    recent_matches:
      over.recent_matches ?? [
        { game: "texas_holdem", agent_result: "win", opponent_names: ["GPT-5"], finished_at: "2026-06-18T10:00:00Z" },
        { game: "coup", agent_result: "loss", opponent_names: ["Gemini 2.5 Pro"], finished_at: "2026-06-18T08:00:00Z" },
      ],
    achievements:
      over.achievements ?? [
        { id: "a1", title: "First Victory", tier: "common" },
        { id: "a2", title: "Giant Slayer", tier: "legendary" },
      ],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("aifight record", () => {
  it("renders ratings, rank, per-game table, recent matches and achievements", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const fetchImpl = vi.fn(async () => jsonResponse(profileJson())) as unknown as typeof fetch;

    const res = await runCapture(["record"], fetchImpl);

    expect(res.code).toBe(0);
    // Uses the server-side name, not the local fallback.
    expect(res.stdout).toContain("AIFight record · Night Owl");
    expect(res.stdout).toContain("Model: claude-opus-4-8");
    expect(res.stdout).toContain("#12");
    expect(res.stdout).toContain("1342 · Texas Hold'em");
    expect(res.stdout).toContain("24-11-3 (W-L-D)");
    expect(res.stdout).toContain("63%");
    // Per-game table with friendly labels.
    expect(res.stdout).toContain("Texas Hold'em");
    expect(res.stdout).toContain("Coup");
    // Recent matches.
    expect(res.stdout).toContain("vs GPT-5");
    expect(res.stdout).toContain("vs Gemini 2.5 Pro");
    // Achievements.
    expect(res.stdout).toContain("Achievements  2 unlocked");
    expect(res.stdout).toContain("Giant Slayer — legendary");
  });

  it("hits the public profile endpoint and never sends the API key", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      seenInit = init;
      return jsonResponse(profileJson());
    }) as unknown as typeof fetch;

    const res = await runCapture(["record"], fetchImpl);

    expect(res.code).toBe(0);
    expect(seenUrl).toBe("https://aifight.ai/api/agents/00000000-0000-4000-8000-000000000001/profile");
    // Security: record is public, read-only data — the agent key must not leak.
    const headers = JSON.stringify(seenInit?.headers ?? {});
    expect(headers).not.toContain("X-API-Key");
    expect(res.stdout).not.toContain("sk-existing-secret");
  });

  it("does not nag a claimed agent about names (claim is the only ranked gate)", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        profileJson({
          // Claimed but never renamed (identity_status still 'bootstrap'): under
          // the 2026-06-18 model this agent is fully ranked-eligible. The old
          // "set an official name" nag must be gone.
          agent: { identity_status: "bootstrap", is_claimed: true },
          summary: { total_games: 0, leaderboard_eligible: false, leaderboard_games_needed: 5, global_rank: null },
        }),
      ),
    ) as unknown as typeof fetch;

    const res = await runCapture(["record"], fetchImpl);

    expect(res.code).toBe(0);
    expect(res.stdout).toContain("No ranked matches yet");
    expect(res.stdout).not.toContain("official name");
  });

  it("shows how many more matches are needed to qualify for the leaderboard", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        profileJson({
          summary: { total_games: 3, leaderboard_eligible: false, leaderboard_games_needed: 2, global_rank: null },
        }),
      ),
    ) as unknown as typeof fetch;

    const res = await runCapture(["record"], fetchImpl);

    expect(res.code).toBe(0);
    expect(res.stdout).toContain("not yet ranked");
    expect(res.stdout).toContain("2 more ranked matches");
  });

  it("prints a setup pointer when the bridge is not configured", async () => {
    useTempHome();
    const fetchImpl = vi.fn(async () => {
      throw new Error("should not be called");
    }) as unknown as typeof fetch;

    const res = await runCapture(["record"], fetchImpl);

    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Bridge: not configured");
    expect(res.stdout).toContain("aifight setup");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("emits raw profile JSON under --json", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const fetchImpl = vi.fn(async () => jsonResponse(profileJson())) as unknown as typeof fetch;

    const res = await runCapture(["record", "--json"], fetchImpl);

    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.agent.name).toBe("Night Owl");
    expect(parsed.summary.global_rank).toBe(12);
  });

  it("fails with a friendly error when the agent is not found", async () => {
    useTempHome();
    writeBridgeConfig(testBridgeConfig());
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "not found" }, 404)) as unknown as typeof fetch;

    const res = await runCapture(["record"], fetchImpl);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("was not found on AIFight");
  });
});
