// "You changed a setting — now make it real."
//
// The bridge reads bridge.json once, at startup, and does not watch the file. So
// every command that edits a setting used to end with a line telling the user to
// go run `aifight service restart` themselves. Owner hit this on a fresh VPS
// (2026-07-29): changed Telegram settings from the menu, was told three separate
// times that a restart was needed, and had to drop out to the shell to type it.
//
// This module turns that hint into an action. On a terminal, with the service
// installed and running and no match in progress, it just asks and restarts.
// Everywhere else — scripts, --json, no service, mid-match — it degrades to
// exactly the message that was printed before, so nothing scripted changes and a
// restart never silently costs someone a live match.

import fs from "node:fs";
import path from "node:path";

import { isSafeAutoUpdatePhase } from "../../bridge/auto-update";
import { getBridgeConfigPath } from "../../bridge/config";
import { BridgeServiceError, restartBridgeService, statusBridgeService } from "../../bridge/service";
import { getAgentsRoot } from "../../store/paths";
import { createStatusIcons } from "../ansi";
import { resolveLocale, t } from "../i18n";
import { createOutput } from "../output";
import { portFilePath } from "../runtime-files";
import type { HandlerEnv } from "../shared";
import { makeClient } from "../shared";
import { promptYesNo } from "./onboard-io";

export interface ApplySettingsOptions {
  /** Skip every prompt and print the plain hint (scripts, --json). */
  readonly jsonMode?: boolean;
  /** Ask before restarting. Default true; setup flows that already have the
   *  user's blessing for local service work pass false. */
  readonly confirm?: boolean;
  /** Test seam. Defaults to `process.stdin.isTTY === true`. */
  readonly interactive?: boolean;
  /** Test seam for the confirm prompt. Defaults to P4 (onboard-io's
   *  promptYesNo, default yes). The question arrives WITHOUT the `[Y/n]`
   *  bracket — P4 appends that itself. */
  readonly promptYesNo?: (question: string) => Promise<boolean>;
}

export type ApplyOutcome =
  | "not_needed" // nothing changed since the bridge started
  | "restarted"
  | "declined"
  | "deferred" // inside withDeferredApply — the menu will offer once at the end
  | "match_in_progress"
  | "not_running" // no service, or installed but stopped — the hint is enough
  | "failed";

// Menus call several writing handlers in one sitting, and each one ends with an
// offer to restart. Left alone that reproduces the exact complaint this module
// exists to fix — the owner was told three separate times in one pass through
// the Telegram menu. So a menu wraps each action in withDeferredApply() and
// makes ONE offer when the user is done.
let deferDepth = 0;

export async function withDeferredApply<T>(fn: () => Promise<T>): Promise<T> {
  deferDepth += 1;
  try {
    return await fn();
  } finally {
    deferDepth -= 1;
  }
}

/**
 * Has a setting a RUNNING bridge only reads at startup changed since it
 * started? The port file is written when the bridge comes up and removed when
 * it stops, so its mtime is a good-enough "started at".
 *
 * Two sources (V3 重启精确化):
 *   1. bridge.json newer than the start — but ONLY the genuinely
 *      restart-needed writes still bump its mtime (rename, telegram, identity
 *      switch, hand edits); the connect-edge settings (pause, daily cap,
 *      games) and the display-only ones (locale, declared model) write with
 *      preserveMtime precisely so they stop landing here.
 *   2. any agents/<slug>/config.json newer than the start — the LLM
 *      profile/model/key/routing config, which the bridge reads once at
 *      startup. This is the one class the restart offer exists for now, and
 *      the mtime scan catches edits from ANY writer (this CLI, the desktop
 *      app, a hand edit), not just in-process ones.
 *
 * Best effort by design: a missing file just means "no bridge running here",
 * which is the safe answer.
 */
export function bridgeRestartPending(): boolean {
  let started: number;
  try {
    started = fs.statSync(portFilePath()).mtimeMs;
  } catch {
    return false; // no port file = no bridge running = nothing can be pending
  }
  try {
    if (fs.statSync(getBridgeConfigPath()).mtimeMs > started) return true;
  } catch {
    // No readable bridge.json — fall through to the LLM scan.
  }
  return llmConfigChangedSince(started);
}

/** Any agent profile's config.json newer than `startedMs`? Best effort: a
 *  missing agents root (or a profile without config.json) is just "no LLM
 *  change". */
function llmConfigChangedSince(startedMs: number): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(getAgentsRoot(), { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      if (fs.statSync(path.join(getAgentsRoot(), entry.name, "config.json")).mtimeMs > startedMs) {
        return true;
      }
    } catch {
      // No config.json in this one — not an LLM change.
    }
  }
  return false;
}

/**
 * Offer — and on a yes, perform — the restart that makes a just-saved setting
 * take effect. Safe to call unconditionally after any bridge.json write: it
 * returns "not_needed" when there is nothing to apply.
 */
export async function applyPendingBridgeRestart(
  env: HandlerEnv,
  opts: ApplySettingsOptions = {},
): Promise<ApplyOutcome> {
  if (deferDepth > 0) return "deferred";
  if (!bridgeRestartPending()) return "not_needed";

  const interactive = opts.interactive ?? process.stdin.isTTY === true;
  const say = (line: string) => {
    if (opts.jsonMode !== true) env.stdout(line);
  };

  // No service, or one that is not running: the user drives `aifight run`
  // themselves, so there is nothing here to restart for them.
  const status = await serviceStatus(env);
  if (status?.installed !== true || status.running !== true) {
    say("Saved. The bridge picks this up the next time it starts.\n");
    return "not_running";
  }

  if (opts.jsonMode === true || !interactive) {
    say("Saved — run `aifight service restart` to apply it to the running bridge.\n");
    return "declined";
  }

  // A restart drops the WebSocket mid-hand: the agent misses its turn and can
  // lose on time. A settings tweak is never worth that.
  const busy = await matchInProgressPhase(env);
  if (busy !== null) {
    say(`Saved. A match is in progress (${busy}), so the bridge was left alone —\n`);
    say("run `aifight service restart` once it finishes.\n");
    return "match_in_progress";
  }

  // P4 (统一交互规范 §2, 批 U4): the one yes/no primitive. The bracket suffix
  // belongs to promptYesNo, so the question — and its i18n entry — carries none.
  const loc = env.locale?.() ?? resolveLocale();
  if (opts.confirm !== false) {
    const ask = opts.promptYesNo ?? ((q: string) => promptYesNo(env, q, true));
    if (!(await ask(t(loc, "confirm.restart.ask")))) {
      say(`${t(loc, "confirm.restart.declined")}\n`);
      return "declined";
    }
  }

  try {
    const result = await restartBridgeService(env.bridgeService);
    const ok = (env.statusIcons ?? createStatusIcons()).ok;
    say(`${ok} ${t(loc, "confirm.restart.ok", { platform: result.platform })}\n`);
    return "restarted";
  } catch (cause) {
    // P6: `✗ message` in red, the fix hint plain underneath. Stays on stderr —
    // a script tailing stderr for this failure must keep seeing it there.
    const hint = cause instanceof BridgeServiceError ? cause.hint : undefined;
    env.stderr(createOutput().fail(t(loc, "confirm.restart.failed", { error: describe(cause) }), hint));
    env.stderr(`${t(loc, "confirm.restart.failed.tail")}\n`);
    return "failed";
  }
}

async function serviceStatus(env: HandlerEnv) {
  try {
    return await statusBridgeService(env.bridgeService);
  } catch {
    return undefined;
  }
}

/** Mirrors bridge-update's probe: any failure means "nothing to protect" — no
 *  bridge is listening, so a restart cannot interrupt a match of ours. */
async function matchInProgressPhase(env: HandlerEnv): Promise<string | null> {
  try {
    const body = await makeClient(env).get<{
      readonly agents?: ReadonlyArray<{ readonly state?: { readonly phase?: unknown } | null }>;
    }>("/v1/agents");
    for (const agent of body.agents ?? []) {
      const phase = agent?.state?.phase;
      if (typeof phase === "string" && !isSafeAutoUpdatePhase(phase)) return phase;
    }
  } catch {
    // See above.
  }
  return null;
}

function describe(cause: unknown): string {
  const stderr = (cause as { stderr?: unknown } | undefined)?.stderr;
  if (typeof stderr === "string" && stderr.trim() !== "") return stderr.trim().split("\n")[0]!;
  return cause instanceof Error ? cause.message : String(cause);
}
