// Per-match accumulator of the PLAYER-VIEW event log + the platform's rules
// summary, fed from server messages and consumed by the direct-LLM prompt
// builder — so the model sees the match history (per-hand results, this
// round's step-by-step actions) instead of only the current state snapshot.
//
// Discipline: accumulate RAW events only (seq-deduped facts). Rendering into
// prompt text happens fresh on every decision (direct-llm-provider) — never
// accumulate rendered strings, they drift. Reconnects heal themselves: the
// server backfills missed events into action_request.event_history, and the
// seq-keyed merge makes that idempotent regardless of overlap.
//
// Everything here is data the client already receives and already persists
// verbatim in inbound.jsonl; this is an in-memory view of it, keyed by the
// per-player session id (action_request.data.match_id / game_over.session_id).

export interface MatchRulesContext {
  readonly summary?: string;
  readonly keyRules?: readonly string[];
}

export interface MatchEventRecord {
  readonly seq: number;
  readonly type: string;
  readonly data?: unknown;
  readonly playerId?: string;
}

export interface BridgeMatchContext {
  /** Player-view events, seq-ascending, oldest first. */
  readonly events: readonly MatchEventRecord[];
  /** game_start rules block (summary + key rules), when seen this process. */
  readonly rules?: MatchRulesContext;
}

// A finished match is dropped on game_over; these caps only bound pathological
// cases (missed game_over, an absurdly long match) so memory stays flat.
const MAX_TRACKED_MATCHES = 16;
const MAX_EVENTS_PER_MATCH = 2000;

interface TrackedMatch {
  rules?: MatchRulesContext;
  readonly events: Map<number, MatchEventRecord>;
}

export class MatchContextTracker {
  readonly #matches = new Map<string, TrackedMatch>();

  /** Feed every inbound server message envelope; ignores anything irrelevant. */
  observe(message: unknown): void {
    if (!isObject(message)) return;
    const type = message.type;
    const data = isObject(message.data) ? message.data : undefined;
    if (type === "game_start" && data !== undefined) {
      const sessionId = readString(data.match_id) ?? readString(message.match_id);
      if (sessionId === undefined) return;
      const entry = this.#ensure(sessionId);
      const rules = parseRules(data.rules);
      if (rules !== undefined) entry.rules = rules;
      return;
    }
    if (type === "action_request" && data !== undefined) {
      const sessionId = readString(data.match_id) ?? readString(message.match_id);
      if (sessionId === undefined) return;
      const entry = this.#ensure(sessionId);
      // event_history first (reconnect backfill), then new_events — the
      // seq-keyed merge dedups any overlap between the two.
      mergeEvents(entry.events, data.event_history);
      mergeEvents(entry.events, data.new_events);
      pruneOldest(entry.events);
      return;
    }
    if (type === "game_over" && data !== undefined) {
      // game_over.data.match_id is the REAL match id (a different namespace) —
      // only session_id matches our key, so there is no fallback.
      const sessionId = readString(data.session_id);
      if (sessionId !== undefined) this.#matches.delete(sessionId);
    }
  }

  /** Current context for a session, events oldest-first; undefined when unseen. */
  get(sessionId: string): BridgeMatchContext | undefined {
    const entry = this.#matches.get(sessionId);
    if (entry === undefined) return undefined;
    const events = [...entry.events.values()].sort((a, b) => a.seq - b.seq);
    return {
      events,
      ...(entry.rules !== undefined ? { rules: entry.rules } : {}),
    };
  }

  #ensure(sessionId: string): TrackedMatch {
    const existing = this.#matches.get(sessionId);
    if (existing !== undefined) return existing;
    // Insertion-ordered eviction: matches finish via game_over; this only
    // guards a runner that somehow never sees one.
    while (this.#matches.size >= MAX_TRACKED_MATCHES) {
      const oldest = this.#matches.keys().next().value;
      if (oldest === undefined) break;
      this.#matches.delete(oldest);
    }
    const entry: TrackedMatch = { events: new Map() };
    this.#matches.set(sessionId, entry);
    return entry;
  }
}

function mergeEvents(into: Map<number, MatchEventRecord>, raw: unknown): void {
  if (!Array.isArray(raw)) return;
  for (const item of raw) {
    const record = parseEvent(item);
    if (record !== null) into.set(record.seq, record);
  }
}

function pruneOldest(events: Map<number, MatchEventRecord>): void {
  if (events.size <= MAX_EVENTS_PER_MATCH) return;
  const seqs = [...events.keys()].sort((a, b) => a - b);
  const excess = events.size - MAX_EVENTS_PER_MATCH;
  for (let i = 0; i < excess; i++) events.delete(seqs[i]!);
}

function parseEvent(raw: unknown): MatchEventRecord | null {
  if (!isObject(raw)) return null;
  const seq = raw.seq;
  const type = raw.type;
  if (typeof seq !== "number" || !Number.isFinite(seq)) return null;
  if (typeof type !== "string" || type === "") return null;
  // Wire field is `player` (engine.Event json tag / common/event.schema.json) —
  // the acting player, essential for e.g. Coup's `action` events.
  const playerId = readString(raw.player);
  return {
    seq,
    type,
    ...(raw.data !== undefined ? { data: raw.data } : {}),
    ...(playerId !== undefined ? { playerId } : {}),
  };
}

// Storage-side caps on server-provided rules text, so a pathological
// game_start can't park megabytes in memory (the prompt renderer has its own,
// tighter caps).
const RULES_STORE_SUMMARY_MAX = 4_000;
const RULES_STORE_MAX_KEY_RULES = 24;
const RULES_STORE_KEY_RULE_MAX = 400;

function parseRules(raw: unknown): MatchRulesContext | undefined {
  if (!isObject(raw)) return undefined;
  const summary = readString(raw.summary)?.slice(0, RULES_STORE_SUMMARY_MAX);
  const keyRules = Array.isArray(raw.key_rules)
    ? raw.key_rules
        .filter((r): r is string => typeof r === "string" && r !== "")
        .slice(0, RULES_STORE_MAX_KEY_RULES)
        .map((r) => r.slice(0, RULES_STORE_KEY_RULE_MAX))
    : undefined;
  if (summary === undefined && (keyRules === undefined || keyRules.length === 0)) return undefined;
  return {
    ...(summary !== undefined ? { summary } : {}),
    ...(keyRules !== undefined && keyRules.length > 0 ? { keyRules } : {}),
  };
}

function readString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
