// Minimal ANSI styling — used ONLY by the interactive panel (menu-select.ts);
// the rest of the CLI's output stays plain. Hand-rolled instead of a color
// dependency: this package keeps runtime deps to the two native modules and
// everything needed here fits below (owner ask 2026-07-30: the menu had no
// colors at all).
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

// SGR sequences only — enough for everything createAnsi emits. Width math
// (the status box, the two-column menu) must measure VISIBLE columns, so a
// styled line goes through this before `.length` is taken.
const SGR_PATTERN = /\x1b\[[0-9;]*m/g;

/** Remove SGR color/style sequences so the result's length is the visible width. */
export function stripAnsi(s: string): string {
  return s.replace(SGR_PATTERN, "");
}
