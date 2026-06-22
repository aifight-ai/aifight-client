// Tests for runtime/src/decision/provider.ts.
//
// M1-14 contract: facade over real buildPrompt + real per-game parser
// + injected mock direct-model client + retry budget + M1-13 fallback
// dispatch. We never touch globalThis.fetch or real M1-11 client
// internals — `clientFactory` injection lets us spin up a stub
// `DirectModelClient` with a `vi.fn()` `generate` so each case asserts
// the facade behavior without coupling to transport details.

import { describe, expect, it, vi } from "vitest";

import {
  createDirectModelProvider,
  DecisionProviderError,
} from "../src/decision/provider";
import {
  DirectModelAbortedError,
  DirectModelHttpError,
  DirectModelInvalidResponseError,
  DirectModelNetworkError,
  DirectModelUnsupportedError,
} from "../src/decision/direct-model/errors";
import type {
  DirectModelClient,
  DirectModelGenerateRequest,
  DirectModelGenerateResponse,
} from "../src/decision/direct-model/types";
import type {
  DecisionRequest,
  LegalAction,
  StrategyProfile,
} from "../src/decision/types";
import type {
  CoupRules,
  CoupState,
  PlayerInfo,
  TexasHoldemRules,
  TexasHoldemState,
} from "../src/protocol/types";

// ─── Fixtures ───────────────────────────────────────────────────────

const COUP_RULES: CoupRules = {
  name: "Coup",
  summary: "Bluff your role; lose all influence to be eliminated.",
  available_actions: {
    income: "Take 1 coin",
    foreign_aid: "Take 2 coins (blockable by Duke)",
    coup: "Pay 7 to eliminate one influence",
    tax: "Take 3 coins (claim Duke)",
    assassinate: "Pay 3, eliminate target's influence (claim Assassin)",
    steal: "Take 2 coins from target (claim Captain)",
    exchange: "Swap cards with deck (claim Ambassador)",
    challenge: "Challenge a role claim",
    pass: "Pass on challenge / block",
    block: "Block an action with claimed role",
    lose_card: "Choose which influence to reveal",
    return_cards: "Return exchange cards to deck",
  },
  key_rules: ["Mandatory coup at 10 coins."],
};

const TEXAS_RULES: TexasHoldemRules = {
  name: "No-Limit Texas Hold'em",
  summary: "Standard NLHE.",
  available_actions: {
    fold: "Fold",
    check: "Check",
    call: "Call current bet",
    raise: "Raise to amount",
    allin: "Push all chips",
  },
  key_rules: ["Best 5-card hand wins."],
};

const COUP_PLAYERS: readonly PlayerInfo[] = [
  { id: "p0", name: "Player 1", status: "active", data: { coins: 4, hidden_cards: 2, revealed: [] } },
  { id: "p1", name: "Player 2", status: "active", data: { coins: 3, hidden_cards: 2, revealed: [] } },
];

const TEXAS_PLAYERS: readonly PlayerInfo[] = [
  { id: "p0", name: "Player 1", status: "active", data: { chips: 10000, bet: 400 } },
  { id: "p1", name: "Player 2", status: "active", data: { chips: 9000, bet: 200 } },
];

function makeStrategy(over: Partial<StrategyProfile> = {}): StrategyProfile {
  return {
    name: "test-bot",
    version: 1,
    provider: "anthropic",
    model: "claude-opus-4-7",
    systemPrompt: "You are a thoughtful, balanced strategic player.",
    maxTokens: 1024,
    ...over,
  };
}

interface CoupReqOver {
  legalActions?: readonly LegalAction[];
  decisionBudgetMs?: number;
  strategyProfile?: StrategyProfile;
  publicState?: CoupState;
}

function makeCoupReq(over: CoupReqOver = {}): DecisionRequest {
  const state: CoupState = over.publicState ?? {
    phase: "action",
    current_turn: "p1",
    your_cards: ["Duke", "Assassin"],
    your_revealed: [],
    coins: 3,
  };
  const legalActions: readonly LegalAction[] = over.legalActions ?? [
    { type: "income", data: {} },
    { type: "foreign_aid", data: {} },
  ];
  return {
    game: "coup",
    matchId: "match-coup-1",
    playerId: "p1",
    rules: COUP_RULES,
    legalActions,
    publicState: state,
    players: COUP_PLAYERS,
    recentEvents: [],
    strategyProfile: over.strategyProfile ?? makeStrategy(),
    turnTimeoutMs: 300_000,
    decisionBudgetMs: over.decisionBudgetMs ?? 60_000,
  };
}

interface TexasReqOver {
  legalActions?: readonly LegalAction[];
  strategyProfile?: StrategyProfile;
}

function makeTexasReq(over: TexasReqOver = {}): DecisionRequest {
  const state: TexasHoldemState = {
    phase: "preflop",
    community_cards: [],
    pot: 600,
    current_bet: 400,
    dealer: 0,
    dealer_id: "p0",
    hand_num: 3,
    max_hands: 10,
    small_blind: 200,
    big_blind: 400,
    current_player_id: "p1",
    action_order: ["p1", "p0"],
    your_hand: ["Ah", "Kd"],
    your_chips: 9000,
    your_bet: 200,
    your_seat: 1,
    your_position: "BB",
    your_player_id: "p1",
  };
  const legalActions: readonly LegalAction[] = over.legalActions ?? [
    { type: "fold", data: {} },
    { type: "call", data: { amount: 200 } },
    { type: "raise", data: { amount: 800, min: 800, max: 9000 } },
  ];
  return {
    game: "texas_holdem",
    matchId: "match-tx-1",
    playerId: "p1",
    rules: TEXAS_RULES,
    legalActions,
    publicState: state,
    players: TEXAS_PLAYERS,
    recentEvents: [],
    strategyProfile: over.strategyProfile ?? makeStrategy(),
    turnTimeoutMs: 300_000,
    decisionBudgetMs: 60_000,
  };
}

function makeMockClient(
  generateImpl: (
    req: DirectModelGenerateRequest,
  ) => Promise<DirectModelGenerateResponse>,
  provider: "anthropic" | "openai" = "anthropic",
  model = "claude-opus-4-7",
): {
  client: DirectModelClient;
  generate: ReturnType<typeof vi.fn>;
} {
  const generate = vi.fn(generateImpl);
  return {
    client: { provider, model, generate },
    generate,
  };
}

function makeOkResponse(text: string, latencyMs = 5): DirectModelGenerateResponse {
  return {
    text,
    inputTokens: 100,
    outputTokens: 20,
    latencyMs,
    raw: { mock: true },
  };
}

// ─── Test cases ─────────────────────────────────────────────────────

describe("createDirectModelProvider — happy + reference equality", () => {
  it("happy path returns DecisionResponse with retries=0 and fallback=false", async () => {
    const { client, generate } = makeMockClient(async () =>
      makeOkResponse('{"action":"income","data":{},"summary":"safe"}'),
    );
    const factory = vi.fn(() => client);
    const provider = createDirectModelProvider({
      name: "test",
      apiKeyResolver: () => "test-key",
      clientFactory: { anthropic: factory },
    });

    const result = await provider.decide(makeCoupReq());

    expect(result.action).toBe("income");
    expect(result.summary).toBe("safe");
    expect(result.providerMetadata.retries).toBe(0);
    expect(result.providerMetadata.fallback).toBe(false);
    expect(result.providerMetadata.provider).toBe("anthropic");
    expect(result.providerMetadata.model).toBe("claude-opus-4-7");
    expect(result.providerMetadata.inputTokens).toBe(100);
    expect(result.providerMetadata.outputTokens).toBe(20);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("Coup target action: params is original server-provided LegalAction.data reference", async () => {
    const coupP1 = { type: "coup", data: { target: "p0" } };
    const legalActions: LegalAction[] = [
      { type: "income", data: {} },
      coupP1,
    ];
    const { client } = makeMockClient(async () =>
      makeOkResponse('{"action":"coup","data":{"target":"p0"}}'),
    );
    const provider = createDirectModelProvider({
      name: "test",
      apiKeyResolver: () => "test-key",
      clientFactory: { anthropic: vi.fn(() => client) },
    });

    const result = await provider.decide(
      makeCoupReq({
        legalActions,
        publicState: {
          phase: "action",
          current_turn: "p1",
          your_cards: ["Duke", "Assassin"],
          your_revealed: [],
          coins: 7,
        },
      }),
    );

    expect(result.action).toBe("coup");
    expect(result.params).toBe(coupP1.data);
  });

  it("Texas raise: params is reconstructed object (not the legalActions reference)", async () => {
    const raiseAction: LegalAction = {
      type: "raise",
      data: { amount: 800, min: 800, max: 9000 },
    };
    const { client } = makeMockClient(async () =>
      makeOkResponse('{"action":"raise","data":{"amount":1500}}'),
    );
    const provider = createDirectModelProvider({
      name: "test",
      apiKeyResolver: () => "test-key",
      clientFactory: { anthropic: vi.fn(() => client) },
    });

    const result = await provider.decide(
      makeTexasReq({
        legalActions: [{ type: "fold", data: {} }, raiseAction],
      }),
    );

    expect(result.action).toBe("raise");
    expect(result.params).toEqual({ amount: 1500 });
    expect(result.params).not.toBe(raiseAction.data);
  });
});

describe("createDirectModelProvider — retry budget", () => {
  it("ParseInvalid on first attempt then ok on second → retries=1", async () => {
    let call = 0;
    const { client } = makeMockClient(async () => {
      call += 1;
      if (call === 1) return makeOkResponse("Sorry I can't.");
      return makeOkResponse('{"action":"income","data":{}}');
    });
    const provider = createDirectModelProvider({
      name: "test",
      apiKeyResolver: () => "test-key",
      clientFactory: { anthropic: vi.fn(() => client) },
    });

    const result = await provider.decide(makeCoupReq());

    expect(result.action).toBe("income");
    expect(result.providerMetadata.retries).toBe(1);
    expect(result.providerMetadata.fallback).toBe(false);
  });

  it("3 ParseInvalid in a row → fallback dispatched, retries=2, fallback=true", async () => {
    const { client, generate } = makeMockClient(async () =>
      makeOkResponse("not even close to JSON"),
    );
    const provider = createDirectModelProvider({
      name: "test",
      apiKeyResolver: () => "test-key",
      clientFactory: { anthropic: vi.fn(() => client) },
      retryBudget: 2,
    });

    const result = await provider.decide(makeCoupReq());

    expect(generate).toHaveBeenCalledTimes(3);
    expect(result.action).toBe("income"); // M1-13 Coup priority for action phase
    expect(result.providerMetadata.retries).toBe(2);
    expect(result.providerMetadata.fallback).toBe(true);
    expect(result.summary).toMatch(/^\(fallback: parse_/);
  });

  it("DirectModelHttpError 429 then ok → retries=1", async () => {
    let call = 0;
    const { client } = makeMockClient(async () => {
      call += 1;
      if (call === 1) {
        throw new DirectModelHttpError("anthropic", 429, "rate limited", "{}");
      }
      return makeOkResponse('{"action":"income","data":{}}');
    });
    const provider = createDirectModelProvider({
      name: "test",
      apiKeyResolver: () => "test-key",
      clientFactory: { anthropic: vi.fn(() => client) },
    });

    const result = await provider.decide(makeCoupReq());

    expect(result.providerMetadata.retries).toBe(1);
    expect(result.providerMetadata.fallback).toBe(false);
  });

  it("DirectModelHttpError 503 then ok → retries=1", async () => {
    let call = 0;
    const { client } = makeMockClient(async () => {
      call += 1;
      if (call === 1) {
        throw new DirectModelHttpError("anthropic", 503, "upstream", "{}");
      }
      return makeOkResponse('{"action":"income","data":{}}');
    });
    const provider = createDirectModelProvider({
      name: "test",
      apiKeyResolver: () => "test-key",
      clientFactory: { anthropic: vi.fn(() => client) },
    });

    const result = await provider.decide(makeCoupReq());
    expect(result.providerMetadata.retries).toBe(1);
  });

  it("DirectModelNetworkError then DirectModelInvalidResponse then ok → retries=2", async () => {
    let call = 0;
    const { client } = makeMockClient(async () => {
      call += 1;
      if (call === 1) {
        throw new DirectModelNetworkError("anthropic", "ECONNREFUSED");
      }
      if (call === 2) {
        throw new DirectModelInvalidResponseError(
          "anthropic",
          "missing content",
          '{"foo":"bar"}',
        );
      }
      return makeOkResponse('{"action":"income","data":{}}');
    });
    const provider = createDirectModelProvider({
      name: "test",
      apiKeyResolver: () => "test-key",
      clientFactory: { anthropic: vi.fn(() => client) },
    });

    const result = await provider.decide(makeCoupReq());

    expect(result.providerMetadata.retries).toBe(2);
    expect(result.providerMetadata.fallback).toBe(false);
  });

  it("3x DirectModelNetworkError → fallback exhausted, fallback=true, retries=2", async () => {
    const { client, generate } = makeMockClient(async () => {
      throw new DirectModelNetworkError("anthropic", "DNS fail");
    });
    const provider = createDirectModelProvider({
      name: "test",
      apiKeyResolver: () => "test-key",
      clientFactory: { anthropic: vi.fn(() => client) },
    });

    const result = await provider.decide(makeCoupReq());

    expect(generate).toHaveBeenCalledTimes(3);
    expect(result.providerMetadata.fallback).toBe(true);
    expect(result.providerMetadata.retries).toBe(2);
    expect(result.summary).toBe("(fallback: direct_model_direct_model_network)");
  });

  it("retry hint appears in attempt 2's userPrompt but not attempt 1's", async () => {
    const userPrompts: string[] = [];
    const { client } = makeMockClient(async (req) => {
      userPrompts.push(req.userPrompt);
      if (userPrompts.length === 1) return makeOkResponse("garbage");
      return makeOkResponse('{"action":"income","data":{}}');
    });
    const provider = createDirectModelProvider({
      name: "test",
      apiKeyResolver: () => "test-key",
      clientFactory: { anthropic: vi.fn(() => client) },
    });

    await provider.decide(makeCoupReq());

    expect(userPrompts.length).toBe(2);
    expect(userPrompts[0]).not.toContain("Retry attempt");
    expect(userPrompts[1]).toContain("Retry attempt 1");
    expect(userPrompts[1]).toContain("Reason: parse_json_parse");
    expect(userPrompts[1]).toContain("garbage");
  });
});

describe("createDirectModelProvider — fatal errors wrap as DecisionProviderError", () => {
  it("DirectModelHttpError 401 → throw fatal_http (no fallback)", async () => {
    const { client, generate } = makeMockClient(async () => {
      throw new DirectModelHttpError("anthropic", 401, "unauthorized", "{}");
    });
    const provider = createDirectModelProvider({
      name: "test",
      apiKeyResolver: () => "test-key",
      clientFactory: { anthropic: vi.fn(() => client) },
    });

    await expect(provider.decide(makeCoupReq())).rejects.toMatchObject({
      name: "DecisionProviderError",
      kind: "fatal_http",
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("DirectModelHttpError 404 → throw fatal_http", async () => {
    const { client } = makeMockClient(async () => {
      throw new DirectModelHttpError("anthropic", 404, "not found", "{}");
    });
    const provider = createDirectModelProvider({
      name: "test",
      apiKeyResolver: () => "test-key",
      clientFactory: { anthropic: vi.fn(() => client) },
    });

    let caught: unknown;
    try {
      await provider.decide(makeCoupReq());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DecisionProviderError);
    expect((caught as DecisionProviderError).kind).toBe("fatal_http");
    expect((caught as DecisionProviderError).cause).toBeInstanceOf(
      DirectModelHttpError,
    );
  });

  it("DirectModelAbortedError → throw fatal_aborted", async () => {
    const { client } = makeMockClient(async () => {
      throw new DirectModelAbortedError("anthropic", "aborted");
    });
    const provider = createDirectModelProvider({
      name: "test",
      apiKeyResolver: () => "test-key",
      clientFactory: { anthropic: vi.fn(() => client) },
    });

    await expect(provider.decide(makeCoupReq())).rejects.toMatchObject({
      kind: "fatal_aborted",
    });
  });

  it("DirectModelUnsupportedError thrown by generate → fatal_unsupported", async () => {
    const { client } = makeMockClient(async () => {
      throw new DirectModelUnsupportedError(
        "anthropic",
        "maxTokens",
        "must be positive",
      );
    });
    const provider = createDirectModelProvider({
      name: "test",
      apiKeyResolver: () => "test-key",
      clientFactory: { anthropic: vi.fn(() => client) },
    });

    await expect(provider.decide(makeCoupReq())).rejects.toMatchObject({
      kind: "fatal_unsupported",
    });
  });

  it("apiKeyResolver returns empty string → fatal_unsupported (no client built)", async () => {
    const factory = vi.fn();
    const provider = createDirectModelProvider({
      name: "test",
      apiKeyResolver: () => "",
      clientFactory: { anthropic: factory },
    });

    await expect(provider.decide(makeCoupReq())).rejects.toMatchObject({
      kind: "fatal_unsupported",
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it("decisionBudgetMs <= 0 → fatal_caller_bug", async () => {
    const provider = createDirectModelProvider({
      name: "test",
      apiKeyResolver: () => "test-key",
      clientFactory: { anthropic: vi.fn() },
    });

    await expect(
      provider.decide(makeCoupReq({ decisionBudgetMs: 0 })),
    ).rejects.toMatchObject({ kind: "fatal_caller_bug" });
  });

  it("req.game not in enum → fatal_caller_bug", async () => {
    const provider = createDirectModelProvider({
      name: "test",
      apiKeyResolver: () => "test-key",
      clientFactory: { anthropic: vi.fn() },
    });

    const badReq = { ...makeCoupReq(), game: "checkers" } as unknown as DecisionRequest;

    await expect(provider.decide(badReq)).rejects.toMatchObject({
      kind: "fatal_caller_bug",
    });
  });

  it("decisionBudgetMs trips before generate resolves → fatal_aborted", async () => {
    const { client } = makeMockClient(
      (req) =>
        new Promise<DirectModelGenerateResponse>((_, reject) => {
          req.signal?.addEventListener("abort", () => {
            reject(new DirectModelAbortedError("anthropic", "aborted"));
          });
        }),
    );
    const provider = createDirectModelProvider({
      name: "test",
      apiKeyResolver: () => "test-key",
      clientFactory: { anthropic: vi.fn(() => client) },
    });

    await expect(
      provider.decide(makeCoupReq({ decisionBudgetMs: 5 })),
    ).rejects.toMatchObject({ kind: "fatal_aborted" });
  });
});

describe("createDirectModelProvider — provider switch + cache", () => {
  it("anthropic strategy → only anthropic factory invoked", async () => {
    const anthropicFactory = vi.fn(() =>
      makeMockClient(async () =>
        makeOkResponse('{"action":"income","data":{}}'),
      ).client,
    );
    const openaiFactory = vi.fn();
    const provider = createDirectModelProvider({
      name: "test",
      apiKeyResolver: () => "test-key",
      clientFactory: { anthropic: anthropicFactory, openai: openaiFactory },
    });

    await provider.decide(
      makeCoupReq({
        strategyProfile: makeStrategy({
          provider: "anthropic",
          model: "claude-opus-4-7",
        }),
      }),
    );

    expect(anthropicFactory).toHaveBeenCalledTimes(1);
    expect(openaiFactory).not.toHaveBeenCalled();
  });

  it("openai strategy → only openai factory invoked", async () => {
    const anthropicFactory = vi.fn();
    const openaiFactory = vi.fn(() =>
      makeMockClient(
        async () => makeOkResponse('{"action":"income","data":{}}'),
        "openai",
        "gpt-5",
      ).client,
    );
    const provider = createDirectModelProvider({
      name: "test",
      apiKeyResolver: () => "test-key",
      clientFactory: { anthropic: anthropicFactory, openai: openaiFactory },
    });

    await provider.decide(
      makeCoupReq({
        strategyProfile: makeStrategy({ provider: "openai", model: "gpt-5" }),
      }),
    );

    expect(openaiFactory).toHaveBeenCalledTimes(1);
    expect(anthropicFactory).not.toHaveBeenCalled();
  });

  it("client cache: factory built once across multiple decides for same (provider, model)", async () => {
    const { client } = makeMockClient(async () =>
      makeOkResponse('{"action":"income","data":{}}'),
    );
    const factory = vi.fn(() => client);
    const provider = createDirectModelProvider({
      name: "test",
      apiKeyResolver: () => "test-key",
      clientFactory: { anthropic: factory },
    });

    await provider.decide(makeCoupReq());
    await provider.decide(makeCoupReq());
    await provider.decide(makeCoupReq());

    expect(factory).toHaveBeenCalledTimes(1);
  });
});

describe("createDirectModelProvider — fallback path metadata", () => {
  it("fallback path params is the server-provided LegalAction.data reference", async () => {
    const incomeAction: LegalAction = { type: "income", data: { source: "treasury" } };
    const { client } = makeMockClient(async () =>
      makeOkResponse("garbage all the way"),
    );
    const provider = createDirectModelProvider({
      name: "test",
      apiKeyResolver: () => "test-key",
      clientFactory: { anthropic: vi.fn(() => client) },
    });

    const result = await provider.decide(
      makeCoupReq({ legalActions: [incomeAction] }),
    );

    expect(result.providerMetadata.fallback).toBe(true);
    expect(result.action).toBe("income");
    expect(result.params).toBe(incomeAction.data);
  });

  it("fallback path inputTokens carries the last successful generate's usage", async () => {
    let call = 0;
    const { client } = makeMockClient(async () => {
      call += 1;
      if (call === 1) {
        return {
          text: "garbage",
          inputTokens: 77,
          outputTokens: 11,
          latencyMs: 9,
          raw: {},
        };
      }
      throw new DirectModelNetworkError("anthropic", "DNS fail later");
    });
    const provider = createDirectModelProvider({
      name: "test",
      apiKeyResolver: () => "test-key",
      clientFactory: { anthropic: vi.fn(() => client) },
    });

    const result = await provider.decide(makeCoupReq());

    expect(result.providerMetadata.fallback).toBe(true);
    expect(result.providerMetadata.inputTokens).toBe(77);
    expect(result.providerMetadata.outputTokens).toBe(11);
    expect(result.providerMetadata.latencyMs).toBeGreaterThanOrEqual(9);
  });
});

describe("createDirectModelProvider — option + factory hardening (Step 2b)", () => {
  it("apiKeyResolver throwing is wrapped as fatal_unsupported with cause preserved", async () => {
    const factory = vi.fn();
    const original = new Error("keychain locked");
    const provider = createDirectModelProvider({
      name: "test",
      apiKeyResolver: () => {
        throw original;
      },
      clientFactory: { anthropic: factory },
    });

    let caught: unknown;
    try {
      await provider.decide(makeCoupReq());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DecisionProviderError);
    expect((caught as DecisionProviderError).kind).toBe("fatal_unsupported");
    expect((caught as DecisionProviderError).cause).toBe(original);
    expect(factory).not.toHaveBeenCalled();
  });

  it("clientFactory throwing a non-DirectModelUnsupportedError is wrapped as fatal_caller_bug", async () => {
    const original = new TypeError("mock factory broke");
    const factory = vi.fn(() => {
      throw original;
    });
    const provider = createDirectModelProvider({
      name: "test",
      apiKeyResolver: () => "test-key",
      clientFactory: { anthropic: factory },
    });

    let caught: unknown;
    try {
      await provider.decide(makeCoupReq());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DecisionProviderError);
    expect((caught as DecisionProviderError).kind).toBe("fatal_caller_bug");
    expect((caught as DecisionProviderError).cause).toBe(original);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("clientFactory throwing DirectModelUnsupportedError stays fatal_unsupported (existing path preserved)", async () => {
    const factory = vi.fn(() => {
      throw new DirectModelUnsupportedError(
        "anthropic",
        "model",
        "model must be non-empty",
      );
    });
    const provider = createDirectModelProvider({
      name: "test",
      apiKeyResolver: () => "test-key",
      clientFactory: { anthropic: factory },
    });

    await expect(provider.decide(makeCoupReq())).rejects.toMatchObject({
      kind: "fatal_unsupported",
    });
  });

  it("rejects retryBudget = -1 at construction with fatal_caller_bug", () => {
    expect(() =>
      createDirectModelProvider({
        name: "test",
        apiKeyResolver: () => "test-key",
        clientFactory: { anthropic: vi.fn() },
        retryBudget: -1,
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "DecisionProviderError",
        kind: "fatal_caller_bug",
      }),
    );
  });

  it("rejects non-integer / NaN retryBudget at construction", () => {
    expect(() =>
      createDirectModelProvider({
        name: "test",
        apiKeyResolver: () => "test-key",
        clientFactory: { anthropic: vi.fn() },
        retryBudget: 1.5,
      }),
    ).toThrowError(
      expect.objectContaining({ kind: "fatal_caller_bug" }),
    );

    expect(() =>
      createDirectModelProvider({
        name: "test",
        apiKeyResolver: () => "test-key",
        clientFactory: { anthropic: vi.fn() },
        retryBudget: Number.NaN,
      }),
    ).toThrowError(
      expect.objectContaining({ kind: "fatal_caller_bug" }),
    );
  });

  it("rejects parseRetryHintCharCap = 0 / negative / non-integer at construction", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createDirectModelProvider({
          name: "test",
          apiKeyResolver: () => "test-key",
          clientFactory: { anthropic: vi.fn() },
          parseRetryHintCharCap: bad,
        }),
      ).toThrowError(
        expect.objectContaining({ kind: "fatal_caller_bug" }),
      );
    }
  });

  it("custom parseRetryHintCharCap > 500 propagates into per-game parser → retry hint carries longer raw snippet", async () => {
    const longGarbage = "X".repeat(800);
    const userPrompts: string[] = [];
    let call = 0;
    const { client } = makeMockClient(async (req) => {
      userPrompts.push(req.userPrompt);
      call += 1;
      if (call === 1) return makeOkResponse(longGarbage);
      return makeOkResponse('{"action":"income","data":{}}');
    });
    const provider = createDirectModelProvider({
      name: "test",
      apiKeyResolver: () => "test-key",
      clientFactory: { anthropic: vi.fn(() => client) },
      parseRetryHintCharCap: 800,
    });

    await provider.decide(makeCoupReq());

    expect(userPrompts.length).toBe(2);
    // Step 2b regression guard: the retry prompt must contain the
    // FULL 800-char garbage payload, not the default-500 truncation.
    // If parseAction ever drops the cap parameter, the parser would
    // silently re-truncate to 500 and the snippet length check fails.
    const snippet = "X".repeat(800);
    expect(userPrompts[1]).toContain(snippet);
    expect(userPrompts[1]).toContain("Previous output (truncated to 800 chars)");
  });
});

describe("createDirectModelProvider — healthCheck", () => {
  it("returns false when no healthCheckProfile is configured", async () => {
    const factory = vi.fn();
    const provider = createDirectModelProvider({
      name: "test",
      apiKeyResolver: () => "test-key",
      clientFactory: { anthropic: factory },
    });

    expect(await provider.healthCheck()).toBe(false);
    expect(factory).not.toHaveBeenCalled();
  });

  it("returns true when configured profile generates 200 OK", async () => {
    const { client } = makeMockClient(async () =>
      makeOkResponse("OK"),
    );
    const provider = createDirectModelProvider({
      name: "test",
      apiKeyResolver: () => "test-key",
      clientFactory: { anthropic: vi.fn(() => client) },
      healthCheckProfile: { provider: "anthropic", model: "claude-opus-4-7" },
    });

    expect(await provider.healthCheck()).toBe(true);
  });

  it("returns false when configured profile generate throws", async () => {
    const { client } = makeMockClient(async () => {
      throw new DirectModelHttpError("anthropic", 401, "bad key");
    });
    const provider = createDirectModelProvider({
      name: "test",
      apiKeyResolver: () => "test-key",
      clientFactory: { anthropic: vi.fn(() => client) },
      healthCheckProfile: { provider: "anthropic", model: "claude-opus-4-7" },
    });

    expect(await provider.healthCheck()).toBe(false);
  });

  it("returns false when apiKeyResolver returns empty string", async () => {
    const factory = vi.fn();
    const provider = createDirectModelProvider({
      name: "test",
      apiKeyResolver: () => "",
      clientFactory: { anthropic: factory },
      healthCheckProfile: { provider: "anthropic", model: "claude-opus-4-7" },
    });

    expect(await provider.healthCheck()).toBe(false);
    expect(factory).not.toHaveBeenCalled();
  });
});
