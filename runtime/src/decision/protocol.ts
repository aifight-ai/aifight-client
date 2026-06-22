import type { AgentDecisionContext } from "../agents/agent";
import type { Action, Event, PlayerInfo } from "../protocol/types";

export const DECISION_PROTOCOL_VERSION = "aifight.decision.v1";

export interface DecisionProtocolStrategySection {
  readonly name: "general" | "game";
  readonly format: "markdown";
  readonly sha256?: string;
  readonly content?: string;
}

export interface DecisionProtocolRequest {
  readonly type: "aifight.decision.request";
  readonly protocol_version: typeof DECISION_PROTOCOL_VERSION;
  readonly request_id: string;
  readonly agent: {
    readonly id: string;
    readonly name: string;
  };
  readonly match: {
    readonly session_id: string;
    readonly game?: string;
  };
  readonly turn: {
    readonly timeout_ms: number;
    readonly deadline_at?: string;
    readonly is_reconnect: boolean;
    readonly retry: boolean;
    readonly retry_reason?: string;
    readonly retries_left?: number;
  };
  readonly context: {
    readonly state: unknown;
    readonly legal_actions: readonly Action[];
    readonly players: readonly PlayerInfo[];
    readonly events: readonly Event[];
  };
  readonly strategy?: readonly DecisionProtocolStrategySection[];
}

export interface DecisionProtocolResponse {
  readonly type?: "aifight.decision.action";
  readonly protocol_version?: typeof DECISION_PROTOCOL_VERSION;
  readonly request_id?: string;
  readonly action: unknown;
  readonly summary?: string;
  readonly metadata?: Record<string, unknown>;
}

export class DecisionProtocolResponseError extends Error {
  override readonly name = "DecisionProtocolResponseError";
}

export interface BuildDecisionProtocolRequestOptions {
  readonly requestId?: string;
  readonly now?: Date;
  readonly strategy?: readonly DecisionProtocolStrategySection[];
}

export function buildDecisionProtocolRequest(
  ctx: AgentDecisionContext,
  opts: BuildDecisionProtocolRequestOptions = {},
): DecisionProtocolRequest {
  const data = ctx.actionRequest.data;
  const timeoutMs = typeof data.timeout_ms === "number" ? data.timeout_ms : 0;
  const events =
    data.is_reconnect === true && Array.isArray(data.event_history)
      ? data.event_history
      : data.new_events ?? [];
  const deadlineAt = opts.now && timeoutMs > 0
    ? new Date(opts.now.getTime() + timeoutMs).toISOString()
    : undefined;

  return {
    type: "aifight.decision.request",
    protocol_version: DECISION_PROTOCOL_VERSION,
    request_id: opts.requestId ?? `${ctx.matchId}:turn`,
    agent: {
      id: ctx.state.agentId,
      name: ctx.state.agentName,
    },
    match: {
      session_id: ctx.matchId,
      ...(ctx.game !== undefined ? { game: ctx.game } : {}),
    },
    turn: {
      timeout_ms: timeoutMs,
      ...(deadlineAt !== undefined ? { deadline_at: deadlineAt } : {}),
      is_reconnect: data.is_reconnect === true,
      retry: data.retry === true,
      ...(data.retry_reason !== undefined ? { retry_reason: data.retry_reason } : {}),
      ...(data.retries_left !== undefined ? { retries_left: data.retries_left } : {}),
    },
    context: {
      state: data.state,
      legal_actions: data.legal_actions ?? [],
      players: data.players ?? [],
      events,
    },
    ...(opts.strategy !== undefined ? { strategy: opts.strategy } : {}),
  };
}

export function readDecisionProtocolAction(response: unknown): unknown {
  if (!response || typeof response !== "object" || !("action" in response)) {
    throw new DecisionProtocolResponseError("decision protocol response must be an object with an action field");
  }
  const action = (response as DecisionProtocolResponse).action;
  if (action === undefined) {
    throw new DecisionProtocolResponseError("decision protocol response action must not be undefined");
  }
  return action;
}
