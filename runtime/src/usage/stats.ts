// Pure aggregation over usage records (borrow-spec §7A). No filesystem
// access here — callers feed records + a price table, so everything is
// unit-testable and the CLI/desktop share one implementation.

import type { ModelPrice, PriceTable } from "./prices";
import { estimateCallCost } from "./prices";
import type { UsageRecord } from "./usage-log";

export interface UsageBucket {
  /** Bucket key: model name, match id, or "total". */
  readonly key: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  /** Estimated cost over PRICED calls only; undefined when no call was priced. */
  estimatedCost?: number;
  /** Calls that had no price entry (cost unknown). */
  unpricedCalls: number;
  /** Distinct matches contributing to this bucket. */
  readonly matchIds: Set<string>;
}

export interface UsageSummary {
  readonly total: UsageBucket;
  readonly byModel: UsageBucket[];
  readonly byMatch: UsageBucket[];
  readonly currency: string;
}

function newBucket(key: string): UsageBucket {
  return {
    key,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    unpricedCalls: 0,
    matchIds: new Set<string>(),
  };
}

function addRecord(b: UsageBucket, r: UsageRecord, price: ModelPrice | undefined): void {
  b.calls++;
  b.inputTokens += r.input_tokens ?? 0;
  b.outputTokens += r.output_tokens ?? 0;
  b.reasoningTokens += r.reasoning_tokens ?? 0;
  b.cachedTokens += r.cached_tokens ?? 0;
  b.cacheWriteTokens += r.cache_write_tokens ?? 0;
  if (r.match_id) b.matchIds.add(r.match_id);
  if (price === undefined) {
    b.unpricedCalls++;
    return;
  }
  const cost = estimateCallCost(price, {
    ...(r.input_tokens !== undefined ? { input: r.input_tokens } : {}),
    ...(r.output_tokens !== undefined ? { output: r.output_tokens } : {}),
    ...(r.cached_tokens !== undefined ? { cached: r.cached_tokens } : {}),
    ...(r.cache_write_tokens !== undefined ? { cacheWrite: r.cache_write_tokens } : {}),
  });
  b.estimatedCost = (b.estimatedCost ?? 0) + cost;
}

export function summarizeUsage(records: readonly UsageRecord[], prices: PriceTable): UsageSummary {
  const total = newBucket("total");
  const byModel = new Map<string, UsageBucket>();
  const byMatch = new Map<string, UsageBucket>();

  for (const r of records) {
    const price = prices.models[r.model];
    addRecord(total, r, price);

    let mb = byModel.get(r.model);
    if (!mb) {
      mb = newBucket(r.model);
      byModel.set(r.model, mb);
    }
    addRecord(mb, r, price);

    const matchKey = r.match_id || "(unknown)";
    let xb = byMatch.get(matchKey);
    if (!xb) {
      xb = newBucket(matchKey);
      byMatch.set(matchKey, xb);
    }
    addRecord(xb, r, price);
  }

  const sortByTokens = (a: UsageBucket, b: UsageBucket) =>
    b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens);

  return {
    total,
    byModel: [...byModel.values()].sort(sortByTokens),
    byMatch: [...byMatch.values()].sort(sortByTokens),
    currency: prices.currency,
  };
}

/** Average output tokens per call (the Kaggle-style "per step" number). */
export function avgOutputPerCall(b: UsageBucket): number {
  return b.calls > 0 ? Math.round(b.outputTokens / b.calls) : 0;
}

/** Average estimated cost per call over priced calls; undefined when unpriced. */
export function avgCostPerCall(b: UsageBucket): number | undefined {
  const priced = b.calls - b.unpricedCalls;
  if (b.estimatedCost === undefined || priced <= 0) return undefined;
  return b.estimatedCost / priced;
}
