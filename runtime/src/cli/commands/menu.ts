// THE interactive control panel. Bare `aifight` opens it, and so does bare
// `aifight config` — there is exactly one menu in this CLI.
//
// (design: RENAME_AND_RANKED_GATE_DESIGN.md §6 — owner ask #5). The necessary
// first-run flow stays in `aifight setup`; this is the "adjust later" panel so a
// returning user can run bare `aifight` and pick a common action instead of
// recalling the flat command list.
//
// `aifight config` used to open a SECOND, narrower menu, and picking "LLM" here
// dropped the user into it — one level down, different numbering, overlapping
// items. The owner hit that walking a fresh VPS install and asked why there were
// two different menus (2026-07-29). Both doors now open this one room; the
// config-only items it was missing ("Show current config") moved in.
//
// It is gated in main.ts to ONLY the interactive case: a bare invocation with
// both stdin and stdout attached to a TTY and not --json. Scripts, the VPS
// service, CI, and `aifight --json` all keep the scriptable behavior (grouped
// help), so nothing about headless usage changes.
//
// Everything it needs (prompt, dispatch, help, configured-state) is INJECTED, so
// the menu's control flow is unit-testable without a real terminal.

import type { HandlerEnv } from "../shared.js";
import { CommandError, SUPPORTED_GAMES, UsageError } from "../shared.js";
import { createAnsi } from "../ansi.js";
import { applyPendingBridgeRestart, withDeferredApply } from "./apply-settings.js";
import { MAX_MANUAL_MATCHES } from "./bridge-start.js";
import { renderMenuFrame, type MenuFrame } from "./menu-frame.js";

export interface MenuDeps {
  readonly env: HandlerEnv;
  /** Read one line of input (main wires createOnboardIO(env).promptLine). */
  readonly prompt: (question: string) => Promise<string>;
  /** The chooser: given the freshly-built frame, resolve the key of the row
   *  the user picked ("1".."14" or "q"). main.ts wires the arrow-key chooser
   *  (menu-select.ts) — the panel only ever opens on a TTY, so that is the
   *  production path. When absent the panel falls back to printing the frame
   *  and reading a number line-by-line (today's tests, and any future host
   *  that opens the panel without raw-mode stdin). */
  readonly choose?: (frame: MenuFrame) => Promise<string>;
  /** Run one CLI command by name with positional args (no flags, non-JSON). */
  readonly dispatch: (cmd: string, positional: string[]) => Promise<number>;
  /** Print the full grouped command help. */
  readonly showHelp: () => void;
  /** Whether a local bridge identity already exists (first-run vs returning). */
  readonly configured: boolean;
  /** Live read of the pause flag (bridge.json), consulted at every render and
   *  by the Pause/Resume item itself — the label must flip right after the
   *  dispatched command rewrote the config, without rebuilding the panel.
   *  Optional so tests and non-configured hosts can omit it (= not paused). */
  readonly matchingPaused?: () => boolean;
  /** Local view of the claim handshake. The claim URL is scrubbed from
   *  bridge.json once the platform reports the agent claimed, so "still on
   *  file" is a reliable offline signal for "not claimed yet" — no network
   *  call just to draw the panel. */
  readonly claim?: { readonly pending: boolean; readonly url?: string; readonly agentName?: string };
}

interface MenuItem {
  readonly key: string;
  /** Static for almost every item; a function for the ones whose wording
   *  depends on live state (Pause vs Resume matching). */
  readonly label: string | ((deps: MenuDeps) => string);
  readonly run: (deps: MenuDeps) => Promise<void>;
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The actionable "what to do next" line typed errors carry (e.g. "Start it
 *  with `aifight service start`"). The CLI funnel always prints it; a menu
 *  catch that drops it turns a recoverable failure into a dead end. Mirrors
 *  printActionError in config.ts. */
function errorHint(cause: unknown): string | undefined {
  if (cause instanceof CommandError || cause instanceof UsageError) return cause.hint;
  return undefined;
}

// The "adjust later" actions, in display order. Each gathers any arguments via
// the injected prompt, then dispatches to the existing command handler — the menu
// adds NO new behavior, it is purely a friendlier front door.
const ITEMS: readonly MenuItem[] = [
  {
    key: "1",
    label: "Status — show this machine's setup",
    run: ({ dispatch }) => dispatch("status", []).then(() => undefined),
  },
  {
    key: "2",
    label: "Record — your ratings, rank & recent matches",
    run: ({ dispatch }) => dispatch("record", []).then(() => undefined),
  },
  {
    key: "3",
    label: "Play — request a manual ranked match",
    run: async ({ env, prompt, dispatch }) => {
      const game = (await prompt(`Game (blank = auto-pick; options: ${SUPPORTED_GAMES.join(", ")}): `)).trim();
      // Validate against the same 1-20 ceiling `aifight start` enforces, here —
      // dispatching an out-of-range count only to be bounced back is a dead end.
      const countRaw = (await prompt(`How many matches? (1-${MAX_MANUAL_MATCHES}, default 1): `)).trim() || "1";
      const count = /^\d+$/.test(countRaw) ? Number.parseInt(countRaw, 10) : 0;
      if (count < 1 || count > MAX_MANUAL_MATCHES) {
        env.stdout(`Count must be a whole number between 1 and ${MAX_MANUAL_MATCHES}.\n`);
        return;
      }
      await dispatch("start", game ? [game, countRaw] : [countRaw]);
    },
  },
  {
    key: "4",
    label: "Rename — change your public display name",
    run: async ({ env, prompt, dispatch }) => {
      const name = (await prompt("New display name: ")).trim();
      if (name === "") {
        env.stdout("No name entered — nothing changed.\n");
        return;
      }
      await dispatch("rename", [name]);
    },
  },
  {
    key: "5",
    // These two delegate to the prompts the old `aifight config` hub used, not
    // to the barer ones this panel had: those show the CURRENT value, treat a
    // blank answer as "keep it", and validate against the setup wizard's
    // ceiling. Merging the menus meant picking one of each pair, and this is
    // the better half.
    label: "Daily cap — automatic matches per day (0 = off)",
    run: async ({ env, prompt }) => {
      const { configureDailyInteractive } = await import("./config.js");
      await configureDailyInteractive({ promptLine: prompt }, env);
    },
  },
  {
    key: "6",
    label: "Games — which games to auto-play",
    run: async ({ env, prompt }) => {
      const { configureGamesInteractive } = await import("./config.js");
      await configureGamesInteractive({ promptLine: prompt }, env);
    },
  },
  {
    key: "7",
    // `config llm`, not bare `config`: bare config opens its own hub, so this
    // used to drop the user into a SECOND menu one level down — which is the
    // "why are there two different menus" the owner ran into (2026-07-29).
    label: "LLM — set up / test your model (provider, key, routing)",
    run: ({ dispatch }) => dispatch("config", ["llm"]).then(() => undefined),
  },
  {
    key: "8",
    label: "Update — get the latest CLI and restart the service",
    run: ({ dispatch }) => dispatch("update", []).then(() => undefined),
  },
  {
    key: "9",
    label: "Full command list",
    run: async ({ showHelp }) => {
      showHelp();
    },
  },
  {
    // Not "0" — that is the quit key.
    key: "10",
    label: "Telegram — phone notifications & remote control",
    run: ({ dispatch }) => dispatch("telegram", []).then(() => undefined),
  },
  {
    key: "11",
    label: "Claim — link this agent to your account (required before it can play)",
    run: async ({ env, claim }) => {
      if (claim?.pending !== true || claim.url === undefined) {
        env.stdout("\nThis agent is already claimed. Manage it in the Dashboard: https://aifight.ai/dashboard\n");
        return;
      }
      env.stdout("\nOpen this link to claim your agent — until you do, it cannot play:\n");
      env.stdout(`  ${claim.url}\n`);
    },
  },
  {
    key: "12",
    label: "Strategy — where to edit how your agent plays",
    run: ({ dispatch }) => dispatch("strategy", ["path"]).then(() => undefined),
  },
  {
    // Carried over from the old `aifight config` hub, which is now this panel.
    key: "13",
    label: "Show current config — what this machine is set to",
    run: ({ dispatch }) => dispatch("config", ["show"]).then(() => undefined),
  },
  {
    // The CLI twin of the desktop app's pause switch (owner gap 2026-07-30:
    // the app persists a pause, the CLI only had the "daily cap 0" workaround).
    // Appended LAST so the existing 13 keys keep their numbers. The label and
    // the dispatched command both follow the live flag, so the item flips to
    // "Resume" on the repaint right after pausing.
    key: "14",
    label: (deps) =>
      deps.matchingPaused?.() === true
        ? "Resume matching — let your agent auto-join matches again"
        : "Pause matching — stop auto-joining new matches (manual ones still work)",
    run: (deps) =>
      deps.dispatch(deps.matchingPaused?.() === true ? "resume" : "pause", []).then(() => undefined),
  },
];

function buildFrame(deps: MenuDeps): MenuFrame {
  const banner: string[] = [];
  // An unclaimed agent cannot play at all, and nothing in the panel used to say
  // so — the owner finished a whole VPS setup and never saw a reminder
  // (2026-07-29). Lead with it, every time round the loop, until it is done.
  if (deps.claim?.pending === true) {
    const who = deps.claim.agentName !== undefined ? ` (${deps.claim.agentName})` : "";
    banner.push(`⚠ NOT CLAIMED${who} — this agent cannot play until you claim it.`);
    if (deps.claim.url !== undefined) banner.push(deps.claim.url);
  }
  return {
    title: "AIFight — what would you like to do?",
    banner,
    choices: [
      // Labels are re-evaluated on every build: item 14's wording follows the
      // live pause flag, and the frame built right after the command rewrote
      // it must already say "Resume".
      ...ITEMS.map((item) => ({
        key: item.key,
        label: typeof item.label === "function" ? item.label(deps) : item.label,
      })),
      // A selectable Quit row, so pure arrow-key usage can exit too.
      { key: "q", label: "Quit" },
    ],
  };
}

/** The chooser-less presentation: print the frame once, read a number. Only
 *  reachable when the panel was opened without a wired chooser — main.ts
 *  gates the panel to TTYs and always wires the arrow-key one, so in
 *  practice this path lives in tests. */
async function lineChoice(deps: MenuDeps, frame: MenuFrame): Promise<string> {
  deps.env.stdout(`\n${renderMenuFrame(frame, -1, createAnsi({ enabled: false })).join("\n")}\n\n`);
  return (await deps.prompt("Pick an action (number, or q to quit): ")).trim().toLowerCase();
}

/**
 * Run the interactive control panel until the user quits. Returns an exit code
 * (always 0 for a normal quit; a dispatched command's own errors are caught,
 * shown, and the loop continues so one failed action never drops the panel).
 */
export async function runInteractiveMenu(deps: MenuDeps): Promise<number> {
  const { env, prompt, dispatch, configured } = deps;

  // First run on this machine: the guided path is `setup`. Offer it directly
  // rather than showing a panel of actions that all need an identity first.
  if (!configured) {
    env.stdout("\nAIFight isn't set up on this machine yet.\n");
    const ans = (await prompt("Run guided setup now? [Y/n]: ")).trim().toLowerCase();
    if (ans === "" || ans === "y" || ans === "yes") {
      return dispatch("setup", []);
    }
    env.stdout("\nWhen you're ready: `aifight setup` (guided) or `aifight --help`.\n");
    return 0;
  }

  const byKey = new Map(ITEMS.map((i) => [i.key, i]));
  for (;;) {
    const frame = buildFrame(deps);
    const choice = deps.choose !== undefined
      ? (await deps.choose(frame)).trim().toLowerCase()
      : await lineChoice(deps, frame);
    if (choice === "q" || choice === "quit" || choice === "0") {
      // Several items write bridge.json, which a running bridge only re-reads on
      // restart. Offer that ONCE, here. The owner's words for being asked after
      // every edit were "连着被告知三次" — so the panel defers each item's own
      // offer and settles up on the way out.
      await applyPendingBridgeRestart(env);
      return 0;
    }
    if (choice === "") continue;
    const item = byKey.get(choice);
    if (item === undefined) {
      env.stdout(`Unknown choice '${choice}'.\n`);
      continue;
    }
    try {
      await withDeferredApply(() => item.run(deps));
    } catch (cause) {
      // A handler error (UsageError / CommandError / unexpected) must not drop
      // the panel — surface the message the same way the CLI funnel would,
      // hint included (a swallowed hint is a dead end).
      env.stdout(`aifight: ${describeError(cause)}\n`);
      const hint = errorHint(cause);
      if (hint !== undefined) env.stdout(`${hint}\n`);
    }
  }
}
