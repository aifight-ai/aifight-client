// The Challenge submenu — friendly duels (约战) from the main panel.
//
// Owner ask (2026-08-01): bare `aifight` must be the front door for EVERY core
// action; nobody should have to memorize `aifight challenge <game> [players]`.
// Same design as profile-menu.ts: a small injected-deps loop that only ever
// gathers arguments and dispatches to the EXISTING command handlers — the menu
// adds no new behavior.
//
// Rows: Create (game + table size → share link), List (open + recent),
// Accept (paste a URL or token), Back.

import type { HandlerEnv } from "../shared";
import { t, type Locale } from "../i18n";
import { createAnsi } from "../ansi";
import { renderMenuFrame, type MenuFrame, type MenuFrameChoice } from "./menu-frame";
import type { MenuChoose } from "./menu-select";

export interface ChallengeMenuDeps {
  readonly env: HandlerEnv;
  readonly locale: () => Locale;
  /** Line input (players count, the accept URL). */
  readonly prompt: (question: string) => Promise<string>;
  /** The arrow-key chooser (production). Absent in tests → line fallback. */
  readonly choose?: MenuChoose;
  /** Run one CLI command by name with positional args (main panel's dispatch). */
  readonly dispatch: (cmd: string, positional: string[]) => Promise<number>;
}

/** The friendly table sizes per game. The SERVER is the authority
 *  (match.FriendlyPlayerCountAllowed) — these mirror it for the picker's
 *  hint + local bounds check, and a drift only costs one round-trip to a
 *  clear server error. texas [2,6] is the owner-ruled heads-up exemption;
 *  dice/coup are the engine Min..Max. */
const TABLE_SIZES: Record<string, { readonly min: number; readonly max: number }> = {
  texas_holdem: { min: 2, max: 6 },
  liars_dice: { min: 2, max: 4 },
  coup: { min: 3, max: 4 },
};

const GAME_ROWS = ["texas_holdem", "liars_dice", "coup"] as const;

function gameTitle(game: string): string {
  switch (game) {
    case "texas_holdem": return "Texas Hold'em";
    case "liars_dice": return "Liar's Dice";
    case "coup": return "Coup";
  }
  return game;
}

/** Run the Challenge submenu until the user backs out. One action per visit
 *  keeps it symmetrical with the other panel items: do the thing, land back
 *  on the main panel. */
export async function runChallengeMenu(deps: ChallengeMenuDeps): Promise<void> {
  const loc = deps.locale();
  const rows: MenuFrameChoice[] = [
    { key: "1", main: t(loc, "challenge.menu.create.main"), hint: t(loc, "challenge.menu.create.hint") },
    { key: "2", main: t(loc, "challenge.menu.list.main"), hint: t(loc, "challenge.menu.list.hint") },
    { key: "3", main: t(loc, "challenge.menu.accept.main"), hint: t(loc, "challenge.menu.accept.hint") },
    { key: "q", main: t(loc, "challenge.menu.back.main"), hint: t(loc, "challenge.menu.back.hint") },
  ];
  const frame: MenuFrame = { title: t(loc, "challenge.menu.title"), banner: [], choices: rows };
  const key = await pickKey(deps, frame, loc);
  if (key === null || key === "q") return;
  if (key === "1") {
    await createFlow(deps, loc);
    return;
  }
  if (key === "2") {
    await deps.dispatch("challenge", ["list"]);
    return;
  }
  if (key === "3") {
    await acceptFlow(deps, loc);
    return;
  }
}

/** Game picker (chooser or line fallback) → table size prompt → dispatch. */
async function createFlow(deps: ChallengeMenuDeps, loc: Locale): Promise<void> {
  const choices: MenuFrameChoice[] = GAME_ROWS.map((game, i) => {
    const size = TABLE_SIZES[game]!;
    return {
      key: String(i + 1),
      main: gameTitle(game),
      hint: t(loc, "challenge.menu.create.game_hint", { min: size.min, max: size.max }),
    };
  });
  choices.push({ key: "q", main: t(loc, "challenge.menu.back.main") });
  const frame: MenuFrame = { title: t(loc, "challenge.menu.create.game_title"), banner: [], choices };
  const key = await pickKey(deps, frame, loc);
  if (key === null || key === "q") return;
  const game = GAME_ROWS[Number.parseInt(key, 10) - 1];
  if (game === undefined) return;

  const size = TABLE_SIZES[game]!;
  const raw = (await deps.prompt(
    t(loc, "challenge.menu.create.players_prompt", { min: size.min, max: size.max }),
  )).trim();
  let positional: string[];
  if (raw === "") {
    positional = [game]; // blank → the server seats the smallest legal table
  } else {
    const n = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 0;
    if (n < size.min || n > size.max) {
      deps.env.stdout(`${t(loc, "challenge.menu.create.players_invalid", { min: size.min, max: size.max })}\n`);
      return;
    }
    positional = [game, String(n)];
  }
  await deps.dispatch("challenge", positional);
}

/** Paste-and-go accept: URL or bare token, straight to `aifight accept`. */
async function acceptFlow(deps: ChallengeMenuDeps, loc: Locale): Promise<void> {
  const raw = (await deps.prompt(t(loc, "challenge.menu.accept.prompt"))).trim();
  if (raw === "") {
    deps.env.stdout(`${t(loc, "prompt.cancel")}\n`);
    return;
  }
  await deps.dispatch("accept", [raw]);
}

/** One chooser pass (single-column), or the line-prompt fallback. q/Esc → null. */
async function pickKey(deps: ChallengeMenuDeps, frame: MenuFrame, loc: Locale): Promise<string | null> {
  if (deps.choose !== undefined) {
    return (await deps.choose(frame, { locale: loc, singleColumn: true })).trim().toLowerCase();
  }
  deps.env.stdout(`\n${renderMenuFrame(frame, -1, createAnsi({ enabled: false }), 0, { singleColumn: true }).join("\n")}\n\n`);
  return (await deps.prompt(t(loc, "menu.pick"))).trim().toLowerCase();
}
