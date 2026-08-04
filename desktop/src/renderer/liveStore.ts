// A single, always-on subscription to the bridge's live streams, folded into the
// match model ONCE at module scope. Lifting accumulation out of WatchView fixes a
// real bug: if a match starts while the user is on another view, the cockpit's
// own reducer (mounted only with that view) would miss the opening game_start and
// render a half-built board. The store keeps folding regardless of which view is
// mounted, so 观战 always shows the match from frame 1, and App-level banners /
// notifications can react to lifecycle transitions.
//
// 🔒 Information-hiding is inherited verbatim from liveMatch.ts — this store only
// re-hosts that reducer; it never surfaces anything the reducer wouldn't. The
// post-game tail fetch adds ONLY the finished match's public replay frames.

import { useEffect, useState } from "react";

import {
  appendFinalEvents,
  emptyLiveMatch,
  injectFinalAction,
  mergePolledEvents,
  reduceServerMessage,
  type LiveMatchState,
} from "./liveMatch";
import type { AifightBridgeApi, BridgeDecisionTrace } from "../shared/ipc";

/**
 * A trace as the store hands it to views: the bridge's frame plus the board
 * step it belongs to. `step` is the event count at arrival — the bridge's
 * stdout is a FIFO, so the action_request (whose new_events advance the board)
 * always lands before the decision traces it provoked, making "events so far"
 * exactly the board position the decision was taken at. `at` is the arrival
 * wall-clock (ms), used by the F4 "thinking" placeholder's elapsed counter.
 */
export type StampedTrace = BridgeDecisionTrace & { readonly step?: number; readonly at?: number };

export interface LiveStoreState {
  readonly match: LiveMatchState;
  readonly traces: readonly StampedTrace[];
  /**
   * Wall-clock (ms) of the last APPLIED server frame or trace for the current
   * session — the live cockpit's liveness signal. A match killed server-side
   * (deploy restart / cancel) never sends game_over; this stamp is what lets
   * the Watch view declare it interrupted instead of showing LIVE forever.
   */
  readonly lastActivityAt: number | null;
}

let state: LiveStoreState = { match: emptyLiveMatch(), traces: [], lastActivityAt: null };
const listeners = new Set<() => void>();
let started = false;
/** Session whose finished-match tail fetch has been launched (once per match). */
let tailFetchedFor: string | null = null;

function emit(): void {
  for (const l of listeners) l();
}

/**
 * After game_over, pull the finished match's PUBLIC replay frames and append
 * the closing stretch the bridge never received (opponents' final actions,
 * showdown, result) — without this the board freezes mid-hand on "opponent
 * thinking…". Retries a few times because the replay row is written at
 * settlement, effectively concurrent with game_over's broadcast.
 */
function fetchFinalTail(bridge: AifightBridgeApi, sessionId: string, replayPath: string): void {
  if (typeof bridge.getReplayTail !== "function") return; // older preload — degrade quietly
  const attempt = (retriesLeft: number): void => {
    void bridge
      .getReplayTail(replayPath)
      .then((frames) => {
        if (state.match.sessionId !== sessionId) return; // a new match took over
        if (frames === null || frames.length === 0) {
          if (retriesLeft > 0) setTimeout(() => attempt(retriesLeft - 1), 2500);
          return;
        }
        const merged = appendFinalEvents(state.match, frames);
        if (merged === state.match) return; // nothing new — no emit
        state = { ...state, match: merged };
        emit();
      })
      .catch(() => {
        if (state.match.sessionId !== sessionId) return;
        if (retriesLeft > 0) setTimeout(() => attempt(retriesLeft - 1), 2500);
      });
  };
  attempt(2);
}

/**
 * Begin the persistent subscription. Idempotent and safe to call from any mount.
 * `api` defaults to the preload-injected window.aifight (undefined in plain-browser
 * QA → no-op, store stays empty so views fall back to demo). Never torn down: the
 * stream is the app's lifetime. Traces reset whenever a NEW match starts so the
 * reasoning panel stays scoped to the current match, never bleeding across matches.
 */
export function ensureLiveStoreStarted(api?: AifightBridgeApi): void {
  // Resolve to the preload-injected bridge unless a fake was passed (tests). The
  // typeof guard keeps this safe under node (no `window`) — explicitly passing
  // `undefined` still falls through to the no-op path, never a ReferenceError.
  const bridge = api ?? (typeof window !== "undefined" ? window.aifight : undefined);
  if (started || bridge === undefined) return;
  started = true;
  bridge.onServerMessage((msg) => {
    const prevSession = state.match.sessionId;
    const wasFinished = state.match.finished;
    const match = reduceServerMessage(state.match, msg);
    const traces = match.sessionId !== prevSession ? [] : state.traces;
    // Same-reference return = the reducer ignored the frame (other session /
    // malformed) — that is not liveness for THIS match, so don't stamp it.
    const lastActivityAt = match !== state.match ? Date.now() : state.lastActivityAt;
    state = { match, traces, lastActivityAt };
    emit();
    // Newly finished with a replay available → complete the board's tail.
    if (
      match.finished &&
      !wasFinished &&
      match.sessionId !== null &&
      match.replayPath !== null &&
      tailFetchedFor !== match.sessionId
    ) {
      tailFetchedFor = match.sessionId;
      fetchFinalTail(bridge, match.sessionId, match.replayPath);
    }
  });
  bridge.onTrace((tr) => {
    // F2: the final_action trace carries the complete action BEFORE it is
    // submitted — inject it as a synthetic board event so the owner's own move
    // shows immediately (the reconciler swaps in the server's real event).
    const match = tr.type === "final_action" ? injectFinalAction(state.match, tr) : state.match;
    // Stamp the board step this trace belongs to (see StampedTrace).
    const stamped: StampedTrace = { ...tr, step: match.events.length, at: Date.now() };
    state = { match, traces: [...state.traces, stamped], lastActivityAt: Date.now() };
    emit();
  });
  // F1: the participant event feed polled by main — opponents' moves between
  // our turns. Merged by seq; render-only, never feeds a prompt. Absent on an
  // older preload → degrade quietly to the turn-driven stream alone.
  if (typeof bridge.onMatchEvents === "function") {
    bridge.onMatchEvents((payload) => {
      if (state.match.sessionId === null || payload.sessionId !== state.match.sessionId) return;
      const match = mergePolledEvents(state.match, payload.sessionId, payload.events);
      if (match === state.match) return; // nothing new — not liveness for the board
      state = { ...state, match, lastActivityAt: Date.now() };
      emit();
    });
  }
  // Renderer-reload resync (owner report 2026-08-03): this module dies with the
  // page, but the bridge in the MAIN process keeps playing. The reducer ignores
  // every frame until it has seen a game_start, so without re-seeding, a reload
  // mid-match loses the live view for good — 观战 fell back to demo while the
  // match was still running. Ask main for the cached game_start; the armed feed
  // poll (full history every ~2.5s) then catches the board up. Live frames win
  // any race: if a game_start arrived before the snapshot resolved, keep it.
  // Traces are renderer-lifetime only and are not recoverable. Older preload
  // (no snapshot API) → same behavior as before this fix.
  if (typeof bridge.getLiveMatchSnapshot === "function") {
    void bridge
      .getLiveMatchSnapshot()
      .then((snap) => {
        if (snap === null || state.match.sessionId !== null) return;
        const match = reduceServerMessage(state.match, snap);
        if (match === state.match) return; // not a usable game_start — stay empty
        state = { ...state, match, lastActivityAt: Date.now() };
        emit();
      })
      .catch(() => {}); // resync is best-effort; the next game_start still works
  }
}

export function getLiveStoreState(): LiveStoreState {
  return state;
}

export function subscribeLiveStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Subscribe a component to the live store (version-agnostic external store hook). */
export function useLiveStore(): LiveStoreState {
  const [snap, setSnap] = useState<LiveStoreState>(getLiveStoreState());
  useEffect(() => {
    ensureLiveStoreStarted(); // lazy self-init on first consumer (idempotent)
    setSnap(getLiveStoreState()); // re-sync in case frames arrived before this mount
    return subscribeLiveStore(() => setSnap(getLiveStoreState()));
  }, []);
  return snap;
}

/** Test-only: reset module singleton between cases. */
export function __resetLiveStoreForTest(): void {
  state = { match: emptyLiveMatch(), traces: [], lastActivityAt: null };
  listeners.clear();
  started = false;
  tailFetchedFor = null;
}
