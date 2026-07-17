// Match-context pipeline ("战报进提示词"): the runner accumulates the
// player-view event log + rules summary per session (MatchContextTracker),
// the decision loop threads it into the runtime request, and the direct-LLM
// prompt renders it fresh each turn — history first, current turn last.
//
// Discipline under test:
//  - raw events only, seq-deduped; reconnect backfill (event_history) merges
//    idempotently; game_over frees the entry; caps bound memory.
//  - rendering is a pure function; with no context the prompt is BYTE-IDENTICAL
//    to the previous shape (no silent behavior change for context-less paths).
//  - a throwing context loader never blocks the decision.

import { afterEach, describe, expect, it } from "vitest";

import { MatchContextTracker } from "../src/bridge/match-context-tracker";
import type { BridgeMatchContext } from "../src/bridge/match-context-tracker";
import { clearAdapters, registerAdapter } from "../src/llm/adapter-registry";
import type { DecisionInput, LLMAdapter, LLMProfile } from "../src/llm/adapters/types";
import { createDirectLLMRuntimeProvider } from "../src/bridge/direct-llm-provider";
import {
  buildBridgeDecisionProvider,
  type BridgeRuntimeDecisionRequest,
  type BridgeRuntimeProvider,
} from "../src/bridge/provider";
import type { AgentDecisionContext } from "../src/agents/agent";
import type { MsgActionRequest } from "../src/protocol/types";
import type { LLMConfig } from "../src/profile/config-schema";

// ── tracker fixtures ─────────────────────────────────────────────────

function gameStartMsg(sessionId: string, rules?: unknown): unknown {
  return { type: "game_start", data: { match_id: sessionId, game: "coup", ...(rules !== undefined ? { rules } : {}) } };
}

function actionRequestMsg(
  sessionId: string,
  newEvents: unknown[],
  eventHistory?: unknown[],
): unknown {
  return {
    type: "action_request",
    data: {
      match_id: sessionId,
      state: {},
      legal_actions: [],
      timeout_ms: 1000,
      new_events: newEvents,
      ...(eventHistory !== undefined ? { event_history: eventHistory } : {}),
    },
  };
}

// Wire field for the acting player is `player` (common/event.schema.json /
// engine.Event json tag) — NOT player_id. Codex review caught the tracker (and
// this fixture) using the wrong name, which had masked the bug.
function ev(seq: number, type = "act", data?: unknown, playerId?: string): unknown {
  return { seq, type, ...(data !== undefined ? { data } : {}), ...(playerId !== undefined ? { player: playerId } : {}) };
}

describe("MatchContextTracker", () => {
  it("stashes game_start rules and accumulates events seq-deduped, sorted", () => {
    const t = new MatchContextTracker();
    t.observe(gameStartMsg("s1", { summary: "Bluffing game.", key_rules: ["one action per turn", 7, ""] }));
    t.observe(actionRequestMsg("s1", [ev(2, "claim", { role: "duke" }, "p1"), ev(1, "turn_start")]));
    t.observe(actionRequestMsg("s1", [ev(2, "claim", { role: "duke" }, "p1"), ev(3, "challenge")]));

    const ctx = t.get("s1");
    expect(ctx?.rules).toEqual({ summary: "Bluffing game.", keyRules: ["one action per turn"] });
    expect(ctx?.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(ctx?.events[1]).toEqual({ seq: 2, type: "claim", data: { role: "duke" }, playerId: "p1" });
  });

  it("merges reconnect event_history idempotently with what it already has", () => {
    const t = new MatchContextTracker();
    t.observe(actionRequestMsg("s1", [ev(1), ev(2)]));
    // Reconnect: server backfills 1..4 into event_history plus new_events 5.
    t.observe(actionRequestMsg("s1", [ev(5)], [ev(1), ev(2), ev(3), ev(4)]));
    expect(t.get("s1")?.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("skips malformed events and unknown message shapes", () => {
    const t = new MatchContextTracker();
    t.observe(null);
    t.observe({ type: "event" });
    t.observe(actionRequestMsg("s1", [{ seq: "x", type: "a" }, { seq: 1 }, ev(2)]));
    expect(t.get("s1")?.events.map((e) => e.seq)).toEqual([2]);
  });

  it("frees the entry on game_over (session_id)", () => {
    const t = new MatchContextTracker();
    t.observe(actionRequestMsg("s1", [ev(1)]));
    t.observe({ type: "game_over", data: { match_id: "real-uuid", session_id: "s1", result: {} } });
    expect(t.get("s1")).toBeUndefined();
  });

  it("evicts the oldest match beyond the tracked-match cap", () => {
    const t = new MatchContextTracker();
    for (let i = 0; i < 17; i++) t.observe(actionRequestMsg(`s${i}`, [ev(1)]));
    expect(t.get("s0")).toBeUndefined();
    expect(t.get("s16")?.events).toHaveLength(1);
  });

  it("caps stored rules text (storage-side, independent of render caps)", () => {
    const t = new MatchContextTracker();
    t.observe(
      gameStartMsg("s1", {
        summary: "s".repeat(10_000),
        key_rules: Array.from({ length: 30 }, () => "r".repeat(1_000)),
      }),
    );
    const rules = t.get("s1")?.rules;
    expect(rules?.summary?.length).toBe(4_000);
    expect(rules?.keyRules).toHaveLength(24);
    expect(rules?.keyRules?.[0]?.length).toBe(400);
  });

  it("caps per-match events, dropping the oldest", () => {
    const t = new MatchContextTracker();
    const batch = Array.from({ length: 2001 }, (_, i) => ev(i + 1));
    t.observe(actionRequestMsg("s1", batch));
    const events = t.get("s1")?.events ?? [];
    expect(events).toHaveLength(2000);
    expect(events[0]?.seq).toBe(2);
    expect(events[events.length - 1]?.seq).toBe(2001);
  });
});

// ── prompt rendering via the direct provider ─────────────────────────

function captureAdapter(): { adapter: LLMAdapter; seen: DecisionInput[] } {
  const seen: DecisionInput[] = [];
  const adapter: LLMAdapter = {
    protocol: "anthropic_messages",
    validateProfile: () => ({ ok: true, errors: [], warnings: [] }),
    probe: async (p: LLMProfile) => ({ success: true, latencyMs: 1, model: p.model, protocol: "anthropic_messages" }),
    generateDecision: async (input) => {
      seen.push(input);
      return { text: '{"action":"noop"}', latencyMs: 1 };
    },
    estimateUsage: (_o, p) => ({
      protocol: "anthropic_messages",
      providerLabel: "anthropic_messages",
      model: p.model,
      latencyMs: 1,
      timestamp: "",
    }),
    redact: (raw) => raw,
  };
  return { adapter, seen };
}

const CONFIG: LLMConfig = {
  schemaVersion: 1,
  activeProfile: "main",
  profiles: { main: { protocol: "anthropic_messages", apiKeyRef: { type: "env", name: "K" }, model: "m" } },
  routing: { default: "main" },
};

function requestWith(extra: Partial<BridgeRuntimeDecisionRequest>): BridgeRuntimeDecisionRequest {
  return {
    game: "coup",
    matchId: "s1",
    playerId: "p0",
    legalActions: [{ type: "noop" }] as unknown as BridgeRuntimeDecisionRequest["legalActions"],
    publicState: { your_player_id: "p0" },
    timeoutMs: 0,
    ...extra,
  };
}

async function promptFor(extra: Partial<BridgeRuntimeDecisionRequest>): Promise<DecisionInput> {
  const { adapter, seen } = captureAdapter();
  process.env.K = "sk-test";
  try {
    const provider = createDirectLLMRuntimeProvider({
      agentSlug: "x",
      loadConfig: async () => CONFIG,
      registerAdapters: async () => {
        clearAdapters();
        registerAdapter(adapter);
      },
    });
    await provider.decide(requestWith(extra));
    return seen[0]!;
  } finally {
    delete process.env.K;
  }
}

const BASE_JSON = JSON.stringify({
  game: "coup",
  match_id: "s1",
  player_id: "p0",
  state: { your_player_id: "p0" },
  legal_actions: [{ type: "noop" }],
  timeout_ms: 0,
});

describe("buildDirectPrompt: match history + rules", () => {
  afterEach(() => clearAdapters());

  it("without matchContext the user prompt is byte-identical to the legacy shape", async () => {
    const input = await promptFor({});
    expect(input.userPrompt).toBe(BASE_JSON);
    expect(input.systemPrompt).not.toContain("Game rules");
  });

  it("renders history before the current turn, one compact line per event", async () => {
    const matchContext: BridgeMatchContext = {
      events: [
        { seq: 3, type: "claim", data: { role: "duke" }, playerId: "p1" },
        { seq: 4, type: "challenge", playerId: "p0" },
      ],
    };
    const input = await promptFor({ matchContext });
    expect(input.userPrompt).toContain("MATCH HISTORY — your view, oldest first:");
    expect(input.userPrompt).toContain('#3 p1 claim {"role":"duke"}');
    expect(input.userPrompt).toContain("#4 p0 challenge");
    const historyIdx = input.userPrompt.indexOf("MATCH HISTORY");
    const currentIdx = input.userPrompt.indexOf("CURRENT TURN (state + legal actions):");
    expect(historyIdx).toBeGreaterThanOrEqual(0);
    expect(currentIdx).toBeGreaterThan(historyIdx);
    expect(input.userPrompt).toContain(BASE_JSON);
  });

  it("keeps the newest events and reports how many older ones were omitted", async () => {
    const events = Array.from({ length: 100 }, (_, i) => ({ seq: i + 1, type: "act" }));
    const input = await promptFor({ matchContext: { events } });
    expect(input.userPrompt).toContain("(20 earlier events omitted)");
    expect(input.userPrompt).not.toContain("#20 act");
    expect(input.userPrompt).toContain("#100 act");
  });

  it("caps a single event line", async () => {
    const input = await promptFor({
      matchContext: { events: [{ seq: 1, type: "act", data: { blob: "z".repeat(500) } }] },
    });
    const line = input.userPrompt.split("\n").find((l) => l.startsWith("#1 act"));
    expect(line).toBeDefined();
    expect(line!.length).toBeLessThanOrEqual(201);
    expect(line!.endsWith("…")).toBe(true);
  });

  it("puts the platform rules in the system prompt BEFORE the strategy", async () => {
    const input = await promptFor({
      matchContext: {
        events: [],
        rules: { summary: "RULES-MARK bluffing game", keyRules: ["one action per turn"] },
      },
      strategy: {
        sections: [
          {
            scope: "global",
            path: "/tmp/global.md",
            content: "STRAT-MARK play tight",
            sha256: "h",
            bytes: 10,
            mtimeMs: 1,
          },
        ],
      },
    });
    expect(input.systemPrompt).toContain("Game rules (from the platform):");
    expect(input.systemPrompt).toContain("RULES-MARK bluffing game");
    expect(input.systemPrompt).toContain("- one action per turn");
    expect(input.systemPrompt.indexOf("RULES-MARK")).toBeLessThan(input.systemPrompt.indexOf("STRAT-MARK"));
    // Rules alone (no events) add nothing to the user prompt.
    expect(input.userPrompt).toBe(BASE_JSON);
  });
});

// ── decision loop threads the loader result into the request ─────────

describe("decision loop: loadMatchContext wiring", () => {
  function makeCtx(): AgentDecisionContext {
    const actionRequest = {
      type: "action_request",
      match_id: "s1",
      data: {
        state: { your_player_id: "p0" },
        legal_actions: [{ type: "fold" }, { type: "call" }],
        timeout_ms: 60_000,
      },
    } as unknown as MsgActionRequest;
    return {
      actionRequest,
      matchId: "s1",
      game: "texas_holdem",
      state: "in_match",
    } as unknown as AgentDecisionContext;
  }

  it("passes the loaded context through; a throwing loader degrades to absent", async () => {
    const seen: BridgeRuntimeDecisionRequest[] = [];
    const provider: BridgeRuntimeProvider = {
      name: "scripted",
      async decide(req) {
        seen.push(req);
        return '{"action":"call"}';
      },
    };
    const context: BridgeMatchContext = { events: [{ seq: 1, type: "hand_result", data: { pot: 40 } }] };

    const ok = buildBridgeDecisionProvider(provider, { loadMatchContext: () => context });
    await ok.decide(makeCtx());
    expect(seen[0]?.matchContext).toEqual(context);

    const throwing = buildBridgeDecisionProvider(provider, {
      loadMatchContext: () => {
        throw new Error("boom");
      },
    });
    const result = await throwing.decide(makeCtx());
    expect(seen[1]?.matchContext).toBeUndefined();
    expect((result as { action: { type: string } }).action.type).toBe("call");
  });
});
