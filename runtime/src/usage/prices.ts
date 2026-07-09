// User-maintained model price table (borrow-spec §7A, owner decision
// 2026-06-11): the CLI/app ships with NO built-in price table — we never
// maintain or vouch for provider prices. Users set per-model unit prices
// (per MILLION tokens) for input / output / cache-hit; models without an
// entry show token counts only. All cost output is labeled an estimate.

import fs from "node:fs";
import path from "node:path";

import { getUsageDir } from "./usage-log";

export interface ModelPrice {
  /** Price per 1,000,000 input tokens (non-cached). */
  readonly input: number;
  /** Price per 1,000,000 output tokens (reasoning bills as output). */
  readonly output: number;
  /** Price per 1,000,000 cache-hit tokens. */
  readonly cacheHit: number;
}

export interface PriceTable {
  readonly version: 1;
  /** Display symbol only — purely cosmetic, user-chosen. */
  readonly currency: string;
  readonly models: Record<string, ModelPrice>;
}

export function emptyPriceTable(): PriceTable {
  return { version: 1, currency: "$", models: {} };
}

export function pricesFilePath(): string {
  return path.join(getUsageDir(), "prices.json");
}

export function loadPriceTable(): PriceTable {
  try {
    const raw = JSON.parse(fs.readFileSync(pricesFilePath(), "utf8")) as PriceTable;
    if (!raw || raw.version !== 1 || typeof raw.models !== "object" || raw.models === null) {
      return emptyPriceTable();
    }
    const models: Record<string, ModelPrice> = {};
    for (const [model, p] of Object.entries(raw.models)) {
      if (!p) continue;
      const input = Number(p.input);
      const output = Number(p.output);
      const cacheHit = Number(p.cacheHit);
      if ([input, output, cacheHit].some((v) => !Number.isFinite(v) || v < 0)) continue;
      models[model] = { input, output, cacheHit };
    }
    return {
      version: 1,
      currency: typeof raw.currency === "string" && raw.currency !== "" ? raw.currency : "$",
      models,
    };
  } catch {
    return emptyPriceTable();
  }
}

export function savePriceTable(table: PriceTable): void {
  const file = pricesFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(table, null, 2) + "\n", "utf8");
}

/**
 * Estimated cost of one call under a price entry. Convention (documented in
 * the spec): billable output = output_tokens as reported by the adapter —
 * the major providers' output counts already INCLUDE reasoning tokens, so
 * reasoning_tokens is an informational subset and is never added (that would
 * double-bill). Cache accounting differs per provider (some report input
 * inclusive of cache hits, some exclusive), so non-cached input is
 * max(0, input - cached) — a slightly conservative estimate, and every
 * surface labels it "estimate, your bill is authoritative".
 */
export function estimateCallCost(
  price: ModelPrice,
  tokens: { input?: number; output?: number; cached?: number; cacheWrite?: number },
): number {
  const input = tokens.input ?? 0;
  const cached = tokens.cached ?? 0;
  const cacheWrite = tokens.cacheWrite ?? 0;
  const output = tokens.output ?? 0;
  const nonCachedInput = Math.max(0, input - cached - cacheWrite);
  return (
    (nonCachedInput * price.input + cached * price.cacheHit + cacheWrite * price.input + output * price.output) /
    1_000_000
  );
}
