// The frame renderer's two-column layout, boxed status banner, and V2
// two-tone rows (owner asks 2026-07-30 + 2026-07-31, 3x-ui style). Pure
// rendering tests — no TTY, colors forced on/off through the ansi helper,
// never raw literal escapes in assertions (except the inverse/cyan pair
// discipline, where the exact SGR pairing IS the contract).

import { describe, expect, it } from "vitest";

import { createAnsi, stripAnsi, visibleWidth } from "../src/cli/ansi";
import {
  columnLayout,
  renderMenuFrame,
  TWO_COLUMN_MIN_WIDTH,
  type MenuFrame,
  type MenuStatusBox,
} from "../src/cli/commands/menu-frame";

const PLAIN = createAnsi({ enabled: false });
const COLOR = createAnsi({ enabled: true });

/** The real panel's shape: 16 numbered actions + the Quit row (V3 final
 *  layout — Profile inserted at 9, 2026-07-31). */
function frame(over: Partial<MenuFrame> = {}): MenuFrame {
  return {
    title: "AIFight — what would you like to do?",
    banner: [],
    choices: [
      ...Array.from({ length: 16 }, (_, i) => ({
        key: String(i + 1),
        main: `Action ${i + 1}`,
        hint: `does thing ${i + 1}`,
      })),
      { key: "q", main: "Quit" },
    ],
    ...over,
  };
}

/** A status box in the V2 three-line shape (identity / matching / model). */
function statusBox(over: Partial<MenuStatusBox> = {}): MenuStatusBox {
  return {
    title: "AIFight · v0.1.0-beta.40",
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
      [{ text: "⚔ matching: queued texas_holdem", style: "cyan" }],
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
  it("splits column-major on a wide terminal: 1-8 left, 9-16 + q right", () => {
    const layout = columnLayout(17, 100);
    expect(layout.columns).toBe(2);
    expect(layout.left).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(layout.right).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16]);
  });

  it("stays single-column below the width threshold", () => {
    const layout = columnLayout(17, TWO_COLUMN_MIN_WIDTH - 1);
    expect(layout.columns).toBe(1);
    expect(layout.left).toHaveLength(17);
    expect(layout.right).toHaveLength(0);
  });

  it("stays single-column when the width is unknown (0)", () => {
    expect(columnLayout(17, 0).columns).toBe(1);
  });

  it("stays single-column for tiny menus even on a wide terminal", () => {
    expect(columnLayout(3, 100).columns).toBe(1);
  });
});

describe("two-column rendering", () => {
  it("draws 9 rows: items 1-8 left, 9-16 + Quit right", () => {
    const lines = renderMenuFrame(frame(), -1, PLAIN, 100);
    // Layout: title, blank, then the 9 choice rows.
    const rows = lines.slice(2);
    expect(rows).toHaveLength(9);
    expect(stripAnsi(rows[0]!)).toContain("1) Action 1 — does thing 1");
    expect(stripAnsi(rows[0]!)).toContain("9) Action 9 — does thing 9");
    expect(stripAnsi(rows[6]!)).toContain("7) Action 7");
    expect(stripAnsi(rows[6]!)).toContain("15) Action 15");
    // Item 8 pairs with 16 on the last full row; Quit sits alone below.
    expect(stripAnsi(rows[7]!)).toContain("8) Action 8");
    expect(stripAnsi(rows[7]!)).toContain("16) Action 16");
    expect(stripAnsi(rows[8]!)).not.toContain("8) Action 8");
    expect(stripAnsi(rows[8]!)).toContain("q) Quit");
  });

  it("keeps the two columns side by side within the terminal width", () => {
    const lines = renderMenuFrame(frame(), -1, PLAIN, 100);
    for (const line of lines) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(100);
    }
    // Left and right cells of the first row are separated by the gap.
    const first = stripAnsi(lines[2]!);
    expect(first.indexOf("9)")).toBeGreaterThan(first.indexOf("1)"));
  });

  it("highlights the selected cell as a rectangle inside its own column", () => {
    // Select item 9 (first row, RIGHT column).
    const lines = renderMenuFrame(frame(), 8, COLOR, 100);
    const first = lines[2]!;
    // The inverse span covers the right cell only: it starts at the column
    // offset, not at column 0, and does not wrap the left cell's text.
    const inverseOpen = first.indexOf("\x1b[7m");
    expect(inverseOpen).toBeGreaterThan(0);
    const beforeInverse = stripAnsi(first.slice(0, inverseOpen));
    expect(beforeInverse).toContain("1) Action 1");
    expect(beforeInverse).not.toContain("9) Action 9");
    // Numbers keep their cyan inside the layout.
    expect(first).toContain(COLOR.cyan(" 9"));
  });

  it("truncates long labels instead of wrapping past the terminal", () => {
    const wide = frame({
      choices: [
        ...Array.from({ length: 16 }, (_, i) => ({
          key: String(i + 1),
          main: `Action ${i + 1}`,
          hint: "with a very long hint that would wrap".repeat(3),
        })),
        { key: "q", main: "Quit" },
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
    // title + blank + 17 rows.
    expect(lines).toHaveLength(19);
    expect(stripAnsi(lines[18]!)).toContain("q) Quit");
    expect(stripAnsi(lines[2]!)).toContain("1) Action 1 — does thing 1");
    expect(stripAnsi(lines[2]!)).not.toContain("9)");
  });

  it("the subheader renders PLAIN between title and choices (profile submenu, V3)", () => {
    const lines = renderMenuFrame(
      frame({ subheader: ["Active: Steel Mongoose (agent-1 · claude-opus-4-6)", "note line"] }),
      -1,
      COLOR,
      100,
    );
    // title(1) + blank(1) + 2 subheader lines + blank(1), then the 9 choice rows.
    expect(stripAnsi(lines[0]!)).toContain("what would you like to do?");
    expect(stripAnsi(lines[2]!)).toBe("Active: Steel Mongoose (agent-1 · claude-opus-4-6)");
    expect(stripAnsi(lines[3]!)).toBe("note line");
    expect(lines[4]).toBe("");
    expect(stripAnsi(lines[5]!)).toContain("1) Action 1");
    // Not yellow, not bold — an info line, not a warning and not the title.
    expect(lines[2]).not.toContain("\x1b[33m");
    expect(lines[2]).not.toContain("\x1b[1m");
  });

  it("singleColumn: true renders one row per choice on a wide terminal", () => {
    const lines = renderMenuFrame(frame(), -1, PLAIN, 100, { singleColumn: true });
    // title + blank + 17 rows.
    expect(lines).toHaveLength(19);
    expect(stripAnsi(lines[2]!)).toContain("1) Action 1");
    expect(stripAnsi(lines[2]!)).not.toContain("9)");
    expect(stripAnsi(lines[18]!)).toContain("q) Quit");
  });
});

// V2 (owner decision ②): every row is a cyan-bold main word plus a dim hint;
// the selected cell's inverse must wrap both tones cleanly (the styles close
// back to inverse, never to a full reset).
describe("two-tone rows (V2)", () => {
  const twoToneFrame = (): MenuFrame =>
    frame({
      choices: [
        { key: "1", main: "Play", hint: "request a ranked match" },
        { key: "2", main: "Pause", hint: "pause auto-matching" },
        { key: "12", main: "Update", hint: "↑ 0.1.0-beta.41 available", hintTone: "yellow" },
        { key: "q", main: "Quit" },
      ],
    });

  it("main is cyan-bold, the hint dim, in both layouts", () => {
    for (const width of [100, 40]) {
      const lines = renderMenuFrame(twoToneFrame(), -1, COLOR, width);
      const body = lines.join("\n");
      expect(body).toContain(COLOR.bold(COLOR.cyan("Play")));
      expect(body).toContain(COLOR.dim(" — request a ranked match"));
      expect(body).toContain(COLOR.bold(COLOR.cyan("Quit")));
    }
  });

  it("the update nudge's hint is yellow, not dim", () => {
    const lines = renderMenuFrame(twoToneFrame(), -1, COLOR, 100);
    const body = lines.join("\n");
    expect(body).toContain(COLOR.yellow(" — ↑ 0.1.0-beta.41 available"));
    expect(body).not.toContain(COLOR.dim(" — ↑ 0.1.0-beta.41 available"));
  });

  it("plain mode keeps the same words with no styling at all", () => {
    const lines = renderMenuFrame(twoToneFrame(), -1, PLAIN, 100);
    const body = lines.join("\n");
    expect(body).not.toContain("\x1b[");
    expect(body).toContain("1) Play — request a ranked match");
    expect(body).toContain("12) Update — ↑ 0.1.0-beta.41 available");
  });

  it("the selected cell inverts BOTH tones and closes back to inverse, never reset", () => {
    const lines = renderMenuFrame(twoToneFrame(), 0, COLOR, 100);
    // Single-column would be width 0; two-column at 100: item 1 is the left
    // cell of row 0.
    const row = lines[2]!;
    const inverseOpen = row.indexOf("\x1b[7m");
    const inverseClose = row.indexOf("\x1b[27m");
    expect(inverseOpen).toBeGreaterThanOrEqual(0);
    expect(inverseClose).toBeGreaterThan(inverseOpen);
    const span = row.slice(inverseOpen, inverseClose + "\x1b[27m".length);
    // No full reset inside the inverse span — the cyan-bold main closes with
    // 39/22 so the inverse attribute stays open across the whole cell.
    expect(span).not.toContain("\x1b[0m");
    expect(span).toContain(COLOR.bold(COLOR.cyan("Play")));
    expect(span).toContain(COLOR.dim(" — request a ranked match"));
    // The inverse rectangle covers the whole padded cell: stripping ANSI
    // leaves a run of the column's width with no leftover unstyled gap.
    const visible = stripAnsi(row);
    const cellEnd = visible.indexOf("match") + "match".length;
    expect(visible.slice(0, cellEnd)).toContain("▸  1) Play — request a ranked match");
  });

  it("width math ignores the style codes: padded cells stay aligned", () => {
    const lines = renderMenuFrame(frame(), -1, COLOR, 100);
    const plainLines = renderMenuFrame(frame(), -1, PLAIN, 100);
    // Every colored row strips to exactly the plain rendering.
    expect(lines.map(stripAnsi)).toEqual(plainLines);
  });

  it("truncation cuts the hint first and keeps the main word whole", () => {
    const long = frame({
      choices: [
        { key: "1", main: "Daily cap", hint: "auto matches [not set]" },
        { key: "q", main: "Quit" },
      ],
    });
    // A 26-column budget: the prefix takes 7, so the label gets 19 — enough
    // for "Daily cap" plus a piece of the hint, never a cut main word.
    const lines = renderMenuFrame(long, -1, PLAIN, 26);
    const row = stripAnsi(lines[2]!);
    expect(row).toContain("Daily cap");
    expect(row).toContain("…");
    expect(row.length).toBeLessThanOrEqual(26);
  });
});

describe("status box", () => {
  it("draws a rounded box with the title in the top border when colored", () => {
    const lines = renderMenuFrame(frame({ statusBox: statusBox() }), -1, COLOR, 100);
    const plain = lines.map(stripAnsi);
    expect(plain[0]).toMatch(/^╭─ AIFight · v0\.1\.0-beta\.40 ─+╮$/);
    expect(plain[1]).toMatch(/^│ Phantom Maverick · ✓ claimed · ● online · auto: 2\/day +│$/);
    expect(plain[2]).toMatch(/^│ ⚔ matching: queued texas_holdem +│$/);
    expect(plain[3]).toMatch(/^│ claude-opus-4-6 · games: texas_holdem, coup +│$/);
    expect(plain[4]).toMatch(/^╰─+╯$/);
    // Border is dimmed (the whole border line is one dim wrap), name bold,
    // the ✓/● green — asserted via the helper, never literal escapes.
    expect(lines[0]).toBe(COLOR.dim(plain[0]!));
    expect(lines[1]).toContain(COLOR.bold("Phantom Maverick"));
    expect(lines[1]).toContain(COLOR.green("✓ claimed"));
    expect(lines[2]).toContain(COLOR.cyan("⚔ matching: queued texas_holdem"));
    expect(lines[3]).toContain(COLOR.cyan("claude-opus-4-6"));
  });

  it("draws the same box as a plain ASCII frame without colors", () => {
    const lines = renderMenuFrame(frame({ statusBox: statusBox() }), -1, PLAIN, 100);
    expect(lines[0]).toMatch(/^\+- AIFight · v0\.1\.0-beta\.40 -+\+$/);
    expect(lines[1]).toMatch(/^\| Phantom Maverick · ✓ claimed · ● online · auto: 2\/day +\|$/);
    expect(lines[4]).toMatch(/^\+-+\+$/);
    // No SGR codes anywhere in plain mode.
    expect(lines.join("\n")).not.toContain("\x1b[");
  });

  it("plain mode swaps the V2 matching glyphs for ASCII (⚔→>, ⏸→||, ⚠→!)", () => {
    const box = statusBox({
      lines: [
        [{ text: "Phantom Maverick", style: "bold" }],
        [{ text: "⏸ matching: paused · resume with: aifight resume", style: "yellow" }],
        [{ text: "claude-opus-4-6", style: "cyan" }],
      ],
    });
    const plain = renderMenuFrame(frame({ statusBox: box }), -1, PLAIN, 100);
    expect(plain[2]).toContain("|| matching: paused");
    expect(plain[2]).not.toContain("⏸");
    const colored = renderMenuFrame(frame({ statusBox: box }), -1, COLOR, 100);
    expect(stripAnsi(colored[2]!)).toContain("⏸ matching: paused");
    // And the queued / claim glyphs behave the same way.
    const queued = statusBox();
    expect(renderMenuFrame(frame({ statusBox: queued }), -1, PLAIN, 100)[2]).toContain("> matching: queued");
    const claim = statusBox({
      lines: [
        [{ text: "Phantom Maverick", style: "bold" }],
        [{ text: "⚠ claim your agent first — menu item 12", style: "yellow" }],
        [{ text: "claude-opus-4-6", style: "cyan" }],
      ],
    });
    expect(renderMenuFrame(frame({ statusBox: claim }), -1, PLAIN, 100)[2]).toContain("! claim your agent first");
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
    // 3 status lines → top border, 3 content lines, bottom border, blank —
    // then the menu title. The provider keeps the line count constant, so a
    // refresh repaint never shifts the rows below.
    expect(stripAnsi(lines[4]!)).toMatch(/^\+-+\+$/);
    expect(lines[5]).toBe("");
    expect(lines[6]).toContain("what would you like to do?");
  });
});

// ── CJK width math (2026-07-31 defect fix) ──────────────────────────
//
// JS .length counts a CJK ideograph as 1 while the terminal draws it as 2 —
// the zh banner's right border and the two-column menu's right column used
// to wobble. Every width decision now goes through visibleWidth.

/** The real zh menu's shape (the i18n dictionary's mains + hints). */
function zhFrame(): MenuFrame {
  const rows: Array<[string, string, string]> = [
    ["1", "请求对局", "发起一场排位赛"],
    ["2", "暂停匹配", "暂停自动匹配"],
    ["3", "本机状态", "本机与 agent 状态"],
    ["4", "战绩积分", "积分·排名·战绩"],
    ["5", "模型", "模型·密钥·路由"],
    ["6", "每日上限", "自动对局 [5/天]"],
    ["7", "参赛游戏", "自动参赛 [已选 3 个]"],
    ["8", "策略文件", "你的 agent 怎么打"],
    ["9", "身份管理", "多 agent 身份切换"],
    ["10", "改名", "公开显示名"],
    ["11", "Telegram", "手机通知与遥控"],
    ["12", "认领", "绑定到你的账号"],
    ["13", "检查更新", "↑ 0.1.0-beta.41 可更新"],
    ["14", "当前配置", "查看当前配置"],
    ["15", "语言", "切换到 English"],
    ["16", "全部命令", "全部命令与说明"],
  ];
  return frame({
    title: "AIFight —— 你想做什么？",
    choices: [...rows.map(([key, main, hint]) => ({ key, main, hint })), { key: "q", main: "退出" }],
  });
}

/** A zh status box (the matching line's three real states). */
function zhStatusBox(): MenuStatusBox {
  return {
    title: "AIFight · v0.1.0-beta.40",
    lines: [
      [
        { text: "Steel Mongoose", style: "bold" },
        { text: " · " },
        { text: "✓ 已认领", style: "green" },
        { text: " · " },
        { text: "● 在线", style: "green" },
        { text: " · " },
        { text: "auto: 5/天", style: "dim" },
      ],
      [{ text: "⚔ 匹配中：texas_holdem 队列", style: "cyan" }],
      [
        { text: "claude-opus-4-6", style: "cyan" },
        { text: " · 游戏：", style: "dim" },
        { text: "texas_holdem, coup" },
      ],
    ],
  };
}

describe("zh layout (CJK width math)", () => {
  it("the zh banner box is a rectangle: every line shares one visible width", () => {
    for (const ansi of [PLAIN, COLOR]) {
      const lines = renderMenuFrame(frame({ statusBox: zhStatusBox() }), -1, ansi, 100);
      const boxLines = lines.slice(0, 5); // top, 3 content, bottom
      const widths = boxLines.map(visibleWidth);
      for (const [i, w] of widths.entries()) {
        expect(w, `line ${i}: ${stripAnsi(boxLines[i]!)}`).toBe(widths[0]!);
      }
      // Right border sits at the same column everywhere.
      for (const line of boxLines.slice(1, 4)) {
        expect(stripAnsi(line).trimEnd().endsWith(ansi === PLAIN ? "|" : "│")).toBe(true);
      }
    }
  });

  it("the zh two-column menu keeps the right column's start constant across rows", () => {
    for (const ansi of [PLAIN, COLOR]) {
      const lines = renderMenuFrame(zhFrame(), -1, ansi, 100);
      const rows = lines.slice(2); // title + blank, then 9 choice rows
      expect(rows).toHaveLength(9);
      const starts = rows.map((row, r) => {
        const marker = r < 8 ? `${r + 9})` : "q)"; // right column holds 9-16, q
        const plainRow = stripAnsi(row);
        const idx = plainRow.indexOf(marker);
        expect(idx, `row ${r} must contain its right cell`).toBeGreaterThan(0);
        // The DISPLAY column of the right CELL's start — the marker sits
        // inside the cell's own " ▸ nn) " prefix (digit at prefix offset 4
        // for one-char numbers like 9/q, offset 3 for two-char 10-15).
        const prefixOffset = marker.length === 2 ? 4 : 3;
        return visibleWidth(plainRow.slice(0, idx)) - prefixOffset;
      });
      for (const [i, s] of starts.entries()) {
        expect(s, `row ${i}: ${stripAnsi(rows[i]!)}`).toBe(starts[0]!);
      }
      // And no row exceeds the terminal width.
      for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(100);
    }
  });

  it("truncation cuts by display width and never splits a wide character", () => {
    const narrow = frame({
      choices: [
        { key: "1", main: "每日上限", hint: "自动对局 [未设置]" },
        { key: "q", main: "退出" },
      ],
    });
    const lines = renderMenuFrame(narrow, -1, PLAIN, 24);
    const row = stripAnsi(lines[2]!);
    expect(row).toContain("每日上限"); // the main word stays whole
    expect(row).toContain("…");
    expect(visibleWidth(row)).toBeLessThanOrEqual(24);
    expect(visibleWidth(row)).toBeGreaterThanOrEqual(23); // the cut uses the budget
  });

  it("EN rendering is byte-identical to the pre-fix output (no wide chars → no change)", () => {
    const lines = renderMenuFrame(
      frame({
        statusBox: {
          title: "AIFight · v0.1.0-beta.40",
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
            [{ text: "⚔ matching: queued texas_holdem", style: "cyan" }],
            [
              { text: "claude-opus-4-6", style: "cyan" },
              { text: " · games: ", style: "dim" },
              { text: "texas_holdem, coup" },
            ],
          ],
        },
      }),
      -1,
      PLAIN,
      100,
    );
    // The exact V3 rendering (pinned 2026-07-31; EN has no wide chars,
    // so the width-math change must not move a single byte).
    expect(lines).toEqual([
      "+- AIFight · v0.1.0-beta.40 ----------------------------+",
      "| Phantom Maverick · ✓ claimed · ● online · auto: 2/day |",
      "| > matching: queued texas_holdem                       |",
      "| claude-opus-4-6 · games: texas_holdem, coup           |",
      "+-------------------------------------------------------+",
      "",
      "AIFight — what would you like to do?",
      "",
      "    1) Action 1 — does thing 1        9) Action 9 — does thing 9  ",
      "    2) Action 2 — does thing 2       10) Action 10 — does thing 10",
      "    3) Action 3 — does thing 3       11) Action 11 — does thing 11",
      "    4) Action 4 — does thing 4       12) Action 12 — does thing 12",
      "    5) Action 5 — does thing 5       13) Action 13 — does thing 13",
      "    6) Action 6 — does thing 6       14) Action 14 — does thing 14",
      "    7) Action 7 — does thing 7       15) Action 15 — does thing 15",
      "    8) Action 8 — does thing 8       16) Action 16 — does thing 16",
      "                                      q) Quit                     ",
    ]);
  });
});
