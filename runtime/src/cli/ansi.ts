// Minimal ANSI styling — used by the interactive panel (menu-select.ts) and,
// since V2 (2026-07-31), by the ✓/⚠ status icons on a few commands' human
// feedback lines (pause / resume / update); the rest of the CLI's output
// stays plain. Hand-rolled instead of a color dependency: this package keeps
// runtime deps to the two native modules and everything needed here fits
// below (owner ask 2026-07-30: the menu had no colors at all).
//
// Colors are emitted only when all three hold (the usual convention):
//   * stdout is a TTY            — piped/redirected output stays machine-clean
//   * NO_COLOR is unset or empty — https://no-color.org
//   * TERM is not "dumb"
// The gate inputs are injectable so tests can force either side.

export interface Ansi {
  readonly enabled: boolean;
  readonly bold: (s: string) => string;
  readonly dim: (s: string) => string;
  readonly inverse: (s: string) => string;
  readonly cyan: (s: string) => string;
  readonly green: (s: string) => string;
  readonly yellow: (s: string) => string;
}

export interface AnsiGate {
  /** Explicit on/off — skips environment detection entirely. */
  readonly enabled?: boolean;
  /** Default: process.stdout.isTTY === true. */
  readonly isTTY?: boolean;
  /** Default: process.env (NO_COLOR and TERM are read from it). */
  readonly env?: NodeJS.ProcessEnv;
}

const ESC = "\x1b[";

// Open/close PAIRS (not a full reset) so styles nest: the selected row wraps
// the whole line in inverse, and the cyan item number inside it must close
// back to inverse, not to nothing.
function wrap(enabled: boolean, open: string, close: string): (s: string) => string {
  return (s) => (enabled ? `${ESC}${open}m${s}${ESC}${close}m` : s);
}

export function createAnsi(gate: AnsiGate = {}): Ansi {
  const enabled = gate.enabled ?? detectColor(gate);
  return {
    enabled,
    bold: wrap(enabled, "1", "22"),
    dim: wrap(enabled, "2", "22"),
    inverse: wrap(enabled, "7", "27"),
    cyan: wrap(enabled, "36", "39"),
    green: wrap(enabled, "32", "39"),
    yellow: wrap(enabled, "33", "39"),
  };
}

function detectColor(gate: AnsiGate): boolean {
  const env = gate.env ?? process.env;
  const isTTY = gate.isTTY ?? process.stdout.isTTY === true;
  const noColor = env.NO_COLOR !== undefined && env.NO_COLOR !== "";
  return isTTY && !noColor && env.TERM !== "dumb";
}

/** The two status icons command feedback lines lead with (owner ask
 *  2026-07-31, V2): a green ✓ for success, a yellow ⚠ for warnings. Colored
 *  glyphs when the gate allows; the ASCII fallback ("OK" / "!") when not, so
 *  NO_COLOR / TERM=dumb / piped output stays clean and --json never sees them
 *  (callers only prefix human output). */
export interface StatusIcons {
  readonly ok: string;
  readonly warn: string;
}

export function createStatusIcons(gate: AnsiGate = {}): StatusIcons {
  const ansi = createAnsi(gate);
  return ansi.enabled
    ? { ok: ansi.green("✓"), warn: ansi.yellow("⚠") }
    : { ok: "OK", warn: "!" };
}

// SGR sequences only — enough for everything createAnsi emits. Width math
// (the status box, the two-column menu) must measure VISIBLE columns, so a
// styled line goes through this before `.length` is taken.
const SGR_PATTERN = /\x1b\[[0-9;]*m/g;

/** Remove SGR color/style sequences so the result's length is the visible width. */
export function stripAnsi(s: string): string {
  return s.replace(SGR_PATTERN, "");
}

/**
 * Terminal-cell width of a string (i18n fix, 2026-07-31): strips ANSI first,
 * then sums PER-CODEPOINT widths — 2 for East Asian Wide/Fullwidth and
 * emoji/pictographs, 0 for combining marks, 1 otherwise. JS `.length` counts
 * a CJK ideograph as 1 while the terminal draws it as 2 cells, which broke
 * the banner's right border and the two-column menu's column start in zh.
 * Iterates by code point (for…of), so surrogate pairs count once.
 */
export function visibleWidth(s: string): number {
  let width = 0;
  for (const ch of stripAnsi(s)) {
    width += codePointWidth(ch.codePointAt(0)!);
  }
  return width;
}

/** The width table, hand-rolled (no wcwidth dependency): the East Asian
 *  Wide/Fullwidth ranges, plus 0x1F300–0x1FAFF so pictographs (emoji) get
 *  the same wide treatment as the mandated ranges. */
function codePointWidth(cp: number): number {
  if (cp >= 0x0300 && cp <= 0x036f) return 0; // combining marks
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals … CJK Symbols
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana … CJK Compatibility
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK Compatibility Forms / Small Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
    (cp >= 0x20000 && cp <= 0x2fffd) || // CJK Ext B+
    (cp >= 0x30000 && cp <= 0x3fffd) || // CJK Ext G+
    (cp >= 0x1f300 && cp <= 0x1faff) // emoji / pictographs (addition to the mandated ranges)
  ) {
    return 2;
  }
  return 1;
}
