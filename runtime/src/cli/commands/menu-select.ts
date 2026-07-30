// The panel's arrow-key chooser — the primary interaction (owner ask
// 2026-07-30: "options clearly visible, move with keyboard up/down", and the
// old all-plain menu had no colors at all).
//
// Raw-mode, readline-free key handling, following the readHidden precedent in
// onboard-io.ts: raw mode is switched back off and stdin paused on the way
// out, and Ctrl-C / Ctrl-D count as quit. Repainting moves the cursor up and
// rewrites the same lines in place (ANSI) instead of scrolling a fresh copy
// of the menu onto the screen every keypress.
//
// main.ts wires this ONLY when the panel opened on a real terminal (bare
// `aifight` / bare `aifight config` are both gated on stdin+stdout TTY), so
// the raw-mode path is never reached from scripts or CI; tests drive
// selectMenuKey with a fake stdin.

import type { HandlerEnv } from "../shared.js";
import { createAnsi, type Ansi } from "../ansi.js";
import { columnLayout, renderMenuFrame, type ColumnLayout, type MenuFrame } from "./menu-frame.js";

/** The slice of process.stdin the chooser needs — an interface so tests can
 *  feed scripted key sequences through a fake. */
export interface RawInput {
  on(event: "data", cb: (data: string) => void): unknown;
  removeListener(event: "data", cb: (data: string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
  setEncoding?(encoding: string): unknown;
  setRawMode?(on: boolean): unknown;
}

export interface SelectOptions {
  readonly ansi?: Ansi;
  /** How long a lone ambiguous digit ("1", which also prefixes "10".."14")
   *  waits for a second digit before running item 1. Tests shrink it. */
  readonly digitCommitMs?: number;
  /** One-shot "the frame's data may have changed" signal — today the status
   *  banner's remote enrichment landing (~1.5s after the panel opens). When
   *  it resolves, the frame is rebuilt via getFrame and redrawn once, so the
   *  first paint never waits on the network. */
  readonly refreshWhen?: Promise<unknown>;
  readonly getFrame?: () => MenuFrame;
}

/** The chooser contract menu.ts depends on: the frame to draw first, plus an
 *  optional one-shot refresh hook (see SelectOptions). */
export type MenuChoose = (frame: MenuFrame, opts?: Pick<SelectOptions, "refreshWhen" | "getFrame">) => Promise<string>;

const ESC = "\x1b";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const DEFAULT_DIGIT_COMMIT_MS = 700;

/** Wire the chooser to the real process stdin (main.ts, TTY-gated). */
export function createMenuChooser(env: HandlerEnv): MenuChoose {
  return (frame, opts) => selectMenuKey(env, frame, process.stdin as unknown as RawInput, opts);
}

/**
 * Draw the frame, read keys until the user picks a row, and resolve that
 * row's key ("1".."14" or "q"). The menu is erased on the way out: what stays
 * on screen is the picked action's own output (or the shell prompt on quit),
 * not a frozen copy of the panel.
 */
export function selectMenuKey(
  env: HandlerEnv,
  frame: MenuFrame,
  stdin: RawInput,
  opts: SelectOptions = {},
): Promise<string> {
  const ansi = opts.ansi ?? createAnsi();
  const digitCommitMs = opts.digitCommitMs ?? DEFAULT_DIGIT_COMMIT_MS;
  let currentFrame = frame;
  let choices = currentFrame.choices;
  let keys = new Set(choices.map((c) => c.key));
  // -1: a line exactly as wide as the terminal sits in the deferred-wrap
  // corner of some emulators; keep a column of slack so the repaint math
  // (one terminal row per rendered line) always holds.
  const width = (process.stdout.columns ?? 0) > 0 ? process.stdout.columns! - 1 : 0;
  let layout: ColumnLayout = columnLayout(choices.length, width);
  let selected = 0;
  let drawn = 0;
  let settled = false;
  let pending = ""; // an escape sequence split across data chunks
  let digits = ""; // buffered numeric shortcut ("1" may still become "10".."14")
  let digitTimer: ReturnType<typeof setTimeout> | null = null;

  const draw = (): void => {
    const twoColumns = layout.columns === 2;
    const lines = [
      "",
      ...renderMenuFrame(currentFrame, selected, ansi, width),
      "",
      ansi.dim(
        twoColumns
          ? "  ↑/↓ ←/→ move · Enter select · number runs · q quit"
          : "  ↑/↓ move · Enter select · number runs · q quit",
      ),
    ];
    let out = drawn > 0 ? `\x1b[${drawn}F` : ""; // back to the first drawn line
    out += lines.map((l) => `\x1b[2K${l}`).join("\n") + "\n";
    drawn = lines.length;
    env.stdout(out);
  };

  return new Promise<string>((resolve) => {
    const resetDigits = (): void => {
      digits = "";
      if (digitTimer !== null) {
        clearTimeout(digitTimer);
        digitTimer = null;
      }
    };
    const cleanup = (): void => {
      resetDigits();
      stdin.removeListener("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
    };
    const finish = (key: string): void => {
      settled = true;
      cleanup();
      if (drawn > 0) env.stdout(`\x1b[${drawn}F\x1b[J`); // erase the menu
      env.stdout(SHOW_CURSOR);
      resolve(key);
    };
    const commitDigits = (): void => {
      const buf = digits;
      resetDigits();
      if (keys.has(buf)) finish(buf);
    };
    const onDigit = (d: string): void => {
      digits += d;
      const exact = keys.has(digits);
      const isPrefix = [...keys].some((k) => k.length > digits.length && k.startsWith(digits));
      if (exact && !isPrefix) {
        commitDigits();
        return;
      }
      if (exact) {
        // "1" is an item AND a prefix of "10".."14" — jump the highlight so
        // the user sees what Enter (or a beat of waiting) would run.
        const idx = choices.findIndex((c) => c.key === digits);
        if (idx >= 0) {
          selected = idx;
          draw();
        }
      } else if (!isPrefix) {
        resetDigits(); // dead end like "9" then "9" — start over
        return;
      }
      if (digitTimer !== null) clearTimeout(digitTimer);
      digitTimer = setTimeout(commitDigits, digitCommitMs);
    };
    // ←/→ jump between the two columns, keeping the row when the other
    // column is that tall (its last row otherwise). ↑/↓ keep their linear
    // reading-order walk, which the column-major split leaves unchanged.
    const jumpColumn = (dir: "left" | "right"): void => {
      resetDigits();
      const from = dir === "right" ? layout.left : layout.right;
      const to = dir === "right" ? layout.right : layout.left;
      const row = from.indexOf(selected);
      if (row === -1 || to.length === 0) return;
      selected = to[Math.min(row, to.length - 1)]!;
      draw();
    };
    const onData = (data: string): void => {
      const parsed = parseMenuKeys(pending + data);
      pending = parsed.rest;
      for (const key of parsed.keys) {
        if (key === "up" || key === "down") {
          resetDigits();
          selected = (selected + (key === "up" ? choices.length - 1 : 1)) % choices.length;
          draw();
        } else if (key === "left" || key === "right") {
          jumpColumn(key);
        } else if (key === "enter") {
          finish(choices[selected]!.key);
          return;
        } else if (key === "quit") {
          finish("q");
          return;
        } else {
          onDigit(key);
        }
      }
    };
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding?.("utf8");
    env.stdout(HIDE_CURSOR);
    draw();
    stdin.on("data", onData);
    // The one-shot refresh (status banner's remote data landing): rebuild the
    // frame and redraw in place. Guarded so a late resolution after the user
    // already picked a row cannot repaint over the action's own output.
    if (opts.refreshWhen !== undefined) {
      void opts.refreshWhen
        .then(() => {
          if (settled) return;
          if (opts.getFrame !== undefined) {
            currentFrame = opts.getFrame();
            choices = currentFrame.choices;
            keys = new Set(choices.map((c) => c.key));
            layout = columnLayout(choices.length, width);
            if (selected >= choices.length) selected = choices.length - 1;
          }
          draw();
        })
        .catch(() => undefined);
    }
  });
}

/**
 * Split a chunk of raw input into key events. Digits come through as their
 * character ("1".."9"); everything semantic is "up" | "down" | "left" |
 * "right" | "enter" | "quit". `rest` holds an escape sequence the chunk cut
 * in half — it is prepended to the next chunk.
 */
function parseMenuKeys(input: string): { keys: string[]; rest: string } {
  const keys: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ESC) {
      const second = input[i + 1];
      if (second === "[") {
        // CSI: parameter/intermediate bytes, then one final byte in 0x40-0x7E.
        let j = i + 2;
        while (j < input.length && !(input.charCodeAt(j) >= 0x40 && input.charCodeAt(j) <= 0x7e)) j += 1;
        if (j >= input.length) return { keys, rest: input.slice(i) }; // split mid-sequence
        // Only the plain (parameterless) arrows mean something; modified
        // variants like Ctrl+↑ ("\x1b[1;5A") are swallowed whole so their
        // digits cannot misfire as shortcuts.
        if (j === i + 2) {
          if (input[j] === "A") keys.push("up");
          else if (input[j] === "B") keys.push("down");
          else if (input[j] === "C") keys.push("right");
          else if (input[j] === "D") keys.push("left");
        }
        i = j + 1;
        continue;
      }
      if (second === "O") {
        // SS3 — how some terminals (e.g. application mode) send arrows.
        const third = input[i + 2];
        if (third === undefined) return { keys, rest: input.slice(i) };
        if (third === "A") keys.push("up");
        else if (third === "B") keys.push("down");
        else if (third === "C") keys.push("right");
        else if (third === "D") keys.push("left");
        i += 3;
        continue;
      }
      keys.push("quit"); // a bare Esc keypress
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") keys.push("enter");
    else if (ch === "\x03" || ch === "\x04") keys.push("quit"); // Ctrl-C / Ctrl-D
    else if (ch === "q" || ch === "Q" || ch === "0") keys.push("quit"); // 0 quits, as before
    else if (ch >= "1" && ch <= "9") keys.push(ch);
    // anything else (including Home/End/F-keys): ignore
    i += 1;
  }
  return { keys, rest: "" };
}
