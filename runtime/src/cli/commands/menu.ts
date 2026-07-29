// Interactive "control panel" shown when `aifight` is run bare in a TTY
// (design: RENAME_AND_RANKED_GATE_DESIGN.md §6 — owner ask #5). The necessary
// first-run flow stays in `aifight setup`; this is the "adjust later" panel so a
// returning user can run bare `aifight` and pick a common action instead of
// recalling the flat command list.
//
// It is gated in main.ts to ONLY the interactive case: a bare invocation with
// both stdin and stdout attached to a TTY and not --json. Scripts, the VPS
// service, CI, and `aifight --json` all keep the scriptable behavior (grouped
// help), so nothing about headless usage changes.
//
// Everything it needs (prompt, dispatch, help, configured-state) is INJECTED, so
// the menu's control flow is unit-testable without a real terminal.

import type { HandlerEnv } from "../shared.js";
import { SUPPORTED_GAMES } from "../shared.js";

export interface MenuDeps {
  readonly env: HandlerEnv;
  /** Read one line of input (main wires createOnboardIO(env).promptLine). */
  readonly prompt: (question: string) => Promise<string>;
  /** Run one CLI command by name with positional args (no flags, non-JSON). */
  readonly dispatch: (cmd: string, positional: string[]) => Promise<number>;
  /** Print the full grouped command help. */
  readonly showHelp: () => void;
  /** Whether a local bridge identity already exists (first-run vs returning). */
  readonly configured: boolean;
  /** Local view of the claim handshake. The claim URL is scrubbed from
   *  bridge.json once the platform reports the agent claimed, so "still on
   *  file" is a reliable offline signal for "not claimed yet" — no network
   *  call just to draw the panel. */
  readonly claim?: { readonly pending: boolean; readonly url?: string; readonly agentName?: string };
}

interface MenuItem {
  readonly key: string;
  readonly label: string;
  readonly run: (deps: MenuDeps) => Promise<void>;
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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
      const countRaw = (await prompt("How many matches? (default 1): ")).trim() || "1";
      if (!/^\d+$/.test(countRaw)) {
        env.stdout("Count must be a whole number.\n");
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
    label: "Daily cap — automatic matches per day (0 = off)",
    run: async ({ env, prompt, dispatch }) => {
      const n = (await prompt("Daily automatic matches (0 = off): ")).trim();
      if (!/^\d+$/.test(n)) {
        env.stdout("Enter a non-negative whole number.\n");
        return;
      }
      await dispatch("set", ["daily", n]);
    },
  },
  {
    key: "6",
    label: "Games — which games to auto-play",
    run: async ({ env, prompt, dispatch }) => {
      const list = (await prompt(`Games to auto-play, comma-separated (options: ${SUPPORTED_GAMES.join(", ")}): `)).trim();
      if (list === "") {
        env.stdout("No games entered — nothing changed.\n");
        return;
      }
      await dispatch("set", ["game", list]);
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
];

function menuText(deps: MenuDeps): string {
  const lines = [""];
  // An unclaimed agent cannot play at all, and nothing in the panel used to say
  // so — the owner finished a whole VPS setup and never saw a reminder
  // (2026-07-29). Lead with it, every time round the loop, until it is done.
  if (deps.claim?.pending === true) {
    const who = deps.claim.agentName !== undefined ? ` (${deps.claim.agentName})` : "";
    lines.push(`  ⚠ NOT CLAIMED${who} — this agent cannot play until you claim it.`);
    if (deps.claim.url !== undefined) lines.push(`    ${deps.claim.url}`);
    lines.push("");
  }
  lines.push("AIFight — what would you like to do?", "");
  for (const item of ITEMS) lines.push(`  ${item.key.padStart(2)}) ${item.label}`);
  lines.push("   q) Quit");
  lines.push("");
  return lines.join("\n");
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
    env.stdout(menuText(deps));
    const choice = (await prompt("Pick an action (number, or q to quit): ")).trim().toLowerCase();
    if (choice === "q" || choice === "quit" || choice === "0") return 0;
    if (choice === "") continue;
    const item = byKey.get(choice);
    if (item === undefined) {
      env.stdout(`Unknown choice '${choice}'.\n`);
      continue;
    }
    try {
      await item.run(deps);
    } catch (cause) {
      // A handler error (UsageError / CommandError / unexpected) must not drop
      // the panel — surface the message the same way the CLI funnel would.
      env.stdout(`aifight: ${describeError(cause)}\n`);
    }
  }
}
