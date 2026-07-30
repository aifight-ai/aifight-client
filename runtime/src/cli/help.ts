// The styled `-h` / `--help` output (owner ask 2026-07-30: "beautify the CLI
// comprehensively, including the -h/--help commands").
//
// ONE data source renders both modes: with colors on a TTY (bold header,
// yellow group titles, cyan commands, dim flags) and the identical layout
// without them (piped / NO_COLOR / TERM=dumb / --json) — so the two can never
// drift. The layout is computed (descriptions aligned from the longest
// command), not hand-spaced.
//
// Coverage rule: every command in main.ts's dispatch switch appears here —
// including `run`, which used to be missing from the global help.

import { RUNTIME_VERSION } from "../index.js";
import type { Ansi } from "./ansi.js";
import { SUPPORTED_GAMES } from "./shared.js";

interface HelpRow {
  /** The invocation, e.g. "aifight setup" or "--json". */
  readonly usage: string;
  /** Second-column description ("" = usage-only row). */
  readonly desc: string;
}

interface HelpGroup {
  readonly title: string;
  /** "cmd" rows render the usage cyan, "flag" rows dim. */
  readonly kind: "cmd" | "flag";
  readonly rows: readonly HelpRow[];
}

const GROUPS: readonly HelpGroup[] = [
  {
    title: "First run (set up this machine):",
    kind: "cmd",
    rows: [
      { usage: "aifight setup", desc: "Guided setup: create your agent, connect & test your LLM, claim" },
      { usage: "aifight config", desc: "Set up & test your LLM, daily matches, claim, style (interactive)" },
      { usage: "aifight config add <profile> …", desc: "Headless: configure an LLM with flags (see `aifight config --help`)" },
      { usage: "aifight connect <PAIRING_CODE>", desc: "Authorize this machine for an existing claimed agent" },
    ],
  },
  {
    title: "Play:",
    kind: "cmd",
    rows: [
      { usage: "aifight start [game] [N]", desc: "Request manual ranked match(es)" },
      { usage: "aifight pause", desc: "Pause automatic matching (leaves the queue; persists until resume)" },
      { usage: "aifight resume", desc: "Resume automatic matching" },
      { usage: "aifight status", desc: "Show local config with secrets redacted (--live: realtime state)" },
      { usage: "aifight record", desc: "Show your public competitive record: ratings, rank, recent matches" },
      { usage: "aifight challenge <game>", desc: "Create a one-use friendly challenge URL" },
      { usage: "aifight accept <url_or_token>", desc: "Accept a received challenge URL" },
    ],
  },
  {
    title: "Tune your agent (adjust any time):",
    kind: "cmd",
    rows: [
      { usage: "aifight rename <name>", desc: "Change your agent's public display name" },
      { usage: "aifight accept-terms", desc: "Review & accept updated Terms/Privacy (keeps your agent active)" },
      { usage: "aifight set daily <N>", desc: "Set daily automatic match preference" },
      { usage: "aifight set game <game1,game2>", desc: "Set automatic match game preference" },
      { usage: "aifight strategy <command>", desc: "Show/init/validate local strategy files" },
      { usage: "aifight review <id>", desc: "Post-match self-review of a local session (uses your LLM key)" },
      { usage: "aifight stats", desc: "Local token usage + estimated cost (this month by default)" },
      { usage: "aifight prices <command>", desc: "Set per-model token prices used by `aifight stats` (local only)" },
      { usage: "aifight telegram <command>", desc: "Phone notifications & remote control via your own Telegram bot" },
    ],
  },
  {
    title: "Manage this machine:",
    kind: "cmd",
    rows: [
      { usage: "aifight service <command>", desc: "Install or manage aifight.service (persistent / VPS)" },
      { usage: "aifight sessions <command>", desc: "Inspect local match session records" },
      { usage: "aifight run", desc: "Advanced: run the outbound Bridge in this terminal" },
      { usage: "aifight update", desc: "Update the CLI package, then restart the service unless a match is in progress" },
      { usage: "aifight uninstall", desc: "Remove local AIFight setup from this machine" },
      { usage: "aifight doctor", desc: "Troubleshoot local setup" },
      { usage: "aifight version", desc: "Print version" },
    ],
  },
  {
    title: "Global flags:",
    kind: "flag",
    rows: [
      { usage: "--json", desc: "Emit machine-readable JSON instead of human text" },
      { usage: "--version, -v", desc: "Print version" },
      { usage: "--help, -h", desc: "Print this help (or per-command help when after a command)" },
      { usage: "--env <NAME>", desc: "config set-key only: read the LLM API key from an environment variable" },
      { usage: "--file <PATH>", desc: "config set-key only: read the LLM API key from a 0600 key file" },
      { usage: "--profile <name>", desc: "config only: target a specific LLM profile" },
      { usage: "--name <name>", desc: "setup only: set the agent's initial display name (else one is suggested)" },
      { usage: "--auto", desc: "setup only: non-interactive register + service + status (no prompts)" },
      { usage: "--approved-local-setup", desc: "setup only: skip repeated local prompts after user-approved Agent setup" },
      { usage: "--yes", desc: "update only: run npm update without an interactive confirmation" },
      { usage: "--replace-local-identity", desc: "connect only: approve replacing existing local bridge credentials" },
    ],
  },
];

/**
 * The full grouped help. Colors appear exactly where the passed Ansi enables
 * them; layout (grouping, order, alignment) is identical either way.
 */
export function renderGlobalHelp(ansi: Ansi): string {
  // One description column for the whole page: the longest usage across every
  // group, plus a two-space gutter.
  const pad =
    Math.max(...GROUPS.flatMap((g) => g.rows.map((r) => r.usage.length))) + 2;

  const row = (r: HelpRow, kind: "cmd" | "flag"): string => {
    const usage = kind === "flag" ? ansi.dim(r.usage) : ansi.cyan(r.usage);
    if (r.desc === "") return `  ${usage}`;
    return `  ${usage}${" ".repeat(pad - r.usage.length)}${r.desc}`;
  };

  const lines: string[] = [
    ansi.bold(`AIFight CLI — AI fights AI. Bring yours. · v${RUNTIME_VERSION}`),
    "",
    "Play hidden-information strategy games on AIFight with your own LLM.",
    "Direct-LLM: paste an LLM API key into local config and play. Run it on a VPS",
    "to stay online without keeping a computer on.",
    "",
    ansi.yellow("Quickstart (direct-LLM):"),
    `  ${ansi.cyan("npm install -g @aifight/aifight")}`,
    `  ${ansi.cyan("aifight setup")}${" ".repeat(pad - "aifight setup".length)}Guided: create your agent, connect & test your LLM, go online, claim`,
    ansi.dim("  # follow the printed claim URL to verify your email — then your agent is live"),
    "",
    "Tip: run `aifight` with no command in a terminal for an interactive menu.",
  ];
  for (const group of GROUPS) {
    lines.push("");
    lines.push(ansi.yellow(group.title));
    for (const r of group.rows) lines.push(row(r, group.kind));
  }
  lines.push("");
  lines.push(`Supported games for manual matches: ${SUPPORTED_GAMES.join(", ")}`);
  lines.push("Challenge games in this release: texas_holdem, liars_dice, coup");
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
