import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { AgentDecisionContext } from "../agents/agent";
import type { BridgeConfig } from "../bridge/config";
import type { BridgeDecisionTrace, BridgeDecisionStrategySection } from "../bridge/provider";
import type {
  MsgActionRequest,
  MsgGameOver,
  MsgGameStart,
  MsgGameState,
} from "../protocol/types";
import { ensureRuntimeHome, getRuntimeHome } from "../store/paths";
import type { ServerMessageEnvelope } from "../wsclient/frame-handler";
import type { WSClientMessage } from "../wsclient/client";

export interface LocalMatchSessionStoreOptions {
  readonly runtimeHome?: string;
  readonly now?: () => Date;
}

export interface LocalMatchSessionSummary {
  readonly version: 1;
  readonly agent_id: string;
  readonly agent_name: string;
  readonly session_id: string;
  readonly status: "active" | "completed";
  readonly game?: string;
  readonly mode?: string;
  readonly player_id?: string;
  readonly started_at: string;
  readonly updated_at: string;
  readonly ended_at?: string;
  readonly real_match_id?: string;
  readonly replay_url?: string;
  readonly result_label?: string;
  /** Seats in the match (game_start roster; confirmed by game_over identities). */
  readonly player_count?: number;
  /**
   * Distinct engine events observed (seq-deduped across action_requests, the
   * same fold the cockpit replay uses) — the whole-match interaction count,
   * every player's moves included, and the local replay's step count.
   */
  readonly event_count?: number;
  /** High-water event seq backing the event_count dedupe. */
  readonly event_seq_max?: number;
  readonly inbound_count: number;
  readonly outbound_count: number;
  readonly decision_count: number;
  readonly final_action_count: number;
  readonly strategy_hashes: readonly string[];
  /** ISO timestamp of the most recent self-review, if any (list marker). */
  readonly self_review_at?: string;
  /** Decisions cut short by a too-small max_tokens (token-budget guard). */
  readonly token_truncation_count?: number;
  /** Profile of the most recent truncated decision (for the "raise it" hint). */
  readonly truncated_profile?: string;
  /**
   * Decisions that FELL BACK to the deterministic policy because the model call
   * failed, grouped by error class (auth / quota / config / rate_limit / …), so
   * `sessions show` can tell the user what to fix. Counts once per fell-back
   * decision, by the class of its final failure.
   */
  readonly error_class_counts?: Readonly<Record<string, number>>;
}

export interface LocalMatchSessionListItem extends LocalMatchSessionSummary {
  readonly path: string;
}

export interface RecordDecisionInput {
  readonly config: BridgeConfig;
  readonly context: AgentDecisionContext;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly traces: readonly BridgeDecisionTrace[];
  readonly action?: unknown;
  readonly error?: unknown;
}

export interface LocalSessionExport {
  readonly summary: LocalMatchSessionSummary;
  readonly path: string;
  readonly inbound: readonly unknown[];
  readonly outbound: readonly unknown[];
  readonly decisions: readonly unknown[];
  readonly strategySnapshot: unknown;
  /** Parsed self_review.json if a review has been generated, else null. */
  readonly selfReview: unknown;
}

export class LocalMatchSessionStore {
  readonly #runtimeHome: string;
  readonly #now: () => Date;

  constructor(opts: LocalMatchSessionStoreOptions = {}) {
    this.#runtimeHome = opts.runtimeHome ?? getRuntimeHome();
    this.#now = opts.now ?? (() => new Date());
  }

  recordServerMessage(config: BridgeConfig, message: ServerMessageEnvelope): void {
    const now = this.#now().toISOString();
    const sessionId = sessionIdFromServerMessage(message);
    if (message.type === "game_start") {
      const msg = message as MsgGameStart;
      this.#ensureSession(config, msg.data.match_id, {
        now,
        game: msg.data.game,
        mode: readMode(msg.data),
        playerId: msg.data.your_player_id,
        playerCount: Array.isArray(msg.data.players) ? msg.data.players.length : undefined,
      });
    }

    if (!sessionId) return;
    const summary = this.#ensureSession(config, sessionId, { now });
    this.#appendJSONLine(summary, "inbound.jsonl", {
      at: now,
      direction: "inbound",
      type: message.type,
      message,
    });
    let next = {
      ...summary,
      inbound_count: summary.inbound_count + 1,
      updated_at: now,
    };
    if (message.type === "action_request") {
      next = applyEventProgress(next, (message as MsgActionRequest).data);
    }
    if (message.type === "game_state") {
      const msg = message as MsgGameState;
      next = {
        ...next,
        player_id: next.player_id ?? readPlayerId(msg.data.state),
      };
    }
    if (message.type === "game_over") {
      next = this.#completeSession(config, next, message as MsgGameOver, now);
    }
    this.#writeSummary(next);
  }

  recordClientMessage(config: BridgeConfig, message: WSClientMessage): void {
    if (message.type !== "action" || !message.match_id) return;
    const now = this.#now().toISOString();
    const summary = this.#ensureSession(config, message.match_id, { now });
    this.#appendJSONLine(summary, "outbound.jsonl", {
      at: now,
      direction: "outbound",
      type: message.type,
      message,
    });
    this.#writeSummary({
      ...summary,
      outbound_count: summary.outbound_count + 1,
      final_action_count: summary.final_action_count + 1,
      updated_at: now,
    });
  }

  recordDecision(input: RecordDecisionInput): void {
    const sessionId = input.context.matchId;
    const startedAt = input.startedAt.toISOString();
    const completedAt = input.completedAt.toISOString();
    const summary = this.#ensureSession(input.config, sessionId, {
      now: startedAt,
      game: input.context.game,
      playerId: readPlayerId(input.context.actionRequest.data.state),
    });
    const strategySections = collectStrategySections(input.traces);
    this.#mergeStrategySnapshot(summary, strategySections, completedAt);
    // Token-budget guard: this decision hit the max_tokens cap if the model was
    // cut off (runtime_success.truncated), the provider auto-raised and retried
    // it (runtime_success.selfHealed — the first attempt WAS truncated, so the
    // user should still make the fix permanent), or it 4xx'd on the cap
    // (runtime_failure.tokenLimit). Count once per decision; remember the profile
    // so `sessions show` can print the exact fix for the profile that failed.
    const truncTrace = input.traces.find(
      (t) =>
        (t.type === "runtime_success" && (t.truncated === true || t.selfHealed !== undefined)) ||
        (t.type === "runtime_failure" && t.tokenLimit === true),
    );
    const truncatedThisDecision = truncTrace !== undefined;
    const truncatedProfile =
      truncTrace?.type === "runtime_success"
        ? truncTrace.profileId
        : truncTrace?.type === "runtime_failure"
          ? truncTrace.profileId
          : undefined;
    // A decision that fell back to the deterministic policy because the model
    // call failed: attribute it to the class of its FINAL failure so
    // `sessions show` can name the fix. A decision that recovered on a retry
    // (final action came from the model) does not count.
    const fellBack = input.traces.some((t) => t.type === "final_action" && t.source === "fallback");
    const lastFailure = [...input.traces].reverse().find((t) => t.type === "runtime_failure");
    const failClass = fellBack && lastFailure?.type === "runtime_failure" ? lastFailure.errorClass : undefined;
    const nextErrorClassCounts =
      failClass !== undefined
        ? { ...(summary.error_class_counts ?? {}), [failClass]: (summary.error_class_counts?.[failClass] ?? 0) + 1 }
        : summary.error_class_counts;
    this.#appendJSONLine(summary, "decisions.jsonl", {
      at: completedAt,
      kind: "decision",
      session_id: sessionId,
      game: input.context.game ?? summary.game ?? null,
      player_id: readPlayerId(input.context.actionRequest.data.state) ?? summary.player_id ?? null,
      duration_ms: Math.max(0, input.completedAt.getTime() - input.startedAt.getTime()),
      action_request: summarizeActionRequest(input.context.actionRequest),
      traces: redactDecisionTraces(input.traces),
      status: input.error === undefined ? "ok" : "error",
      ...(truncatedThisDecision ? { truncated: true } : {}),
      ...(input.action !== undefined ? { final_action: input.action } : {}),
      ...(input.error !== undefined ? { error: stringifyCause(input.error) } : {}),
    });
    this.#writeSummary({
      ...summary,
      game: input.context.game ?? summary.game,
      player_id: readPlayerId(input.context.actionRequest.data.state) ?? summary.player_id,
      updated_at: completedAt,
      decision_count: summary.decision_count + 1,
      token_truncation_count: (summary.token_truncation_count ?? 0) + (truncatedThisDecision ? 1 : 0),
      ...(truncatedProfile !== undefined
        ? { truncated_profile: truncatedProfile }
        : summary.truncated_profile !== undefined
          ? { truncated_profile: summary.truncated_profile }
          : {}),
      ...(nextErrorClassCounts !== undefined ? { error_class_counts: nextErrorClassCounts } : {}),
      strategy_hashes: mergeHashes(summary.strategy_hashes, strategySections.map((s) => s.sha256)),
    });
  }

  listSessions(): readonly LocalMatchSessionListItem[] {
    return this.#readAllSummaries().sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  getSession(selector: string): LocalMatchSessionListItem | null {
    const summaries = this.#readAllSummaries();
    const exact = summaries.find((s) => s.session_id === selector || s.real_match_id === selector);
    if (exact) return exact;
    if (selector.length >= 8) {
      const matches = summaries.filter(
        (s) => s.session_id.startsWith(selector) || s.real_match_id?.startsWith(selector),
      );
      if (matches.length === 1) return matches[0]!;
    }
    return null;
  }

  exportSession(selector: string): LocalSessionExport | null {
    const item = this.getSession(selector);
    if (!item) return null;
    return {
      summary: stripPath(item),
      path: item.path,
      inbound: readJSONLines(path.join(item.path, "inbound.jsonl")),
      outbound: readJSONLines(path.join(item.path, "outbound.jsonl")),
      decisions: readJSONLines(path.join(item.path, "decisions.jsonl")),
      strategySnapshot: readJSONFile(path.join(item.path, "strategy-snapshot.json")) ?? null,
      selfReview: readJSONFile(path.join(item.path, "self_review.json")) ?? null,
    };
  }

  /** Read the stored self-review for a session, or null if none/unknown. */
  readSelfReview(selector: string): unknown | null {
    const item = this.getSession(selector);
    if (!item) return null;
    return readJSONFile(path.join(item.path, "self_review.json")) ?? null;
  }

  /**
   * Persist a self-review for a session (overwrites any prior one — D9) and
   * stamp `self_review_at` on the summary so lists can mark it reviewed.
   * Returns false when the session can't be found. Local-only; never uploaded.
   */
  writeSelfReview(selector: string, review: unknown): boolean {
    const item = this.getSession(selector);
    if (!item) return false;
    writeJSONFile(path.join(item.path, "self_review.json"), review);
    this.#writeSummary({ ...stripPath(item), self_review_at: this.#now().toISOString() });
    return true;
  }

  #ensureSession(
    config: BridgeConfig,
    sessionId: string,
    opts: {
      readonly now: string;
      readonly game?: string;
      readonly mode?: string;
      readonly playerId?: string;
      readonly playerCount?: number;
    },
  ): LocalMatchSessionSummary {
    const dir = this.#sessionDir(config.agentId, sessionId);
    ensurePrivateDir(dir);
    const existing = readSummary(path.join(dir, "session.json"));
    if (existing) {
      const merged = {
        ...existing,
        agent_name: config.agentName,
        game: opts.game ?? existing.game,
        mode: opts.mode ?? existing.mode,
        player_id: opts.playerId ?? existing.player_id,
        ...(opts.playerCount !== undefined ? { player_count: opts.playerCount } : {}),
        updated_at: opts.now,
      };
      this.#writeSummary(merged);
      return merged;
    }
    const summary: LocalMatchSessionSummary = {
      version: 1,
      agent_id: config.agentId,
      agent_name: config.agentName,
      session_id: sessionId,
      status: "active",
      ...(opts.game !== undefined ? { game: opts.game } : {}),
      ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
      ...(opts.playerId !== undefined ? { player_id: opts.playerId } : {}),
      ...(opts.playerCount !== undefined ? { player_count: opts.playerCount } : {}),
      started_at: opts.now,
      updated_at: opts.now,
      inbound_count: 0,
      outbound_count: 0,
      decision_count: 0,
      final_action_count: 0,
      strategy_hashes: [],
    };
    this.#writeSummary(summary);
    return summary;
  }

  #completeSession(
    config: BridgeConfig,
    summary: LocalMatchSessionSummary,
    gameOver: MsgGameOver,
    now: string,
  ): LocalMatchSessionSummary {
    const roster = Array.isArray(gameOver.data.players) ? gameOver.data.players.length : 0;
    return {
      ...summary,
      status: "completed",
      updated_at: now,
      ended_at: now,
      real_match_id: gameOver.data.match_id,
      ...(gameOver.data.replay_url !== undefined
        ? { replay_url: fullReplayURL(config.baseUrl, gameOver.data.replay_url) }
        : {}),
      // game_over discloses the full real roster — authoritative over the
      // (possibly missed, e.g. mid-match reconnect) game_start count.
      ...(roster > 0 ? { player_count: roster } : {}),
      result_label: resultLabel(config.agentId, gameOver),
    };
  }

  #mergeStrategySnapshot(
    summary: LocalMatchSessionSummary,
    sections: readonly BridgeDecisionStrategySection[],
    now: string,
  ): void {
    if (sections.length === 0) return;
    const file = path.join(this.#sessionDir(summary.agent_id, summary.session_id), "strategy-snapshot.json");
    const existing = readStrategySnapshot(file);
    const byHash = { ...existing.sections };
    for (const section of sections) {
      byHash[section.sha256] = {
        scope: section.scope,
        ...(section.game !== undefined ? { game: section.game } : {}),
        path: section.path,
        sha256: section.sha256,
        bytes: section.bytes,
        mtimeMs: section.mtimeMs,
        truncated: section.truncated === true,
        content: section.content,
      };
    }
    writeJSONFile(file, {
      version: 1,
      updated_at: now,
      sections: byHash,
    });
  }

  #appendJSONLine(summary: LocalMatchSessionSummary, filename: string, value: unknown): void {
    const file = path.join(this.#sessionDir(summary.agent_id, summary.session_id), filename);
    fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    chmodPrivateFile(file);
  }

  #writeSummary(summary: LocalMatchSessionSummary): void {
    writeJSONFile(path.join(this.#sessionDir(summary.agent_id, summary.session_id), "session.json"), summary);
  }

  #readAllSummaries(): LocalMatchSessionListItem[] {
    const agentsRoot = path.join(this.#runtimeHome, "agents");
    let agentDirs: string[];
    try {
      agentDirs = fs.readdirSync(agentsRoot);
    } catch {
      return [];
    }
    const out: LocalMatchSessionListItem[] = [];
    for (const agentDir of agentDirs) {
      const sessionsRoot = path.join(agentsRoot, agentDir, "sessions");
      let sessions: string[];
      try {
        sessions = fs.readdirSync(sessionsRoot);
      } catch {
        continue;
      }
      for (const sessionDir of sessions) {
        const dir = path.join(sessionsRoot, sessionDir);
        let summary = readSummary(path.join(dir, "session.json"));
        if (!summary) continue;
        if (
          summary.status === "completed" &&
          (summary.event_count === undefined || summary.player_count === undefined)
        ) {
          summary = backfillWholeMatchCounts(dir, summary);
        }
        out.push({ ...summary, path: dir });
      }
    }
    return out;
  }

  #sessionDir(agentId: string, sessionId: string): string {
    return path.join(this.#runtimeHome, "agents", safePathSegment(agentId), "sessions", safePathSegment(sessionId));
  }
}

export function createLocalMatchSessionStore(
  opts: LocalMatchSessionStoreOptions = {},
): LocalMatchSessionStore {
  if (opts.runtimeHome === undefined) ensureRuntimeHome();
  return new LocalMatchSessionStore(opts);
}

function sessionIdFromServerMessage(message: ServerMessageEnvelope): string | null {
  if (message.type === "game_start") return (message as MsgGameStart).data.match_id;
  if (message.type === "game_state") return (message as MsgGameState).data.match_id;
  if (message.type === "action_request") return (message as MsgActionRequest).data.match_id;
  if (message.type === "game_over") return (message as MsgGameOver).data.session_id;
  return null;
}

/**
 * Fold one action_request's event payload into the summary's whole-match
 * interaction counters. Mirrors the cockpit replay's dedupe exactly: events
 * count once by monotonic `seq` (overlapping deliveries skip), and a
 * reconnect's `event_history` — the full filtered log — resets the fold.
 */
function applyEventProgress(
  summary: LocalMatchSessionSummary,
  data: MsgActionRequest["data"] | undefined,
): LocalMatchSessionSummary {
  if (!data || typeof data !== "object") return summary;
  let count = summary.event_count ?? 0;
  let max = summary.event_seq_max ?? -1;
  const history =
    data.is_reconnect === true && Array.isArray(data.event_history) && data.event_history.length > 0
      ? data.event_history
      : null;
  if (history) {
    count = history.length;
    max = -1;
    for (const e of history) {
      const seq = (e as { seq?: unknown })?.seq;
      if (typeof seq === "number" && seq > max) max = seq;
    }
  } else {
    for (const e of data.new_events ?? []) {
      const seq = (e as { seq?: unknown })?.seq;
      if (typeof seq === "number") {
        if (seq <= max) continue;
        max = seq;
        count += 1;
      } else {
        count += 1;
      }
    }
  }
  if (count === (summary.event_count ?? 0) && max === (summary.event_seq_max ?? -1)) return summary;
  return { ...summary, event_count: count, event_seq_max: max };
}

/**
 * One-shot self-healing migration for sessions recorded before the whole-match
 * counters existed: derive player_count / event_count from the stored inbound
 * frames (the same fold live recording uses) and persist them back into the
 * SCANNED session.json, so the cost is paid once per legacy session.
 */
function backfillWholeMatchCounts(
  dir: string,
  summary: LocalMatchSessionSummary,
): LocalMatchSessionSummary {
  let next = summary;
  try {
    for (const rec of readJSONLines(path.join(dir, "inbound.jsonl"))) {
      const msg = (rec as { message?: unknown })?.message;
      if (!msg || typeof msg !== "object") continue;
      const type = (msg as { type?: unknown }).type;
      if (type === "game_start" || type === "game_over") {
        const players = ((msg as { data?: { players?: unknown } }).data ?? {}).players;
        if (Array.isArray(players) && players.length > 0) {
          next = { ...next, player_count: players.length };
        }
      } else if (type === "action_request") {
        next = applyEventProgress(next, (msg as MsgActionRequest).data);
      }
    }
  } catch {
    // Best effort — a broken frame log still gets the sentinel below.
  }
  if (next.event_count === undefined) {
    next = { ...next, event_count: 0, event_seq_max: -1 };
  }
  try {
    writeJSONFile(path.join(dir, "session.json"), next);
  } catch {
    // Best effort — an unwritable store just re-derives next time.
  }
  return next;
}

function summarizeActionRequest(actionRequest: MsgActionRequest): Record<string, unknown> {
  const data = actionRequest.data;
  return {
    match_id: data.match_id,
    timeout_ms: data.timeout_ms,
    legal_action_count: (data.legal_actions ?? []).length,
    legal_actions: data.legal_actions ?? [],
    state_sha256: sha256JSON(data.state),
    state: data.state,
    new_events_count: Array.isArray(data.new_events) ? data.new_events.length : 0,
    new_events: data.new_events,
  };
}

function collectStrategySections(traces: readonly BridgeDecisionTrace[]): BridgeDecisionStrategySection[] {
  const sections: BridgeDecisionStrategySection[] = [];
  for (const trace of traces) {
    if (trace.type !== "decision_request") continue;
    for (const section of trace.strategy) {
      sections.push({
        scope: section.scope,
        ...(section.game !== undefined ? { game: section.game } : {}),
        path: section.path,
        content: section.content,
        sha256: section.sha256,
        bytes: section.bytes,
        mtimeMs: section.mtimeMs,
        ...(section.truncated === true ? { truncated: true } : {}),
      });
    }
  }
  return sections;
}

function redactDecisionTraces(traces: readonly BridgeDecisionTrace[]): readonly unknown[] {
  return traces.map((trace) => {
    if (trace.type !== "decision_request") return trace;
    return {
      ...trace,
      strategy: trace.strategy.map((section) => ({
        scope: section.scope,
        ...(section.game !== undefined ? { game: section.game } : {}),
        path: section.path,
        sha256: section.sha256,
        bytes: section.bytes,
        mtimeMs: section.mtimeMs,
        ...(section.truncated === true ? { truncated: true } : {}),
      })),
    };
  });
}

function readPlayerId(state: unknown): string | undefined {
  if (!state || typeof state !== "object") return undefined;
  const value = (state as Record<string, unknown>).your_player_id;
  return typeof value === "string" ? value : undefined;
}

function readMode(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = (data as Record<string, unknown>).mode;
  return typeof value === "string" ? value : undefined;
}

function resultLabel(agentId: string, gameOver: MsgGameOver): string {
  const player = gameOver.data.players.find((p) => p.agent_id === agentId);
  if (player === undefined) return "completed";
  if (gameOver.data.forfeited_by === player.player_id) return "forfeit";
  if (gameOver.data.forfeit_reason !== undefined) return "opponent forfeit";
  if (gameOver.data.result.is_draw) return "draw";
  const ownPayoff = gameOver.data.result.payoffs[player.player_id];
  if (typeof ownPayoff !== "number") {
    return gameOver.data.result.winner === player.player_id ? "1st place" : "completed";
  }
  const higher = Object.values(gameOver.data.result.payoffs).filter((payoff) => payoff > ownPayoff).length;
  return `${ordinal(higher + 1)} place`;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function fullReplayURL(baseUrl: string, replayPath: string): string {
  try {
    return new URL(replayPath, `${baseUrl.replace(/\/+$/, "")}/`).toString();
  } catch {
    return replayPath;
  }
}

function readSummary(file: string): LocalMatchSessionSummary | null {
  const value = readJSONFile(file);
  if (!value || typeof value !== "object") return null;
  const summary = value as Partial<LocalMatchSessionSummary>;
  if (
    summary.version !== 1 ||
    typeof summary.agent_id !== "string" ||
    typeof summary.agent_name !== "string" ||
    typeof summary.session_id !== "string" ||
    (summary.status !== "active" && summary.status !== "completed")
  ) {
    return null;
  }
  return {
    version: 1,
    agent_id: summary.agent_id,
    agent_name: summary.agent_name,
    session_id: summary.session_id,
    status: summary.status,
    ...(typeof summary.game === "string" ? { game: summary.game } : {}),
    ...(typeof summary.mode === "string" ? { mode: summary.mode } : {}),
    ...(typeof summary.player_id === "string" ? { player_id: summary.player_id } : {}),
    started_at: typeof summary.started_at === "string" ? summary.started_at : "",
    updated_at: typeof summary.updated_at === "string" ? summary.updated_at : "",
    ...(typeof summary.ended_at === "string" ? { ended_at: summary.ended_at } : {}),
    ...(typeof summary.real_match_id === "string" ? { real_match_id: summary.real_match_id } : {}),
    ...(typeof summary.replay_url === "string" ? { replay_url: summary.replay_url } : {}),
    ...(typeof summary.result_label === "string" ? { result_label: summary.result_label } : {}),
    ...(typeof summary.player_count === "number" ? { player_count: summary.player_count } : {}),
    ...(typeof summary.event_count === "number" ? { event_count: summary.event_count } : {}),
    ...(typeof summary.event_seq_max === "number" ? { event_seq_max: summary.event_seq_max } : {}),
    inbound_count: typeof summary.inbound_count === "number" ? summary.inbound_count : 0,
    outbound_count: typeof summary.outbound_count === "number" ? summary.outbound_count : 0,
    decision_count: typeof summary.decision_count === "number" ? summary.decision_count : 0,
    final_action_count: typeof summary.final_action_count === "number" ? summary.final_action_count : 0,
    strategy_hashes: Array.isArray(summary.strategy_hashes)
      ? summary.strategy_hashes.filter((v): v is string => typeof v === "string")
      : [],
    ...(typeof summary.self_review_at === "string" ? { self_review_at: summary.self_review_at } : {}),
    ...(typeof summary.token_truncation_count === "number" ? { token_truncation_count: summary.token_truncation_count } : {}),
    ...(typeof summary.truncated_profile === "string" ? { truncated_profile: summary.truncated_profile } : {}),
    ...(coerceErrorClassCounts(summary.error_class_counts) !== undefined
      ? { error_class_counts: coerceErrorClassCounts(summary.error_class_counts) }
      : {}),
  };
}

/** Keep only string→positive-number entries when reading a persisted summary. */
function coerceErrorClassCounts(value: unknown): Record<string, number> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function stripPath(item: LocalMatchSessionListItem): LocalMatchSessionSummary {
  const { path: _path, ...summary } = item;
  return summary;
}

function readStrategySnapshot(file: string): {
  readonly sections: Record<string, unknown>;
} {
  const value = readJSONFile(file);
  if (!value || typeof value !== "object") return { sections: {} };
  const sections = (value as { sections?: unknown }).sections;
  return sections && typeof sections === "object" && !Array.isArray(sections)
    ? { sections: sections as Record<string, unknown> }
    : { sections: {} };
}

function readJSONFile(file: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function readJSONLines(file: string): unknown[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as unknown);
    } catch {
      out.push({ parse_error: true, raw: line });
    }
  }
  return out;
}

function writeJSONFile(file: string, value: unknown): void {
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodPrivateFile(tmp);
  fs.renameSync(tmp, file);
  chmodPrivateFile(file);
}

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // Best effort only; the user's filesystem may not support POSIX modes.
    }
  }
}

function chmodPrivateFile(file: string): void {
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort only.
  }
}

function safePathSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  return safe.length > 0 ? safe : "unknown";
}

function mergeHashes(existing: readonly string[], next: readonly string[]): readonly string[] {
  return [...new Set([...existing, ...next])].sort();
}

function sha256JSON(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stringifyCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}
