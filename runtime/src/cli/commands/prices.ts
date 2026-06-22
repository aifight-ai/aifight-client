// `aifight prices` — user-maintained model price table (borrow-spec §7A).
//
// Owner decision 2026-06-11: the CLI/app ships with NO built-in price table.
// We never maintain or vouch for provider prices; the user copies the unit
// prices from their provider's pricing page once, and `aifight stats` turns
// token counts into cost estimates. Prices are per MILLION tokens, stored
// locally in <aifight-home>/usage/prices.json, never uploaded.

import {
  emptyPriceTable,
  loadPriceTable,
  pricesFilePath,
  savePriceTable,
  type ModelPrice,
} from "../../usage/prices";
import { UsageError, type HandlerArgs, type HandlerEnv } from "../shared";

const USAGE = [
  "usage: aifight prices list",
  "       aifight prices set <model> --input <p> --output <p> [--cache-hit <p>] [--currency <symbol>]",
  "       aifight prices unset <model>",
  "",
  "Prices are per 1,000,000 tokens, in whatever currency you choose (display",
  "only). Models without a price show token counts in `aifight stats` but no",
  "cost. Reasoning tokens bill as output on the major providers, so only",
  "input / output / cache-hit need prices.",
].join("\n");

export async function runPrices(args: HandlerArgs, env: HandlerEnv): Promise<number> {
  const sub = args.positional[0];
  if (!sub) throw new UsageError("missing prices command", USAGE);

  if (sub === "list") {
    const table = loadPriceTable();
    if (args.jsonMode) {
      env.stdout(JSON.stringify({ path: pricesFilePath(), ...table }) + "\n");
      return 0;
    }
    const entries = Object.entries(table.models);
    if (entries.length === 0) {
      env.stdout(
        "No model prices set. Costs stay hidden until you add one:\n" +
          "  aifight prices set <model> --input <p> --output <p> --cache-hit <p>\n",
      );
      return 0;
    }
    env.stdout(`Currency: ${table.currency} (display only) · per 1M tokens · ${pricesFilePath()}\n`);
    for (const [model, p] of entries) {
      env.stdout(`  ${model}: input ${p.input} / output ${p.output} / cache-hit ${p.cacheHit}\n`);
    }
    return 0;
  }

  if (sub === "set") {
    const model = args.positional[1];
    if (!model) throw new UsageError("missing <model>", USAGE);
    if (args.positional.length > 2) {
      throw new UsageError(`unexpected argument '${args.positional[2]}'`, USAGE);
    }
    const input = requirePriceFlag(args, "input");
    const output = requirePriceFlag(args, "output");
    const cacheHit = optionalPriceFlag(args, "cache-hit") ?? input; // default: same as input (no discount assumed)

    const current = loadPriceTable();
    const currencyFlag = args.flags["currency"];
    const currency =
      typeof currencyFlag === "string" && currencyFlag.trim() !== ""
        ? currencyFlag.trim().slice(0, 8)
        : current.currency;
    const price: ModelPrice = { input, output, cacheHit };
    const next = {
      ...emptyPriceTable(),
      currency,
      models: { ...current.models, [model]: price },
    };
    savePriceTable(next);
    env.stdout(
      args.jsonMode
        ? JSON.stringify({ model, ...price, currency }) + "\n"
        : `Saved ${model}: input ${input} / output ${output} / cache-hit ${cacheHit} per 1M tokens (${currency}).\n` +
          "Estimates only — your provider bill is authoritative.\n",
    );
    return 0;
  }

  if (sub === "unset") {
    const model = args.positional[1];
    if (!model) throw new UsageError("missing <model>", USAGE);
    const current = loadPriceTable();
    if (!(model in current.models)) {
      env.stdout(`No price set for ${model}.\n`);
      return 0;
    }
    const models = { ...current.models };
    delete models[model];
    savePriceTable({ ...current, models });
    env.stdout(`Removed price for ${model}.\n`);
    return 0;
  }

  throw new UsageError(`unknown prices command '${sub}'`, USAGE);
}

function requirePriceFlag(args: HandlerArgs, name: string): number {
  const v = optionalPriceFlag(args, name);
  if (v === undefined) throw new UsageError(`missing --${name}`, USAGE);
  return v;
}

function optionalPriceFlag(args: HandlerArgs, name: string): number | undefined {
  const raw = args.flags[name];
  if (raw === undefined) return undefined;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) {
    throw new UsageError(`--${name} must be a non-negative number (price per 1M tokens)`, USAGE);
  }
  return v;
}

export const pricesUsage = USAGE;
