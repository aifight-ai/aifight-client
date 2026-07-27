// Supersede-abort sentinel for the decision loop (R13-F02).
//
// When a newer action_request arrives for a match that already has a decision
// in flight, the agent aborts the previous decision's AbortController with THIS
// error as the reason. The direct-LLM provider combines that controller signal
// with its own turn-deadline `AbortSignal.timeout(...)` and passes the pair to
// the adapter fetch, so a superseded decision actually CANCELS its in-flight
// (paid) HTTP call instead of running to completion and being discarded.
//
// The reason class lets every layer tell a deliberate supersede/stop cancel
// apart from a real API failure or the turn-deadline timeout: on supersede the
// decision must be discarded quietly (a fresh decision for the superseding
// request is already running), NOT self-healed, transient-retried, or fallen
// back — those would burn more of the user's tokens for a result nobody uses.

export class DecisionSupersededError extends Error {
  override readonly name = "DecisionSupersededError";
  constructor(matchId: string, kind: "superseded" | "stopped" = "superseded") {
    super(
      kind === "stopped"
        ? `decision for match ${matchId} abandoned: agent stopped`
        : `decision for match ${matchId} superseded by a newer action_request`,
    );
  }
}

/**
 * True when `signal` has fired with a DecisionSupersededError as its abort
 * reason — the deliberate supersede/stop cancel. Keying on the reason (R15
 * 2026-07-26), not on `aborted` alone, keeps the predicate meaningful for a
 * COMBINED signal (supersede signal + turn-deadline timeout): a timeout abort
 * carries a different reason and must NOT read as "discard this decision".
 */
export function isSupersededAbort(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && signal.reason instanceof DecisionSupersededError;
}
