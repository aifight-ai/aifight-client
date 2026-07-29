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

import { isSafeAutoUpdatePhase } from "../../bridge/auto-update";
import { getBridgeConfigPath } from "../../bridge/config";
import { BridgeServiceError, restartBridgeService, statusBridgeService } from "../../bridge/service";
import { portFilePath } from "../runtime-files";
import type { HandlerEnv } from "../shared";
import { makeClient } from "../shared";

export interface ApplySettingsOptions {
  /** Skip every prompt and print the plain hint (scripts, --json). */
  readonly jsonMode?: boolean;
  /** Ask before restarting. Default true; setup flows that already have the
   *  user's blessing for local service work pass false. */
  readonly confirm?: boolean;
  /** Test seam. Defaults to `process.stdin.isTTY === true`. */
  readonly interactive?: boolean;
  /** Test seam for the confirm prompt. Defaults to a stdin read. */
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
 * Has bridge.json changed since the running bridge read it? The port file is
 * written when the bridge comes up and removed when it stops, so its mtime is a
 * good-enough "started at". Best effort by design: a missing file just means "no
 * bridge running here", which is the safe answer.
 */
export function bridgeRestartPending(): boolean {
  try {
    const started = fs.statSync(portFilePath()).mtimeMs;
    return fs.statSync(getBridgeConfigPath()).mtimeMs > started;
  } catch {
    return false;
  }
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

  if (opts.confirm !== false) {
    const ask = opts.promptYesNo ?? ((q: string) => promptYesNoDefaultYes(env, q));
    if (!(await ask("Restart the bridge now so it takes effect? [Y/n] "))) {
      say("Left running with the previous settings — `aifight service restart` when you're ready.\n");
      return "declined";
    }
  }

  try {
    const result = await restartBridgeService(env.bridgeService);
    say(`aifight.service restarted (${result.platform}) — the new settings are live.\n`);
    return "restarted";
  } catch (cause) {
    const hint = cause instanceof BridgeServiceError ? cause.hint : undefined;
    env.stderr(`warning: aifight.service could not be restarted: ${describe(cause)}\n`);
    if (hint !== undefined) env.stderr(`${hint}\n`);
    env.stderr("The setting is saved — run `aifight service restart` once that is sorted.\n");
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

async function promptYesNoDefaultYes(env: HandlerEnv, question: string): Promise<boolean> {
  env.stdout(question);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  const answer = await new Promise<string>((resolve) => {
    process.stdin.once("data", (chunk) => resolve(String(chunk)));
  });
  process.stdin.pause();
  const normalized = answer.trim().toLowerCase();
  return normalized === "" || normalized === "y" || normalized === "yes";
}
