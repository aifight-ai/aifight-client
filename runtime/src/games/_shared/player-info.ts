// PlayerInfo.data shape-guard helpers — shared by Texas Hold'em / Liar's
// Dice / Coup state-formatters.
//
// PlayerInfo.data is opaque per protocol/common/player_info.schema.json.
// Game-specific fields (chips / bet / dice_count / coins / hidden_cards /
// revealed) live inside `data: {}` and are NOT narrowed by TypeScript.
// These helpers do typeof / Array.isArray checks; on missing fields or
// wrong-type values they return `undefined`, the caller MUST omit the
// output field (never throw, never default to 0 / [] — the latter would
// mislead the LLM).
//
// See M1-12.md TED rev3 — `## 3 款游戏 formatter` 段顶部 PlayerInfo 字段
// 读取合同 + Risks #16.
//
// Internal-only — not re-exported from runtime/src/index.ts.

/**
 * Read `data[key]` as a finite number. Returns `undefined` if `data` is
 * not a non-null object, the field is missing, the value is not a
 * number, or the value is NaN / Infinity / -Infinity. Caller must omit
 * the output field on `undefined` (never default to 0).
 */
export function readNumberField(data: unknown, key: string): number | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const obj = data as Record<string, unknown>;
  const v = obj[key];
  if (typeof v !== "number") return undefined;
  if (!Number.isFinite(v)) return undefined;
  return v;
}

/**
 * Read `data[key]` as `string[]`. Returns `undefined` if `data` is not a
 * non-null object, the field is missing, the value is not an array, or
 * any element is not a string. Returns the array reference (no copy) —
 * read-only by convention; caller must NOT mutate.
 */
export function readStringArrayField(data: unknown, key: string): string[] | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const obj = data as Record<string, unknown>;
  const v = obj[key];
  if (!Array.isArray(v)) return undefined;
  for (const item of v) {
    if (typeof item !== "string") return undefined;
  }
  return v as string[];
}
