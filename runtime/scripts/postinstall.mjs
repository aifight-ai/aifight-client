#!/usr/bin/env node
// AIFight CLI postinstall — the small guidance box printed after
// `npm install -g @aifight/aifight`, telling the user the one next step.
//
// Rules (owner decision 2026-07-31, CLI_UX_V3_DESIGN §3 "B — recommended"):
//   * NEVER fails: whatever happens, the process exits 0 — a postinstall must
//     not be able to break an install.
//   * Prints ONLY on an interactive terminal: stdout must be a TTY and CI
//     must be unset. CI, Docker, scripts, piped installs (and the build's own
//     scratch-install verification) see nothing at all.
//   * No auto-launch: npm advises against interactive postinstalls (TTY
//     ownership under sudo/root is weird, CI would hang). The box is all
//     there is; the first bare `aifight` runs the integrated setup.
//   * Same color gate as the rest of the CLI: no ANSI when NO_COLOR is set or
//     TERM=dumb — the plain box then uses an ASCII +-+ frame.
//
// renderPostinstallBox is a pure function of (isTTY, env) so the test suite
// drives the whole TTY / CI / NO_COLOR matrix without a terminal. Importing
// this file has no side effects; only direct `node postinstall.mjs` prints.

import { pathToFileURL } from "node:url";

/**
 * Build the box text, or null when nothing should print.
 * @param {boolean} isTTY  whether stdout is an interactive terminal
 * @param {Record<string, string | undefined>} [env]  environment (CI / NO_COLOR / TERM)
 * @returns {string | null}
 */
export function renderPostinstallBox(isTTY, env = {}) {
  if (isTTY !== true) return null;
  if (typeof env.CI === "string" && env.CI !== "") return null;
  const color = !(typeof env.NO_COLOR === "string" && env.NO_COLOR !== "") && env.TERM !== "dumb";

  const tick = color ? "\x1b[32m✓\x1b[39m" : "✓";
  const cmd = color ? "\x1b[36m\x1b[1maifight\x1b[22m\x1b[39m" : "aifight";
  const docs = "https://aifight.ai/skill.md";
  const rows = [
    { plain: "✓ AIFight CLI installed", styled: `${tick} AIFight CLI installed` },
    { plain: "Next: run  aifight  to set up your agent and play.", styled: `Next: run  ${cmd}  to set up your agent and play.` },
    { plain: `Docs: ${docs}`, styled: color ? `\x1b[2mDocs: ${docs}\x1b[22m` : `Docs: ${docs}` },
  ];

  const inner = Math.max(...rows.map((row) => row.plain.length));
  const c = color
    ? { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" }
    : { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" };
  const edge = (s) => (color ? `\x1b[2m${s}\x1b[22m` : s);

  const bar = c.h.repeat(inner + 4); // two columns of padding on each side
  const lines = ["", edge(`${c.tl}${bar}${c.tr}`)];
  for (const row of rows) {
    const pad = " ".repeat(inner - row.plain.length);
    lines.push(`${edge(`${c.v}  `)}${row.styled}${pad}${edge(`  ${c.v}`)}`);
  }
  lines.push(edge(`${c.bl}${bar}${c.br}`));
  return lines.join("\n");
}

// Only print when invoked directly (`node scripts/postinstall.mjs` from npm's
// postinstall hook) — never on import (tests).
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    const box = renderPostinstallBox(process.stdout.isTTY === true, process.env);
    if (box !== null) process.stdout.write(`${box}\n\n`);
  } catch {
    // A postinstall must never break an install — swallow and exit 0.
  }
}
