// Cross-view handoff: the dashboard's recent-matches rows ask the Watch tab to
// open one specific past session as a replay (owner ruling, 2026-07-02:
// clicking a match means "show me the details", not "go find it in History").
// A single-shot module-level slot — same lifetime trick as liveStore, but
// consumed on first read — survives the tab unmount/remount without a router
// or new IPC. WatchView consumes it on mount; anything unconsumed is simply
// replaced by the next click.

export interface WatchReplayIntent {
  /** Local session id (`aifight sessions export` selector). */
  readonly sessionId: string;
  /** Game engine name — drives the demo-platform fixture fallback. */
  readonly game?: string;
  /** Row context re-shown in the replay header. */
  readonly resultLabel?: string;
  /** Server replay page (absolute URL), when the session recorded one. */
  readonly replayUrl?: string;
}

let pending: WatchReplayIntent | null = null;

export function setWatchReplayIntent(intent: WatchReplayIntent): void {
  pending = intent;
}

/** Read-and-clear: the intent fires exactly once. */
export function consumeWatchReplayIntent(): WatchReplayIntent | null {
  const v = pending;
  pending = null;
  return v;
}
