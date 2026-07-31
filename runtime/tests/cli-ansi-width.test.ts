// visibleWidth (ansi.ts) — the terminal-cell width math the zh layout
// depends on (CJK = 2 columns, combining marks = 0, ANSI codes free).
// JS .length counts an ideograph as 1; the terminal draws it as 2 — that
// mismatch broke the zh banner border and the two-column menu (2026-07-31).

import { describe, expect, it } from "vitest";

import { createAnsi, stripAnsi, visibleWidth } from "../src/cli/ansi";

describe("visibleWidth", () => {
  it("plain ASCII counts one column per character", () => {
    expect(visibleWidth("abc")).toBe(3);
    expect(visibleWidth("")).toBe(0);
    expect(visibleWidth("auto: 5/day")).toBe(11);
  });

  it("CJK ideographs count two columns each", () => {
    expect(visibleWidth("请求对局")).toBe(8);
    expect(visibleWidth("语言")).toBe(4);
    // 7 letters + space + 2 em dashes (narrow) + space + 5 ideographs + fullwidth ？
    expect(visibleWidth("AIFight —— 你想做什么？")).toBe(7 + 1 + 2 + 1 + 10 + 2);
  });

  it("fullwidth punctuation counts two columns each (：，。、)", () => {
    expect(visibleWidth("：")).toBe(2);
    expect(visibleWidth("，")).toBe(2);
    expect(visibleWidth("。")).toBe(2);
    expect(visibleWidth("、")).toBe(2);
    expect(visibleWidth("匹配中：")).toBe(6 + 2);
  });

  it("combining marks count zero (the base char keeps its width)", () => {
    expect(visibleWidth("e")).toBe(1);
    expect(visibleWidth("e\u0301")).toBe(1); // e + U+0301 combining acute
    expect(visibleWidth("é")).toBe(1); // precomposed é — one code point, narrow
  });

  it("surrogate-pair code points count once, as two columns (for…of iteration)", () => {
    expect("𠀀".length).toBe(2); // U+20000 — two UTF-16 units…
    expect(visibleWidth("𠀀")).toBe(2); // …but one wide code point
    expect(visibleWidth("𠀀𠀁")).toBe(4);
  });

  it("emoji / pictographs count two columns", () => {
    expect(visibleWidth("😀")).toBe(2); // U+1F600
  });

  it("the banner glyphs stay narrow (⚔ ⚠ ⏸ ✓ ● ○ ↑ ▸ are width 1)", () => {
    for (const g of ["⚔", "⚠", "⏸", "✓", "●", "○", "↑", "▸", "…"]) {
      expect(visibleWidth(g), g).toBe(1);
    }
  });

  it("ignores ANSI styling around CJK text", () => {
    const ansi = createAnsi({ enabled: true });
    expect(visibleWidth(ansi.cyan("⚔ 匹配中：texas_holdem 队列"))).toBe(
      visibleWidth("⚔ 匹配中：texas_holdem 队列"),
    );
    expect(visibleWidth(ansi.bold(ansi.cyan("请求对局")))).toBe(8);
    expect(visibleWidth(ansi.dim(" — 自动对局 [5/天]"))).toBe(3 + 10 + 5);
  });

  it("equals stripAnsi length for text without wide characters (EN unchanged)", () => {
    for (const s of [
      "Play — request a ranked match",
      "⚔ matching: queued texas_holdem",
      "Phantom Maverick · ✓ claimed · ● online · auto: 2/day",
      "AIFight — what would you like to do?",
    ]) {
      expect(visibleWidth(s), s).toBe(stripAnsi(s).length);
    }
  });
});
