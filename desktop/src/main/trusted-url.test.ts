// E5 (windows-loop) — trusted-URL serialization. The IPC guard and the
// navigation lock both accept exactly ONE string and reject everything else, and
// that string is compared against what Chromium reports as the frame URL. So the
// serialization is the security boundary: get it wrong in either direction and
// the app either rejects its own renderer (looks bricked) or, if someone
// loosened the comparison to compensate, stops pinning the page at all.
//
// This matters most on Windows, which is where the loop that produced this batch
// was running: `C:\Program Files\AIFight\...` percent-encodes, and a hand-built
// "file://" + dir would never match the URL the frame actually carries.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getTrustedRendererUrl, RENDERER_ENTRY_RELATIVE } from "./trusted-url";

describe("getTrustedRendererUrl (the one string the guards compare against)", () => {
  it("is a file:// URL that round-trips back to the renderer entry", () => {
    const base = path.join(path.sep, "opt", "aifight", "dist", "main");
    const url = getTrustedRendererUrl(base);
    expect(url.startsWith("file://")).toBe(true);
    expect(fileURLToPath(url)).toBe(path.join(base, RENDERER_ENTRY_RELATIVE));
  });

  it("percent-encodes a spacey install path instead of emitting a raw space", () => {
    // The real Windows default, and the case a string-concatenated URL fails.
    const base = path.join(path.sep, "Program Files", "AIFight", "dist", "main");
    const url = getTrustedRendererUrl(base);
    expect(url).toContain("Program%20Files");
    expect(url).not.toContain("Program Files");
    // Still has to survive the trip back, or the encoding is merely different-wrong.
    expect(fileURLToPath(url)).toBe(path.join(base, RENDERER_ENTRY_RELATIVE));
  });

  it("encodes non-ASCII too (a user folder is often the install root)", () => {
    const base = path.join(path.sep, "用户", "aifight", "dist", "main");
    const url = getTrustedRendererUrl(base);
    expect(url).not.toContain("用户");
    expect(fileURLToPath(url)).toBe(path.join(base, RENDERER_ENTRY_RELATIVE));
  });

  it("is stable across calls — the guards cache it at window-create time", () => {
    expect(getTrustedRendererUrl()).toBe(getTrustedRendererUrl());
  });

  it("normalizes away the '..' rather than leaving it in the compared string", () => {
    // Chromium resolves the path before reporting frame.url; a URL still carrying
    // "/dist/main/../renderer/" would never string-equal what the frame shows.
    const url = getTrustedRendererUrl(path.join(path.sep, "opt", "aifight", "dist", "main"));
    expect(url).not.toContain("..");
    expect(url.endsWith("/renderer/index.html")).toBe(true);
  });

  it("points at the same file main.ts hands to loadFile", () => {
    // Two independent expressions of one path. Move the renderer output and
    // update only one of them and the guard pins a URL nothing ever loads: every
    // ipc call is rejected, with nothing in the code looking wrong.
    const main = fs.readFileSync(path.join(__dirname, "main.ts"), "utf8");
    const loadFileArg = /loadFile\(path\.join\(__dirname,\s*"([^"]+)"\)\)/.exec(main);
    expect(loadFileArg, "main.ts no longer calls loadFile(path.join(__dirname, ...))").not.toBeNull();
    expect(loadFileArg![1]).toBe(RENDERER_ENTRY_RELATIVE);
  });
});
