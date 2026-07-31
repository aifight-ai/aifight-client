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
// 2026-07-31 V2: two-tone rows (cyan-bold main word + dim hint) and a fixed
// THREE-line banner whose middle line is the matching state.

import { visibleWidth, type Ansi } from "../ansi.js";

export interface MenuFrameChoice {
  /** "1".."14" for actions, "q" for the Quit row. */
  readonly key: string;
  /** The action word ("Play", "Daily cap") — rendered cyan-bold (V2,
   *  2026-07-31: two-tone rows, owner decision ②). */
  readonly main: string;
  /** The short dim description after the main word ("request a ranked
   *  match"). May carry live state (the daily cap, the games count). */
  readonly hint?: string;
  /** Hint styling — dim normally; yellow for the update-available nudge. */
  readonly hintTone?: "dim" | "yellow";
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

/** Truncate plain text to `budget` VISIBLE columns, ellipsis included. Cuts
 *  by display width (CJK/fullwidth = 2 columns): a wide character that would
 *  cross the budget is dropped whole and the ellipsis takes the last column,
 *  so the result never exceeds budget nor leaves an odd half-column. */
function truncatePlain(s: string, budget: number): string {
  if (budget <= 0) return "";
  if (visibleWidth(s) <= budget) return s;
  if (budget === 1) return "…";
  let used = 0;
  let out = "";
  for (const ch of s) {
    if (used + visibleWidth(ch) > budget - 1) break; // reserve the ellipsis column
    out += ch;
    used += visibleWidth(ch);
  }
  return `${out}…`;
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
    const w = visibleWidth(seg.text);
    if (w <= room) {
      out.push(seg);
      used += w;
    } else {
      out.push({ ...seg, text: truncatePlain(seg.text, room) });
      used = budget;
    }
  }
  return out;
}

function visibleLength(line: MenuStatusLine): number {
  return line.reduce((n, seg) => n + visibleWidth(seg.text), 0);
}

/** Plain-mode stand-ins for the banner's unicode status glyphs (V2 matching
 *  line: ⏸ paused, ⚔ queued, ⚠ claim guidance). Same spirit as the box
 *  renderer's ╭→+ fallback: NO_COLOR / TERM=dumb / piped output gets ASCII,
 *  the content stays. Applied BEFORE truncation so the width math measures
 *  what is actually drawn (⏸→|| grows by one column). */
const ASCII_GLYPH_FALLBACK: ReadonlyArray<readonly [string, string]> = [
  ["⏸", "||"],
  ["⚔", ">"],
  ["⚠", "!"],
];

function asciiFallbackLine(line: MenuStatusLine): MenuStatusLine {
  return line.map((seg) => ({
    ...seg,
    text: ASCII_GLYPH_FALLBACK.reduce((t, [from, to]) => t.split(from).join(to), seg.text),
  }));
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
  const lines = box.lines.map((line) =>
    truncateSegments(ansi.enabled ? line : asciiFallbackLine(line), innerCap),
  );
  const contentInner = Math.max(1, ...lines.map(visibleLength));
  // The top border needs title + 6 columns (╭─ + spaces + one fill dash + ╮).
  const total = Math.min(cap, Math.max(contentInner + 4, Math.min(visibleWidth(box.title), cap - 6) + 6));
  const inner = total - 4;
  const title = truncatePlain(box.title, Math.max(1, total - 6));

  const c = ansi.enabled
    ? { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" }
    : { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" };
  const edge = (s: string): string => (ansi.enabled ? ansi.dim(s) : s);

  const fill = Math.max(1, total - visibleWidth(title) - 5);
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
  const fit = (s: string): string => (width > 0 ? truncatePlain(s, width) : s);
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

/** A choice's visible label text: the main word plus its " — hint" suffix. */
function choiceLabelText(choice: MenuFrameChoice): string {
  return choice.hint !== undefined && choice.hint !== "" ? `${choice.main} — ${choice.hint}` : choice.main;
}

/**
 * Style a choice label for the V2 two-tone rows: the main word cyan-bold,
 * the " — hint" suffix dim (yellow for the update nudge). `budget` is the
 * label's visible-column allowance (0 = no limit); truncation happens on the
 * PLAIN text first — the hint is the expendable part, the main word stays
 * whole as long as it fits — and the styles wrap the pieces afterwards, so
 * the open/close pair discipline (cyan→39, bold/dim→22) keeps nesting inside
 * the selected row's inverse.
 */
function styleChoiceLabel(choice: MenuFrameChoice, budget: number, ansi: Ansi): string {
  const hintPart = choice.hint !== undefined && choice.hint !== "" ? ` — ${choice.hint}` : "";
  const main = ansi.bold(ansi.cyan(choice.main));
  const styleHint = (s: string): string =>
    choice.hintTone === "yellow" ? ansi.yellow(s) : ansi.dim(s);
  const mainWidth = visibleWidth(choice.main);
  if (budget <= 0 || mainWidth + visibleWidth(hintPart) <= budget) {
    return main + styleHint(hintPart);
  }
  if (mainWidth < budget) {
    return main + styleHint(truncatePlain(hintPart, budget - mainWidth));
  }
  // Even the main word does not fit (a very narrow terminal): one styled cut.
  return ansi.bold(ansi.cyan(truncatePlain(choiceLabelText(choice), budget)));
}

/** The one-row-per-choice rendering (narrow terminals, the line-prompt
 *  fallback, tiny menus) — same layout as beta.38, V2 two-tone styling. */
function renderSingleColumnRow(
  choice: MenuFrameChoice,
  selected: boolean,
  ansi: Ansi,
  width: number,
): string {
  const pointer = selected ? "▸" : " ";
  const num = choice.key.padStart(2);
  const labelBudget = width > 0 ? Math.max(1, width - CELL_PREFIX_LENGTH) : 0;
  const row = ` ${pointer} ${ansi.cyan(num)}) ${styleChoiceLabel(choice, labelBudget, ansi)}`;
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
  const cell = (index: number): { num: string; pointer: string; choice: MenuFrameChoice; naturalWidth: number } => {
    const choice = choices[index]!;
    const pointer = index === selected ? "▸" : " ";
    const num = choice.key.padStart(2);
    return { num, pointer, choice, naturalWidth: CELL_PREFIX_LENGTH + visibleWidth(choiceLabelText(choice)) };
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
    c: { num: string; pointer: string; choice: MenuFrameChoice },
    index: number,
    colWidth: number,
  ): string => {
    const labelBudget = Math.max(1, colWidth - CELL_PREFIX_LENGTH);
    const label = styleChoiceLabel(c.choice, labelBudget, ansi);
    // Measure the STYLED label (visibleWidth ignores the SGR codes): the pad
    // must fill to the column width in terminal cells, whatever the label's
    // mix of narrow and wide characters ended up as after truncation.
    const pad = " ".repeat(Math.max(0, colWidth - CELL_PREFIX_LENGTH - visibleWidth(label)));
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
    width > 0 && visibleWidth(line) > width ? truncateStyled(line, width) : line,
  );
}

/** Last-resort visible-width truncation for a styled line (ANSI preserved
 *  only up to the cut; an explicit reset closes any style left open). Cuts
 *  by display width and never splits a wide character. */
function truncateStyled(line: string, width: number): string {
  let visible = 0;
  let i = 0;
  let out = "";
  while (i < line.length) {
    if (line[i] === "\x1b") {
      const end = line.indexOf("m", i);
      if (end === -1) break;
      out += line.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    const cp = line.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const w = visibleWidth(ch);
    if (visible + w > width - 1) break;
    out += ch;
    visible += w;
    i += ch.length; // 2 UTF-16 units for a surrogate pair
  }
  return `${out}…\x1b[0m`;
}
