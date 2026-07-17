// Reasoning capture (config.captureReasoning) — opt-in, LOCAL-ONLY persistence
// of the model's thinking for replay/self-review.
//
//  1. config-schema accepts the boolean switch and rejects non-booleans.
//  2. direct-llm-provider: OFF (default) keeps today's behavior — no reasoning
//     override sent to the adapter, nothing captured even when the adapter
//     returns reasoning (DeepSeek always does). ON asks for a summary where the
//     profile already has a reasoning config (never forces thinking on), caps
//     the captured text, and drops empty text.
//  3. anthropic adapter: display override reaches the wire; a summary block is
//     parsed; a legacy full-thinking block (no summary) is surfaced as the
//     summary; without the override the request keeps display "omitted".
//  4. decision loop: reasoning rides the runtime_success trace (→ the local
//     session log) but NEVER appears in the outgoing action payload.
//  5. session store: reasoning survives trace redaction into decisions.jsonl.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { validateConfig } from "../src/profile/config-schema";
import type { LLMConfig, LLMProfile as ConfigProfile } from "../src/profile/config-schema";
import { buildReviewContext } from "../src/review/build-review-context";
import { buildReviewPrompt } from "../src/review/self-review";
import type { LocalSessionExport } from "../src/session/local-match-session-store";
import { run } from "../src/cli/main";
import { clearAdapters, registerAdapter, registerBuiltinAdapters, requireAdapter } from "../src/llm/adapter-registry";
import type { DecisionInput, LLMAdapter, LLMProfile } from "../src/llm/adapters/types";
import { createDirectLLMRuntimeProvider } from "../src/bridge/direct-llm-provider";
import {
  buildBridgeDecisionProvider,
  type BridgeDecisionTrace,
  type BridgeRuntimeDecisionRequest,
  type BridgeRuntimeProvider,
} from "../src/bridge/provider";
import type { AgentDecisionContext } from "../src/agents/agent";
import type { MsgActionRequest } from "../src/protocol/types";
import { LocalMatchSessionStore } from "../src/session/local-match-session-store";
import type { BridgeConfig } from "../src/bridge/config";

// ── shared fixtures ──────────────────────────────────────────────────

function makeConfig(opts: {
  thinking?: ConfigProfile["thinking"];
  captureReasoning?: boolean;
}): LLMConfig {
  return {
    schemaVersion: 1,
    activeProfile: "main",
    profiles: {
      main: {
        protocol: "anthropic_messages",
        apiKeyRef: { type: "env", name: "K" },
        model: "claude-main",
        ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
      },
    },
    routing: { default: "main" },
    ...(opts.captureReasoning !== undefined ? { captureReasoning: opts.captureReasoning } : {}),
  };
}

function decisionRequest(): BridgeRuntimeDecisionRequest {
  return {
    game: "coup",
    matchId: "m1",
    legalActions: [{ type: "noop" }] as unknown as BridgeRuntimeDecisionRequest["legalActions"],
    publicState: { your_player_id: "p0" },
    timeoutMs: 0,
  };
}

/** Fake adapter that records the DecisionInput it saw and returns a scripted
 *  reasoningSummary alongside the action text. */
function reasoningAdapter(summary?: string): { adapter: LLMAdapter; seen: DecisionInput[] } {
  const seen: DecisionInput[] = [];
  const adapter: LLMAdapter = {
    protocol: "anthropic_messages",
    validateProfile: () => ({ ok: true, errors: [], warnings: [] }),
    probe: async (p: LLMProfile) => ({ success: true, latencyMs: 1, model: p.model, protocol: "anthropic_messages" }),
    generateDecision: async (input) => {
      seen.push(input);
      return {
        text: '{"action":"noop"}',
        latencyMs: 1,
        ...(summary !== undefined ? { reasoningSummary: summary } : {}),
      };
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

async function decideWith(config: LLMConfig, summary?: string) {
  const { adapter, seen } = reasoningAdapter(summary);
  process.env.K = "sk-test";
  try {
    const provider = createDirectLLMRuntimeProvider({
      agentSlug: "x",
      loadConfig: async () => config,
      registerAdapters: async () => {
        clearAdapters();
        registerAdapter(adapter);
      },
    });
    const out = (await provider.decide(decisionRequest())) as {
      raw: string;
      reasoning?: { text: string; truncated?: boolean };
    };
    return { out, seen };
  } finally {
    delete process.env.K;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearAdapters();
});

// ── 1. config-schema ─────────────────────────────────────────────────

describe("config-schema: captureReasoning", () => {
  const base = {
    schemaVersion: 1,
    activeProfile: "main",
    profiles: { main: { protocol: "anthropic_messages", apiKeyRef: { type: "env", name: "K" }, model: "m" } },
    routing: { default: "main" },
  };

  it("accepts true / false / absent", () => {
    expect(validateConfig({ ...base, captureReasoning: true }).ok).toBe(true);
    expect(validateConfig({ ...base, captureReasoning: false }).ok).toBe(true);
    expect(validateConfig(base).ok).toBe(true);
  });

  it("rejects a non-boolean", () => {
    const result = validateConfig({ ...base, captureReasoning: "yes" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toContain("captureReasoning");
    }
  });
});

// ── 2. direct-llm-provider gating ────────────────────────────────────

describe("direct-llm-provider: reasoning capture gating", () => {
  it("OFF (default): no reasoning override sent, nothing captured even when the adapter returns reasoning", async () => {
    const { out, seen } = await decideWith(
      makeConfig({ thinking: { enabled: true, mode: "always", effort: "high" } }),
      "the model thought about it",
    );
    expect(seen[0]?.reasoning).toBeUndefined();
    expect(out.reasoning).toBeUndefined();
  });

  it("ON + profile with thinking: adapter receives display=summarized/summary=auto, text is captured", async () => {
    const { out, seen } = await decideWith(
      makeConfig({ thinking: { enabled: true, mode: "always", effort: "high" }, captureReasoning: true }),
      "weighing a bluff vs income",
    );
    expect(seen[0]?.reasoning).toMatchObject({
      enabled: true,
      mode: "enabled",
      effort: "high",
      display: "summarized",
      summary: "auto",
    });
    expect(out.reasoning).toEqual({ text: "weighing a bluff vs income" });
  });

  it("ON + profile WITHOUT thinking: no override (never forces thinking on) but returned reasoning is still captured", async () => {
    const { out, seen } = await decideWith(
      makeConfig({ captureReasoning: true }),
      "deepseek-style always-on reasoning",
    );
    expect(seen[0]?.reasoning).toBeUndefined();
    expect(out.reasoning).toEqual({ text: "deepseek-style always-on reasoning" });
  });

  it("caps long reasoning at 4000 chars and flags truncation", async () => {
    const { out } = await decideWith(makeConfig({ captureReasoning: true }), "x".repeat(5000));
    expect(out.reasoning?.truncated).toBe(true);
    expect(out.reasoning?.text.length).toBeLessThanOrEqual(4000 + "…[truncated]".length);
    expect(out.reasoning?.text.endsWith("…[truncated]")).toBe(true);
  });

  it("drops empty/whitespace reasoning", async () => {
    const { out } = await decideWith(makeConfig({ captureReasoning: true }), "   \n  ");
    expect(out.reasoning).toBeUndefined();
  });
});

// ── 3. anthropic adapter wire + parse ────────────────────────────────

function stubFetch(status: number, body: unknown): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const text = JSON.stringify(body);
  const fn = vi.fn(async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      json: async () => JSON.parse(text),
      headers: { get: () => null },
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return { calls };
}

function anthropicProfile(): LLMProfile {
  return {
    profileId: "p",
    displayName: "p",
    protocol: "anthropic_messages",
    baseURL: "https://api.anthropic.com",
    model: "claude-opus-4-8",
    apiKey: "sk-test",
    temperature: null,
    maxTokens: 256,
    timeouts: { requestMs: 1000 },
    retries: { maxAttempts: 1 },
  };
}

const ANTHROPIC_INPUT: DecisionInput = {
  systemPrompt: "SYS",
  userPrompt: "usr",
  maxTokens: 64,
  temperature: null,
  responseFormat: "json",
};

describe("anthropic adapter: thinking display + summary parsing", () => {
  it("display=summarized reaches the wire and a summary block is parsed", async () => {
    await registerBuiltinAdapters();
    const adapter = requireAdapter("anthropic_messages");
    const { calls } = stubFetch(200, {
      content: [
        { type: "thinking", thinking: "long hidden thoughts", summary: "SUM" },
        { type: "text", text: '{"action":"noop"}' },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
    });
    const out = await adapter.generateDecision(
      { ...ANTHROPIC_INPUT, reasoning: { enabled: true, mode: "enabled", display: "summarized" } },
      anthropicProfile(),
    );
    const body = JSON.parse(String(calls[0]!.init.body)) as { thinking?: { type: string; display?: string } };
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(out.reasoningSummary).toBe("SUM");
  });

  it("legacy full-thinking block (no summary field) is surfaced as the summary", async () => {
    await registerBuiltinAdapters();
    const adapter = requireAdapter("anthropic_messages");
    stubFetch(200, {
      content: [
        { type: "thinking", thinking: "FULL CHAIN OF THOUGHT" },
        { type: "text", text: '{"action":"noop"}' },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
    });
    const out = await adapter.generateDecision(
      { ...ANTHROPIC_INPUT, reasoning: { enabled: true, mode: "enabled" } },
      anthropicProfile(),
    );
    expect(out.reasoningSummary).toBe("FULL CHAIN OF THOUGHT");
  });

  it("without a display override the request keeps display=omitted (today's default)", async () => {
    await registerBuiltinAdapters();
    const adapter = requireAdapter("anthropic_messages");
    const { calls } = stubFetch(200, {
      content: [{ type: "text", text: '{"action":"noop"}' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
    });
    await adapter.generateDecision(
      { ...ANTHROPIC_INPUT, reasoning: { enabled: true, mode: "enabled" } },
      anthropicProfile(),
    );
    const body = JSON.parse(String(calls[0]!.init.body)) as { thinking?: { type: string; display?: string } };
    expect(body.thinking).toEqual({ type: "adaptive", display: "omitted" });
  });
});

// ── 4. decision loop: trace carries reasoning, wire payload never does ─

const LEGAL_ACTIONS = [{ type: "fold" }, { type: "call" }] as const;

function makeCtx(): AgentDecisionContext {
  const actionRequest = {
    type: "action_request",
    match_id: "m-1",
    data: {
      state: { your_player_id: "p0" },
      legal_actions: [...LEGAL_ACTIONS],
      timeout_ms: 60_000,
    },
  } as unknown as MsgActionRequest;
  return {
    actionRequest,
    matchId: "m-1",
    game: "texas_holdem",
    state: "in_match",
  } as unknown as AgentDecisionContext;
}

describe("decision loop: reasoning stays local", () => {
  it("runtime_success trace carries reasoning; the outgoing action payload does not", async () => {
    const provider: BridgeRuntimeProvider = {
      name: "scripted",
      async decide() {
        return { raw: '{"action":"call"}', reasoning: { text: "SECRET-THOUGHTS" } };
      },
    };
    const traces: BridgeDecisionTrace[] = [];
    const dp = buildBridgeDecisionProvider(provider, { onTrace: (t) => traces.push(t) });

    const result = await dp.decide(makeCtx());

    const success = traces.find((t) => t.type === "runtime_success");
    expect(success && success.type === "runtime_success" ? success.reasoning : undefined).toEqual({
      text: "SECRET-THOUGHTS",
    });
    // Privacy: the object handed back for the wire action message must not
    // contain the reasoning text anywhere.
    expect(JSON.stringify(result)).not.toContain("SECRET-THOUGHTS");
  });
});

// ── 5. session store: reasoning survives redaction into decisions.jsonl ─

function bridgeConfig(): BridgeConfig {
  return {
    version: 1,
    baseUrl: "https://aifight.ai",
    wsUrl: "wss://aifight.ai/api/ws",
    agentId: "agent-1",
    agentName: "alpha",
    apiKey: "sk-local-agent-key",
    runtimeType: "mock",
    runtimeLocalUrl: "mock://local",
    runtimeModel: "mock",
    updatedAt: "2026-05-18T00:00:00.000Z",
  };
}

describe("session store: reasoning persisted in decisions.jsonl", () => {
  it("keeps the runtime_success reasoning through trace redaction", () => {
    const store = new LocalMatchSessionStore({
      runtimeHome: fs.mkdtempSync(path.join(os.tmpdir(), "aifight-reasoning-")),
      now: () => new Date("2026-07-16T01:02:03.000Z"),
    });
    const request = {
      type: "action_request",
      data: {
        match_id: "session-1",
        state: { your_player_id: "p0" },
        legal_actions: [{ type: "challenge" }],
        players: [],
        timeout_ms: 300_000,
        new_events: [],
      },
    } as unknown as MsgActionRequest;

    store.recordDecision({
      config: bridgeConfig(),
      context: {
        actionRequest: request,
        matchId: "session-1",
        game: "liars_dice",
        state: null,
      } as never,
      startedAt: new Date("2026-07-16T01:02:03.000Z"),
      completedAt: new Date("2026-07-16T01:02:04.000Z"),
      traces: [
        {
          type: "runtime_success",
          matchId: "session-1",
          attempt: 1,
          raw: { kind: "text", sha256: "h", bytes: 5, preview: "x" },
          reasoning: { text: "THINK-LOCAL", truncated: true },
        },
        {
          type: "final_action",
          matchId: "session-1",
          source: "runtime",
          action: { type: "challenge" },
        },
      ],
      action: { type: "challenge" },
    });

    const exported = store.exportSession("session-1");
    expect(exported?.decisions).toHaveLength(1);
    const line = exported?.decisions[0] as {
      traces: Array<{ type: string; reasoning?: { text: string; truncated?: boolean } }>;
    };
    const success = line.traces.find((t) => t.type === "runtime_success");
    expect(success?.reasoning).toEqual({ text: "THINK-LOCAL", truncated: true });
  });
});

// ── 6. review context + prompt include the captured thinking ─────────

function exportWithThinking(thinking?: string): LocalSessionExport {
  return {
    summary: {
      session_id: "session-1",
      game: "coup",
      result_label: "1st place",
      player_id: "p0",
      strategy_hashes: [],
    },
    path: "/tmp/x",
    inbound: [],
    outbound: [],
    decisions: [
      {
        action_request: {
          state_summary: '{"coins":3}',
          legal_actions: [{ type: "income" }, { type: "tax" }],
        },
        final_action: { type: "tax", summary: "claim duke" },
        traces: [
          {
            type: "runtime_success",
            matchId: "session-1",
            attempt: 1,
            raw: { kind: "text", sha256: "h", bytes: 5, preview: "x" },
            ...(thinking !== undefined ? { reasoning: { text: thinking } } : {}),
          },
          { type: "final_action", matchId: "session-1", source: "runtime", action: { type: "tax" } },
        ],
      },
    ],
    strategySnapshot: null,
    selfReview: null,
  } as unknown as LocalSessionExport;
}

describe("review context: captured thinking reaches the review prompt", () => {
  it("threads thinking into the turn and the prompt line", () => {
    const ctx = buildReviewContext(exportWithThinking("opponent folded twice to raises"));
    expect(ctx.turns[0]?.thinking).toBe("opponent folded twice to raises");
    const { userPrompt } = buildReviewPrompt(ctx, "en");
    expect(userPrompt).toContain("thinking: opponent folded twice to raises");
  });

  it("truncates long thinking at the review cap", () => {
    const ctx = buildReviewContext(exportWithThinking("y".repeat(2000)));
    expect(ctx.turns[0]?.thinking?.length).toBeLessThan(520);
    expect(ctx.turns[0]?.thinking).toContain("…(+");
  });

  it("omits the field (and the prompt line) when nothing was captured", () => {
    const ctx = buildReviewContext(exportWithThinking(undefined));
    expect(ctx.turns[0]?.thinking).toBeUndefined();
    const { userPrompt } = buildReviewPrompt(ctx, "en");
    expect(userPrompt).not.toContain("thinking:");
  });

  it("attributes thinking strictly to the winning call — never a rejected earlier attempt", () => {
    const exported = exportWithThinking(undefined) as unknown as {
      decisions: Array<{ traces: unknown[] }>;
    };
    // Corrective-retry shape: first call (with thinking) was rejected as
    // illegal; the winning second call returned no reasoning.
    exported.decisions[0]!.traces = [
      {
        type: "runtime_success",
        matchId: "session-1",
        attempt: 1,
        raw: { kind: "text", sha256: "h", bytes: 5, preview: "x" },
        reasoning: { text: "STALE-REJECTED-THOUGHTS" },
      },
      { type: "illegal_retry", matchId: "session-1", attempt: 1, reason: "illegal_runtime_action", priorPreview: "x" },
      {
        type: "runtime_success",
        matchId: "session-1",
        attempt: 2,
        raw: { kind: "text", sha256: "h2", bytes: 5, preview: "y" },
      },
      { type: "final_action", matchId: "session-1", source: "runtime", action: { type: "tax" } },
    ];
    const ctx = buildReviewContext(exported as unknown as LocalSessionExport);
    expect(ctx.turns[0]?.thinking).toBeUndefined();
  });

  it("a fallback final action never inherits the rejected call's thinking (Codex review MED-2)", () => {
    const exported = exportWithThinking(undefined) as unknown as {
      decisions: Array<{ traces: unknown[] }>;
    };
    // First call had thinking but its output was illegal; the corrective retry
    // then FAILED (network), so the deterministic fallback played the turn.
    exported.decisions[0]!.traces = [
      {
        type: "runtime_success",
        matchId: "session-1",
        attempt: 1,
        raw: { kind: "text", sha256: "h", bytes: 5, preview: "x" },
        reasoning: { text: "STALE-REJECTED-THOUGHTS" },
      },
      { type: "illegal_retry", matchId: "session-1", attempt: 1, reason: "illegal_runtime_action", priorPreview: "x" },
      { type: "runtime_failure", matchId: "session-1", attempt: 2, error: "network", errorClass: "network" },
      { type: "final_action", matchId: "session-1", source: "fallback", decisionSource: "fallback", action: { type: "income" } },
    ];
    const ctx = buildReviewContext(exported as unknown as LocalSessionExport);
    expect(ctx.turns[0]?.thinking).toBeUndefined();
    const { userPrompt } = buildReviewPrompt(ctx, "en");
    expect(userPrompt).not.toContain("STALE-REJECTED-THOUGHTS");
  });
});

// ── 7. CLI: `aifight config reasoning` get/set ───────────────────────

describe("cli: config reasoning subcommand", () => {
  let prevHome: string | undefined;
  let tmpDir: string;

  async function runCapture(argv: readonly string[]) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await run(argv, { stdout: (s) => stdout.push(s), stderr: (s) => stderr.push(s) });
    return { code, stdout: stdout.join(""), stderr: stderr.join("") };
  }

  function scaffoldConfig(tmp: string): string {
    const dir = path.join(tmp, "agents", "default");
    fs.mkdirSync(dir, { recursive: true });
    const cfgPath = path.join(dir, "config.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        schemaVersion: 1,
        activeProfile: "main",
        profiles: {
          main: { protocol: "anthropic_messages", apiKeyRef: { type: "env", name: "K" }, model: "m" },
        },
        routing: { default: "main" },
      }),
    );
    return cfgPath;
  }

  it("shows off by default, sets on, and removes the key on off", async () => {
    prevHome = process.env.AIFIGHT_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-reasoning-cli-"));
    process.env.AIFIGHT_HOME = tmpDir;
    try {
      const cfgPath = scaffoldConfig(tmpDir);

      const show = await runCapture(["config", "reasoning", "--json"]);
      expect(show.code).toBe(0);
      expect(JSON.parse(show.stdout)).toEqual({ agentSlug: "default", captureReasoning: false });

      const on = await runCapture(["config", "reasoning", "on", "--json"]);
      expect(on.code).toBe(0);
      expect(JSON.parse(on.stdout)).toEqual({ agentSlug: "default", captureReasoning: true });
      expect(JSON.parse(fs.readFileSync(cfgPath, "utf8")).captureReasoning).toBe(true);

      const off = await runCapture(["config", "reasoning", "off", "--json"]);
      expect(off.code).toBe(0);
      expect(JSON.parse(off.stdout)).toEqual({ agentSlug: "default", captureReasoning: false });
      expect("captureReasoning" in JSON.parse(fs.readFileSync(cfgPath, "utf8"))).toBe(false);
    } finally {
      if (prevHome === undefined) delete process.env.AIFIGHT_HOME;
      else process.env.AIFIGHT_HOME = prevHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── 8. CLI: `sessions show --reasoning` ──────────────────────────────

describe("cli: sessions show --reasoning", () => {
  it("prints the per-decision thinking section only when asked", async () => {
    const prevRuntimeHome = process.env.AIFIGHT_RUNTIME_HOME;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-sessions-reasoning-"));
    process.env.AIFIGHT_RUNTIME_HOME = tmp;
    try {
      const store = new LocalMatchSessionStore({
        runtimeHome: tmp,
        now: () => new Date("2026-07-16T02:00:00.000Z"),
      });
      const request = {
        type: "action_request",
        data: {
          match_id: "session-9",
          state: { your_player_id: "p0" },
          legal_actions: [{ type: "challenge" }],
          players: [],
          timeout_ms: 300_000,
          new_events: [],
        },
      } as unknown as MsgActionRequest;
      store.recordDecision({
        config: bridgeConfig(),
        context: {
          actionRequest: request,
          matchId: "session-9",
          game: "liars_dice",
          state: null,
        } as never,
        startedAt: new Date("2026-07-16T02:00:00.000Z"),
        completedAt: new Date("2026-07-16T02:00:01.000Z"),
        traces: [
          {
            type: "runtime_success",
            matchId: "session-9",
            attempt: 1,
            raw: { kind: "text", sha256: "h", bytes: 5, preview: "x" },
            reasoning: { text: "count says 4 threes is a stretch" },
          },
          { type: "final_action", matchId: "session-9", source: "runtime", action: { type: "challenge" } },
        ],
        action: { type: "challenge" },
      });

      // Second decision: model call had thinking but the turn fell back to the
      // deterministic policy — its thinking must NOT be shown (attribution gate).
      store.recordDecision({
        config: bridgeConfig(),
        context: {
          actionRequest: request,
          matchId: "session-9",
          game: "liars_dice",
          state: null,
        } as never,
        startedAt: new Date("2026-07-16T02:01:00.000Z"),
        completedAt: new Date("2026-07-16T02:01:01.000Z"),
        traces: [
          {
            type: "runtime_success",
            matchId: "session-9",
            attempt: 1,
            raw: { kind: "text", sha256: "h2", bytes: 5, preview: "y" },
            reasoning: { text: "GHOST-THINKING" },
          },
          {
            type: "final_action",
            matchId: "session-9",
            source: "fallback",
            decisionSource: "fallback",
            reason: "illegal_runtime_action",
            action: { type: "challenge" },
          },
        ],
        action: { type: "challenge" },
      });

      const collect = async (argv: readonly string[]) => {
        const out: string[] = [];
        const code = await run(argv, { stdout: (s) => out.push(s), stderr: () => {} });
        return { code, text: out.join("") };
      };

      const withFlag = await collect(["sessions", "show", "session-9", "--reasoning"]);
      expect(withFlag.code).toBe(0);
      expect(withFlag.text).toContain("Model thinking (local only):");
      expect(withFlag.text).toContain("count says 4 threes is a stretch");
      expect(withFlag.text).toContain("[t1] chose challenge");
      expect(withFlag.text).not.toContain("GHOST-THINKING");

      const withoutFlag = await collect(["sessions", "show", "session-9"]);
      expect(withoutFlag.code).toBe(0);
      expect(withoutFlag.text).not.toContain("Model thinking");
    } finally {
      if (prevRuntimeHome === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
      else process.env.AIFIGHT_RUNTIME_HOME = prevRuntimeHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
