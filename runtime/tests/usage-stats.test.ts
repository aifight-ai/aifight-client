// §7A acceptance: aggregation math, the no-built-in-price-table policy
// (unpriced models show tokens but no cost), cache-hit pricing, and the
// per-call averages (the Kaggle-style "per step" numbers).

import { describe, expect, it } from "vitest";

import { emptyPriceTable, estimateCallCost, type PriceTable } from "../src/usage/prices";
import { avgCostPerCall, avgOutputPerCall, summarizeUsage } from "../src/usage/stats";
import type { UsageRecord } from "../src/usage/usage-log";

function rec(partial: Partial<UsageRecord> & { model: string }): UsageRecord {
  return {
    ts: "2026-06-12T03:00:00.000Z",
    match_id: "m-1",
    game: "texas_holdem",
    provider: "anthropic_messages",
    decision_source: "model",
    ...partial,
  };
}

const PRICED: PriceTable = {
  version: 1,
  currency: "$",
  models: {
    "claude-x": { input: 3, output: 15, cacheHit: 0.3 }, // per 1M tokens
  },
};

describe("usage stats (§7A)", () => {
  it("estimateCallCost: input/output/cache-hit at per-million prices", () => {
    const price = PRICED.models["claude-x"]!;
    // 1M non-cached input + 1M output = 3 + 15
    expect(estimateCallCost(price, { input: 1_000_000, output: 1_000_000 })).toBe(18);
    // fully cached input bills at the cache-hit rate
    expect(estimateCallCost(price, { input: 1_000_000, cached: 1_000_000 })).toBe(0.3);
    // provider-reported input may EXCLUDE cache reads — never go negative
    expect(estimateCallCost(price, { input: 100, cached: 5_000, output: 0 })).toBeCloseTo(
      (5_000 * 0.3) / 1_000_000,
      9,
    );
    // Cache writes are not cache hits; absent a separate write price, estimate
    // them at the ordinary input rate rather than the discounted cache-hit rate.
    expect(estimateCallCost(price, { input: 1_100, cached: 100, cacheWrite: 200 })).toBeCloseTo(
      (800 * 3 + 100 * 0.3 + 200 * 3) / 1_000_000,
      9,
    );
  });

  it("no built-in price table: default is empty, costs stay undefined", () => {
    const summary = summarizeUsage(
      [rec({ model: "claude-x", input_tokens: 1000, output_tokens: 500 })],
      emptyPriceTable(),
    );
    expect(summary.total.calls).toBe(1);
    expect(summary.total.inputTokens).toBe(1000);
    expect(summary.total.estimatedCost).toBeUndefined();
    expect(summary.total.unpricedCalls).toBe(1);
    expect(avgCostPerCall(summary.total)).toBeUndefined();
  });

  it("mixed priced + unpriced models: cost covers priced calls only and flags the rest", () => {
    const summary = summarizeUsage(
      [
        rec({ model: "claude-x", input_tokens: 1_000_000, output_tokens: 1_000_000 }),
        rec({ model: "mystery-self-hosted", input_tokens: 9_999, output_tokens: 9_999 }),
      ],
      PRICED,
    );
    expect(summary.total.calls).toBe(2);
    expect(summary.total.estimatedCost).toBe(18);
    expect(summary.total.unpricedCalls).toBe(1);
    const models = Object.fromEntries(summary.byModel.map((b) => [b.key, b]));
    expect(models["claude-x"]!.estimatedCost).toBe(18);
    expect(models["mystery-self-hosted"]!.estimatedCost).toBeUndefined();
  });

  it("groups by model and by match; averages are per call", () => {
    const summary = summarizeUsage(
      [
        rec({ model: "claude-x", match_id: "m-1", output_tokens: 100 }),
        rec({ model: "claude-x", match_id: "m-1", output_tokens: 300, decision_source: "model_retry" }),
        rec({ model: "claude-x", match_id: "m-2", output_tokens: 500 }),
      ],
      PRICED,
    );
    expect(summary.total.calls).toBe(3);
    expect(summary.total.matchIds.size).toBe(2);
    expect(avgOutputPerCall(summary.total)).toBe(300);
    const byMatch = Object.fromEntries(summary.byMatch.map((b) => [b.key, b]));
    expect(byMatch["m-1"]!.calls).toBe(2);
    expect(byMatch["m-2"]!.calls).toBe(1);
  });
});
