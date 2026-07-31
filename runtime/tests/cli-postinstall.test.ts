// The postinstall guidance box (scripts/postinstall.mjs, V3 ③): prints only
// on an interactive terminal with no CI, never fails, no ANSI under
// NO_COLOR / TERM=dumb. The renderer is pure (isTTY, env) — this drives the
// whole gating matrix without a terminal.

import { describe, expect, it } from "vitest";

import { renderPostinstallBox } from "../scripts/postinstall.mjs";

describe("postinstall guidance box", () => {
  it("prints the 3-line box on an interactive terminal", () => {
    const box = renderPostinstallBox(true, { TERM: "xterm-256color" });
    expect(box).not.toBeNull();
    expect(box).toContain("AIFight CLI installed");
    expect(box).toContain("aifight");
    expect(box).toContain("https://aifight.ai/skill.md");
    // Rounded frame + colors when the gate allows.
    expect(box).toContain("╭");
    expect(box).toContain("╯");
    expect(box).toContain("\x1b[32m"); // green ✓
  });

  it("stays silent when stdout is not a TTY (scripts, Docker, piped installs)", () => {
    expect(renderPostinstallBox(false, {})).toBeNull();
    expect(renderPostinstallBox(false, { TERM: "xterm" })).toBeNull();
  });

  it("stays silent under CI (any non-empty CI value)", () => {
    expect(renderPostinstallBox(true, { CI: "true" })).toBeNull();
    expect(renderPostinstallBox(true, { CI: "1", TERM: "xterm" })).toBeNull();
    // An empty CI is "unset" for our purposes.
    expect(renderPostinstallBox(true, { CI: "", TERM: "xterm" })).not.toBeNull();
  });

  it("emits no ANSI under NO_COLOR — ASCII frame, same content", () => {
    const box = renderPostinstallBox(true, { NO_COLOR: "1", TERM: "xterm" });
    expect(box).not.toBeNull();
    expect(box).not.toContain("\x1b[");
    expect(box).toContain("+");
    expect(box).toContain("AIFight CLI installed");
  });

  it("emits no ANSI when TERM=dumb", () => {
    const box = renderPostinstallBox(true, { TERM: "dumb" });
    expect(box).not.toBeNull();
    expect(box).not.toContain("\x1b[");
  });

  it("keeps the box rectangular (every row the same visible width)", () => {
    for (const env of [{ TERM: "xterm" }, { NO_COLOR: "1" }]) {
      const box = renderPostinstallBox(true, env);
      expect(box).not.toBeNull();
      const rows = box!.split("\n").filter((l) => l.length > 0);
      const widths = rows.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").length);
      for (const w of widths) expect(w).toBe(widths[0]);
    }
  });
});
