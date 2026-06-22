// Detect notify-worthy transitions in the live-match stream (pure, unit-tested).
// The desktop turns these into an in-app banner + an OS notification so the user
// is told when THEIR agent starts or finishes a match — even while looking at
// another view. The accumulation that feeds this lives in liveStore.ts; the
// text formatting (i18n) lives in the caller. This module is side-effect free.

import type { LiveMatchState, MatchOutcome } from "./liveMatch";

export interface MatchAlert {
  /** "start" = a new match just went live; "over" = the current match just ended. */
  readonly kind: "start" | "over";
  readonly matchId: string;
  readonly game: string;
  /** Meaningful only for kind "over"; "unknown" otherwise. */
  readonly outcome: MatchOutcome;
}

/**
 * Compare two consecutive live-match snapshots and report a notify-worthy
 * transition, or null when nothing changed worth alerting on.
 *
 * - over : same match, `finished` flips false→true (checked first so the frame
 *          that ends a match is reported as "over", never as a fresh "start").
 * - start: `sessionId` becomes non-null or changes to a different match id while
 *          not finished (covers idle→match and back-to-back matches).
 *
 * Idempotent against repeated identical snapshots (e.g. a language re-render or a
 * late game_state frame): an unchanged match yields null, so no duplicate alert.
 */
export function detectMatchAlert(prev: LiveMatchState, next: LiveMatchState): MatchAlert | null {
  if (next.sessionId !== null && next.finished && !prev.finished) {
    return { kind: "over", matchId: next.sessionId, game: next.game ?? "", outcome: next.outcome };
  }
  if (next.sessionId !== null && !next.finished && next.sessionId !== prev.sessionId) {
    return { kind: "start", matchId: next.sessionId, game: next.game ?? "", outcome: "unknown" };
  }
  return null;
}
