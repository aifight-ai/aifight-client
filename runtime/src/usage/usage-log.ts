// Local token-usage ledger (borrow-spec §7A).
//
// One JSONL record per model call, appended to <aifight-home>/usage/YYYY-MM.jsonl
// (months roll naturally; nothing is ever uploaded — owner decision keeps cost
// data local; only model + token counts sync to the platform separately via
// §7B). Writing is strictly best-effort: stats must NEVER break a match, so
// every failure path swallows silently. A per-file size cap stops runaway
// growth; when the current month's file exceeds it we stop appending for the
// rest of the month.

import fs from "node:fs";
import path from "node:path";

import { getAifightHome } from "../store/paths";

export interface UsageRecord {
  /** ISO timestamp of the model call. */
  readonly ts: string;
  readonly match_id: string;
  readonly game: string;
  /** Adapter protocol, e.g. "anthropic-messages". */
  readonly provider: string;
  readonly model: string;
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly reasoning_tokens?: number;
  readonly cached_tokens?: number;
  readonly latency_ms?: number;
  /**
   * What kind of call this was: "model" = a decision's first call,
   * "model_retry" = a §3 corrective retry. Fallbacks never call a model and
   * therefore never produce a record.
   */
  readonly decision_source: "model" | "model_retry";
}

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB per month is far beyond normal play

export function getUsageDir(): string {
  return path.join(getAifightHome(), "usage");
}

/** Month key for a date, e.g. "2026-06". */
export function usageMonthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function usageFilePath(monthKey: string): string {
  return path.join(getUsageDir(), `${monthKey}.jsonl`);
}

/** Append one record. Silent on any failure (stats must never affect play). */
export function appendUsageRecord(record: UsageRecord): void {
  try {
    const file = usageFilePath(usageMonthKey(new Date(record.ts)));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_FILE_BYTES) return; // cap reached: drop silently
    } catch {
      // file does not exist yet — fine
    }
    fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // best-effort by contract
  }
}

/**
 * Read records covering the window [since, now]. Reads only the month files
 * the window can touch. Malformed lines are skipped.
 */
export function readUsageRecordsSince(since: Date, now: Date = new Date()): UsageRecord[] {
  const months = new Set<string>();
  const cursor = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), 1));
  while (cursor.getTime() <= now.getTime()) {
    months.add(usageMonthKey(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  const records: UsageRecord[] = [];
  for (const month of months) {
    let text: string;
    try {
      text = fs.readFileSync(usageFilePath(month), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const parsed = JSON.parse(trimmed) as UsageRecord;
        if (typeof parsed.ts !== "string" || typeof parsed.model !== "string") continue;
        const t = Date.parse(parsed.ts);
        if (Number.isNaN(t) || t < since.getTime() || t > now.getTime()) continue;
        records.push(parsed);
      } catch {
        // skip malformed line
      }
    }
  }
  return records;
}
