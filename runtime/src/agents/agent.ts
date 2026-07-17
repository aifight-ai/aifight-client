// M1-09 AgentInstance wiring layer.
//
// This class owns one agent's lifecycle and bridges the pure M1-08 FSM
// to injected runtime dependencies. It does not read credentials, open
// SQLite, call model providers directly, or route multiple agents.

import type { MsgActionRequest, MsgGameOver } from "../protocol/types";
import {
  createReconnectingWSClient,
  type ReconnectingWSClient,
  type ReconnectingWSClientOptions,
  type ReconnectCloseInfo,
} from "../wsclient/reconnect";
import type { WSClientMessage } from "../wsclient/client";
import type { ServerMessageEnvelope } from "../wsclient/frame-handler";
import { WSDeviceMismatchError, type WSClientError } from "../wsclient/errors";
import {
  createInitialAgentFSM,
  transitionAgentFSM,
  type AgentDecisionWireDecision,
  type AgentDecisionWireUsage,
  type AgentFSMEffect,
  type AgentFSMInput,
  type AgentFSMState,
} from "./state-machine";
import { DecisionSupersededError } from "./decision-abort";

export type { AgentDecisionWireDecision, AgentDecisionWireUsage } from "./state-machine";

export interface AgentDecisionContext {
  readonly actionRequest: MsgActionRequest;
  readonly matchId: string;
  readonly game?: string;
  readonly state: AgentFSMState;
  /**
   * Aborts when this decision is superseded by a newer action_request for the
   * same match (or the agent stops). Providers that make a paid network call
   * SHOULD forward this to the request so a superseded decision cancels its
   * in-flight HTTP call instead of running to completion (R13-F02). Optional so
   * existing/mock providers keep working unchanged.
   */
  readonly signal?: AbortSignal;
}

/**
 * Structured decision result: the chosen action plus optional model usage
 * metadata (protocol v1.1) and optional decision-provenance telemetry
 * (protocol v1.2, F09) to attach to the outgoing action message.
 * Providers may also return the bare action (legacy shape) — the agent
 * unwraps both. The wrapper is recognized by its exact key set
 * ({action} plus any of usage/decision); real game actions always carry a
 * `type` key instead, so the two shapes cannot collide.
 */
export interface AgentDecisionOutput {
  readonly action: unknown;
  readonly usage?: AgentDecisionWireUsage;
  readonly decision?: AgentDecisionWireDecision;
}

export interface AgentDecisionProvider {
  decide(ctx: AgentDecisionContext): Promise<unknown | AgentDecisionOutput>;
}

function isAgentDecisionOutput(value: unknown): value is AgentDecisionOutput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.includes("action") && keys.every((k) => k === "action" || k === "usage" || k === "decision");
}

export interface AgentInstanceNotify {
  readonly level: "info" | "warning" | "error";
  readonly code: string;
  readonly message: string;
  readonly cause?: unknown;
}

export interface AgentInstanceSnapshot {
  readonly name: string;
  readonly state: AgentFSMState | null;
  readonly transport: ReconnectingWSClient["state"] | "idle";
  readonly started: boolean;
  readonly stopped: boolean;
}

export interface AgentInstanceOptions {
  readonly name: string;
  readonly ws: ReconnectingWSClientOptions;
  readonly autoConfirmMatches?: boolean;
  readonly decisionProvider: AgentDecisionProvider;
  readonly connect?: (opts: ReconnectingWSClientOptions) => Promise<ReconnectingWSClient>;
  readonly now?: () => number;
  readonly onNotify?: (event: AgentInstanceNotify) => void;
  readonly onServerMessage?: (message: ServerMessageEnvelope) => void;
  readonly onClientMessage?: (message: WSClientMessage) => void;
  readonly onReadinessCheck?: (data: unknown) => Promise<unknown> | unknown;
  readonly onResult?: (gameOver: MsgGameOver, context: { readonly game?: string }) => void;
  readonly onFallbackRequired?: (effect: Extract<AgentFSMEffect, { type: "fallback_required" }>) => void;
}

export type AgentInstanceErrorKind =
  | "agent_start"
  | "agent_not_started"
  | "agent_stopped"
  | "agent_effect";

export abstract class AgentInstanceError extends Error {
  abstract readonly kind: AgentInstanceErrorKind;
  readonly cause: unknown;

  protected constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

export class AgentInstanceStartError extends AgentInstanceError {
  override readonly name = "AgentInstanceStartError";
  override readonly kind = "agent_start" as const;
  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

export class AgentInstanceNotStartedError extends AgentInstanceError {
  override readonly name = "AgentInstanceNotStartedError";
  override readonly kind = "agent_not_started" as const;
  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

export class AgentInstanceStoppedError extends AgentInstanceError {
  override readonly name = "AgentInstanceStoppedError";
  override readonly kind = "agent_stopped" as const;
  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

export class AgentInstanceEffectError extends AgentInstanceError {
  override readonly name = "AgentInstanceEffectError";
  override readonly kind = "agent_effect" as const;
  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

type StateHandler = (snapshot: AgentInstanceSnapshot) => void;

interface ActiveDecision {
  readonly token: number;
  readonly matchId: string;
  /** Aborted when this decision is superseded (or the agent stops) so the
   *  in-flight provider call can cancel its paid HTTP request (R13-F02). */
  readonly controller: AbortController;
  /** The action_request `request_id` this decision answers (every
   *  action_request carries one since the 2026-07-16 v1.2 enforcement;
   *  kept optional here as defensive internal bookkeeping only). */
  readonly requestId?: string;
}

export class AgentInstance {
  readonly #opts: AgentInstanceOptions;
  #client: ReconnectingWSClient | null = null;
  #state: AgentFSMState | null = null;
  #started = false;
  #stopped = false;
  #unsubs: Array<() => void> = [];
  #stateHandlers = new Set<StateHandler>();
  #effectQueue: Promise<void> = Promise.resolve();
  #decisionSeq = 0;
  #activeDecisions = new Map<string, ActiveDecision>();

  constructor(opts: AgentInstanceOptions) {
    this.#opts = opts;
  }

  async start(): Promise<AgentInstanceSnapshot> {
    if (this.#stopped) {
      throw new AgentInstanceStoppedError(`agent '${this.#opts.name}' has been stopped`);
    }
    if (this.#started) {
      throw new AgentInstanceStartError(`agent '${this.#opts.name}' is already started`);
    }

    const connect = this.#opts.connect ?? createReconnectingWSClient;
    let client: ReconnectingWSClient;
    try {
      client = await connect(this.#opts.ws);
    } catch (e) {
      throw new AgentInstanceStartError(
        `failed to start agent '${this.#opts.name}': ${stringifyCause(e)}`,
        e,
      );
    }
    if (client.welcome === null) {
      throw new AgentInstanceStartError(
        `failed to start agent '${this.#opts.name}': reconnect client returned without welcome`,
      );
    }

    this.#client = client;
    this.#state = createInitialAgentFSM({
      welcome: client.welcome,
      autoConfirmMatches: this.#opts.autoConfirmMatches,
      now: this.#now(),
    });
    this.#started = true;
    this.#registerClientHandlers(client);
    this.#emitState();
    return this.snapshot();
  }

  async stop(reason = "agent stop"): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#cleanupHandlers();

    const client = this.#client;
    if (client !== null && client.state !== "closed") {
      await client.close(1000, reason);
    }
    // R13-F02: cancel any in-flight decisions so their paid provider calls stop
    // rather than run to completion after the agent is gone.
    for (const decision of this.#activeDecisions.values()) {
      decision.controller.abort(new DecisionSupersededError(decision.matchId, "stopped"));
    }
    this.#activeDecisions.clear();
    if (this.#state !== null) {
      this.#apply({ type: "stop", reason });
    }
  }

  joinQueue(game: string, mode?: string, opts: { readonly oneShot?: boolean } = {}): void {
    this.#ensureReadyForCommand();
    this.#apply({ type: "command.join_queue", game, mode, oneShot: opts.oneShot });
  }

  leaveQueue(): void {
    this.#ensureReadyForCommand();
    this.#apply({ type: "command.leave_queue" });
  }

  confirmMatch(confirmId?: string): void {
    this.#ensureReadyForCommand();
    this.#apply({ type: "command.confirm_match", confirmId });
  }

  snapshot(): AgentInstanceSnapshot {
    return {
      name: this.#opts.name,
      state: this.#state,
      transport: this.#client?.state ?? "idle",
      started: this.#started,
      stopped: this.#stopped,
    };
  }

  /** Number of matches with a decision currently in flight — the local "busy"
   *  signal for the Phase 1B readiness handshake (no LLM call involved). */
  get activeMatchCount(): number {
    return this.#activeDecisions.size;
  }

  onState(handler: StateHandler): () => void {
    this.#stateHandlers.add(handler);
    return () => {
      this.#stateHandlers.delete(handler);
    };
  }

  #registerClientHandlers(client: ReconnectingWSClient): void {
    this.#unsubs.push(
      client.onMessage((message) => {
        if (message.type === "readiness_check") {
          void this.#handleReadinessCheck(message.data);
          return;
        }
        this.#opts.onServerMessage?.(message);
        this.#apply({ type: "ws.message", message, now: this.#now() });
      }),
      client.onReconnect((event) => {
        this.#apply({ type: "reconnect.event", event });
      }),
      client.onClose((info) => {
        if (isDeviceMismatchCause(info.cause)) {
          this.#notify({
            level: "error",
            code: "agent.device_mismatch",
            message: "device_mismatch",
            cause: info.cause,
          });
        }
        this.#apply({ type: "reconnect.close", info });
      }),
      client.onError((cause) => {
        this.#notifyFromClientError(cause);
      }),
    );
  }

  async #handleReadinessCheck(data: unknown): Promise<void> {
    const requestId = readRequestId(data);
    try {
      const status = this.#opts.onReadinessCheck
        ? await this.#opts.onReadinessCheck(data)
        : {
            request_id: requestId,
            ready: false,
            runtime_type: "mock",
            checked_at: new Date().toISOString(),
            detail: "readiness check handler is not configured",
          };
      this.#send({ type: "runtime_status", data: normalizeReadinessStatus(status, requestId) });
    } catch (cause) {
      this.#send({
        type: "runtime_status",
        data: {
          request_id: requestId,
          ready: false,
          runtime_type: "mock",
          checked_at: new Date().toISOString(),
          detail: truncateDetail(`readiness check failed: ${stringifyCause(cause)}`),
        },
      });
    }
  }

  #apply(input: AgentFSMInput): void {
    const state = this.#requireState();
    const next = transitionAgentFSM(state, input);
    this.#state = next.state;
    this.#emitState();
    this.#enqueueEffects(next.effects);
  }

  #enqueueEffects(effects: readonly AgentFSMEffect[]): void {
    if (effects.length === 0) return;
    const serialEffects: AgentFSMEffect[] = [];
    for (const effect of effects) {
      if (effect.type === "request_decision") {
        void this.#runDecisionEffect(effect);
      } else {
        serialEffects.push(effect);
      }
    }
    if (serialEffects.length === 0) return;
    this.#effectQueue = this.#effectQueue
      .then(() => this.#runEffects(serialEffects))
      .catch((cause: unknown) => {
        this.#notify({
          level: "error",
          code: "agent.effect_queue",
          message: `Agent effect queue failed: ${stringifyCause(cause)}`,
          cause,
        });
      });
  }

  async #runEffects(effects: readonly AgentFSMEffect[]): Promise<void> {
    for (const effect of effects) {
      await this.#runEffect(effect);
    }
  }

  async #runEffect(effect: AgentFSMEffect): Promise<void> {
    switch (effect.type) {
      case "send":
        this.#send(effect.message);
        return;
      case "request_decision":
        await this.#requestDecision(effect);
        return;
      case "fallback_required":
        this.#opts.onFallbackRequired?.(effect);
        this.#notify({
          level: "warning",
          code: "agent.fallback_required",
          message: `Decision failed for match ${effect.actionRequest.data.match_id}; fallback required`,
          cause: effect.reason,
        });
        return;
      case "record_result":
        this.#opts.onResult?.(effect.gameOver, effect.game !== undefined ? { game: effect.game } : {});
        return;
      case "notify":
        this.#notify(effect);
        return;
    }
  }

  async #runDecisionEffect(effect: Extract<AgentFSMEffect, { type: "request_decision" }>): Promise<void> {
    try {
      await this.#requestDecision(effect);
    } catch (cause) {
      this.#notify({
        level: "error",
        code: "agent.decision_effect",
        message: `Decision effect failed for match ${effect.matchId}: ${stringifyCause(cause)}`,
        cause,
      });
    }
  }

  #send(message: WSClientMessage): void {
    const client = this.#requireClient();
    try {
      client.send(message);
      this.#opts.onClientMessage?.(message);
    } catch (e) {
      this.#notify({
        level: "error",
        code: "agent.send_failed",
        message: `Failed to send ${message.type}: ${stringifyCause(e)}`,
        cause: new AgentInstanceEffectError(`send ${message.type} failed`, e),
      });
    }
  }

  async #requestDecision(effect: Extract<AgentFSMEffect, { type: "request_decision" }>): Promise<void> {
    const token = ++this.#decisionSeq;
    // R13-F02 abort-on-supersede: a newer action_request for THIS match replaces
    // the map entry; abort the previous decision's controller first so its
    // in-flight (paid) provider call is cancelled rather than left running and
    // its result discarded. Separate controllers per decision — aborting the old
    // one never touches the new one.
    const previous = this.#activeDecisions.get(effect.matchId);
    if (previous !== undefined) {
      previous.controller.abort(new DecisionSupersededError(effect.matchId));
    }
    const controller = new AbortController();
    this.#activeDecisions.set(effect.matchId, {
      token,
      matchId: effect.matchId,
      controller,
      ...(effect.requestId !== undefined ? { requestId: effect.requestId } : {}),
    });
    const stateAtRequest = this.#requireState();
    try {
      const decided = await this.#opts.decisionProvider.decide({
        actionRequest: effect.actionRequest,
        matchId: effect.matchId,
        game: effect.game,
        state: stateAtRequest,
        signal: controller.signal,
      });
      const { action, usage, decision } = isAgentDecisionOutput(decided)
        ? { action: decided.action, usage: decided.usage, decision: decided.decision }
        : { action: decided, usage: undefined, decision: undefined };
      if (!this.#isDecisionCurrent(token, effect.matchId)) {
        this.#notify({
          level: "warning",
          code: "agent.stale_decision",
          message: `Ignoring stale decision for match ${effect.matchId}`,
        });
        this.#clearDecisionIfCurrent(token, effect.matchId);
        return;
      }
      this.#apply({
        type: "decision.ready",
        action,
        matchId: effect.matchId,
        ...(usage !== undefined ? { usage } : {}),
        ...(decision !== undefined ? { decision } : {}),
      });
      this.#clearDecisionIfCurrent(token, effect.matchId);
    } catch (e) {
      if (!this.#isDecisionCurrent(token, effect.matchId)) {
        this.#notify({
          level: "warning",
          code: "agent.stale_decision",
          message: `Ignoring stale decision failure for match ${effect.matchId}`,
          cause: e,
        });
        this.#clearDecisionIfCurrent(token, effect.matchId);
        return;
      }
      this.#apply({ type: "decision.failed", reason: e, matchId: effect.matchId });
      this.#clearDecisionIfCurrent(token, effect.matchId);
    }
  }

  #isDecisionCurrent(token: number, matchId: string): boolean {
    const state = this.#state;
    const active = this.#activeDecisions.get(matchId);
    const pendingAction =
      state?.pendingActions?.[matchId] ??
      (state?.pendingAction?.data.match_id === matchId ? state.pendingAction : undefined);
    return (
      active?.token === token &&
      active.matchId === matchId &&
      state?.phase === "deciding" &&
      pendingAction !== undefined
    );
  }

  #clearDecisionIfCurrent(token: number, matchId: string): void {
    const active = this.#activeDecisions.get(matchId);
    if (active?.token === token) {
      this.#activeDecisions.delete(matchId);
    }
  }

  #ensureReadyForCommand(): void {
    if (!this.#started || this.#state === null || this.#client === null) {
      throw new AgentInstanceNotStartedError(`agent '${this.#opts.name}' is not started`);
    }
    if (this.#stopped || this.#state.phase === "closed") {
      throw new AgentInstanceStoppedError(`agent '${this.#opts.name}' is stopped`);
    }
  }

  #requireClient(): ReconnectingWSClient {
    if (this.#client === null) {
      throw new AgentInstanceNotStartedError(`agent '${this.#opts.name}' is not started`);
    }
    return this.#client;
  }

  #requireState(): AgentFSMState {
    if (this.#state === null) {
      throw new AgentInstanceNotStartedError(`agent '${this.#opts.name}' is not started`);
    }
    return this.#state;
  }

  #emitState(): void {
    const snapshot = this.snapshot();
    for (const handler of [...this.#stateHandlers]) {
      handler(snapshot);
    }
  }

  #cleanupHandlers(): void {
    const unsubs = this.#unsubs;
    this.#unsubs = [];
    for (const unsub of unsubs) {
      unsub();
    }
  }

  #notifyFromClientError(cause: WSClientError): void {
    this.#notify({
      level: "error",
      code: "agent.ws_error",
      message: cause.message,
      cause,
    });
  }

  #notify(event: AgentInstanceNotify): void {
    this.#opts.onNotify?.(event);
  }

  #now(): number {
    return this.#opts.now?.() ?? Date.now();
  }
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

function isDeviceMismatchCause(cause: unknown): boolean {
  let cur: unknown = cause;
  const seen = new Set<unknown>();
  while (cur !== null && cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    if (cur instanceof WSDeviceMismatchError) return true;
    // Fallbacks for when `instanceof` fails (the error class can be duplicated
    // across bundles): match the actual message ("device mismatch: ...", a
    // space) as well as the server's "device_mismatch" token, and duck-type the
    // 403 handshake body which always carries "device_mismatch".
    if (cur instanceof Error && /device[ _]mismatch/i.test(cur.message)) return true;
    if (typeof cur === "object" && cur !== null && "responseBody" in cur) {
      const body = (cur as { readonly responseBody?: unknown }).responseBody;
      if (typeof body === "string" && body.includes("device_mismatch")) return true;
    }
    if (typeof cur === "object" && "cause" in cur) {
      cur = (cur as { readonly cause?: unknown }).cause;
      continue;
    }
    break;
  }
  return false;
}

function readRequestId(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const value = (data as Record<string, unknown>).request_id;
  return typeof value === "string" ? value : "";
}

function normalizeReadinessStatus(status: unknown, fallbackRequestId: string): Record<string, unknown> {
  const base = status && typeof status === "object"
    ? { ...(status as Record<string, unknown>) }
    : {};
  if (typeof base.request_id !== "string") base.request_id = fallbackRequestId;
  if (typeof base.ready !== "boolean") base.ready = false;
  if (base.runtime_type !== "direct" && base.runtime_type !== "mock") {
    base.runtime_type = "direct";
  }
  if (typeof base.checked_at !== "string") base.checked_at = new Date().toISOString();
  if (typeof base.detail === "string") {
    base.detail = truncateDetail(base.detail);
  }
  return base;
}

function truncateDetail(detail: string): string {
  return detail.length > 240 ? detail.slice(0, 240) : detail;
}
