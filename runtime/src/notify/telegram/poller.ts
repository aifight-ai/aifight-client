// getUpdates long-poll loop.
//
// Outbound-only by construction: this machine asks Telegram "anything new?"
// and holds the connection open for up to 50 s. No inbound port, no public
// hostname, no webhook — the same shape as the bridge's own connection, so it
// works from a laptop behind NAT and from a VPS alike.
//
// The loop owns exactly one piece of state: the update offset. It lives in
// memory only — a restart re-reads at most the backlog, and re-delivery is
// absorbed upstream by idempotent commands and one-shot nonces, which is a far
// better trade than another file to keep consistent on disk.

import { TelegramApiError, type TelegramApi, type TelegramUpdate } from "./api";

/** Telegram's own ceiling for a long poll is 50 s. */
const DEFAULT_LONG_POLL_SECONDS = 50;

const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

/** Floor between two EMPTY polls. A healthy long poll blocks for up to 50 s, so
 *  this never fires in normal operation — it exists because a proxy (or a
 *  Telegram edge having a bad day) that answers `{ok:true,result:[]}` instantly
 *  would otherwise turn this loop into a hot spin: 100% of a core, and, because
 *  every iteration only awaits already-resolved promises, timers in the same
 *  process would never get a turn. */
const MIN_EMPTY_POLL_GAP_MS = 500;

export interface TelegramPollerLog {
  readonly code: string;
  readonly message: string;
  readonly level: "info" | "warning" | "error";
}

export interface TelegramPollerOptions {
  readonly api: TelegramApi;
  /** Handled one at a time, in order. Throwing is contained, not fatal. */
  readonly onUpdate: (update: TelegramUpdate) => void | Promise<void>;
  readonly onLog?: (event: TelegramPollerLog) => void;
  /** The token stopped working; the loop has already given up when this runs. */
  readonly onAuthFailure?: (message: string) => void;
  readonly longPollSeconds?: number;
  /** Ignore everything queued before startup (default true). Telegram keeps
   *  updates for 24 h, and replaying yesterday's button taps after a restart
   *  would be surprising at best. */
  readonly dropBacklog?: boolean;
  /** Test seam: an abortable sleep. */
  readonly sleepFn?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Longest stop() waits for the loop to unwind before leaving it behind.
 *
 *  The loop handles one update at a time and awaits the handler, so a handler
 *  stuck on the network would otherwise hold shutdown for as long as it is
 *  stuck. Every handler action has its own timeout now; this is the backstop
 *  that keeps the promise made in bridge-run — a wedged Telegram can never keep
 *  the bridge from stopping. */
const STOP_BUDGET_MS = 2_000;

export interface TelegramPollerHandle {
  /** Abort the in-flight poll and wait (briefly) for the loop to unwind. */
  stop(): Promise<void>;
  /** Resolves when the loop has exited (stopped, or gave up on a dead token). */
  readonly done: Promise<void>;
}

export function startTelegramPoller(opts: TelegramPollerOptions): TelegramPollerHandle {
  const controller = new AbortController();
  const sleep = opts.sleepFn ?? abortableSleep;
  const longPollSeconds = opts.longPollSeconds ?? DEFAULT_LONG_POLL_SECONDS;
  const log = (level: TelegramPollerLog["level"], code: string, message: string): void => {
    opts.onLog?.({ code, message, level });
  };

  const done = (async () => {
    let offset: number | undefined;

    if (opts.dropBacklog !== false) {
      try {
        // offset:-1 returns just the newest queued update; confirming past it
        // discards the rest.
        const latest = await opts.api.getUpdates({ offset: -1, timeoutSec: 0, signal: controller.signal });
        const last = latest.at(-1);
        if (last !== undefined) offset = last.update_id + 1;
      } catch (cause) {
        // Not fatal: the worst case is replaying a stale message once.
        if (isAuthFailure(cause)) {
          reportAuthFailure(cause);
          return;
        }
        log("warning", "telegram.backlog_skip_failed", describe(cause));
      }
    }

    let backoffMs = BACKOFF_START_MS;
    while (!controller.signal.aborted) {
      let updates: TelegramUpdate[];
      const startedAt = Date.now();
      try {
        updates = await opts.api.getUpdates({
          ...(offset !== undefined ? { offset } : {}),
          timeoutSec: longPollSeconds,
          signal: controller.signal,
        });
        backoffMs = BACKOFF_START_MS; // a good answer clears the penalty box
      } catch (cause) {
        if (controller.signal.aborted) break;
        if (isAuthFailure(cause)) {
          reportAuthFailure(cause);
          return;
        }
        const retryAfter = cause instanceof TelegramApiError ? cause.retryAfterMs : undefined;
        const waitMs = retryAfter ?? backoffMs;
        log(
          "warning",
          "telegram.poll_failed",
          `${describe(cause)}; retrying in ${Math.round(waitMs / 1000)}s`,
        );
        await sleep(waitMs, controller.signal);
        if (retryAfter === undefined) backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
        continue;
      }

      if (updates.length === 0) {
        const elapsed = Date.now() - startedAt;
        if (elapsed < MIN_EMPTY_POLL_GAP_MS) await sleep(MIN_EMPTY_POLL_GAP_MS - elapsed, controller.signal);
        continue;
      }

      for (const update of updates) {
        // Advance BEFORE handling: a handler that throws must not make Telegram
        // redeliver the same update forever.
        offset = Math.max(offset ?? 0, update.update_id + 1);
        if (controller.signal.aborted) break;
        try {
          await opts.onUpdate(update);
        } catch (cause) {
          log("warning", "telegram.update_handler_failed", describe(cause));
        }
      }
    }
  })();

  function reportAuthFailure(cause: unknown): void {
    const message = describe(cause);
    log("error", "telegram.auth_failed", `Telegram rejected the bot token (${message}); notifications are off until you run \`aifight telegram setup\` again`);
    opts.onAuthFailure?.(message);
  }

  return {
    done,
    stop: async () => {
      controller.abort();
      await Promise.race([done.catch(() => undefined), unrefSleep(STOP_BUDGET_MS)]);
    },
  };
}

function isAuthFailure(cause: unknown): boolean {
  return cause instanceof TelegramApiError && cause.kind === "auth";
}

/** Never includes a request URL — see the note at the top of api.ts. */
function describe(cause: unknown): string {
  if (cause instanceof TelegramApiError) return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}

/** A plain delay that can never be the reason the process stays alive. */
function unrefSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}
