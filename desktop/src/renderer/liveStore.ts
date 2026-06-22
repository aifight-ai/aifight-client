// A single, always-on subscription to the bridge's live streams, folded into the
// match model ONCE at module scope. Lifting accumulation out of WatchView fixes a
// real bug: if a match starts while the user is on another view, the cockpit's
// own reducer (mounted only with that view) would miss the opening game_start and
// render a half-built board. The store keeps folding regardless of which view is
// mounted, so 观战 always shows the match from frame 1, and App-level banners /
// notifications can react to lifecycle transitions.
//
// 🔒 Information-hiding is inherited verbatim from liveMatch.ts — this store only
// re-hosts that reducer; it never surfaces anything the reducer wouldn't.

import { useEffect, useState } from "react";

import { emptyLiveMatch, reduceServerMessage, type LiveMatchState } from "./liveMatch";
import type { AifightBridgeApi, BridgeDecisionTrace } from "../shared/ipc";

export interface LiveStoreState {
  readonly match: LiveMatchState;
  readonly traces: readonly BridgeDecisionTrace[];
}

let state: LiveStoreState = { match: emptyLiveMatch(), traces: [] };
const listeners = new Set<() => void>();
let started = false;

function emit(): void {
  for (const l of listeners) l();
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
    const match = reduceServerMessage(state.match, msg);
    const traces = match.sessionId !== prevSession ? [] : state.traces;
    state = { match, traces };
    emit();
  });
  bridge.onTrace((tr) => {
    state = { match: state.match, traces: [...state.traces, tr] };
    emit();
  });
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
  state = { match: emptyLiveMatch(), traces: [] };
  listeners.clear();
  started = false;
}
