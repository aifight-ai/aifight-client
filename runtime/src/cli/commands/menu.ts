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
import { readBridgeConfig, writeBridgeConfig } from "../../bridge/config.js";
import { resolveLocale, t, type Locale } from "../i18n.js";
import { applyPendingBridgeRestart, withDeferredApply } from "./apply-settings.js";
import { MAX_MANUAL_MATCHES } from "./bridge-start.js";
import { renderMenuFrame, type MenuFrame } from "./menu-frame.js";
import type { MenuStatusBoxProvider } from "./menu-status.js";
import type { MenuChoose } from "./menu-select.js";

export interface MenuDeps {
  readonly env: HandlerEnv;
  /** Read one line of input (main wires createOnboardIO(env).promptLine). */
  readonly prompt: (question: string) => Promise<string>;
  /** The chooser: given the freshly-built frame, resolve the key of the row
   *  the user picked ("1".."16" or "q"). main.ts wires the arrow-key chooser
   *  (menu-select.ts) — the panel only ever opens on a TTY, so that is the
   *  production path. When absent the panel falls back to printing the frame
   *  and reading a number line-by-line (today's tests, and any future host
   *  that opens the panel without raw-mode stdin). The optional second
   *  argument carries the status banner's one-shot refresh hook. */
  readonly choose?: MenuChoose;
  /** Run one CLI command by name with positional args (no flags, non-JSON). */
  readonly dispatch: (cmd: string, positional: string[]) => Promise<number>;
  /** Print the full grouped command help. */
  readonly showHelp: () => void;
  /** Whether a local bridge identity already exists (first-run vs returning). */
  readonly configured: boolean;
  /** Whether aifight.service is installed on this machine (V3 ③): resolved
   *  once when the panel opens. `false` adds one gentle yellow banner line —
   *  the bridge dies with this window otherwise. Undefined = unknown (a probe
   *  error must never nag). */
  readonly serviceInstalled?: boolean;
  /** Live read of the display locale (AIFIGHT_LANG > bridge.json > "en"),
   *  consulted at every render — the Language item flips bridge.json and the
   *  very next frame repaints in the new language. Optional: defaults to en. */
  readonly locale?: () => Locale;
  /** Live read of the pause flag (bridge.json), consulted at every render and
   *  by the Pause/Resume item itself — the label must flip right after the
   *  dispatched command rewrote the config, without rebuilding the panel.
   *  Optional so tests and non-configured hosts can omit it (= not paused). */
  readonly matchingPaused?: () => boolean;
  /** Live read of the daily cap (bridge.json autoDailyLimit) for item 6's
   *  hint. Optional; absent = "not set". */
  readonly dailyCap?: () => number | undefined;
  /** Live read of the auto-play game selection (bridge.json autoGames) for
   *  item 7's hint. Optional; absent = the supported default list. */
  readonly autoGames?: () => readonly string[];
  /** The checkbox games picker (V3, design §1): main.ts wires the raw-mode
   *  multi-select; absent in tests/chooser-less hosts → item 7 falls back to
   *  the line prompt. Resolves the new selection, null = cancelled. */
  readonly pickGames?: (current: readonly string[]) => Promise<readonly string[] | null>;
  /** Local view of the claim handshake. The claim URL is scrubbed from
   *  bridge.json once the platform reports the agent claimed, so "still on
   *  file" is a reliable offline signal for "not claimed yet" — no network
   *  call just to draw the panel. */
  readonly claim?: { readonly pending: boolean; readonly url?: string; readonly agentName?: string };
  /** The boxed status banner above the menu (3x-ui style, owner ask
   *  2026-07-30). Absent = no box (first run, or tests that don't care
   *  about the banner). The provider owns the local snapshot and the
   *  one-shot remote enrichment; the panel just re-asks it for lines on
   *  every build. */
  readonly statusBox?: MenuStatusBoxProvider;
  /** Called by the Profile item after an identity switch so the host can
   *  refresh the identity-carrying decorations (status box, claim banner) —
   *  main.ts rebuilds both from the new bridge.json. */
  readonly onIdentitySwitched?: () => void;
}

interface MenuItem {
  readonly key: string;
  /** The action word ("Play"), translated. A function of the locale AND the
   *  deps: Pause/Resume flips with the live flag, Language flips with the
   *  locale itself. */
  readonly main: (loc: Locale, deps: MenuDeps) => string;
  /** The short dim description after the main word, translated; carries live
   *  state for the cap/games/update rows. */
  readonly hint?: (loc: Locale, deps: MenuDeps) => string;
  /** Yellow instead of dim while an update is known-newer (item 13). */
  readonly hintTone?: (deps: MenuDeps) => "dim" | "yellow";
  readonly run: (deps: MenuDeps) => Promise<void>;
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Did the inline setup actually leave a usable identity behind? The abort
 *  path (a wizard quit, or a partial failure) must exit with hints instead of
 *  dropping into a panel whose every action needs an identity. */
function bridgeConfiguredNow(): boolean {
  try {
    readBridgeConfig();
    return true;
  } catch {
    return false;
  }
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
//
// V2 (2026-07-31, owner decision ① — an accepted one-time break): renumbered
// by usage frequency — playing first (Play/Pause/Status/Record), settings in
// the middle, system items last — and every row is two-tone: a cyan-bold main
// word plus a dim hint. Hints are re-evaluated on every build, so the ones
// carrying live state (Pause/Resume, the cap, the games count, the update
// nudge) flip on the repaint right after the underlying value changed.
// i18n (same day): every label goes through t(locale, …); item 15 (Language)
// flips bridge.json and the next frame repaints in the new language.
// V3 (2026-07-31, owner decision ②): the FINAL 17-row layout — Profile
// (identity manage) inserted at 9, Rename→16 shifting one down; 1-8 left,
// 9-16 + Quit right. V2 never shipped, so the renumber costs nothing.

/** The locale for this render — re-read on every build (AIFIGHT_LANG >
 *  bridge.json > "en"), so the Language toggle repaints immediately. */
function localeOf(deps: MenuDeps): Locale {
  return deps.locale?.() ?? "en";
}

const ITEMS: readonly MenuItem[] = [
  {
    key: "1",
    main: (loc) => t(loc, "menu.item.play.main"),
    hint: (loc) => t(loc, "menu.item.play.hint"),
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
    // The CLI twin of the desktop app's pause switch. The main word AND the
    // dispatched command both follow the live flag, so the item flips to
    // "Resume" on the repaint right after pausing.
    key: "2",
    main: (loc, deps) =>
      t(loc, deps.matchingPaused?.() === true ? "menu.item.resume.main" : "menu.item.pause.main"),
    hint: (loc, deps) =>
      t(loc, deps.matchingPaused?.() === true ? "menu.item.resume.hint" : "menu.item.pause.hint"),
    run: (deps) =>
      deps.dispatch(deps.matchingPaused?.() === true ? "resume" : "pause", []).then(() => undefined),
  },
  {
    key: "3",
    main: (loc) => t(loc, "menu.item.status.main"),
    hint: (loc) => t(loc, "menu.item.status.hint"),
    run: ({ dispatch }) => dispatch("status", []).then(() => undefined),
  },
  {
    key: "4",
    main: (loc) => t(loc, "menu.item.record.main"),
    hint: (loc) => t(loc, "menu.item.record.hint"),
    run: ({ dispatch }) => dispatch("record", []).then(() => undefined),
  },
  {
    key: "5",
    // `config llm`, not bare `config`: bare config opens its own hub, so this
    // used to drop the user into a SECOND menu one level down — which is the
    // "why are there two different menus" the owner ran into (2026-07-29).
    main: (loc) => t(loc, "menu.item.llm.main"),
    hint: (loc) => t(loc, "menu.item.llm.hint"),
    run: ({ dispatch }) => dispatch("config", ["llm"]).then(() => undefined),
  },
  {
    key: "6",
    // The daily item delegates to the prompt the old `aifight config` hub
    // used: it shows the CURRENT value, treats a blank answer as "keep it",
    // and validates against the setup wizard's ceiling (V3: re-asking after
    // an invalid one instead of exiting). Merging the menus meant picking one
    // of each pair, and this is the better half.
    main: (loc) => t(loc, "menu.item.daily.main"),
    hint: (loc, deps) => {
      const cap = deps.dailyCap?.();
      return cap === undefined
        ? t(loc, "menu.item.daily.hint.unset")
        : cap === 0
          ? t(loc, "menu.item.daily.hint.off")
          : t(loc, "menu.item.daily.hint.cap", { cap });
    },
    run: async ({ env, prompt }) => {
      const { configureDailyInteractive } = await import("./config.js");
      await configureDailyInteractive({ promptLine: prompt }, env);
    },
  },
  {
    key: "7",
    main: (loc) => t(loc, "menu.item.games.main"),
    hint: (loc, deps) =>
      t(loc, "menu.item.games.hint", { count: (deps.autoGames?.() ?? SUPPORTED_GAMES).length }),
    run: async (deps) => {
      // The checkbox picker (V3): rows are platform-given so nothing can be
      // misspelled. The picked list dispatches through `set game`, which owns
      // validation + the write. Chooser-less hosts keep the line prompt.
      if (deps.pickGames !== undefined) {
        const picked = await deps.pickGames([...(deps.autoGames?.() ?? SUPPORTED_GAMES)]);
        if (picked === null) return; // cancelled — the picker said nothing changed
        if (picked.length === 0) return; // the picker's own guard re-asks instead
        await deps.dispatch("set", ["game", picked.join(",")]);
        return;
      }
      const { configureGamesInteractive } = await import("./config.js");
      await configureGamesInteractive({ promptLine: deps.prompt }, deps.env);
    },
  },
  {
    key: "8",
    main: (loc) => t(loc, "menu.item.strategy.main"),
    hint: (loc) => t(loc, "menu.item.strategy.hint"),
    run: ({ dispatch }) => dispatch("strategy", ["path"]).then(() => undefined),
  },
  {
    // Profile Manage (V3 ④): multiple agent identities on this machine, one
    // active. The submenu lives in profile-menu.ts; after a switch the panel's
    // identity-carrying decorations refresh via onIdentitySwitched.
    key: "9",
    main: (loc) => t(loc, "menu.item.profile.main"),
    hint: (loc) => t(loc, "menu.item.profile.hint"),
    run: async (deps) => {
      const { runProfileMenu } = await import("./profile-menu.js");
      await runProfileMenu({
        env: deps.env,
        locale: () => localeOf(deps),
        prompt: deps.prompt,
        ...(deps.choose !== undefined ? { choose: deps.choose } : {}),
        ...(deps.onIdentitySwitched !== undefined ? { onIdentitySwitched: deps.onIdentitySwitched } : {}),
      });
    },
  },
  {
    key: "10",
    main: (loc) => t(loc, "menu.item.rename.main"),
    hint: (loc) => t(loc, "menu.item.rename.hint"),
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
    // Not "0" — that is the quit key.
    key: "11",
    main: (loc) => t(loc, "menu.item.telegram.main"),
    hint: (loc) => t(loc, "menu.item.telegram.hint"),
    run: ({ dispatch }) => dispatch("telegram", []).then(() => undefined),
  },
  {
    key: "12",
    main: (loc) => t(loc, "menu.item.claim.main"),
    hint: (loc) => t(loc, "menu.item.claim.hint"),
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
    key: "13",
    main: (loc) => t(loc, "menu.item.update.main"),
    // Yellow with the version only while the banner's update check has landed
    // a known-newer release; a quiet dim "check & update" otherwise.
    hint: (loc, deps) => {
      const newer = deps.statusBox?.updateVersion?.();
      return newer !== undefined
        ? t(loc, "menu.item.update.hint.newer", { version: newer })
        : t(loc, "menu.item.update.hint");
    },
    hintTone: (deps) => (deps.statusBox?.updateVersion?.() !== undefined ? "yellow" : "dim"),
    run: ({ dispatch }) => dispatch("update", []).then(() => undefined),
  },
  {
    // Carried over from the old `aifight config` hub, which is now this panel.
    key: "14",
    main: (loc) => t(loc, "menu.item.config.main"),
    hint: (loc) => t(loc, "menu.item.config.hint"),
    run: ({ dispatch }) => dispatch("config", ["show"]).then(() => undefined),
  },
  {
    // The display-language toggle (owner ask 2026-07-31). Local-only like
    // Claim: flips bridge.json's locale field and the VERY NEXT frame
    // repaints fully translated — localeOf re-reads on every build. The
    // bridge never reads locale, so the write preserves the file mtime and
    // no restart offer fires on the way out. The confirmation prints in the
    // NEW language, same as `aifight set language`.
    key: "15",
    main: (loc) => t(loc, "menu.item.language.main"),
    hint: (loc) => t(loc, "menu.item.language.hint"),
    run: async (deps) => {
      const next: Locale = localeOf(deps) === "zh" ? "en" : "zh";
      try {
        const config = readBridgeConfig();
        writeBridgeConfig(
          { ...config, locale: next, updatedAt: new Date().toISOString() },
          { preserveMtime: true },
        );
      } catch {
        // The panel only opens when configured; a config that vanished
        // mid-session just loses persistence.
      }
      deps.env.stdout(`${t(next, "set.language.ok")}\n`);
    },
  },
  {
    key: "16",
    main: (loc) => t(loc, "menu.item.help.main"),
    hint: (loc) => t(loc, "menu.item.help.hint"),
    run: async ({ showHelp }) => {
      showHelp();
    },
  },
];

function buildFrame(deps: MenuDeps): MenuFrame {
  const loc = localeOf(deps);
  const banner: string[] = [];
  // An unclaimed agent cannot play at all, and nothing in the panel used to say
  // so — the owner finished a whole VPS setup and never saw a reminder
  // (2026-07-29). Lead with it, every time round the loop, until it is done.
  if (deps.claim?.pending === true) {
    const who = deps.claim.agentName !== undefined ? ` (${deps.claim.agentName})` : "";
    banner.push(t(loc, "menu.banner.unclaimed", { who }));
    if (deps.claim.url !== undefined) banner.push(deps.claim.url);
  }
  // V3 ③: configured but no aifight.service — the bridge dies with this
  // window. One gentle yellow line under the box, every repaint, no nag
  // dialogs (owner decision ③).
  if (deps.serviceInstalled === false) {
    banner.push(t(loc, "menu.banner.no_service"));
  }
  return {
    title: t(loc, "menu.title"),
    banner,
    choices: [
      // Main words and hints are re-evaluated on every build: item 2's wording
      // follows the live pause flag, the cap/games hints follow bridge.json,
      // and item 13's yellow nudge appears the moment the update check lands —
      // the frame built right after any of those changed must already say so.
      ...ITEMS.map((item) => ({
        key: item.key,
        main: item.main(loc, deps),
        ...(item.hint !== undefined ? { hint: item.hint(loc, deps) } : {}),
        ...(item.hintTone !== undefined ? { hintTone: item.hintTone(deps) } : {}),
      })),
      // A selectable Quit row, so pure arrow-key usage can exit too.
      { key: "q", main: t(loc, "menu.item.quit") },
    ],
    // The status box re-composes from the provider's live data on every
    // build: the first build is local-only, the one the chooser's refresh
    // hook triggers right after carries the remote answers.
    ...(deps.statusBox !== undefined
      ? { statusBox: { title: deps.statusBox.title, lines: deps.statusBox.lines(loc) } }
      : {}),
  };
}

/** The chooser-less presentation: print the frame once, read a number. Only
 *  reachable when the panel was opened without a wired chooser — main.ts
 *  gates the panel to TTYs and always wires the arrow-key one, so in
 *  practice this path lives in tests. */
async function lineChoice(deps: MenuDeps, frame: MenuFrame): Promise<string> {
  deps.env.stdout(`\n${renderMenuFrame(frame, -1, createAnsi({ enabled: false })).join("\n")}\n\n`);
  return (await deps.prompt(t(localeOf(deps), "menu.pick"))).trim().toLowerCase();
}

/**
 * Run the interactive control panel until the user quits. Returns an exit code
 * (always 0 for a normal quit; a dispatched command's own errors are caught,
 * shown, and the loop continues so one failed action never drops the panel).
 */
export async function runInteractiveMenu(deps: MenuDeps): Promise<number> {
  const { env, dispatch, configured } = deps;

  // First run on this machine (V3 ③, owner decision): no more "want to run
  // setup?" gate — bare `aifight` goes straight through the EXISTING guided
  // setup and lands in the full panel on success. An abort (or a failure that
  // left no identity) exits with the next-step hints instead. The wizard's own
  // inner strings stay English in V1 (the established i18n boundary); only the
  // orchestration lines around it are translated.
  if (!configured) {
    const loc = localeOf(deps);
    env.stdout(`\n${t(loc, "menu.firstrun.intro")}\n\n`);
    const code = await dispatch("setup", []);
    if (code !== 0 || !bridgeConfiguredNow()) {
      env.stdout(`\n${t(loc, "menu.firstrun.aborted")}\n`);
      return code;
    }
    env.stdout(`\n${t(loc, "menu.firstrun.done")}\n`);
    // Fall through into the panel loop with the identity just created. (The
    // status box and claim banner were resolved before the panel opened, so
    // they debut on the NEXT bare `aifight`; the wizard already printed the
    // claim URL twice.)
  }

  const byKey = new Map(ITEMS.map((i) => [i.key, i]));
  for (;;) {
    const frame = buildFrame(deps);
    let choice: string;
    if (deps.choose !== undefined) {
      // While the status banner's one-shot remote refresh is still in flight,
      // hand the chooser a hook so it can repaint the box the moment the
      // answers land — the first paint never waits on the network.
      const refreshWhen = deps.statusBox?.refreshed?.();
      choice = (await deps.choose(
        frame,
        {
          locale: localeOf(deps),
          ...(refreshWhen !== undefined ? { refreshWhen, getFrame: () => buildFrame(deps) } : {}),
        },
      )).trim().toLowerCase();
    } else {
      choice = await lineChoice(deps, frame);
    }
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
