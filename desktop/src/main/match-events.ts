// Fetch the PARTICIPANT event feed of a live match (LIVE_MATCH_FEED F1).
//
// GET /api/agents/me/matches/{sessionID}/events is an existing production
// endpoint (internal/server/server.go handleAgentMatchEvents): agent-key auth,
// participant-only, and — unlike the public spectator stream — NO anti-collusion
// delay. It answers the FULL event history already filtered through the game's
// FilterEventForPlayer (`is_full_history: true`; there is no `since` param), so
// every page is self-sufficient and the caller dedupes by seq against whatever
// action_request.new_events already delivered.
//
// 🔒 The feed only ever flows into renderer display + local session persistence.
// It NEVER triggers an LLM call — the bridge calls the model only on
// action_request; this is a read-only mirror of what the platform already lets
// this player see.

import type { ProtocolEvent } from "../shared/ipc";

const FETCH_TIMEOUT_MS = 8000;

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

/**
 * One page of the participant feed. Returns null on ANY failure (network,
 * non-OK, malformed body) — the poller treats null as "keep what we have and
 * back off", never as match-relevant information. Never throws.
 */
export async function fetchParticipantEvents(
  origin: string,
  sessionId: string,
  apiKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<readonly ProtocolEvent[] | null> {
  if (origin === "" || sessionId === "" || apiKey === "") return null;
  const base = origin.replace(/\/+$/, "");
  const url = `${base}/api/agents/me/matches/${encodeURIComponent(sessionId)}/events`;
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url, {
      headers: { "X-API-Key": apiKey },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const b = (body ?? {}) as { events?: unknown };
  if (!Array.isArray(b.events)) return null;
  const out: ProtocolEvent[] = [];
  for (const e of b.events) {
    if (e === null || typeof e !== "object") return null; // malformed page: trust nothing
    const ev = e as { type?: unknown };
    if (typeof ev.type !== "string" || ev.type === "") return null;
    out.push(e as ProtocolEvent);
  }
  return out;
}
