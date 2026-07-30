// The panel's data + rendering, shared by its two presenters:
//   * the arrow-key chooser (menu-select.ts) — repaints the frame in place
//     with a highlighted row;
//   * the line-prompt fallback (menu.ts) — prints the frame once and asks for
//     a number, for hosts that open the panel without the chooser wired.
// One renderer keeps the two presentations identical and lets tests assert on
// exactly what the chooser draws.

import type { Ansi } from "../ansi.js";

export interface MenuFrameChoice {
  /** "1".."14" for actions, "q" for the Quit row. */
  readonly key: string;
  readonly label: string;
}

export interface MenuFrame {
  readonly title: string;
  /** Warning lines drawn above the title (today: the NOT CLAIMED banner).
   *  Empty when there is nothing to warn about. */
  readonly banner: readonly string[];
  readonly choices: readonly MenuFrameChoice[];
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
  for (const b of frame.banner) lines.push(ansi.yellow(fit(`  ${b}`)));
  if (frame.banner.length > 0) lines.push("");
  lines.push(ansi.bold(fit(frame.title)));
  lines.push("");
  frame.choices.forEach((choice, i) => {
    const pointer = i === selected ? "▸" : " ";
    const num = choice.key.padStart(2);
    const prefix = ` ${pointer} ${num}) `;
    const label =
      width > 0 && prefix.length + choice.label.length > width
        ? `${choice.label.slice(0, Math.max(0, width - prefix.length - 1))}…`
        : choice.label;
    const row = ` ${pointer} ${ansi.cyan(num)}) ${label}`;
    lines.push(i === selected ? ansi.inverse(row) : row);
  });
  return lines;
}
