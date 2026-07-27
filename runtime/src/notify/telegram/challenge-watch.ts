// "Your challenge was accepted."
//
// There is no push for this: the server, on accept, goes straight to creating
// the match, and what reaches the host is an ordinary game_start with no marker
// saying it came from a challenge (game_start carries no mode). Checked in the
// server's accept path on 2026-07-27.
//
// What IS available is the token-holder's own read: GET /api/challenges/{token}
// returns the duel's status and the guest's name, unauthenticated, because
// holding the token is the access control. So a challenge created FROM THE CHAT
// is watched here — a cheap poll on a short leash — and anything created some
// other way simply isn't (its result still arrives as a normal match report).

import { fetchChallengeStatus } from "../../bridge/agent-actions";

/** Gap between checks. A human is waiting for a friend to tap a link; half a
 *  minute is responsive without being chatty. */
const POLL_INTERVAL_MS = 30_000;

/** Give up after this long. Server-side expiry is the real bound; this keeps a
 *  forgotten challenge from polling for a day. */
const MAX_WATCH_MS = 60 * 60_000;

/** At most this many outstanding challenges are watched at once. */
const MAX_WATCHES = 5;

export interface ChallengeWatcherOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly onAccepted: (info: { readonly game: string; readonly guestName?: string }) => void;
  readonly onLog?: (message: string) => void;
  readonly now?: () => number;
  /** Test seam. */
  readonly setTimer?: (fn: () => void, ms: number) => { cancel: () => void };
}

export interface ChallengeWatcher {
  /** Start watching a challenge this process just created. */
  watch(token: string, game: string): void;
  stop(): void;
}

export function createChallengeWatcher(opts: ChallengeWatcherOptions): ChallengeWatcher {
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? defaultTimer;
  const active = new Map<string, { cancel: () => void }>();
  let stopped = false;

  function schedule(token: string, game: string, deadline: number): void {
    if (stopped) return;
    const handle = setTimer(() => {
      void check(token, game, deadline);
    }, POLL_INTERVAL_MS);
    active.set(token, handle);
  }

  async function check(token: string, game: string, deadline: number): Promise<void> {
    if (stopped) return;
    active.delete(token);
    let status;
    try {
      status = await fetchChallengeStatus(opts.baseUrl, token, opts.fetchImpl ?? globalThis.fetch);
    } catch (cause) {
      // A flaky minute is not a reason to stop watching.
      opts.onLog?.(cause instanceof Error ? cause.message : String(cause));
      status = null;
    }

    if (status !== null && status.status !== "pending") {
      // Anything past "pending" means someone took it: accepted, in a match, or
      // already finished (a fast match). Expired/cancelled just stop the watch.
      if (status.status !== "expired" && status.status !== "cancelled") {
        opts.onAccepted({
          game: status.game ?? game,
          ...(status.guestAgentName !== undefined ? { guestName: status.guestAgentName } : {}),
        });
      }
      return;
    }
    if (now() >= deadline) return;
    schedule(token, game, deadline);
  }

  return {
    watch: (token, game) => {
      if (stopped || active.has(token)) return;
      if (active.size >= MAX_WATCHES) {
        opts.onLog?.("too many challenges being watched at once; not watching this one");
        return;
      }
      schedule(token, game, now() + MAX_WATCH_MS);
    },
    stop: () => {
      stopped = true;
      for (const handle of active.values()) handle.cancel();
      active.clear();
    },
  };
}

function defaultTimer(fn: () => void, ms: number): { cancel: () => void } {
  const timer = setTimeout(fn, ms);
  // Never keep the bridge process alive for a challenge poll.
  (timer as { unref?: () => void }).unref?.();
  return { cancel: () => clearTimeout(timer) };
}
