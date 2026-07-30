// The frame renderer's two-column layout and boxed status banner (owner ask
// 2026-07-30, 3x-ui style). Pure rendering tests — no TTY, colors forced
// on/off through the ansi helper, never raw literal escapes in assertions.

import { describe, expect, it } from "vitest";

import { createAnsi, stripAnsi } from "../src/cli/ansi";
import {
  columnLayout,
  renderMenuFrame,
  TWO_COLUMN_MIN_WIDTH,
  type MenuFrame,
  type MenuStatusBox,
} from "../src/cli/commands/menu-frame";

const PLAIN = createAnsi({ enabled: false });
const COLOR = createAnsi({ enabled: true });

/** The real panel's shape: 14 numbered actions + the Quit row. */
function frame(over: Partial<MenuFrame> = {}): MenuFrame {
  return {
    title: "AIFight — what would you like to do?",
    banner: [],
    choices: [
      ...Array.from({ length: 14 }, (_, i) => ({ key: String(i + 1), label: `Action ${i + 1}` })),
      { key: "q", label: "Quit" },
    ],
    ...over,
  };
}

function statusBox(over: Partial<MenuStatusBox> = {}): MenuStatusBox {
  return {
    title: "AIFight · v0.1.0-beta.39",
    lines: [
      [
        { text: "Phantom Maverick", style: "bold" },
        { text: " · " },
        { text: "✓ claimed", style: "green" },
        { text: " · " },
        { text: "● online", style: "green" },
        { text: " · " },
        { text: "auto: 2/day", style: "dim" },
      ],
      [
        { text: "claude-opus-4-6", style: "cyan" },
        { text: " · games: ", style: "dim" },
        { text: "texas_holdem, coup" },
      ],
    ],
    ...over,
  };
}

describe("columnLayout", () => {
  it("splits column-major on a wide terminal: 1-7 left, 8-14 + q right", () => {
    const layout = columnLayout(15, 100);
    expect(layout.columns).toBe(2);
    expect(layout.left).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(layout.right).toEqual([7, 8, 9, 10, 11, 12, 13, 14]);
  });

  it("stays single-column below the width threshold", () => {
    const layout = columnLayout(15, TWO_COLUMN_MIN_WIDTH - 1);
    expect(layout.columns).toBe(1);
    expect(layout.left).toHaveLength(15);
    expect(layout.right).toHaveLength(0);
  });

  it("stays single-column when the width is unknown (0)", () => {
    expect(columnLayout(15, 0).columns).toBe(1);
  });

  it("stays single-column for tiny menus even on a wide terminal", () => {
    expect(columnLayout(3, 100).columns).toBe(1);
  });
});

describe("two-column rendering", () => {
  it("draws 8 rows: items 1-7 left, 8-14 + Quit right", () => {
    const lines = renderMenuFrame(frame(), -1, PLAIN, 100);
    // Layout: title, blank, then the 8 choice rows.
    const rows = lines.slice(2);
    expect(rows).toHaveLength(8);
    expect(stripAnsi(rows[0]!)).toContain("1) Action 1");
    expect(stripAnsi(rows[0]!)).toContain("8) Action 8");
    expect(stripAnsi(rows[6]!)).toContain("7) Action 7");
    expect(stripAnsi(rows[6]!)).toContain("14) Action 14");
    // The last row holds only the right column's Quit cell.
    expect(stripAnsi(rows[7]!)).toContain("q) Quit");
    expect(stripAnsi(rows[7]!)).not.toContain("Action");
  });

  it("keeps the two columns side by side within the terminal width", () => {
    const lines = renderMenuFrame(frame(), -1, PLAIN, 100);
    for (const line of lines) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(100);
    }
    // Left and right cells of the first row are separated by the gap.
    const first = stripAnsi(lines[2]!);
    expect(first.indexOf("8)")).toBeGreaterThan(first.indexOf("1)"));
  });

  it("highlights the selected cell as a rectangle inside its own column", () => {
    // Select item 8 (first row, RIGHT column).
    const lines = renderMenuFrame(frame(), 7, COLOR, 100);
    const first = lines[2]!;
    // The inverse span covers the right cell only: it starts at the column
    // offset, not at column 0, and does not wrap the left cell's text.
    const inverseOpen = first.indexOf("\x1b[7m");
    expect(inverseOpen).toBeGreaterThan(0);
    const beforeInverse = stripAnsi(first.slice(0, inverseOpen));
    expect(beforeInverse).toContain("1) Action 1");
    expect(beforeInverse).not.toContain("8) Action 8");
    // Numbers keep their cyan inside the layout.
    expect(first).toContain(COLOR.cyan(" 8"));
  });

  it("truncates long labels instead of wrapping past the terminal", () => {
    const wide = frame({
      choices: [
        ...Array.from({ length: 14 }, (_, i) => ({
          key: String(i + 1),
          label: `Action ${i + 1} ${"with a very long label that would wrap".repeat(3)}`,
        })),
        { key: "q", label: "Quit" },
      ],
    });
    const lines = renderMenuFrame(wide, -1, PLAIN, 80);
    for (const line of lines) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(80);
    }
    expect(lines.some((l) => l.includes("…"))).toBe(true);
  });

  it("degrades to the single-column list on a narrow terminal", () => {
    const lines = renderMenuFrame(frame(), -1, PLAIN, 60);
    // title + blank + 15 rows.
    expect(lines).toHaveLength(17);
    expect(stripAnsi(lines[16]!)).toContain("q) Quit");
    expect(stripAnsi(lines[2]!)).toContain("1) Action 1");
    expect(stripAnsi(lines[2]!)).not.toContain("8)");
  });
});

describe("status box", () => {
  it("draws a rounded box with the title in the top border when colored", () => {
    const lines = renderMenuFrame(frame({ statusBox: statusBox() }), -1, COLOR, 100);
    const plain = lines.map(stripAnsi);
    expect(plain[0]).toMatch(/^╭─ AIFight · v0\.1\.0-beta\.39 ─+╮$/);
    expect(plain[1]).toMatch(/^│ Phantom Maverick · ✓ claimed · ● online · auto: 2\/day +│$/);
    expect(plain[2]).toMatch(/^│ claude-opus-4-6 · games: texas_holdem, coup +│$/);
    expect(plain[3]).toMatch(/^╰─+╯$/);
    // Border is dimmed (the whole border line is one dim wrap), name bold,
    // the ✓/● green — asserted via the helper, never literal escapes.
    expect(lines[0]).toBe(COLOR.dim(plain[0]!));
    expect(lines[1]).toContain(COLOR.bold("Phantom Maverick"));
    expect(lines[1]).toContain(COLOR.green("✓ claimed"));
    expect(lines[2]).toContain(COLOR.cyan("claude-opus-4-6"));
  });

  it("draws the same box as a plain ASCII frame without colors", () => {
    const lines = renderMenuFrame(frame({ statusBox: statusBox() }), -1, PLAIN, 100);
    expect(lines[0]).toMatch(/^\+- AIFight · v0\.1\.0-beta\.39 -+\+$/);
    expect(lines[1]).toMatch(/^\| Phantom Maverick · ✓ claimed · ● online · auto: 2\/day +\|$/);
    expect(lines[3]).toMatch(/^\+-+\+$/);
    // No SGR codes anywhere in plain mode.
    expect(lines.join("\n")).not.toContain("\x1b[");
  });

  it("keeps every line inside min(terminal, 72) columns", () => {
    for (const width of [100, 72, 40]) {
      const lines = renderMenuFrame(frame({ statusBox: statusBox() }), -1, PLAIN, width);
      for (const line of lines) {
        expect(stripAnsi(line).length, `width ${width}: ${line}`).toBeLessThanOrEqual(Math.min(width, 72));
      }
    }
  });

  it("truncates over-long content instead of breaking the box", () => {
    const long = statusBox({
      lines: [[{ text: "A".repeat(120), style: "bold" }]],
    });
    const lines = renderMenuFrame(frame({ statusBox: long }), -1, PLAIN, 100);
    for (const line of lines.slice(0, 3)) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(72);
    }
    expect(lines[1]).toContain("…");
    expect(stripAnsi(lines[1]!).endsWith("|")).toBe(true);
  });

  it("draws the box as content + 3 lines (top, bottom, blank) before the title", () => {
    const lines = renderMenuFrame(frame({ statusBox: statusBox() }), -1, PLAIN, 100);
    // 2 status lines → top border, 2 content lines, bottom border, blank —
    // then the menu title. The provider keeps the line count constant, so a
    // refresh repaint never shifts the rows below.
    expect(stripAnsi(lines[3]!)).toMatch(/^\+-+\+$/);
    expect(lines[4]).toBe("");
    expect(lines[5]).toContain("what would you like to do?");
  });
});
