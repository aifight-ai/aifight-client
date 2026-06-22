// `aifight stats` — local token usage + estimated cost (borrow-spec §7A).
//
// Reads the local JSONL ledger (one line per model call) and the
// user-maintained price table. Models without a price entry show token
// counts only; every money figure is an ESTIMATE — the provider bill is
// authoritative. Nothing here talks to the network or the platform.

import { loadPriceTable } from "../../usage/prices";
import { readUsageRecordsSince } from "../../usage/usage-log";
import {
  avgCostPerCall,
  avgOutputPerCall,
  summarizeUsage,
  type UsageBucket,
} from "../../usage/stats";
import { UsageError, type HandlerArgs, type HandlerEnv } from "../shared";

const USAGE = [
  "usage: aifight stats [--days N] [--by-model] [--by-match] [--match <id>] [--json]",
  "",
  "Local token usage and estimated cost for your AIFight matches.",
  "Default window: the current month. Costs appear only for models you",
  "priced via `aifight prices set` — estimates; your provider bill is",
  "authoritative.",
].join("\n");

export async function runStats(args: HandlerArgs, env: HandlerEnv): Promise<number> {
  if (args.positional.length > 0) {
    throw new UsageError(`unexpected argument '${args.positional[0]}'`, USAGE);
  }

  const now = new Date();
  let since: Date;
  const daysFlag = args.flags["days"];
  if (daysFlag !== undefined) {
    const days = Number(daysFlag);
    if (!Number.isInteger(days) || days < 1 || days > 366) {
      throw new UsageError("--days must be an integer between 1 and 366", USAGE);
    }
    since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  } else {
    since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  let records = readUsageRecordsSince(since, now);
  const matchFilter = typeof args.flags["match"] === "string" ? (args.flags["match"] as string) : undefined;
  if (matchFilter !== undefined) {
    records = records.filter((r) => r.match_id === matchFilter || r.match_id.endsWith(matchFilter));
  }

  const prices = loadPriceTable();
  const summary = summarizeUsage(records, prices);

  if (args.jsonMode) {
    const bucketJSON = (b: UsageBucket) => ({
      key: b.key,
      calls: b.calls,
      matches: b.matchIds.size,
      input_tokens: b.inputTokens,
      output_tokens: b.outputTokens,
      reasoning_tokens: b.reasoningTokens,
      cached_tokens: b.cachedTokens,
      avg_output_tokens_per_call: avgOutputPerCall(b),
      ...(b.estimatedCost !== undefined ? { estimated_cost: round4(b.estimatedCost) } : {}),
      unpriced_calls: b.unpricedCalls,
    });
    env.stdout(
      JSON.stringify({
        since: since.toISOString(),
        until: now.toISOString(),
        currency: summary.currency,
        note: "costs are estimates; your provider bill is authoritative",
        total: bucketJSON(summary.total),
        by_model: summary.byModel.map(bucketJSON),
        by_match: summary.byMatch.map(bucketJSON),
      }) + "\n",
    );
    return 0;
  }

  if (summary.total.calls === 0) {
    env.stdout("No local usage recorded in this window yet. Play a direct-LLM match first.\n");
    return 0;
  }

  const t = summary.total;
  const cur = summary.currency;
  env.stdout(`Window: ${since.toISOString().slice(0, 10)} → ${now.toISOString().slice(0, 10)}\n`);
  env.stdout(
    `Total: ${t.calls} calls · ${t.matchIds.size} matches · in ${fmtTokens(t.inputTokens)} / out ${fmtTokens(t.outputTokens)}` +
      (t.cachedTokens > 0 ? ` / cached ${fmtTokens(t.cachedTokens)}` : "") +
      ` · avg out/call ${avgOutputPerCall(t)}\n`,
  );
  if (t.estimatedCost !== undefined) {
    const perCall = avgCostPerCall(t);
    env.stdout(
      `Estimated cost: ${cur}${round4(t.estimatedCost)}` +
        (perCall !== undefined ? ` (avg ${cur}${round4(perCall)}/call)` : "") +
        (t.unpricedCalls > 0 ? ` — ${t.unpricedCalls} calls unpriced` : "") +
        ` · estimate only, your bill is authoritative\n`,
    );
  } else {
    env.stdout("Estimated cost: — (no model prices set; see `aifight prices set --help`)\n");
  }

  const wantsByMatch = args.flags["by-match"] === true || matchFilter !== undefined;
  const rows = wantsByMatch ? summary.byMatch : summary.byModel;
  const label = wantsByMatch ? "Match" : "Model";
  env.stdout(`\n${label.padEnd(34)} ${"calls".padStart(6)} ${"in".padStart(10)} ${"out".padStart(10)} ${"avg out".padStart(8)} ${"est cost".padStart(12)}\n`);
  for (const b of rows.slice(0, 25)) {
    const cost =
      b.estimatedCost !== undefined
        ? `${cur}${round4(b.estimatedCost)}${b.unpricedCalls > 0 ? "*" : ""}`
        : "—";
    env.stdout(
      `${truncKey(b.key).padEnd(34)} ${String(b.calls).padStart(6)} ${fmtTokens(b.inputTokens).padStart(10)} ${fmtTokens(b.outputTokens).padStart(10)} ${String(avgOutputPerCall(b)).padStart(8)} ${cost.padStart(12)}\n`,
    );
  }
  if (rows.length > 25) env.stdout(`… ${rows.length - 25} more (use --json for everything)\n`);
  return 0;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function truncKey(k: string): string {
  return k.length <= 34 ? k : `${k.slice(0, 31)}…`;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

export const statsUsage = USAGE;
