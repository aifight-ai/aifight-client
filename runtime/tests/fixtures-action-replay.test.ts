// M1-20 Step 2: action-parser fixture replay.
//
// Walks each game-typed transcript looking for (action_request → action)
// pairs and feeds the parsers a synthesized LLM-format JSON whose fields
// mirror the recorded wire action. Asserts parser returns kind:"ok" and
// the parsed action matches the recorded wire action.
//
// Why the LLM-format wrap: per protocol, parsers consume LLM completions
// (envelope `{"action": "<type>", "data": {...}}`); transcripts hold
// wire actions (envelope `{"type": "<type>", "data": {...}}`). The
// fixture rebuilds the LLM-format text the parser would have seen if
// the LLM had emitted exactly the recorded action — a unit-level
// parser regression check, not a Mode B oracle (M1-22 territory).

import { describe, expect, it, test } from "vitest";

import { loadTranscript, type LoadedTranscript } from "./_fixtures/transcripts";
import { parseTexasHoldemAction } from "../src/games/texas_holdem/action-parser";
import { parseLiarsDiceAction } from "../src/games/liars_dice/action-parser";
import { parseCoupAction } from "../src/games/coup/action-parser";
import type { LegalAction } from "../src/decision/types";
import type { ParseResult } from "../src/decision/parser-types";

type Game = "texas_holdem" | "liars_dice" | "coup";

const PARSERS: Record<Game, (raw: string, legal: readonly LegalAction[]) => ParseResult> = {
  texas_holdem: parseTexasHoldemAction,
  liars_dice: parseLiarsDiceAction,
  coup: parseCoupAction,
};

// 2 happy_path transcripts where parser straight-pass is the expected
// flow. Coup forfeit + server_error_illegal_action are tested in
// separate describes below — Coup's challenge/block cascades use a
// `pending_action` state machine where some actions are legal outside
// the `legal_actions` enum (parser correctly rejects those as
// action_not_legal — protocol intent, not parser bug); illegal_action
// is *designed* to be rejected.
const TRANSCRIPT_FIXTURES: ReadonlyArray<{ name: string; game: Game }> = [
  { name: "happy_path/texas_holdem_4player.jsonl", game: "texas_holdem" },
  { name: "happy_path/liars_dice_3player.jsonl", game: "liars_dice" },
];

interface ActionPair {
  readonly legalActions: readonly LegalAction[];
  readonly wireAction: Readonly<{ type: string; data?: Record<string, unknown> }>;
  readonly index: number;
}

function extractActionPairs(t: LoadedTranscript): ActionPair[] {
  const pairs: ActionPair[] = [];
  let lastLegalActions: readonly LegalAction[] | undefined;
  for (let i = 0; i < t.entries.length; i += 1) {
    const e = t.entries[i];
    if (e.direction === "server_to_client" && e.payload.type === "action_request") {
      const data = e.payload.data as { legal_actions?: readonly LegalAction[] | null };
      // Coup informational action_request can carry legal_actions: null
      // (event-broadcast variant; e.g. line 14 of
      // edge_cases/coup_3player_forfeit_disconnect.jsonl). Treat null /
      // empty as "no actionable hint" and retain the previous legal set.
      if (data.legal_actions != null && data.legal_actions.length > 0) {
        lastLegalActions = data.legal_actions;
      }
      continue;
    }
    if (e.direction === "client_to_server" && e.payload.type === "action") {
      // Skip actions that lack a preceding actionable hint — capture
      // ordering quirks (Coup multi-player block / challenge cascades)
      // can produce sparse pairings. Parser fixture only needs the
      // happy 1-to-1 pairs.
      if (!lastLegalActions) continue;
      // wire envelope is `{type: "action", data: {type: "<game-action>",
      // data?: {...}}}`. Unwrap the inner game-action layer here so
      // pair.wireAction.type === "raise" / "bid" / etc. directly.
      const inner = e.payload.data as ActionPair["wireAction"] | undefined;
      if (!inner || typeof inner.type !== "string") continue;
      pairs.push({
        legalActions: lastLegalActions,
        wireAction: inner,
        index: i + 1,
      });
    }
  }
  return pairs;
}

function llmFormatFromWire(wireAction: ActionPair["wireAction"]): string {
  // Rename wire envelope `{type, data}` to LLM envelope `{action, data}`
  // — preserves data shape exactly, no field mutation. parser consumes
  // this, returns kind:"ok" with `action` back in wire shape.
  const llm: Record<string, unknown> = { action: wireAction.type };
  if (wireAction.data !== undefined) {
    llm.data = wireAction.data;
  }
  return JSON.stringify(llm);
}

describe("fixtures-action-replay", () => {
  for (const fixture of TRANSCRIPT_FIXTURES) {
    describe(fixture.name, () => {
      const t = loadTranscript(fixture.name);
      const pairs = extractActionPairs(t);
      const parse = PARSERS[fixture.game];

      it(`yields ≥1 (action_request → action) pair`, () => {
        expect(pairs.length).toBeGreaterThanOrEqual(1);
      });

      test.each(pairs.map((p, idx) => [idx, p] as const))(
        "action[%i] (line %s): parser returns ok + action.type matches wire",
        (_idx, pair) => {
          const llmText = llmFormatFromWire(pair.wireAction);
          const result = parse(llmText, pair.legalActions);
          if (result.kind !== "ok") {
            throw new Error(
              `${fixture.name} line ${pair.index}: parser returned kind=${result.kind} reason=${(result as { reason?: string }).reason ?? "n/a"} for input ${llmText}`,
            );
          }
          expect(result.action.type).toBe(pair.wireAction.type);
          // Verify parser's action is structurally a member-or-equivalent
          // of legal_actions (reference equality holds for fold/check/call/
          // allin/challenge/pass etc; raise/bid construct fresh objects per
          // M1-14 拍板点 #5).
          const matchByType = pair.legalActions.find((la) => la.type === pair.wireAction.type);
          expect(matchByType).toBeDefined();
        },
      );
    });
  }
});

describe("fixtures-action-replay: amount fidelity", () => {
  // Stronger assertion for raise/bid actions: parser's reconstructed
  // amount must equal the wire action's amount (M1-14 §6 — fresh
  // {type, data} object holds the parsed amount).
  const t = loadTranscript("happy_path/texas_holdem_4player.jsonl");
  const pairs = extractActionPairs(t);
  const raisePairs = pairs.filter((p) => p.wireAction.type === "raise");

  it("texas hold'em transcript contains ≥1 raise action", () => {
    expect(raisePairs.length).toBeGreaterThanOrEqual(1);
  });

  test.each(raisePairs.map((p, idx) => [idx, p] as const))(
    "raise[%i]: parser amount === wire amount",
    (_idx, pair) => {
      const result = parseTexasHoldemAction(llmFormatFromWire(pair.wireAction), pair.legalActions);
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        const parsedData = result.action.data as { amount?: number } | undefined;
        const wireData = pair.wireAction.data as { amount?: number } | undefined;
        expect(parsedData?.amount).toBe(wireData?.amount);
      }
    },
  );
});

describe("fixtures-action-replay: liar's dice bid fidelity", () => {
  const t = loadTranscript("happy_path/liars_dice_3player.jsonl");
  const pairs = extractActionPairs(t);
  const bidPairs = pairs.filter((p) => p.wireAction.type === "bid");

  it("liars_dice transcript contains ≥1 bid action", () => {
    expect(bidPairs.length).toBeGreaterThanOrEqual(1);
  });

  test.each(bidPairs.map((p, idx) => [idx, p] as const))(
    "bid[%i]: parser quantity+face === wire quantity+face",
    (_idx, pair) => {
      const result = parseLiarsDiceAction(llmFormatFromWire(pair.wireAction), pair.legalActions);
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        const parsed = result.action.data as { quantity?: number; face?: number } | undefined;
        const wire = pair.wireAction.data as { quantity?: number; face?: number } | undefined;
        expect(parsed?.quantity).toBe(wire?.quantity);
        expect(parsed?.face).toBe(wire?.face);
      }
    },
  );
});

// ---- edge case transcripts: structural negative tests ----

describe("fixtures-action-replay: server_error_illegal_action", () => {
  // Spec §7.4: client sends a `challenge` when only `bid` is legal
  // → server replies with error + retry action_request. The parser's
  // job (M1-14) is to enforce legality; the recorded illegal action
  // therefore MUST surface as kind:"invalid" reason:"action_not_legal".
  it("parser rejects the recorded illegal challenge with action_not_legal", () => {
    const t = loadTranscript("edge_cases/server_error_illegal_action.jsonl");
    const pairs = extractActionPairs(t);
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    const first = pairs[0];
    expect(first.wireAction.type).toBe("challenge");
    const result = parseLiarsDiceAction(llmFormatFromWire(first.wireAction), first.legalActions);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.reason).toBe("action_not_legal");
    }
  });
});

describe("fixtures-action-replay: coup forfeit pending_action interactions", () => {
  // Coup has a challenge / block / lose_card cascade where the legal
  // set hangs off `pending_action` state, not the bare `legal_actions`
  // enum. Some recorded actions therefore fail the parser's strict
  // legal_actions membership check — that is protocol-correct (parser
  // is M1-14 LLM-output validator; pending_action handling is M1-22
  // / soak territory). We assert the *shape* of every recorded action
  // is parseable structure-wise (json_parse succeeds, action.type is a
  // known coup type) but we accept either kind:"ok" or
  // kind:"invalid" with reason:"action_not_legal" — never json_parse,
  // missing_fields, unknown_action_type, or data_validation.
  it("every recorded action parses to a structurally valid coup type", () => {
    const t = loadTranscript("edge_cases/coup_3player_forfeit_disconnect.jsonl");
    const pairs = extractActionPairs(t);
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    const ALLOWED_INVALID = new Set(["action_not_legal"]);
    for (const pair of pairs) {
      const result = parseCoupAction(llmFormatFromWire(pair.wireAction), pair.legalActions);
      if (result.kind === "ok") continue;
      if (!ALLOWED_INVALID.has(result.reason)) {
        throw new Error(
          `${"edge_cases/coup_3player_forfeit_disconnect.jsonl"} line ${pair.index}: unexpected parser reason='${result.reason}' for action.type='${pair.wireAction.type}'`,
        );
      }
    }
  });
});
