// The P1 primitive's shared entry (统一交互规范 §2, 2026-08-02): one
// list-choice, arrow-key chooser when the host wired one, printed frame +
// numbered line input otherwise. challenge-menu and profile-menu each
// hand-rolled this pair (pickKey); every list choice — including the flows
// being migrated off hand-typed words — now goes through here so the two
// presentations can never drift again.

import type { HandlerEnv } from "../shared.js";
import { createAnsi } from "../ansi.js";
import { t, type Locale } from "../i18n.js";
import { renderMenuFrame, type MenuFrame } from "./menu-frame.js";
import type { MenuChoose } from "./menu-select.js";

export interface PickOneDeps {
  readonly env: HandlerEnv;
  readonly locale: Locale;
  /** The arrow-key chooser (production TTY). Absent → line fallback. */
  readonly choose?: MenuChoose;
  /** Line input for the fallback (and only for it). */
  readonly prompt: (question: string) => Promise<string>;
}

/**
 * Resolve ONE row key from the frame. Returns null when the user backed out
 * (q / Esc / the frame's own "q" row / a blank line answer — the blank case
 * also keeps exhausted test scripts terminating instead of looping). In line
 * mode an answer that matches no row re-asks with the standard unknown-choice
 * line rather than silently cancelling.
 */
export async function pickOneKey(deps: PickOneDeps, frame: MenuFrame): Promise<string | null> {
  const keys = new Set(frame.choices.map((c) => c.key));
  if (deps.choose !== undefined) {
    const key = (await deps.choose(frame, { locale: deps.locale, singleColumn: true })).trim().toLowerCase();
    return key === "" || key === "q" ? null : key;
  }
  deps.env.stdout(
    `\n${renderMenuFrame(frame, -1, createAnsi({ enabled: false }), 0, { singleColumn: true }).join("\n")}\n\n`,
  );
  for (;;) {
    const raw = (await deps.prompt(t(deps.locale, "menu.pick"))).trim().toLowerCase();
    if (raw === "" || raw === "q" || raw === "quit" || raw === "0") return null;
    if (keys.has(raw)) return raw;
    deps.env.stdout(`${t(deps.locale, "menu.unknown_choice", { choice: raw })}\n`);
  }
}
