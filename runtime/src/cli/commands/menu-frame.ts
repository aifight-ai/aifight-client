// The panel's data + rendering, shared by its two presenters:
//   * the arrow-key chooser (menu-select.ts) — repaints the frame in place
//     with a highlighted row;
//   * the line-prompt fallback (menu.ts) — prints the frame once and asks for
//     a number, for hosts that open the panel without the chooser wired.
// One renderer keeps the two presentations identical and lets tests assert on
// exactly what the chooser draws.
//
// 2026-07-30 beautification (owner ask, 3x-ui style):
//   * an optional boxed STATUS banner above the title (╭─ title ──╮ rounded
//     when colors are on, a plain ASCII +-+ frame when they are not);
//   * a TWO-COLUMN numbered layout on terminals wide enough, column-major so
//     the item numbers never move (1-7 left, 8-14 + Quit right).

import { stripAnsi, type Ansi } from "../ansi.js";

export interface MenuFrameChoice {
  /** "1".."14" for actions, "q" for the Quit row. */
  readonly key: string;
  readonly label: string;
}

/** One styled piece of a status-box line. Kept as DATA (not a pre-styled
 *  string) so the renderer can measure and truncate plain text before any
 *  ANSI is added — the chooser's repaint math depends on visible widths. */
export interface MenuStatusSegment {
  readonly text: string;
  readonly style?: "bold" | "dim" | "cyan" | "green" | "yellow";
}

export type MenuStatusLine = readonly MenuStatusSegment[];

export interface MenuStatusBox {
  /** Carried inside the top border: ╭─ <title> ─────────╮ */
  readonly title: string;
  readonly lines: readonly MenuStatusLine[];
}

export interface MenuFrame {
  readonly title: string;
  /** Warning lines drawn above the title (today: the NOT CLAIMED banner).
   *  Empty when there is nothing to warn about. */
  readonly banner: readonly string[];
  readonly choices: readonly MenuFrameChoice[];
  /** The 3x-ui-style status box above everything. Absent when there is no
   *  local identity to describe (first run) — the panel's first-run guidance
   *  takes the whole screen then anyway. */
  readonly statusBox?: MenuStatusBox;
}

/** Boxed banner never exceeds this many columns, however wide the terminal.
 *  72 lines up with the two-column menu's minimum width: a terminal wide
 *  enough for the two columns fits the box's typical content exactly. */
const STATUS_BOX_MAX_WIDTH = 72;
/** Below this terminal width the menu stays single-column (3x-ui's two
 *  columns need the room; a narrow SSH window gets the old list). */
export const TWO_COLUMN_MIN_WIDTH = 72;
/** Spaces between the left and right menu columns. */
const COLUMN_GAP = 4;

export interface ColumnLayout {
  readonly columns: 1 | 2;
  /** Choice indices per column, in display order. Single column: everything
   *  is in `left`, `right` is empty. */
  readonly left: readonly number[];
  readonly right: readonly number[];
}

/**
 * Column-major split, 3x-ui style: the left column takes the first floor(n/2)
 * choices, the right column the rest — for the panel's 15 rows that is 1-7 on
 * the left and 8-14 + Quit on the right. The split is a pure function of the
 * choice count, so the mapping number → position is stable and muscle memory
 * survives resizes.
 */
export function columnLayout(choiceCount: number, width: number): ColumnLayout {
  if (choiceCount < 4 || width < TWO_COLUMN_MIN_WIDTH) {
    return { columns: 1, left: Array.from({ length: choiceCount }, (_, i) => i), right: [] };
  }
  const leftCount = Math.floor(choiceCount / 2);
  return {
    columns: 2,
    left: Array.from({ length: leftCount }, (_, i) => i),
    right: Array.from({ length: choiceCount - leftCount }, (_, i) => leftCount + i),
  };
}

/** Truncate plain text to `budget` visible columns, ellipsis included. */
function truncatePlain(s: string, budget: number): string {
  if (budget <= 0) return "";
  if (s.length <= budget) return s;
  if (budget === 1) return "…";
  return `${s.slice(0, budget - 1)}…`;
}

/** Truncate a segment line to `budget` visible columns, keeping whole
 *  segments where they fit and cutting (with an ellipsis) inside the one
 *  that crosses the budget. */
function truncateSegments(line: MenuStatusLine, budget: number): MenuStatusLine {
  const out: MenuStatusSegment[] = [];
  let used = 0;
  for (const seg of line) {
    if (used >= budget) break;
    const room = budget - used;
    if (seg.text.length <= room) {
      out.push(seg);
      used += seg.text.length;
    } else {
      out.push({ ...seg, text: truncatePlain(seg.text, room) });
      used = budget;
    }
  }
  return out;
}

function visibleLength(line: MenuStatusLine): number {
  return line.reduce((n, seg) => n + seg.text.length, 0);
}

function styleSegment(seg: MenuStatusSegment, ansi: Ansi): string {
  switch (seg.style) {
    case "bold": return ansi.bold(seg.text);
    case "dim": return ansi.dim(seg.text);
    case "cyan": return ansi.cyan(seg.text);
    case "green": return ansi.green(seg.text);
    case "yellow": return ansi.yellow(seg.text);
    default: return seg.text;
  }
}

/**
 * Draw the status box. Rounded corners + dim border when colors are on; a
 * plain ASCII +-+ frame when they are not (NO_COLOR / TERM=dumb / piped) —
 * same content either way. Width: content-driven, capped at
 * min(terminal, 72), every line truncated to fit so the box always closes.
 */
function renderStatusBox(box: MenuStatusBox, ansi: Ansi, width: number): string[] {
  const cap = width > 0 ? Math.min(width, STATUS_BOX_MAX_WIDTH) : STATUS_BOX_MAX_WIDTH;
  // A line is "│ " + content + " │" — 4 columns of frame around the content.
  const innerCap = Math.max(1, cap - 4);
  const lines = box.lines.map((line) => truncateSegments(line, innerCap));
  const contentInner = Math.max(1, ...lines.map(visibleLength));
  // The top border needs title + 6 columns (╭─ + spaces + one fill dash + ╮).
  const total = Math.min(cap, Math.max(contentInner + 4, Math.min(box.title.length, cap - 6) + 6));
  const inner = total - 4;
  const title = truncatePlain(box.title, Math.max(1, total - 6));

  const c = ansi.enabled
    ? { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" }
    : { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" };
  const edge = (s: string): string => (ansi.enabled ? ansi.dim(s) : s);

  const fill = Math.max(1, total - title.length - 5);
  const out: string[] = [
    edge(`${c.tl}${c.h} ${title} ${c.h.repeat(fill)}${c.tr}`),
  ];
  for (const line of lines) {
    const styled = line.map((seg) => styleSegment(seg, ansi)).join("");
    const pad = " ".repeat(Math.max(0, inner - visibleLength(line)));
    out.push(`${edge(`${c.v} `)}${styled}${pad}${edge(` ${c.v}`)}`);
  }
  out.push(edge(`${c.bl}${c.h.repeat(total - 2)}${c.br}`));
  return out;
}

/**
 * Render the frame as terminal lines. `selected` is the highlighted row index
 * (-1 = no highlight, the fallback's plain print).
 *
 * `width` truncates every line to that many VISIBLE columns (0 = no limit).
 * The chooser passes the terminal width minus one: a wrapped line would occupy
 * two rows and silently break the "move up N lines, redraw" repaint math.
 */
export function renderMenuFrame(
  frame: MenuFrame,
  selected: number,
  ansi: Ansi,
  width = 0,
): string[] {
  const fit = (s: string): string =>
    width > 0 && s.length > width ? `${s.slice(0, Math.max(0, width - 1))}…` : s;
  const lines: string[] = [];
  // A box needs room to be a box; below ~24 columns the menu itself is
  // truncating hard, so the status degrades to "no box" rather than a
  // crushed two-character frame.
  if (frame.statusBox !== undefined && (width === 0 || width >= 24)) {
    lines.push(...renderStatusBox(frame.statusBox, ansi, width));
    lines.push("");
  }
  for (const b of frame.banner) lines.push(ansi.yellow(fit(`  ${b}`)));
  if (frame.banner.length > 0) lines.push("");
  lines.push(ansi.bold(fit(frame.title)));
  lines.push("");
  const layout = columnLayout(frame.choices.length, width);
  if (layout.columns === 2) {
    lines.push(...renderTwoColumns(frame.choices, selected, ansi, width, layout));
  } else {
    frame.choices.forEach((choice, i) => {
      lines.push(renderSingleColumnRow(choice, i === selected, ansi, width));
    });
  }
  return lines;
}

/** The original one-row-per-choice rendering (narrow terminals, the
 *  line-prompt fallback, tiny menus). Unchanged since beta.38. */
function renderSingleColumnRow(
  choice: MenuFrameChoice,
  selected: boolean,
  ansi: Ansi,
  width: number,
): string {
  const pointer = selected ? "▸" : " ";
  const num = choice.key.padStart(2);
  const prefix = ` ${pointer} ${num}) `;
  const label =
    width > 0 && prefix.length + choice.label.length > width
      ? `${choice.label.slice(0, Math.max(0, width - prefix.length - 1))}…`
      : choice.label;
  const row = ` ${pointer} ${ansi.cyan(num)}) ${label}`;
  return selected ? ansi.inverse(row) : row;
}

/** A cell's fixed head: " ▸  7) " — space, pointer, space, 2-col number, ") ". */
const CELL_PREFIX_LENGTH = 7;

/**
 * The two-column body. Each cell is padded to its column's width so the
 * selected row's inverse highlight is a neat rectangle inside its own column
 * rather than a full-width bar. Columns share the terminal budget; long
 * labels truncate with an ellipsis instead of pushing the right column off
 * screen (which would wrap and break the repaint math).
 */
function renderTwoColumns(
  choices: readonly MenuFrameChoice[],
  selected: number,
  ansi: Ansi,
  width: number,
  layout: ColumnLayout,
): string[] {
  const cell = (index: number): { num: string; pointer: string; label: string; naturalWidth: number } => {
    const choice = choices[index]!;
    const pointer = index === selected ? "▸" : " ";
    const num = choice.key.padStart(2);
    return { num, pointer, label: choice.label, naturalWidth: CELL_PREFIX_LENGTH + choice.label.length };
  };
  const leftCells = layout.left.map(cell);
  const rightCells = layout.right.map(cell);
  let leftWidth = Math.max(...leftCells.map((c) => c.naturalWidth));
  let rightWidth = Math.max(0, ...rightCells.map((c) => c.naturalWidth));
  if (width > 0 && leftWidth + COLUMN_GAP + rightWidth > width) {
    // Halve the budget; the left column concedes its slack to the right.
    leftWidth = Math.min(leftWidth, Math.floor((width - COLUMN_GAP) / 2));
    rightWidth = Math.min(rightWidth, Math.max(CELL_PREFIX_LENGTH + 1, width - COLUMN_GAP - leftWidth));
  }

  const renderCell = (
    c: { num: string; pointer: string; label: string },
    index: number,
    colWidth: number,
  ): string => {
    const labelBudget = Math.max(1, colWidth - CELL_PREFIX_LENGTH);
    const label = truncatePlain(c.label, labelBudget);
    const pad = " ".repeat(Math.max(0, colWidth - CELL_PREFIX_LENGTH - label.length));
    const text = ` ${c.pointer} ${ansi.cyan(c.num)}) ${label}${pad}`;
    return index === selected ? ansi.inverse(text) : text;
  };

  const rows = Math.max(leftCells.length, rightCells.length);
  const out: string[] = [];
  for (let r = 0; r < rows; r += 1) {
    const left = r < leftCells.length ? renderCell(leftCells[r]!, layout.left[r]!, leftWidth) : " ".repeat(leftWidth);
    if (r < rightCells.length) {
      out.push(`${left}${" ".repeat(COLUMN_GAP)}${renderCell(rightCells[r]!, layout.right[r]!, rightWidth)}`);
    } else {
      out.push(left);
    }
  }
  // Defensive: never exceed the terminal width even if the math above drifted
  // (measure on the VISIBLE text — ANSI codes are free).
  return out.map((line) =>
    width > 0 && stripAnsi(line).length > width ? truncateStyled(line, width) : line,
  );
}

/** Last-resort visible-width truncation for a styled line (ANSI preserved
 *  only up to the cut; an explicit reset closes any style left open). */
function truncateStyled(line: string, width: number): string {
  let visible = 0;
  let i = 0;
  let out = "";
  while (i < line.length && visible < width - 1) {
    if (line[i] === "\x1b") {
      const end = line.indexOf("m", i);
      if (end === -1) break;
      out += line.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    out += line[i];
    visible += 1;
    i += 1;
  }
  return `${out}…\x1b[0m`;
}
