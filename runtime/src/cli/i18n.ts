// CLI display-language switching (owner ask 2026-07-31: "Does it support
// Chinese/English switching? Default all-English. Add a language toggle
// option to the menu.").
//
// Design (owner-approved):
//   * Default locale is ALWAYS "en" — no system-locale auto-detect.
//     Resolution order: AIFIGHT_LANG env (en|zh) > bridge.json `locale` > "en".
//   * Dictionaries are flat namespaced keys ("menu.item.play.main"). The zh
//     table is typed Record<I18nKey, string>, so a missing or extra zh key is
//     a COMPILE error; a runtime parity test backs that up. At runtime a
//     missing translation falls back to English silently.
//   * Only HUMAN-facing text is translated. --json keys/values stay English,
//     and the V1 surface list is deliberately bounded (menu, banner, help,
//     the three default-bracket prompts, pause/resume/update/set-language,
//     `aifight status`) — everything else stays English.

import { readBridgeConfig } from "../bridge/config.js";
import { en, type I18nKey } from "./i18n-en.js";
import { zh } from "./i18n-zh.js";

export type Locale = "en" | "zh";
export type { I18nKey };

const TABLES: Record<Locale, Record<I18nKey, string>> = { en, zh };

/** Accept exactly "en"/"zh" (case/space-insensitive); anything else is not a
 *  locale and falls through to the next source. */
export function parseLocale(value: unknown): Locale | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  return v === "en" || v === "zh" ? v : undefined;
}

/**
 * Resolve the display locale: AIFIGHT_LANG > bridge.json locale > "en".
 * Injectable for tests; an unreadable/absent bridge config just falls through
 * to the default (the CLI must still work pre-setup).
 */
export function resolveLocale(
  env: NodeJS.ProcessEnv = process.env,
  readConfig: () => { readonly locale?: unknown } = readBridgeConfig,
): Locale {
  const fromEnv = parseLocale(env.AIFIGHT_LANG);
  if (fromEnv !== undefined) return fromEnv;
  try {
    const fromConfig = parseLocale(readConfig().locale);
    if (fromConfig !== undefined) return fromConfig;
  } catch {
    // Unconfigured or damaged config → the default below.
  }
  return "en";
}

/**
 * Translate `key` into `locale`, interpolating {{params}}. Unknown params are
 * left as literal "{{name}}" so a call-site/dictionary drift is visible in
 * output rather than swallowed. A key missing from the zh table falls back to
 * English (the parity test makes that a can't-happen); a key missing from en
 * is a programming error and throws.
 */
export function t(locale: Locale, key: I18nKey, params?: Record<string, string | number>): string {
  const template = TABLES[locale][key] ?? en[key];
  if (template === undefined) throw new Error(`unknown i18n key: ${key}`);
  if (params === undefined) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (raw, name: string) =>
    params[name] !== undefined ? String(params[name]) : raw,
  );
}

// ── Game display names ─────────────────────────────────────────────────
// The same mapping the Telegram companion renders with (render.ts
// game_* strings) — one vocabulary across every surface. Unknown ids fall
// back to the raw id: a new server-side game must never crash the menu.

const GAME_NAME_KEYS: Readonly<Record<string, I18nKey>> = {
  texas_holdem: "game.texas_holdem",
  liars_dice: "game.liars_dice",
  coup: "game.coup",
};

/** One game's display name in `locale` ("texas_holdem" → "德州扑克"). */
export function gameLabel(locale: Locale, id: string): string {
  const key = GAME_NAME_KEYS[id];
  return key === undefined ? id : t(locale, key);
}

/** A list of game ids as display names, joined with the locale's list
 *  separator ("、" zh / ", " en). */
export function joinGameLabels(locale: Locale, ids: readonly string[]): string {
  return ids.map((id) => gameLabel(locale, id)).join(locale === "zh" ? "、" : ", ");
}
