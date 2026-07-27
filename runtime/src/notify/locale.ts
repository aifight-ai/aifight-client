// Which language the companion speaks. There is no i18n framework in the CLI
// and one is not worth adding for two languages, so every user-visible string
// is a { zh, en } pair in one flat table (see telegram/render.ts).
//
// The environment habit (AIFIGHT_LOCALE → LC_ALL → LANG, /^zh/i) matches what
// `aifight review` and the runner's auto-review already do.

export type NotifyLocale = "zh" | "en";

/** Resolve from the environment alone (no config override available). */
export function envNotifyLocale(): NotifyLocale {
  const raw = process.env.AIFIGHT_LOCALE ?? process.env.LC_ALL ?? process.env.LANG ?? "";
  return /^zh/i.test(raw) ? "zh" : "en";
}

/** Explicit configuration wins; otherwise fall back to the environment. */
export function resolveNotifyLocale(configured: NotifyLocale | undefined): NotifyLocale {
  return configured ?? envNotifyLocale();
}
