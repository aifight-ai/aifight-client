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
import { createOutput } from "../output";

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
      cache_write_tokens: b.cacheWriteTokens,
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
  const out = createOutput();
  env.stdout(`${out.kv("Window", `${since.toISOString().slice(0, 10)} → ${now.toISOString().slice(0, 10)}`)}\n`);
  env.stdout(
    `${out.kv("Total",
      `${t.calls} calls · ${t.matchIds.size} matches · in ${fmtTokens(t.inputTokens)} / out ${fmtTokens(t.outputTokens)}` +
      (t.cachedTokens > 0 ? ` / cached ${fmtTokens(t.cachedTokens)}` : "") +
      (t.cacheWriteTokens > 0 ? ` / cache writes ${fmtTokens(t.cacheWriteTokens)}` : "") +
      ` · avg out/call ${avgOutputPerCall(t)}`)}\n`,
  );
  if (t.estimatedCost !== undefined) {
    const perCall = avgCostPerCall(t);
    env.stdout(
      `${out.kv("Estimated cost",
        `${cur}${round4(t.estimatedCost)}` +
          (perCall !== undefined ? ` (avg ${cur}${round4(perCall)}/call)` : "") +
          (t.unpricedCalls > 0 ? ` — ${t.unpricedCalls} calls unpriced` : "") +
          ` · estimate only, your bill is authoritative`, { tone: "green" })}\n`,
    );
  } else {
    env.stdout(`${out.kv("Estimated cost", "— (no model prices set; see `aifight prices set --help`)")}\n`);
  }

  const wantsByMatch = args.flags["by-match"] === true || matchFilter !== undefined;
  const rows = wantsByMatch ? summary.byMatch : summary.byModel;
  const label = wantsByMatch ? "Match" : "Model";
  env.stdout("\n");
  env.stdout(
    out.table(
      [
        { label, maxWidth: 34 },
        { label: "calls", align: "right" },
        { label: "in", align: "right" },
        { label: "out", align: "right" },
        { label: "avg out", align: "right" },
        { label: "est cost", align: "right" },
      ],
      rows.slice(0, 25).map((b) => [
        b.key,
        String(b.calls),
        fmtTokens(b.inputTokens),
        fmtTokens(b.outputTokens),
        String(avgOutputPerCall(b)),
        b.estimatedCost !== undefined
          ? `${cur}${round4(b.estimatedCost)}${b.unpricedCalls > 0 ? "*" : ""}`
          : "—",
      ]),
      { indent: "" },
    ).join("\n") + "\n",
  );
  if (rows.length > 25) env.stdout(out.note(`… ${rows.length - 25} more (use --json for everything)`) + "\n");
  return 0;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

export const statsUsage = USAGE;
