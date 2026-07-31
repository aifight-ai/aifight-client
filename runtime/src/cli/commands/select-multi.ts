// The checkbox multi-select — the fool-proof picking half of CLI UX V3
// (design: CLI_UX_V3_DESIGN_2026-07-31.html §1). Typing a comma list of game
// names was the error hotspot (typos, stray spaces, names that do not exist);
// here the platform provides the rows, so nothing can be misspelled.
//
// Same raw-mode discipline as the menu chooser (menu-select.ts): raw mode is
// switched back off and stdin paused on the way out, Ctrl-C / Ctrl-D count as
// cancel, and repainting moves the cursor up and rewrites the same lines in
// place instead of scrolling a fresh copy. The block is erased on the way
// out: what stays on screen is the caller's own confirmation output.
//
// ↑/↓ move, SPACE toggles [x]/[ ], Enter confirms, q/Esc cancels (resolves
// null = unchanged). spec.validate can REJECT a confirm — its message shows
// yellow inline and picking continues (the games picker's "select at least 1"
// guard). One line is reserved for that message from the very first paint, so
// the move-up-N repaint math never shifts when it appears or clears.
//
// Only ever wired on a real TTY (the callers' bare-interactive paths are
// TTY-gated); tests drive selectMulti with a fake stdin, exactly like the
// menu chooser's tests.

import type { HandlerEnv } from "../shared.js";
import { createAnsi, visibleWidth, type Ansi } from "../ansi.js";
import { t, type Locale } from "../i18n.js";
import { truncatePlain } from "./menu-frame.js";
import type { RawInput } from "./menu-select.js";

export interface MultiSelectItem {
  /** The row's main text — rendered cyan-bold, like a menu main word. */
  readonly label: string;
  /** A short dim suffix after the label. */
  readonly hint?: string;
  readonly checked: boolean;
}

export interface MultiSelectSpec {
  readonly title: string;
  readonly items: readonly MultiSelectItem[];
  /** The dim footer line. Default: the generic multi-select nav line. */
  readonly navHint?: string;
  /** Confirm gate: return a message to REJECT (shown yellow inline, picking
   *  continues); undefined accepts. Receives the selected row indices. */
  readonly validate?: (selected: readonly number[]) => string | undefined;
}

export interface MultiSelectOptions {
  readonly ansi?: Ansi;
  /** The nav-hint language (i18n). Default "en". */
  readonly locale?: Locale;
}

const ESC = "\x1b";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

/**
 * Draw the checkbox list, read keys until confirm or cancel, and resolve the
 * selected row indices (null on cancel). The picker is erased on the way out,
 * like the menu's.
 */
export function selectMulti(
  env: HandlerEnv,
  spec: MultiSelectSpec,
  stdin: RawInput,
  opts: MultiSelectOptions = {},
): Promise<readonly number[] | null> {
  const ansi = opts.ansi ?? createAnsi();
  const loc = opts.locale ?? "en";
  const checked = spec.items.map((item) => item.checked);
  // -1: see the same comment in menu-select.ts (deferred-wrap corner slack).
  const width = (process.stdout.columns ?? 0) > 0 ? process.stdout.columns! - 1 : 0;
  let selected = 0;
  let error: string | null = null;
  let drawn = 0;
  let pending = ""; // an escape sequence split across data chunks

  const row = (item: MultiSelectItem, i: number): string => {
    const pointer = i === selected ? "▸" : " ";
    const boxText = checked[i] === true ? "[x]" : "[ ]";
    const box = checked[i] === true ? ansi.green(boxText) : ansi.dim(boxText);
    // Truncate on the PLAIN text first (the hint is the expendable part, same
    // rule as the menu's two-tone rows), then style — so the repaint width
    // math measures what is actually drawn.
    let label = item.label;
    let hint = item.hint !== undefined && item.hint !== "" ? ` ${item.hint}` : "";
    if (width > 0) {
      const room = Math.max(1, width - 7); // " ▸ [x] " prefix
      if (visibleWidth(label) + visibleWidth(hint) > room) {
        if (visibleWidth(label) < room) {
          hint = truncatePlain(hint, room - visibleWidth(label));
        } else {
          label = truncatePlain(label, room);
          hint = "";
        }
      }
    }
    const line = ` ${pointer} ${box} ${ansi.bold(ansi.cyan(label))}${ansi.dim(hint)}`;
    return i === selected ? ansi.inverse(line) : line;
  };

  const draw = (): void => {
    const lines: string[] = ["", ansi.bold(spec.title)];
    spec.items.forEach((item, i) => lines.push(row(item, i)));
    lines.push("");
    // The reserved validation-message slot (empty most of the time): keeping
    // the line count constant is what makes the in-place repaint safe.
    lines.push(error !== null ? ansi.yellow(truncatePlain(error, width > 0 ? width : error.length)) : "");
    lines.push(ansi.dim(spec.navHint ?? t(loc, "multiselect.nav")));
    let out = drawn > 0 ? `\x1b[${drawn}F` : ""; // back to the first drawn line
    out += lines.map((l) => `\x1b[2K${l}`).join("\n") + "\n";
    drawn = lines.length;
    env.stdout(out);
  };

  return new Promise<readonly number[] | null>((resolve) => {
    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
    };
    const finish = (result: readonly number[] | null): void => {
      cleanup();
      if (drawn > 0) env.stdout(`\x1b[${drawn}F\x1b[J`); // erase the picker
      env.stdout(SHOW_CURSOR);
      resolve(result);
    };
    const confirm = (): void => {
      const picked = checked.flatMap((on, i) => (on ? [i] : []));
      const problem = spec.validate?.(picked);
      if (problem !== undefined) {
        error = problem;
        draw();
        return;
      }
      finish(picked);
    };
    const onData = (data: string): void => {
      const parsed = parseMultiKeys(pending + data);
      pending = parsed.rest;
      for (const key of parsed.keys) {
        if (key === "up" || key === "down") {
          selected = (selected + (key === "up" ? spec.items.length - 1 : 1)) % spec.items.length;
          draw();
        } else if (key === "toggle") {
          checked[selected] = checked[selected] !== true;
          error = null; // a new toggle supersedes the last rejected confirm
          draw();
        } else if (key === "confirm") {
          confirm();
          return;
        } else if (key === "cancel") {
          finish(null);
          return;
        }
      }
    };
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding?.("utf8");
    env.stdout(HIDE_CURSOR);
    draw();
    stdin.on("data", onData);
  });
}

/**
 * Split a chunk of raw input into key events: "up" | "down" | "toggle" |
 * "confirm" | "cancel". Same CSI/SS3 arrow handling as the menu chooser;
 * SPACE toggles, Enter confirms, q/Esc/Ctrl-C/Ctrl-D cancels. `rest` holds an
 * escape sequence the chunk cut in half — it is prepended to the next chunk.
 * Digits and everything else are ignored (the picker has no shortcuts).
 */
function parseMultiKeys(input: string): { keys: string[]; rest: string } {
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
        if (j === i + 2) {
          if (input[j] === "A") keys.push("up");
          else if (input[j] === "B") keys.push("down");
        }
        i = j + 1;
        continue;
      }
      if (second === "O") {
        // SS3 — how some terminals (application mode) send arrows.
        const third = input[i + 2];
        if (third === undefined) return { keys, rest: input.slice(i) };
        if (third === "A") keys.push("up");
        else if (third === "B") keys.push("down");
        i += 3;
        continue;
      }
      keys.push("cancel"); // a bare Esc keypress
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") keys.push("confirm");
    else if (ch === " ") keys.push("toggle");
    else if (ch === "\x03" || ch === "\x04") keys.push("cancel"); // Ctrl-C / Ctrl-D
    else if (ch === "q" || ch === "Q") keys.push("cancel");
    // anything else (digits, other keys): ignore
    i += 1;
  }
  return { keys, rest: "" };
}
