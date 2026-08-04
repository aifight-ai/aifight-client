// Shared "this live thing is actually dead" cutoff, used by BOTH the History
// list (stored session rows) and the live Watch cockpit. A match killed
// server-side while nothing was listening (deploy restart, cancel) never sends
// game_over, so the local side stays "active"/"live" forever — the owner hit
// exactly that (2026-07-28: a deploy-cancelled match showed 进行中 all night).
// Platform rules bound a LIVE match's silence: the per-turn absolute cap is
// 10 minutes, so a genuinely running match produces traffic at least that
// often. 30 minutes with no update is therefore proof of death, not caution.

export const STALE_LIVE_SESSION_MS = 30 * 60 * 1000;

/** History rows: stored `status` + ISO `updated_at`. Fail-closed on bad data. */
export function isStaleLiveSession(status: string | undefined, updatedAtISO: string | undefined, nowMs: number): boolean {
  if (status !== "active") return false;
  if (!updatedAtISO) return true; // live with no timestamp at all → unknowable, treat as dead
  const t = new Date(updatedAtISO).getTime();
  if (Number.isNaN(t)) return true;
  return nowMs - t > STALE_LIVE_SESSION_MS;
}

/** Live store: millisecond activity stamp. Null = no activity ever recorded. */
export function isSilentPastCutoff(lastActivityAtMs: number | null, nowMs: number): boolean {
  if (lastActivityAtMs === null) return false;
  return nowMs - lastActivityAtMs > STALE_LIVE_SESSION_MS;
}
