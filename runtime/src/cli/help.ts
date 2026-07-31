// The styled `-h` / `--help` output (owner ask 2026-07-30: "beautify the CLI
// comprehensively, including the -h/--help commands").
//
// ONE data source renders both modes: with colors on a TTY (bold header,
// yellow group titles, cyan commands, dim flags) and the identical layout
// without them (piped / NO_COLOR / TERM=dumb / --json) — so the two can never
// drift. The layout is computed (descriptions aligned from the longest
// command), not hand-spaced.
//
// i18n (2026-07-31): every human string is an i18n key looked up in the
// caller's locale; --json always passes "en" (machine output stays English).
//
// Coverage rule: every command in main.ts's dispatch switch appears here —
// including `run`, which used to be missing from the global help.

import { RUNTIME_VERSION } from "../index.js";
import type { Ansi } from "./ansi.js";
import { visibleWidth } from "./ansi.js";
import { t, type I18nKey, type Locale } from "./i18n.js";
import { SUPPORTED_GAMES } from "./shared.js";

interface HelpRow {
  /** The invocation, e.g. "aifight setup" or "--json" (never translated). */
  readonly usage: string;
  /** Second-column description key ("" = usage-only row). */
  readonly descKey: I18nKey;
}

interface HelpGroup {
  readonly titleKey: I18nKey;
  /** "cmd" rows render the usage cyan, "flag" rows dim. */
  readonly kind: "cmd" | "flag";
  readonly rows: readonly HelpRow[];
}

const GROUPS: readonly HelpGroup[] = [
  {
    titleKey: "help.group.firstrun",
    kind: "cmd",
    rows: [
      { usage: "aifight setup", descKey: "help.cmd.setup" },
      { usage: "aifight config", descKey: "help.cmd.config" },
      { usage: "aifight config add <profile> …", descKey: "help.cmd.config.add" },
      { usage: "aifight connect <PAIRING_CODE>", descKey: "help.cmd.connect" },
    ],
  },
  {
    titleKey: "help.group.play",
    kind: "cmd",
    rows: [
      { usage: "aifight start [game] [N]", descKey: "help.cmd.start" },
      { usage: "aifight pause", descKey: "help.cmd.pause" },
      { usage: "aifight resume", descKey: "help.cmd.resume" },
      { usage: "aifight status", descKey: "help.cmd.status" },
      { usage: "aifight record", descKey: "help.cmd.record" },
      { usage: "aifight challenge <game>", descKey: "help.cmd.challenge" },
      { usage: "aifight accept <url_or_token>", descKey: "help.cmd.accept" },
    ],
  },
  {
    titleKey: "help.group.tune",
    kind: "cmd",
    rows: [
      { usage: "aifight rename <name>", descKey: "help.cmd.rename" },
      { usage: "aifight accept-terms", descKey: "help.cmd.accept_terms" },
      { usage: "aifight set daily <N>", descKey: "help.cmd.set.daily" },
      { usage: "aifight set game <game1,game2>", descKey: "help.cmd.set.game" },
      { usage: "aifight set language <en|zh>", descKey: "help.cmd.set.language" },
      { usage: "aifight strategy <command>", descKey: "help.cmd.strategy" },
      { usage: "aifight review <id>", descKey: "help.cmd.review" },
      { usage: "aifight stats", descKey: "help.cmd.stats" },
      { usage: "aifight prices <command>", descKey: "help.cmd.prices" },
      { usage: "aifight telegram <command>", descKey: "help.cmd.telegram" },
    ],
  },
  {
    titleKey: "help.group.manage",
    kind: "cmd",
    rows: [
      { usage: "aifight service <command>", descKey: "help.cmd.service" },
      { usage: "aifight sessions <command>", descKey: "help.cmd.sessions" },
      { usage: "aifight run", descKey: "help.cmd.run" },
      { usage: "aifight update", descKey: "help.cmd.update" },
      { usage: "aifight uninstall", descKey: "help.cmd.uninstall" },
      { usage: "aifight doctor", descKey: "help.cmd.doctor" },
      { usage: "aifight version", descKey: "help.cmd.version" },
    ],
  },
  {
    titleKey: "help.group.flags",
    kind: "flag",
    rows: [
      { usage: "--json", descKey: "help.flag.json" },
      { usage: "--version, -v", descKey: "help.flag.version" },
      { usage: "--help, -h", descKey: "help.flag.help" },
      { usage: "--env <NAME>", descKey: "help.flag.env" },
      { usage: "--file <PATH>", descKey: "help.flag.file" },
      { usage: "--profile <name>", descKey: "help.flag.profile" },
      { usage: "--name <name>", descKey: "help.flag.name" },
      { usage: "--auto", descKey: "help.flag.auto" },
      { usage: "--approved-local-setup", descKey: "help.flag.approved" },
      { usage: "--yes", descKey: "help.flag.yes" },
      { usage: "--replace-local-identity", descKey: "help.flag.replace" },
    ],
  },
];

/**
 * The full grouped help. Colors appear exactly where the passed Ansi enables
 * them; layout (grouping, order, alignment) is identical either way. The
 * header's tagline stays English in every locale (brand); --json callers
 * pass "en" so machine output never varies.
 */
export function renderGlobalHelp(ansi: Ansi, locale: Locale = "en"): string {
  // One description column for the whole page: the longest usage across every
  // group (in terminal cells — a wide-char usage must not skew the column),
  // plus a two-space gutter.
  const pad =
    Math.max(...GROUPS.flatMap((g) => g.rows.map((r) => visibleWidth(r.usage)))) + 2;

  const row = (r: HelpRow, kind: "cmd" | "flag"): string => {
    const usage = kind === "flag" ? ansi.dim(r.usage) : ansi.cyan(r.usage);
    const desc = t(locale, r.descKey);
    if (desc === "") return `  ${usage}`;
    return `  ${usage}${" ".repeat(pad - visibleWidth(r.usage))}${desc}`;
  };

  const lines: string[] = [
    ansi.bold(`AIFight CLI — AI fights AI. Bring yours. · v${RUNTIME_VERSION}`),
    "",
    t(locale, "help.intro1"),
    t(locale, "help.intro2"),
    t(locale, "help.intro3"),
    "",
    ansi.yellow(t(locale, "help.quickstart")),
    `  ${ansi.cyan("npm install -g @aifight/aifight")}`,
    `  ${ansi.cyan("aifight setup")}${" ".repeat(pad - visibleWidth("aifight setup"))}${t(locale, "help.quickstart.setup")}`,
    ansi.dim(t(locale, "help.quickstart.note")),
    "",
    t(locale, "help.tip"),
  ];
  for (const group of GROUPS) {
    lines.push("");
    lines.push(ansi.yellow(t(locale, group.titleKey)));
    for (const r of group.rows) lines.push(row(r, group.kind));
  }
  lines.push("");
  lines.push(t(locale, "help.footer.games", { games: SUPPORTED_GAMES.join(", ") }));
  lines.push(t(locale, "help.footer.challenge"));
  return lines.join("\n");
}

/**
 * Light styling for the per-command usage blocks (`aifight <cmd> --help`):
 * the "Usage:" lead-in goes bold, `aifight <cmd> …` invocations cyan, flags
 * dim. Zero-width codes only, so the hand-aligned columns inside those blocks
 * are untouched — and with colors off the text passes through byte-identical.
 */
export function styleSubcommandUsage(usage: string, ansi: Ansi): string {
  if (!ansi.enabled) return usage;
  return usage
    .split("\n")
    .map((line) => {
      let out = line.startsWith("Usage:") ? ansi.bold("Usage:") + line.slice("Usage:".length) : line;
      out = out.replace(/\baifight(?: [a-z][a-z-]*){0,3}/g, (m) => ansi.cyan(m));
      out = out.replace(/--[a-z][a-z-]*/g, (m) => ansi.dim(m));
      return out;
    })
    .join("\n");
}
