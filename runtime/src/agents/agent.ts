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
  type ReconnectStateHandler,
  type ReconnectStateSnapshot,
} from "../wsclient/reconnect";
import type { WSClientMessage } from "../wsclient/client";
import type { ServerMessageEnvelope } from "../wsclient/frame-handler";
import { WSDeviceMismatchError, WSProtocolVersionError, type WSClientError } from "../wsclient/errors";
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
  /** Abort handle for an IN-FLIGHT start()'s first connect only (审查 F5).
   *  Null once the connect settles — later stops go through client.close(). */
  #startAbort: AbortController | null = null;
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
    // Abortable in-flight start (redesign, 审查 F5): with the server down the
    // first-connect promise legitimately PENDS (transient failures retry
    // forever), and a stop() that merely waited for it would hang the host's
    // shutdown for as long as the outage lasts. stop() aborts this controller
    // instead — the facade rejects promptly and start() surfaces the stop.
    // Chained onto the caller's own signal so an external abort still lands.
    const startAbort = new AbortController();
    this.#startAbort = startAbort;
    const upstream = this.#opts.ws.signal;
    const relayAbort = (): void => startAbort.abort(upstream?.reason);
    if (upstream !== undefined) {
      if (upstream.aborted) relayAbort();
      else upstream.addEventListener("abort", relayAbort, { once: true });
    }
    let client: ReconnectingWSClient;
    try {
      client = await connect({ ...this.#opts.ws, signal: startAbort.signal });
    } catch (e) {
      throw new AgentInstanceStartError(
        `failed to start agent '${this.#opts.name}': ${stringifyCause(e)}`,
        e,
      );
    } finally {
      // Once the connect settles the controller's job is done: a LATER stop()
      // must go through client.close() (caller-close semantics), never through
      // a lifecycle abort that would reclassify the shutdown as kind=signal.
      this.#startAbort = null;
      if (upstream !== undefined) upstream.removeEventListener("abort", relayAbort);
    }
    if (client.welcome === null) {
      throw new AgentInstanceStartError(
        `failed to start agent '${this.#opts.name}': reconnect client returned without welcome`,
      );
    }

    // stop() may have run while we were connecting. It could not close this
    // client — #client was still null when it looked — so honouring the stop is
    // our job, and skipping it would leave a LIVE connection nobody holds a
    // reference to. That is the exact state the machine-wide seat lock exists to
    // prevent: the caller that gave up has already handed the seat to another
    // client, and this socket would sit underneath it, reconnecting forever.
    if (this.#stopped) {
      try {
        await client.close(1000, "agent stopped while connecting");
      } catch {
        // The connection is being abandoned either way.
      }
      throw new AgentInstanceStoppedError(`agent '${this.#opts.name}' has been stopped`);
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

    // A start still connecting (server down → first-connect pends forever) is
    // aborted, not waited out (审查 F5) — see the controller in start().
    this.#startAbort?.abort();

    // R13-F02: cancel any in-flight decisions so their paid provider calls stop
    // rather than run to completion after the agent is gone. Runs BEFORE the
    // close await (R15 2026-07-26): a close() that hangs or throws must never
    // delay or skip these aborts.
    for (const decision of this.#activeDecisions.values()) {
      decision.controller.abort(new DecisionSupersededError(decision.matchId, "stopped"));
    }
    this.#activeDecisions.clear();

    const client = this.#client;
    try {
      if (client !== null && client.state !== "closed") {
        await client.close(1000, reason);
      }
    } finally {
      // The FSM must record the stop even when close() rejects (R15 2026-07-26).
      if (this.#state !== null) {
        this.#apply({ type: "stop", reason });
      }
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

  // ── Reconnect-redesign passthroughs (2026-07-25) — thin by design: the
  // facade owns the semantics; these only exist so hosts reach it through the
  // instance without holding the raw client. ──

  /** Wake the reconnect loop now (P2): backoff → dial, parked → probe,
   *  suspended → resume. Safe no-op before start / after stop. */
  poke(): void {
    this.#client?.poke();
  }

  /** Non-terminal sleep parking (P5): hand the seat back gracefully and stop
   *  scheduling retries until poke(). Safe no-op before start / after stop. */
  suspendConnection(): void {
    this.#client?.suspend();
  }

  /** Live connection-state projection (P4). The handler also fires once
   *  immediately with the standing snapshot. Returns an unsubscribe. */
  onConnectionStateChange(handler: ReconnectStateHandler): () => void {
    return this.#requireClient().onStateChange(handler);
  }

  /** Pull counterpart of onConnectionStateChange, null before start. */
  connectionSnapshot(): ReconnectStateSnapshot | null {
    return this.#client?.snapshot() ?? null;
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
        this.#invokeHostHook("onServerMessage", () => this.#opts.onServerMessage?.(message));
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
        // 连接审计 #6: a protocol-version close needs its own code — hosts used
        // to fold it into the generic "reconnect gave up, retry" banner, and
        // retrying an incompatible client is the one thing that can't help.
        if (isVersionMismatchCause(info.cause)) {
          this.#notify({
            level: "error",
            code: "agent.version_mismatch",
            message: "protocol version mismatch — this client is too old for the server; update it",
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
        this.#send(effect.message, effect.restoreOnFailure);
        return;
      case "request_decision":
        await this.#requestDecision(effect);
        return;
      case "fallback_required":
        this.#invokeHostHook("onFallbackRequired", () => this.#opts.onFallbackRequired?.(effect));
        this.#notify({
          level: "warning",
          code: "agent.fallback_required",
          message: `Decision failed for match ${effect.actionRequest.data.match_id}; fallback required`,
          cause: effect.reason,
        });
        return;
      case "record_result":
        this.#invokeHostHook("onResult", () =>
          this.#opts.onResult?.(effect.gameOver, effect.game !== undefined ? { game: effect.game } : {}),
        );
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

  #send(message: WSClientMessage, restoreOnFailure?: MsgActionRequest): void {
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
      // D2 (windows-loop): tell the FSM. This used to stop at the log line, so
      // the FSM went on believing the message had gone out — for an `action`
      // that means the agent thinks it answered, the server never got an answer,
      // and the turn times out into a judged loss. Feeding it back lets the FSM
      // put the turn back and re-open the duplicate gate for a redelivery.
      if (this.#state !== null && this.#state.phase !== "closed") {
        this.#apply({
          type: "send.failed",
          message,
          ...(restoreOnFailure !== undefined ? { restore: restoreOnFailure } : {}),
          cause: e,
        });
      }
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

  // D1 (windows-loop): every term here must be PER MATCH. This used to require
  // `state.phase === "deciding"`, and phase is one scalar shared by all
  // concurrent matches — so another match's game_start (or a queue join) lowered
  // it and this match's finished, already-paid-for decision was dropped as
  // "stale" before it ever reached the FSM, leaving the turn unanswered for the
  // server to judge a forfeit.
  //
  // Now that phase is derived, that term would be redundant rather than harmful
  // (a pending action derives "deciding"), so this change is defence in depth,
  // not a second independent fix — the state-machine change alone closes the
  // bug. What the term was actually protecting is kept explicitly below: do not
  // feed a decision to an agent that has been stopped.
  #isDecisionCurrent(token: number, matchId: string): boolean {
    const state = this.#state;
    if (this.#stopped || state === null || state.phase === "closed") return false;
    const active = this.#activeDecisions.get(matchId);
    const pendingAction =
      state.pendingActions?.[matchId] ??
      (state.pendingAction?.data.match_id === matchId ? state.pendingAction : undefined);
    return (
      active?.token === token &&
      active.matchId === matchId &&
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
      this.#invokeHostHook("onState", () => handler(snapshot));
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

  /** Dispatch one host callback with isolation (R15 2026-07-26): hosts run
   *  arbitrary code in these hooks, and a throw must never escape into the
   *  FSM/effect pipeline — it would drop queued effects (e.g. #apply's
   *  #emitState runs before #enqueueEffects) or surface as an unhandled
   *  rejection. Failures are contained and reported through #notify. */
  #invokeHostHook(hook: string, fn: () => void): void {
    try {
      fn();
    } catch (cause) {
      this.#notify({
        level: "error",
        code: "agent.host_callback",
        message: `Host callback ${hook} failed: ${stringifyCause(cause)}`,
        cause,
      });
    }
  }

  #notify(event: AgentInstanceNotify): void {
    try {
      this.#opts.onNotify?.(event);
    } catch {
      // Terminal channel (R15 2026-07-26): a throwing onNotify has nowhere
      // further to report and must not break its caller — #notify is invoked
      // from error paths (effect-queue catch, ws error handlers) where a
      // throw would become an unhandled rejection or kill the dispatch loop.
    }
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

/** Same chain walk as isDeviceMismatchCause, for the protocol-version close
 *  (连接审计 #6). instanceof first; message fallback for cross-bundle copies. */
function isVersionMismatchCause(cause: unknown): boolean {
  let cur: unknown = cause;
  const seen = new Set<unknown>();
  while (cur !== null && cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    if (cur instanceof WSProtocolVersionError) return true;
    if (cur instanceof Error && /protocol[ _-]version/i.test(cur.message)) return true;
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
  // Whitelist EXACTLY the fields client_runtime_status.schema.json allows
  // (additionalProperties:false): anything else the handler returns would make
  // serializeClientMessage reject the whole envelope — which is how the 1B
  // capacity fields (active_matches/max_concurrent) silently killed every
  // readiness reply until 2026-07-30. Handler-returned extras belong in
  // `detail`, not in top-level keys.
  const src = status && typeof status === "object"
    ? (status as Record<string, unknown>)
    : {};
  const base: Record<string, unknown> = {};
  if (typeof src.request_id === "string") base.request_id = src.request_id;
  if (typeof src.ready === "boolean") base.ready = src.ready;
  if (src.runtime_type === "direct" || src.runtime_type === "mock") {
    base.runtime_type = src.runtime_type;
  }
  if (typeof src.runtime_name === "string") base.runtime_name = src.runtime_name;
  if (typeof src.checked_at === "string") base.checked_at = src.checked_at;
  if (typeof src.detail === "string") base.detail = truncateDetail(src.detail);
  if (typeof base.request_id !== "string") base.request_id = fallbackRequestId;
  if (typeof base.ready !== "boolean") base.ready = false;
  if (base.runtime_type === undefined) base.runtime_type = "direct";
  if (typeof base.checked_at !== "string") base.checked_at = new Date().toISOString();
  return base;
}

function truncateDetail(detail: string): string {
  return detail.length > 240 ? detail.slice(0, 240) : detail;
}
