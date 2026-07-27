// One-time pairing: the same mental model as `aifight connect <PAIRING_CODE>`,
// pointed the other way. The CLI prints a six-digit code, the user sends it to
// their own bot from their phone, and whichever chat says it first becomes the
// single chat this companion will ever talk to.
//
// Everything that arrives while waiting is discarded except the code itself,
// and nothing is answered — a stranger who guessed the bot's name learns
// nothing from silence.

import { randomInt } from "node:crypto";

import { TelegramApiError, type TelegramApi } from "./api";

/** Long enough to walk to your phone, short enough that a printed code left on
 *  a screen is not a standing invitation. */
export const PAIRING_CODE_TTL_MS = 10 * 60_000;

/** Each poll's long-poll window while pairing. Shorter than the companion's 50 s
 *  so the deadline is honoured promptly. */
const PAIRING_POLL_SECONDS = 20;

/** How many wrong codes may arrive before pairing gives up.
 *
 *  A six-digit code has 900,000 values, so ten guesses is a rounding error
 *  against it — but the budget has to be spent per CANDIDATE, not per message:
 *  Telegram allows 4096 characters in one message, which is room for ~585
 *  standalone six-digit numbers. Counting messages would let a stranger who
 *  knows the bot's @name sweep the whole code space inside the ten-minute
 *  window and become the one chat that owns this bridge. */
const PAIRING_MAX_GUESSES = 10;

/** Wait between failed polls: without one, a fast failure (no network, or the
 *  409 that Telegram returns when the bridge's own poller already holds this
 *  bot) turns the wait into a hot loop that burns a core and floods stderr for
 *  the full ten minutes. Same reasoning as poller.ts, which had it first. */
const PAIRING_BACKOFF_START_MS = 1_000;
const PAIRING_BACKOFF_MAX_MS = 15_000;

/** Floor between two empty polls, for the same reason poller.ts has one: a
 *  proxy that answers instantly must not spin the loop. */
const MIN_EMPTY_POLL_GAP_MS = 500;

export function generatePairingCode(): string {
  return String(randomInt(100_000, 1_000_000));
}

export type PairingOutcome =
  | { readonly status: "paired"; readonly chatId: number; readonly lastUpdateId: number }
  | { readonly status: "timeout" }
  /** Wrong codes kept arriving: someone else is guessing. */
  | { readonly status: "abandoned" }
  /** Telegram says another getUpdates already holds this bot — almost always
   *  this machine's own bridge, still running. Retrying cannot win that race. */
  | { readonly status: "conflict"; readonly message: string };

export interface WaitForPairingOptions {
  readonly api: TelegramApi;
  readonly code: string;
  /** Absolute epoch-ms deadline. */
  readonly deadline: number;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly onLog?: (message: string) => void;
  /** Test seam: an abortable sleep. */
  readonly sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Poll until some private chat sends the pairing code, or the deadline passes.
 * Network errors are retried until the deadline — a flaky first minute should
 * not force the user to start over.
 */
export async function waitForPairingCode(opts: WaitForPairingOptions): Promise<PairingOutcome> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleepFn ?? abortableSleep;
  let offset: number | undefined;
  let lastUpdateId = 0;
  let backoffMs = PAIRING_BACKOFF_START_MS;
  let guesses = 0;

  while (now() < opts.deadline) {
    const remainingSec = Math.ceil((opts.deadline - now()) / 1000);
    const windowSec = Math.max(1, Math.min(PAIRING_POLL_SECONDS, remainingSec));

    let updates;
    const startedAt = now();
    try {
      updates = await opts.api.getUpdates({
        ...(offset !== undefined ? { offset } : {}),
        timeoutSec: windowSec,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
      backoffMs = PAIRING_BACKOFF_START_MS; // a good answer clears the penalty box
    } catch (cause) {
      if (opts.signal?.aborted === true) return { status: "timeout" };
      // Auth failures are the caller's to classify (it holds the token); rethrow
      // rather than burning the whole window on a token that will never work.
      if (isAuthFailure(cause)) throw cause;
      // Two pollers on one bot is a state to report, not to retry: Telegram
      // hands the updates to whichever one asked, so the code could land in the
      // bridge's chat panel while this loop waits out the whole window.
      if (isConflict(cause)) return { status: "conflict", message: describe(cause) };
      const retryAfter = cause instanceof TelegramApiError ? cause.retryAfterMs : undefined;
      const waitMs = Math.max(0, Math.min(retryAfter ?? backoffMs, opts.deadline - now()));
      opts.onLog?.(`${describe(cause)}; retrying in ${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs, opts.signal);
      if (retryAfter === undefined) backoffMs = Math.min(backoffMs * 2, PAIRING_BACKOFF_MAX_MS);
      continue;
    }

    for (const update of updates) {
      lastUpdateId = Math.max(lastUpdateId, update.update_id);
      offset = update.update_id + 1;
      const message = update.message;
      if (message === undefined) continue;
      // Group chats are out of scope by design (§9): one bot, one person.
      if (message.chat.type !== undefined && message.chat.type !== "private") continue;
      if (message.text === undefined) continue;
      const candidates = standaloneRuns(message.text, opts.code.length);
      if (candidates.includes(opts.code)) {
        return { status: "paired", chatId: message.chat.id, lastUpdateId };
      }
      // Every number of the right shape is one guess, however many share a
      // message — see PAIRING_MAX_GUESSES.
      guesses += candidates.length;
      if (guesses >= PAIRING_MAX_GUESSES) return { status: "abandoned" };
    }

    if (updates.length === 0) {
      const elapsed = now() - startedAt;
      if (elapsed < MIN_EMPTY_POLL_GAP_MS) await sleep(MIN_EMPTY_POLL_GAP_MS - elapsed, opts.signal);
    }
  }
  return { status: "timeout" };
}

/** True when the message carries the code as a standalone number — so "123456"
 *  and "/start 123456" both pair, while a longer number that merely contains
 *  those digits does not. */
export function containsPairingCode(text: string, code: string): boolean {
  return standaloneRuns(text, code.length).includes(code);
}

/** Every run of exactly `length` digits that is not part of a longer number. */
function standaloneRuns(text: string, length: number): string[] {
  return text.split(/\D+/).filter((run) => run.length === length);
}

function isConflict(cause: unknown): boolean {
  return cause instanceof TelegramApiError && cause.status === 409;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
  });
}

function isAuthFailure(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as { kind?: string }).kind === "auth";
}
