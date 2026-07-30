// The Telegram companion's settings block: defaults, value parsing, and the
// human summary. One definition shared by the CLI (`aifight telegram set`,
// `aifight telegram mute`) and, later, the in-chat settings panel — the two
// surfaces edit the same bridge.json section, so they must agree on what a
// value means without either one re-deriving it.

import type { BridgeTelegramConfig } from "../../bridge/config";
import { isDigestTime } from "../../bridge/config";

/** When the daily digest goes out, in this machine's local time. */
export const TELEGRAM_DEFAULT_DIGEST_AT = "22:00";

export type TelegramSettingKey =
  | "results"
  | "digest_at"
  | "alerts"
  | "challenge_events"
  | "control"
  | "locale";

export const TELEGRAM_SETTING_KEYS: readonly TelegramSettingKey[] = [
  "results",
  "digest_at",
  "alerts",
  "challenge_events",
  "control",
  "locale",
];

/** Allowed values per key, for error messages and the `set` usage text. */
export const TELEGRAM_SETTING_VALUES: Readonly<Record<TelegramSettingKey, string>> = {
  results: "per_match | daily | both | off",
  digest_at: "HH:MM (24-hour, this machine's local time)",
  alerts: "on | off",
  challenge_events: "on | off",
  control: "on | off",
  locale: "zh | en | auto",
};

export function isTelegramSettingKey(raw: string): raw is TelegramSettingKey {
  return (TELEGRAM_SETTING_KEYS as readonly string[]).includes(raw);
}

/** The section written when pairing succeeds — every default from the design's
 *  §4.2 table. Alerts and control default on: the whole point is to notice a
 *  broken agent from your phone and stop it. */
export function defaultTelegramConfig(chatId: number): BridgeTelegramConfig {
  return {
    chatId,
    results: "per_match",
    digestAt: TELEGRAM_DEFAULT_DIGEST_AT,
    alerts: true,
    challengeEvents: true,
    control: true,
  };
}

export type TelegramSettingOutcome =
  | { readonly ok: true; readonly section: BridgeTelegramConfig; readonly summary: string }
  | { readonly ok: false; readonly message: string; readonly allowed: string };

/** Apply one `key value` edit, returning a new section (never mutating). */
export function applyTelegramSetting(
  section: BridgeTelegramConfig,
  key: TelegramSettingKey,
  rawValue: string,
): TelegramSettingOutcome {
  const value = rawValue.trim().toLowerCase();
  const reject = (): TelegramSettingOutcome => ({
    ok: false,
    message: `invalid value '${rawValue}' for '${key}'`,
    allowed: TELEGRAM_SETTING_VALUES[key],
  });

  switch (key) {
    case "results": {
      if (value !== "per_match" && value !== "daily" && value !== "both" && value !== "off") return reject();
      return { ok: true, section: { ...section, results: value }, summary: `results = ${value}` };
    }
    case "digest_at": {
      if (!isDigestTime(value)) return reject();
      return { ok: true, section: { ...section, digestAt: value }, summary: `digest_at = ${value}` };
    }
    case "alerts":
    case "challenge_events":
    case "control": {
      const on = parseOnOff(value);
      if (on === undefined) return reject();
      const field = key === "alerts" ? "alerts" : key === "control" ? "control" : "challengeEvents";
      return {
        ok: true,
        section: { ...section, [field]: on },
        summary: `${key} = ${on ? "on" : "off"}`,
      };
    }
    case "locale": {
      if (value === "auto") {
        const { locale: _dropped, ...rest } = section;
        return { ok: true, section: rest, summary: "locale = auto (follow the environment)" };
      }
      if (value !== "zh" && value !== "en") return reject();
      return { ok: true, section: { ...section, locale: value }, summary: `locale = ${value}` };
    }
  }
}

function parseOnOff(value: string): boolean | undefined {
  if (value === "on" || value === "true" || value === "1" || value === "yes") return true;
  if (value === "off" || value === "false" || value === "0" || value === "no") return false;
  return undefined;
}

export type MuteSpec = "1h" | "today" | "off";

export type MuteOutcome =
  | { readonly ok: true; readonly mutedUntil: number | undefined }
  | { readonly ok: false; readonly message: string; readonly allowed: string };

export const MUTE_SPEC_VALUES = "1h | today | off";

/** Turn a mute spec into an absolute epoch-ms deadline (undefined = unmute).
 *  `today` means "until this local day ends", not "24 hours". */
export function parseMuteSpec(raw: string, now: number): MuteOutcome {
  const value = raw.trim().toLowerCase();
  if (value === "off" || value === "none") return { ok: true, mutedUntil: undefined };
  if (value === "1h") return { ok: true, mutedUntil: now + 60 * 60_000 };
  if (value === "today") {
    const end = new Date(now);
    end.setHours(24, 0, 0, 0);
    return { ok: true, mutedUntil: end.getTime() };
  }
  return { ok: false, message: `unknown mute window '${raw}'`, allowed: MUTE_SPEC_VALUES };
}

/** True while notifications are suppressed. Alerts ignore this by design —
 *  muting means "stop chatting", not "stop telling me the agent is broken". */
export function isMuted(section: BridgeTelegramConfig, now: number): boolean {
  return section.mutedUntil !== undefined && section.mutedUntil > now;
}
