// The shared styled-output kit (cli/output.ts, V4): section / kv / kvRows /
// table / note — colors on and off (identical layout modulo ANSI), CJK-aware
// padding, ellipsis truncation, and the no-glue guarantee between a long
// label and its value.

import { describe, expect, it } from "vitest";

import { stripAnsi, visibleWidth } from "../src/cli/ansi";
import { createOutput } from "../src/cli/output";

const PLAIN = createOutput({ enabled: false });
const COLOR = createOutput({ enabled: true });

describe("output kit", () => {
  it("section is bold with colors on, plain text with colors off", () => {
    expect(COLOR.section("Overall")).toBe("\x1b[1mOverall\x1b[22m");
    expect(PLAIN.section("Overall")).toBe("Overall");
  });

  it("kv pads the label column and styles the value; stripAnsi matches the plain render", () => {
    const colored = COLOR.kv("Rank", "#12", { tone: "green" });
    const plain = PLAIN.kv("Rank", "#12");
    expect(colored).toContain("\x1b[32m#12\x1b[39m");
    expect(colored).toContain("\x1b[2mRank");
    expect(stripAnsi(colored)).toBe(plain);
    expect(plain).toBe("  Rank          #12");
  });

  it("a label longer than the column never glues onto its value", () => {
    const line = PLAIN.kv("Automatic ranked matches", "2 per day");
    expect(line).toContain("Automatic ranked matches  2 per day");
    // And a CJK label pads by display width, not code units: the value starts
    // at the same display column as a latin label's value would.
    const zh = PLAIN.kv("自动排位对局", "每日 5 场", { labelWidth: 26 });
    expect(zh.indexOf("每日 5 场")).toBe(2 + 6 + (26 - 12)); // 6 CJK chars, 12 display cols
    const latin = PLAIN.kv("Rank", "v", { labelWidth: 26 });
    expect(latin.indexOf("v")).toBe(2 + 26);
  });

  it("kvRows auto-sizes the label column to the longest label + 2", () => {
    const rows = PLAIN.kvRows([
      ["Rank", "#12"],
      ["Best rating", "1342"],
    ]);
    expect(rows[0]).toBe("  Rank         #12");
    expect(rows[1]).toBe("  Best rating  1342");
    // CJK longest label: width measured in display columns — compare the
    // visible width of the prefixes, since string indices differ for CJK.
    const zh = PLAIN.kvRows([
      ["排名", "#12"],
      ["最高积分", "1342"],
    ]);
    const prefix = (line: string, marker: string): number =>
      visibleWidth(line.slice(0, line.indexOf(marker)));
    expect(prefix(zh[0]!, "#12")).toBe(prefix(zh[1]!, "1342"));
  });

  it("table: dim-bold header, right-aligned numeric columns, per-cell truncation", () => {
    const lines = PLAIN.table(
      [
        { label: "GAME" },
        { label: "RATING", align: "right" },
        { label: "WIN%", align: "right" },
      ],
      [
        ["Texas Hold'em", "1342", "66%"],
        ["Coup", "1095", "62%"],
      ],
    );
    expect(lines[0]).toBe("  GAME           RATING  WIN%");
    expect(lines[1]).toBe("  Texas Hold'em    1342   66%");
    expect(lines[2]).toBe("  Coup             1095   62%");
    // Right-aligned cells end at the same column as their header.
    expect(lines[1]!.indexOf("1342") + 4).toBe(lines[0]!.indexOf("RATING") + 6);
  });

  it("table truncates a long cell to maxWidth with an ellipsis and keeps the next column aligned", () => {
    const lines = PLAIN.table(
      [
        { label: "OPPONENTS", maxWidth: 20 },
        { label: "DATE", minWidth: 10 },
      ],
      [["vs Agent Kimi K3, GPT-5, Gemini 2.5 Pro", "2026-07-30"]],
    );
    const body = lines[1]!;
    expect(body).toContain("…");
    // The date column starts exactly after the 20-column opponents cell + gap.
    expect(body.indexOf("2026-07-30")).toBe(2 + 20 + 2);
    expect(stripAnsi(lines[0]!).length).toBeLessThanOrEqual(2 + 20 + 2 + 10);
  });

  it("table honors CJK cell widths when padding", () => {
    const lines = PLAIN.table(
      [{ label: "游戏" }, { label: "胜率", align: "right" }],
      [
        ["德州扑克", "66%"],
        ["Coup", "62%"],
      ],
    );
    // "德州扑克" is 8 display columns (4 string chars); "Coup" pads to the
    // same DISPLAY column — compare visible widths of the prefixes, since
    // string indices differ for CJK rows.
    const prefix = (line: string, marker: string): number =>
      visibleWidth(line.slice(0, line.indexOf(marker)));
    expect(prefix(lines[1]!, "66%")).toBe(prefix(lines[2]!, "62%"));
  });

  it("table tones cells per column when colors are on; plain render is identical modulo ANSI", () => {
    const colored = COLOR.table([{ label: "KEY", tone: "cyan" }], [["env:X"]]);
    const plain = PLAIN.table([{ label: "KEY", tone: "cyan" }], [["env:X"]]);
    expect(colored[1]).toContain("\x1b[36m");
    expect(stripAnsi(colored.join("\n"))).toBe(plain.join("\n"));
  });

  it("note is a dim indented line", () => {
    expect(PLAIN.note("estimate only")).toBe("  estimate only");
    expect(COLOR.note("estimate only")).toBe("  \x1b[2mestimate only\x1b[22m");
  });

  // P6 (统一交互规范 §2, 批 U4): one failure shape for every command.
  it("fail is a red ✗ headline with the hint plain underneath", () => {
    expect(PLAIN.fail("could not restart", "run `aifight service restart`"))
      .toBe("✗ could not restart\nrun `aifight service restart`\n");
    expect(COLOR.fail("could not restart")).toBe("\x1b[31m✗ could not restart\x1b[39m\n");
    // Errors are red; yellow stays the warning color.
    expect(COLOR.fail("x")).toContain("\x1b[31m");
  });

  it("fail without a hint emits no trailing blank line", () => {
    expect(PLAIN.fail("boom")).toBe("✗ boom\n");
    expect(PLAIN.fail("boom", "")).toBe("✗ boom\n");
  });
});
