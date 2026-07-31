// The shared styled-output kit for human-facing command output (V4 — the
// owner's 0.2.0-beta.2 complaint: the styled panel is followed by plain
// unstyled text dumps, which reads as broken).
//
// One small set of primitives — section headers, label/value rows, tables,
// note lines — all built on ansi.ts's color gate (NO_COLOR / TERM=dumb /
// non-TTY → the same layout with zero ANSI) and its CJK width math (every
// pad/truncate goes through visibleWidth, so zh output stays aligned).
//
// --json never touches this module: every command's machine output is built
// separately and stays byte-stable.

import {
  createAnsi,
  padEndVisible,
  padStartVisible,
  truncatePlain,
  visibleWidth,
  type Ansi,
  type AnsiGate,
} from "./ansi.js";

/** Value/cell styling. "default" leaves the text untouched (pre-styled
 *  content passes through). */
export type Tone = "default" | "dim" | "bold" | "cyan" | "green" | "yellow";

export interface TableColumn {
  readonly label: string;
  /** Default "left". Numeric columns should be "right". */
  readonly align?: "left" | "right";
  /** Applied to every body cell of the column (the header is always dim-bold). */
  readonly tone?: Tone;
  /** Truncate cells (and the header) to this many visible columns with an
   *  ellipsis. The fix for glued columns (record's opponents → date, 2026-07). */
  readonly maxWidth?: number;
  readonly minWidth?: number;
}

export interface Output {
  readonly ansi: Ansi;
  /** A bold section header line ("Overall", "Per game"). */
  section(title: string): string;
  /** One two-space-indented row: dim fixed-width label column + styled value.
   *  The column is opts.labelWidth, the createOutput default (14), or the
   *  label's own width + 2 — whichever is largest, so a long label can never
   *  glue onto its value. */
  kv(label: string, value: string, opts?: KvOptions): string;
  /** A run of kv rows with the label column auto-sized to the longest label
   *  (+2), so a block of them aligns without each caller hand-tuning widths. */
  kvRows(rows: readonly KvRow[]): string[];
  /** A styled table: dim-bold header, per-column alignment/tone, per-cell
   *  ellipsis truncation to the column's maxWidth. Returns one string per line
   *  (caller joins) so it composes with the other primitives. */
  table(columns: readonly TableColumn[], rows: readonly (readonly string[])[], opts?: TableOptions): string[];
  /** A dim indented note line ("Note: …" tails, caveats). */
  note(text: string): string;
}

export interface KvOptions {
  readonly tone?: Tone;
  readonly labelWidth?: number;
}

/** [label, value, tone?] — the tone is per-row so one block can mix a green
 *  "resolvable" with default rows. */
export type KvRow = readonly [label: string, value: string, tone?: Tone];

export interface TableOptions {
  readonly indent?: string;
}

export interface OutputOptions extends AnsiGate {
  /** The kv label column width for this kit instance (default 14). */
  readonly labelWidth?: number;
}

const DEFAULT_LABEL_WIDTH = 14;
const TABLE_GAP = 2;

/** Bind the primitives to one color decision (the shared gate by default;
 *  tests force either side through AnsiGate). */
export function createOutput(gate: OutputOptions = {}): Output {
  const ansi = createAnsi(gate);
  const defaultLabelWidth = gate.labelWidth ?? DEFAULT_LABEL_WIDTH;

  const style = (tone: Tone | undefined, s: string): string => {
    switch (tone) {
      case "dim": return ansi.dim(s);
      case "bold": return ansi.bold(s);
      case "cyan": return ansi.cyan(s);
      case "green": return ansi.green(s);
      case "yellow": return ansi.yellow(s);
      default: return s;
    }
  };

  const section = (title: string): string => ansi.bold(title);

  const kv = (label: string, value: string, opts: KvOptions = {}): string => {
    const width = Math.max(opts.labelWidth ?? defaultLabelWidth, visibleWidth(label) + 2);
    return `  ${ansi.dim(padEndVisible(label, width))}${style(opts.tone, value)}`;
  };

  const kvRows = (rows: readonly KvRow[]): string[] => {
    const width = Math.max(...rows.map(([label]) => visibleWidth(label))) + 2;
    return rows.map(([label, value, tone]) => kv(label, value, { labelWidth: width, ...(tone !== undefined ? { tone } : {}) }));
  };

  const table = (
    columns: readonly TableColumn[],
    rows: readonly (readonly string[])[],
    opts: TableOptions = {},
  ): string[] => {
    const indent = opts.indent ?? "  ";
    const widths = columns.map((col, i) => {
      let w = Math.max(
        visibleWidth(col.label),
        col.minWidth ?? 0,
        ...rows.map((row) => visibleWidth(row[i] ?? "")),
      );
      if (col.maxWidth !== undefined) w = Math.min(w, col.maxWidth);
      return w;
    });
    const cell = (raw: string, i: number, tone?: Tone): string => {
      const col = columns[i]!;
      const w = widths[i]!;
      const text = visibleWidth(raw) > w ? truncatePlain(raw, w) : raw;
      const padded = (col.align ?? "left") === "right" ? padStartVisible(text, w) : padEndVisible(text, w);
      return style(tone ?? col.tone, padded);
    };
    // The header keeps its own dim-bold; body cells take their column tone.
    const headerLine = indent + columns.map((col, i) => {
      const w = widths[i]!;
      const text = visibleWidth(col.label) > w ? truncatePlain(col.label, w) : col.label;
      const padded = (col.align ?? "left") === "right" ? padStartVisible(text, w) : padEndVisible(text, w);
      return ansi.dim(ansi.bold(padded));
    }).join(" ".repeat(TABLE_GAP));
    const body = rows.map((row) =>
      indent + columns.map((_, i) => cell(row[i] ?? "", i)).join(" ".repeat(TABLE_GAP)),
    );
    return [headerLine, ...body];
  };

  const note = (text: string): string => `  ${ansi.dim(text)}`;

  return { ansi, section, kv, kvRows, table, note };
}
