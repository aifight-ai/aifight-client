// Server reconciliation for local session records stuck "已中断" — rows whose
// game_over frame was missed (bridge down at match end, deploy restart, laptop
// lid). The server's pending-notice mailbox only redelivers within 1h and only
// over a live WS reconnect; everything it misses used to stay "active" locally
// forever, greyed out as interrupted after the 30-minute staleness cutoff.
//
// This module asks the DB-backed terminal-state endpoint
// (GET /api/agents/me/matches/{sessionID}/result, agent-key auth — see
// internal/server/agent_match_result.go) for exactly those rows, and folds a
// "completed" answer through LocalMatchSessionStore.recordServerMessage as a
// synthesized game_over envelope — the SAME code path a live game_over takes,
// so result labels, opponents, replay URL and the stored inbound frame all
// come out identical to a never-missed finish.
//
// Scope guards, deliberately narrow:
//   - only sessions of the CURRENTLY configured agent (the key can't answer
//     for anyone else);
//   - only rows already past the staleness cutoff (a live match keeps its
//     updated_at fresh — platform rules bound silence at 10 min/turn — so this
//     can never touch the match the bridge is playing right now);
//   - "active" answers change nothing; 404/403/"cancelled" are remembered for
//     the rest of the app run so History opens stop re-asking about rows the
//     server will never complete (pruned server data, other-env records, void
//     matches — those stay 已中断, which is the truth);
//   - writes stamp the record with the server's finished_at, not "now": a
//     week-old match must neither float to the top of the history list nor
//     report a week-long duration.
//
// 🔒 Read-only against the platform + local-store writes only. Never triggers
// an LLM call, never touches the live bridge connection.

import { readBridgeConfig, type BridgeConfig } from "@aifight/aifight/bridge/config";
import {
  createLocalMatchSessionStore,
  LocalMatchSessionStore,
} from "@aifight/aifight/session/local-match-session-store";
import type { ServerMessageEnvelope } from "@aifight/aifight/wsclient/frame-handler";

import { isStaleLiveSession } from "../shared/staleSession";
import { httpOriginOf } from "./bridge-host";

const FETCH_TIMEOUT_MS = 8000;
// One History open repairs at most this many rows; anything beyond rides the
// next open. Keeps a years-old pile of stuck rows from turning one page load
// into dozens of requests.
const MAX_SESSIONS_PER_RUN = 12;
const CONCURRENCY = 4;

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

export interface ReconcileOutcome {
  /** Interrupted rows we asked the server about this run. */
  readonly checked: number;
  /** Rows completed with a real outcome (History should reload when > 0). */
  readonly updated: number;
}

export interface ReconcileOptions {
  /** Tests: bypass readBridgeConfig(); null = explicitly unconfigured. */
  readonly config?: BridgeConfig | null;
  /** Tests: isolated store root instead of the real ~/.aifight. */
  readonly runtimeHome?: string;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => number;
  /** Tests: isolated no-retry memory instead of the app-run singleton. */
  readonly memo?: Set<string>;
}

// Sessions the server answered "will never complete" (404/403/cancelled),
// keyed by origin so an env switch (beta ⇄ prod) re-asks. App-run lifetime.
const settledNoRetry = new Set<string>();

// Both triggers (History open, bridge reconnect) funnel into one run at a
// time; a call during a run just joins it.
let inFlight: Promise<ReconcileOutcome> | null = null;

export function reconcileInterruptedSessions(opts: ReconcileOptions = {}): Promise<ReconcileOutcome> {
  if (inFlight !== null) return inFlight;
  const run = doReconcile(opts).finally(() => {
    inFlight = null;
  });
  inFlight = run;
  return run;
}

async function doReconcile(opts: ReconcileOptions): Promise<ReconcileOutcome> {
  const none: ReconcileOutcome = { checked: 0, updated: 0 };
  let config: BridgeConfig | null;
  if (opts.config !== undefined) {
    config = opts.config;
  } else {
    try {
      config = readBridgeConfig();
    } catch {
      return none; // not configured yet — nothing to reconcile against
    }
  }
  if (config === null) return none;
  const cfg = config; // const-bind after narrowing so closures below keep the type
  const origin = httpOriginOf(cfg.baseUrl);
  const apiKey = cfg.apiKey ?? "";
  if (origin === null || apiKey === "" || cfg.agentId === "") return none;

  const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike);
  const memo = opts.memo ?? settledNoRetry;
  const nowMs = (opts.now ?? Date.now)();
  const homeOpt = opts.runtimeHome !== undefined ? { runtimeHome: opts.runtimeHome } : {};
  const store = createLocalMatchSessionStore(homeOpt);

  const candidates = store
    .listSessions() // already sorted newest-first by updated_at
    .filter(
      (s) =>
        s.agent_id === cfg.agentId &&
        s.status === "active" &&
        isStaleLiveSession(s.status, s.updated_at, nowMs) &&
        !memo.has(`${origin}|${s.session_id}`),
    )
    .slice(0, MAX_SESSIONS_PER_RUN);
  if (candidates.length === 0) return none;

  let updated = 0;
  const handleOne = async (sessionId: string): Promise<void> => {
    const answer = await fetchSessionResult(origin, sessionId, apiKey, fetchImpl);
    if (answer === null || answer.kind === "active") return; // transient / still running — ask again some later run
    if (answer.kind === "gone") {
      memo.add(`${origin}|${sessionId}`);
      return;
    }
    // Dodge the redelivery race: if the live bridge's mailbox game_over landed
    // between listing and now, the runner already completed this record.
    const current = store.getSession(sessionId);
    if (current === null || current.status !== "active") return;
    // Stamp with the real end time (see header) — one throwaway store whose
    // clock is pinned to finished_at; recordServerMessage then writes
    // updated_at/ended_at as that instant.
    const writeStore = new LocalMatchSessionStore({
      ...homeOpt,
      now: () => answer.finishedAt ?? new Date(nowMs),
    });
    writeStore.recordServerMessage(cfg, answer.envelope);
    updated += 1;
  };

  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    await Promise.all(candidates.slice(i, i + CONCURRENCY).map((s) => handleOne(s.session_id)));
  }
  if (updated > 0) {
    console.log(`[reconcile] repaired ${updated}/${candidates.length} interrupted session record(s) from the server`);
  }
  return { checked: candidates.length, updated };
}

type SessionResultAnswer =
  | { readonly kind: "active" }
  | { readonly kind: "gone" } // 404 / 403 / cancelled — final for this app run
  | { readonly kind: "completed"; readonly envelope: ServerMessageEnvelope; readonly finishedAt: Date | null };

/**
 * One terminal-state lookup. Null on ANY transient failure (network, 5xx,
 * malformed body) — retried on a later run; never throws.
 */
async function fetchSessionResult(
  origin: string,
  sessionId: string,
  apiKey: string,
  fetchImpl: FetchLike,
): Promise<SessionResultAnswer | null> {
  const url = `${origin.replace(/\/+$/, "")}/api/agents/me/matches/${encodeURIComponent(sessionId)}/result`;
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url, {
      headers: { "X-API-Key": apiKey },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  // 404 also covers an old server without this endpoint yet — memoizing it for
  // the app run is right either way (retrying can't succeed until a restart
  // after a server deploy).
  if (res.status === 404 || res.status === 403) return { kind: "gone" };
  if (!res.ok) return null;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (!isRecord(body)) return null;
  switch (body.status) {
    case "active":
      return { kind: "active" };
    case "cancelled":
      return { kind: "gone" };
    case "completed":
      return buildCompletedAnswer(sessionId, body);
    default:
      return null;
  }
}

/** Validate the payload and shape it into the game_over envelope the store's
 *  normal completion path consumes. Null on anything malformed: a record is
 *  only ever completed from a payload that carries a real, whole outcome. */
function buildCompletedAnswer(sessionId: string, body: Record<string, unknown>): SessionResultAnswer | null {
  const go = body.game_over;
  if (!isRecord(go)) return null;
  if (typeof go.match_id !== "string" || go.match_id === "") return null;
  // A mismatched echo would complete the WRONG local record — refuse.
  if (typeof go.session_id === "string" && go.session_id !== "" && go.session_id !== sessionId) return null;
  const result = go.result;
  if (!isRecord(result) || !isRecord(result.payoffs)) return null;
  const players = go.players;
  if (!Array.isArray(players)) return null;
  for (const p of players) {
    if (
      !isRecord(p) ||
      typeof p.player_id !== "string" ||
      typeof p.agent_id !== "string" ||
      typeof p.agent_name !== "string"
    ) {
      return null;
    }
  }
  const data: Record<string, unknown> = {
    match_id: go.match_id,
    session_id: sessionId,
    result,
    players,
  };
  if (typeof go.replay_url === "string" && go.replay_url !== "") data.replay_url = go.replay_url;
  if (typeof go.forfeit_reason === "string" && go.forfeit_reason !== "") data.forfeit_reason = go.forfeit_reason;
  if (typeof go.forfeited_by === "string" && go.forfeited_by !== "") data.forfeited_by = go.forfeited_by;
  return {
    kind: "completed",
    envelope: { type: "game_over", data } as ServerMessageEnvelope,
    finishedAt: parseISODate(body.finished_at),
  };
}

function parseISODate(value: unknown): Date | null {
  if (typeof value !== "string" || value === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
