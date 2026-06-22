// Local token-usage aggregation for the home dashboard (§7A). Reads the SAME
// JSONL ledger + price table the CLI's `aifight stats` / `aifight prices` use
// (runtime/src/usage/*), so the numbers match exactly. Pure local reads —
// nothing here touches the network, and estimated costs never leave the machine.

import { readUsageRecordsSince, type UsageRecord } from "@aifight/aifight/usage/usage-log";
import { summarizeUsage, type UsageBucket } from "@aifight/aifight/usage/stats";
import { loadPriceTable } from "@aifight/aifight/usage/prices";
import type { UsageBucketDTO, UsageOverview } from "../shared/ipc";

function toDTO(b: UsageBucket): UsageBucketDTO {
  return {
    key: b.key,
    calls: b.calls,
    inputTokens: b.inputTokens,
    outputTokens: b.outputTokens,
    reasoningTokens: b.reasoningTokens,
    cachedTokens: b.cachedTokens,
    ...(b.estimatedCost !== undefined ? { estimatedCost: b.estimatedCost } : {}),
    unpricedCalls: b.unpricedCalls,
    matches: b.matchIds.size,
  };
}

/** Aggregate the local ledger for the dashboard: current month + today. */
export function getUsageOverview(now: Date = new Date()): UsageOverview {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const prices = loadPriceTable();

  let monthRecords: UsageRecord[];
  try {
    monthRecords = readUsageRecordsSince(monthStart, now);
  } catch {
    monthRecords = [];
  }
  const todayRecords = monthRecords.filter((r) => {
    const t = Date.parse(r.ts);
    return Number.isFinite(t) && t >= dayStart.getTime();
  });

  const month = summarizeUsage(monthRecords, prices);
  const today = summarizeUsage(todayRecords, prices);

  return {
    month: { total: toDTO(month.total), byModel: month.byModel.map(toDTO) },
    today: { total: toDTO(today.total) },
    currency: month.currency,
    hasPrices: Object.keys(prices.models).length > 0,
  };
}
