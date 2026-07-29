import { describe, expect, it, vi } from "vitest";

import {
  AgentInstance,
  AgentInstanceNotStartedError,
  AgentInstanceStartError,
  AgentInstanceStoppedError,
  type AgentDecisionProvider,
  type AgentInstanceNotify,
} from "../src/agents/agent";
import { DecisionSupersededError, isSupersededAbort } from "../src/agents/decision-abort";
import type {
  MsgActionRequest,
  MsgError,
  MsgGameOver,
  MsgGameStart,
  MsgMatchConfirmRequest,
} from "../src/protocol/types";
import type { ServerMessageEnvelope } from "../src/wsclient/frame-handler";
import type {
  ReconnectingWSClient,
  ReconnectStateSnapshot,
  ReconnectingWSClientOptions,
  ReconnectCloseHandler,
  ReconnectCloseInfo,
  ReconnectEvent,
  ReconnectEventHandler,
} from "../src/wsclient/reconnect";
import type {
  WSClientMessage,
  WSMessageHandler,
  WSErrorHandler,
  WSWelcome,
} from "../src/wsclient/client";
import { WSClosedError, WSDeviceMismatchError } from "../src/wsclient/errors";

const welcome: WSWelcome = {
  type: "welcome",
  data: {
    server_protocol_version: "v1.0.0",
    agent_id: "agent-1",
    agent_name: "Instance Agent",
    server_time: "2026-04-26T00:00:00Z",
    games: ["texas_holdem", "liars_dice", "coup"],
  },
};

class FakeReconnectClient implements ReconnectingWSClient {
  totalAttempts = 1;
  nextRetryAt: number | null = null;
  connectedAtMs: number | null = null;
  parkedReason: ReconnectStateSnapshot["parkedReason"] = null;
  onStateChange(handler: (snap: ReconnectStateSnapshot) => void): () => void {
    handler(this.snapshot());
    return () => {};
  }
  snapshot(): ReconnectStateSnapshot {
    return {
      state: this.state,
      attempt: this.attempt,
      totalAttempts: this.totalAttempts,
      nextRetryAt: this.nextRetryAt,
      connectedAt: this.connectedAtMs,
      welcome: this.welcome,
      parkedReason: this.parkedReason,
      authFailures: 0,
      seq: 0,
    };
  }
  poke(): void {}
  suspend(): void {}
  state: ReconnectingWSClient["state"] = "connected";
  attempt = 1;
  welcome: WSWelcome | null = welcome;
  readonly sent: WSClientMessage[] = [];
  closeCalls = 0;
  sendImpl: (msg: WSClientMessage) => void = (msg) => {
    this.sent.push(msg);
  };
  readonly messageHandlers = new Set<WSMessageHandler>();
  readonly errorHandlers = new Set<WSErrorHandler>();
  readonly closeHandlers = new Set<ReconnectCloseHandler>();
  readonly reconnectHandlers = new Set<ReconnectEventHandler>();

  send(msg: WSClientMessage): void {
    this.sendImpl(msg);
  }

  onMessage(handler: WSMessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onError(handler: WSErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  onClose(handler: ReconnectCloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  onReconnect(handler: ReconnectEventHandler): () => void {
    this.reconnectHandlers.add(handler);
    return () => this.reconnectHandlers.delete(handler);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.state = "closed";
  }

  emitMessage(msg: ServerMessageEnvelope): void {
    for (const handler of [...this.messageHandlers]) handler(msg);
  }

  emitReconnect(event: ReconnectEvent): void {
    for (const handler of [...this.reconnectHandlers]) handler(event);
  }

  emitClose(info: ReconnectCloseInfo = { kind: "fatal-close", code: 1006 }): void {
    this.state = "closed";
    for (const handler of [...this.closeHandlers]) handler(info);
  }

  emitError(err = new WSClosedError("frame error")): void {
    for (const handler of [...this.errorHandlers]) handler(err);
  }
}

function makeHarness(opts: Partial<{
  client: FakeReconnectClient;
  autoConfirmMatches: boolean;
  decisionProvider: AgentDecisionProvider;
  onServerMessage: (message: ServerMessageEnvelope) => void;
}> = {}) {
  const client = opts.client ?? new FakeReconnectClient();
  const connect = vi.fn(async (_ws: ReconnectingWSClientOptions) => client);
  const onNotify = vi.fn<(event: AgentInstanceNotify) => void>();
  const onResult = vi.fn<(msg: MsgGameOver, context: { readonly game?: string }) => void>();
  const onFallbackRequired = vi.fn();
  const decisionProvider = opts.decisionProvider ?? {
    decide: vi.fn(async () => ({ type: "fold" })),
  };
  const agent = new AgentInstance({
    name: "alpha",
    ws: {
      url: "ws://127.0.0.1:1/api/ws",
      apiKey: "sk-test",
      expectedProtocolVersion: "v1.0.0",
    },
    autoConfirmMatches: opts.autoConfirmMatches,
    connect,
    decisionProvider,
    ...(opts.onServerMessage !== undefined ? { onServerMessage: opts.onServerMessage } : {}),
    onNotify,
    onResult,
    onFallbackRequired,
    now: () => 42,
  });
  return { agent, client, connect, onNotify, onResult, onFallbackRequired, decisionProvider };
}

function confirmRequest(): MsgMatchConfirmRequest {
  return {
    type: "match_confirm_request",
    data: {
      confirm_id: "11111111-1111-4111-8111-111111111111",
      game: "coup",
      mode: "ranked",
      players: 3,
      timeout_ms: 30_000,
    },
  };
}

function gameStart(sessionId = "22222222-2222-4222-8222-222222222222"): MsgGameStart {
  return {
    type: "game_start",
    data: {
      match_id: sessionId,
      game: "coup",
      mode: "ranked",
      your_position: 0,
      player_id: "p0",
      players: [],
      rules: {},
      config: {},
    },
  } as unknown as MsgGameStart;
}

function actionRequest(sessionId = "22222222-2222-4222-8222-222222222222"): MsgActionRequest {
  return {
    type: "action_request",
    data: {
      match_id: sessionId,
      state: {},
      legal_actions: [{ type: "income" }],
      players: [],
      timeout_ms: 300_000,
      new_events: [],
    },
  } as unknown as MsgActionRequest;
}

function gameOver(sessionId = "22222222-2222-4222-8222-222222222222"): MsgGameOver {
  return {
    type: "game_over",
    data: {
      match_id: "33333333-3333-4333-8333-333333333333",
      session_id: sessionId,
      result: { winner: "p0", payoffs: { p0: 1, p1: -1 } },
      players: [],
    },
  } as unknown as MsgGameOver;
}

function serverError(message = "bad action"): MsgError {
  return { type: "error", data: { message } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

describe("AgentInstance", () => {
  it("start calls injected connect and seeds FSM from welcome", async () => {
    const { agent, connect } = makeHarness();

    const snapshot = await agent.start();

    expect(connect).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:1/api/ws",
      apiKey: "sk-test",
      expectedProtocolVersion: "v1.0.0",
      // 审查 F5: start() threads its own abort signal into the connect so a
      // stop() during a server outage can cancel instead of waiting forever.
      signal: expect.any(AbortSignal),
    });
    expect(snapshot.started).toBe(true);
    expect(snapshot.state?.agentId).toBe("agent-1");
    expect(snapshot.state?.phase).toBe("connected");
  });

  it("start registers message, reconnect, close, and error handlers", async () => {
    const { agent, client } = makeHarness();

    await agent.start();

    expect(client.messageHandlers.size).toBe(1);
    expect(client.reconnectHandlers.size).toBe(1);
    expect(client.closeHandlers.size).toBe(1);
    expect(client.errorHandlers.size).toBe(1);
  });

  it("joinQueue sends join_queue through the reconnect client", async () => {
    const { agent, client } = makeHarness();
    await agent.start();

    agent.joinQueue("coup");
    await flushEffects();

    expect(client.sent).toEqual([{ type: "join_queue", data: { game: "coup", mode: "ranked" } }]);
    expect(agent.snapshot().state?.phase).toBe("queuing");
  });

  it("leaveQueue sends leave_queue after queued", async () => {
    const { agent, client } = makeHarness();
    await agent.start();
    agent.joinQueue("coup");
    await flushEffects();

    agent.leaveQueue();
    await flushEffects();

    expect(client.sent.at(-1)).toEqual({ type: "leave_queue" });
    expect(agent.snapshot().state?.phase).toBe("connected");
  });

  it("manual confirm flow sends match_confirm when caller confirms", async () => {
    const { agent, client } = makeHarness({ autoConfirmMatches: false });
    await agent.start();

    client.emitMessage(confirmRequest());
    await flushEffects();
    expect(agent.snapshot().state?.phase).toBe("confirming");

    agent.confirmMatch();
    await flushEffects();

    expect(client.sent.at(-1)).toEqual({
      type: "match_confirm",
      data: { confirm_id: "11111111-1111-4111-8111-111111111111" },
    });
  });

  it("auto confirm sends match_confirm without caller command", async () => {
    const { agent, client } = makeHarness({ autoConfirmMatches: true });
    await agent.start();

    client.emitMessage(confirmRequest());
    await flushEffects();

    expect(client.sent).toEqual([
      {
        type: "match_confirm",
        data: { confirm_id: "11111111-1111-4111-8111-111111111111" },
      },
    ]);
  });

  it("action_request calls the injected decision provider with context", async () => {
    const d = deferred<unknown>();
    const decisionProvider = { decide: vi.fn(() => d.promise) };
    const { agent, client } = makeHarness({ decisionProvider });
    await agent.start();
    client.emitMessage(gameStart());

    client.emitMessage(actionRequest());
    await flushEffects();

    expect(decisionProvider.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        matchId: "22222222-2222-4222-8222-222222222222",
        game: "coup",
      }),
    );
    expect(agent.snapshot().state?.phase).toBe("deciding");
  });

  it("decision success feeds decision.ready and sends action", async () => {
    const d = deferred<unknown>();
    const decisionProvider = { decide: vi.fn(() => d.promise) };
    const { agent, client } = makeHarness({ decisionProvider });
    await agent.start();
    client.emitMessage(gameStart());
    client.emitMessage(actionRequest());
    await flushEffects();

    d.resolve({ type: "income" });
    await flushEffects();

    expect(client.sent.at(-1)).toEqual({
      type: "action",
      match_id: "22222222-2222-4222-8222-222222222222",
      data: { type: "income" },
    });
    expect(agent.snapshot().state?.phase).toBe("in_match");
  });

  it("structured decision output unwraps action and attaches usage (§7B-1)", async () => {
    const d = deferred<unknown>();
    const decisionProvider = { decide: vi.fn(() => d.promise) };
    const { agent, client } = makeHarness({ decisionProvider });
    await agent.start();
    client.emitMessage(gameStart());
    client.emitMessage(actionRequest());
    await flushEffects();

    d.resolve({
      action: { type: "income" },
      usage: { model: "claude-x", input_tokens: 321, output_tokens: 45 },
    });
    await flushEffects();

    expect(client.sent.at(-1)).toEqual({
      type: "action",
      match_id: "22222222-2222-4222-8222-222222222222",
      data: { type: "income" },
      usage: { model: "claude-x", input_tokens: 321, output_tokens: 45 },
    });
    expect(agent.snapshot().state?.phase).toBe("in_match");
  });

  it("handles concurrent decisions for separate match sessions", async () => {
    const decisions = new Map<string, ReturnType<typeof deferred<unknown>>>();
    const decisionProvider = {
      decide: vi.fn((ctx: Parameters<AgentDecisionProvider["decide"]>[0]) => {
        const d = deferred<unknown>();
        decisions.set(ctx.matchId, d);
        return d.promise;
      }),
    } satisfies AgentDecisionProvider;
    const { agent, client } = makeHarness({ decisionProvider });
    await agent.start();

    client.emitMessage(gameStart("session-a"));
    client.emitMessage(gameStart("session-b"));
    client.emitMessage(actionRequest("session-a"));
    client.emitMessage(actionRequest("session-b"));
    await flushEffects();

    expect(decisionProvider.decide).toHaveBeenCalledTimes(2);
    decisions.get("session-b")?.resolve({ type: "income" });
    await flushEffects();
    decisions.get("session-a")?.resolve({ type: "pass" });
    await flushEffects();

    expect(client.sent).toContainEqual({
      type: "action",
      match_id: "session-b",
      data: { type: "income" },
    });
    expect(client.sent).toContainEqual({
      type: "action",
      match_id: "session-a",
      data: { type: "pass" },
    });
    expect(agent.snapshot().state?.activeMatches?.["session-a"]).toBeDefined();
    expect(agent.snapshot().state?.activeMatches?.["session-b"]).toBeDefined();
  });

  // ─── R13-F02: idempotent, bounded, cancellable decisions ─────────────

  function actionRequestWithId(sessionId: string, requestId: string): MsgActionRequest {
    const base = actionRequest(sessionId);
    return { ...base, data: { ...base.data, request_id: requestId } } as MsgActionRequest;
  }

  /** Fake provider that records each decision call + whether its signal aborted. */
  function recordingProvider() {
    const calls: Array<{
      ctx: Parameters<AgentDecisionProvider["decide"]>[0];
      deferred: ReturnType<typeof deferred<unknown>>;
      aborted: boolean;
    }> = [];
    const provider: AgentDecisionProvider = {
      decide: vi.fn((ctx) => {
        const d = deferred<unknown>();
        const rec = { ctx, deferred: d, aborted: false };
        ctx.signal?.addEventListener("abort", () => {
          rec.aborted = true;
        });
        calls.push(rec);
        return d.promise;
      }),
    };
    return { provider, calls };
  }

  it("F-02(a): duplicate action_request (same request_id) → exactly ONE provider call", async () => {
    const { provider, calls } = recordingProvider();
    const { agent, client } = makeHarness({ decisionProvider: provider });
    await agent.start();
    client.emitMessage(gameStart());
    client.emitMessage(actionRequestWithId("22222222-2222-4222-8222-222222222222", "req-1"));
    client.emitMessage(actionRequestWithId("22222222-2222-4222-8222-222222222222", "req-1"));
    await flushEffects();

    expect(calls).toHaveLength(1);
  });

  it("F-02(b): superseding action_request aborts the first call and sends exactly one final decision", async () => {
    const { provider, calls } = recordingProvider();
    const { agent, client, onNotify } = makeHarness({ decisionProvider: provider });
    await agent.start();
    client.emitMessage(gameStart());

    client.emitMessage(actionRequestWithId("22222222-2222-4222-8222-222222222222", "req-1"));
    await flushEffects();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.aborted).toBe(false);

    // A newer request for the same match supersedes the first.
    client.emitMessage(actionRequestWithId("22222222-2222-4222-8222-222222222222", "req-2"));
    await flushEffects();
    expect(calls).toHaveLength(2);
    // The first (now superseded) call's signal was aborted — its paid work cancels.
    expect(calls[0]!.aborted).toBe(true);

    // Resolve the superseding decision → the one and only action is sent.
    calls[1]!.deferred.resolve({ type: "income" });
    await flushEffects();

    // A late-arriving result from the superseded call must be DISCARDED, not sent.
    calls[0]!.deferred.resolve({ type: "coup" });
    await flushEffects();

    const actions = client.sent.filter((m) => m.type === "action");
    expect(actions).toEqual([
      {
        type: "action",
        match_id: "22222222-2222-4222-8222-222222222222",
        data: { type: "income" },
        request_id: "req-2",
      },
    ]);
    expect(onNotify).toHaveBeenCalledWith(expect.objectContaining({ code: "agent.stale_decision" }));
  });

  it("F-02(d): a normal single decision still completes end-to-end and sends the action", async () => {
    const { provider, calls } = recordingProvider();
    const { agent, client } = makeHarness({ decisionProvider: provider });
    await agent.start();
    client.emitMessage(gameStart());
    client.emitMessage(actionRequestWithId("22222222-2222-4222-8222-222222222222", "req-1"));
    await flushEffects();
    expect(calls).toHaveLength(1);

    calls[0]!.deferred.resolve({ type: "income" });
    await flushEffects();

    expect(client.sent.filter((m) => m.type === "action")).toEqual([
      {
        type: "action",
        match_id: "22222222-2222-4222-8222-222222222222",
        data: { type: "income" },
        request_id: "req-1",
      },
    ]);
    expect(agent.snapshot().state?.phase).toBe("in_match");
  });

  it("F-02: stop() aborts an in-flight decision's signal", async () => {
    const { provider, calls } = recordingProvider();
    const { agent, client } = makeHarness({ decisionProvider: provider });
    await agent.start();
    client.emitMessage(gameStart());
    client.emitMessage(actionRequestWithId("22222222-2222-4222-8222-222222222222", "req-1"));
    await flushEffects();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.aborted).toBe(false);

    await agent.stop();
    expect(calls[0]!.aborted).toBe(true);
  });

  it("F-02: isSupersededAbort keys on the DecisionSupersededError reason, not any abort (R15)", () => {
    // Unfired / absent signal → false.
    expect(isSupersededAbort(undefined)).toBe(false);
    expect(isSupersededAbort(new AbortController().signal)).toBe(false);
    // Aborted for another reason (e.g. the separate turn-deadline timeout on a
    // combined signal) must NOT read as "discard this decision quietly".
    const timedOut = new AbortController();
    timedOut.abort(new Error("turn deadline"));
    expect(isSupersededAbort(timedOut.signal)).toBe(false);
    // The deliberate supersede/stop cancel is the only true case.
    const superseded = new AbortController();
    superseded.abort(new DecisionSupersededError("match-1"));
    expect(isSupersededAbort(superseded.signal)).toBe(true);
    const stopped = new AbortController();
    stopped.abort(new DecisionSupersededError("match-1", "stopped"));
    expect(isSupersededAbort(stopped.signal)).toBe(true);
  });

  it("decision rejection triggers fallback callback and does not send action", async () => {
    const decisionProvider = { decide: vi.fn(async () => { throw new Error("model down"); }) };
    const { agent, client, onFallbackRequired } = makeHarness({ decisionProvider });
    await agent.start();
    client.emitMessage(gameStart());
    client.emitMessage(actionRequest());
    await flushEffects();

    expect(onFallbackRequired).toHaveBeenCalledOnce();
    expect(client.sent).toEqual([]);
  });

  it("stale decision result after game_over is ignored with warning", async () => {
    const d = deferred<unknown>();
    const decisionProvider = { decide: vi.fn(() => d.promise) };
    const { agent, client, onNotify } = makeHarness({ decisionProvider });
    await agent.start();
    client.emitMessage(gameStart());
    client.emitMessage(actionRequest());
    await flushEffects();

    client.emitMessage(gameOver());
    d.resolve({ type: "income" });
    await flushEffects();

    expect(client.sent).toEqual([]);
    expect(onNotify).toHaveBeenCalledWith(expect.objectContaining({ code: "agent.stale_decision" }));
  });

  it("game_over calls onResult", async () => {
    const { agent, client, onResult } = makeHarness();
    await agent.start();
    const msg = gameOver();

    client.emitMessage(msg);
    await flushEffects();

    expect(onResult).toHaveBeenCalledWith(msg, {});
  });

  it("server error routes to onNotify and keeps instance alive", async () => {
    const { agent, client, onNotify } = makeHarness();
    await agent.start();

    client.emitMessage(serverError("bad action"));
    await flushEffects();

    expect(onNotify).toHaveBeenCalledWith(expect.objectContaining({ code: "server.error", level: "error" }));
    expect(agent.snapshot().stopped).toBe(false);
  });

  it("reconnect failure updates FSM transport and notifies", async () => {
    const { agent, client, onNotify } = makeHarness();
    await agent.start();
    client.state = "backoff";

    client.emitReconnect({ type: "attempt-failure", attempt: 2, elapsedMs: 1000, severity: "warning" });
    await flushEffects();

    expect(agent.snapshot().state?.transport).toBe("backoff");
    expect(agent.snapshot().transport).toBe("backoff");
    expect(onNotify).toHaveBeenCalledWith(expect.objectContaining({ code: "reconnect.attempt_failure" }));
  });

  it("reconnect close closes FSM and later command throws stopped error", async () => {
    const { agent, client } = makeHarness();
    await agent.start();

    client.emitClose();
    await flushEffects();

    expect(agent.snapshot().state?.phase).toBe("closed");
    expect(() => agent.joinQueue("coup")).toThrow(AgentInstanceStoppedError);
  });

  it("reconnect close with device_mismatch emits a structured takeover notify", async () => {
    const { agent, client, onNotify } = makeHarness();
    await agent.start();

    client.emitClose({
      kind: "fatal-error",
      cause: new WSDeviceMismatchError(
        '{"error":"device_mismatch"}',
        "device_mismatch: agent key is bound to another device",
      ),
    });
    await flushEffects();

    expect(onNotify).toHaveBeenCalledWith(
      expect.objectContaining({ code: "agent.device_mismatch", level: "error" }),
    );
  });

  it("send failure reports notify(error) without throwing command", async () => {
    const { agent, client, onNotify } = makeHarness();
    await agent.start();
    client.sendImpl = () => {
      throw new Error("socket closed");
    };

    expect(() => agent.joinQueue("coup")).not.toThrow();
    await flushEffects();

    expect(onNotify).toHaveBeenCalledWith(expect.objectContaining({ code: "agent.send_failed", level: "error" }));
  });

  it("command before start throws AgentInstanceNotStartedError", () => {
    const { agent } = makeHarness();

    expect(() => agent.joinQueue("coup")).toThrow(AgentInstanceNotStartedError);
  });

  it("double start throws AgentInstanceStartError", async () => {
    const { agent } = makeHarness();
    await agent.start();

    await expect(agent.start()).rejects.toBeInstanceOf(AgentInstanceStartError);
  });

  // A stop that lands WHILE we are connecting has nothing to close yet — the
  // client does not exist until connect() resolves. If the late-arriving client
  // were then adopted, the caller that already gave up (and, in the CLI service,
  // already handed the machine's agent seat to somebody else) would be sitting
  // on top of a live connection nobody holds a reference to: two bridges, one
  // agent, which is the exact state the seat lock exists to prevent.
  it("closes and refuses a connection that lands after stop()", async () => {
    const client = new FakeReconnectClient();
    let releaseConnect: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    const agent = new AgentInstance({
      name: "slow-to-connect",
      ws: {
        url: "ws://127.0.0.1:1/api/ws",
        apiKey: "sk-test",
        expectedProtocolVersion: "v1.0.0",
      },
      connect: async () => {
        await pending;
        return client;
      },
      decisionProvider: { decide: vi.fn(async () => ({ type: "fold" })) },
      now: () => 42,
    });

    const starting = agent.start();
    // The caller gives up before the connection lands.
    await agent.stop("gave up waiting");
    releaseConnect?.();

    await expect(starting).rejects.toBeInstanceOf(AgentInstanceStoppedError);
    // The socket that arrived late must be closed, not left running.
    expect(client.state).toBe("closed");
    expect(agent.snapshot().stopped).toBe(true);
  });

  it("start wraps connect failure in AgentInstanceStartError", async () => {
    const { agent } = makeHarness();
    const failing = new AgentInstance({
      name: "broken",
      ws: {
        url: "ws://127.0.0.1:1/api/ws",
        apiKey: "sk-test",
        expectedProtocolVersion: "v1.0.0",
      },
      decisionProvider: { decide: vi.fn(async () => ({ type: "fold" })) },
      connect: async () => {
        throw new Error("dial refused");
      },
    });

    await expect(failing.start()).rejects.toBeInstanceOf(AgentInstanceStartError);
    expect(agent.snapshot().started).toBe(false);
  });

  it("start rejects when reconnect client has no welcome", async () => {
    const client = new FakeReconnectClient();
    client.welcome = null;
    const { agent } = makeHarness({ client });

    await expect(agent.start()).rejects.toBeInstanceOf(AgentInstanceStartError);
  });

  it("stop unsubscribes handlers and closes client once", async () => {
    const { agent, client } = makeHarness();
    await agent.start();

    await agent.stop("done");

    expect(client.closeCalls).toBe(1);
    expect(client.messageHandlers.size).toBe(0);
    expect(client.reconnectHandlers.size).toBe(0);
    expect(client.closeHandlers.size).toBe(0);
    expect(client.errorHandlers.size).toBe(0);
    expect(agent.snapshot().state?.phase).toBe("closed");
  });

  it("double stop is a no-op", async () => {
    const { agent, client } = makeHarness();
    await agent.start();

    await agent.stop("one");
    await agent.stop("two");

    expect(client.closeCalls).toBe(1);
  });

  // ─── R15 2026-07-26: stop() ordering — decisions abort before close ───

  it("R15: stop() aborts in-flight decisions even when close() hangs", async () => {
    const client = new FakeReconnectClient();
    client.close = () => new Promise<void>(() => {}); // close never settles
    const { provider, calls } = recordingProvider();
    const { agent } = makeHarness({ client, decisionProvider: provider });
    await agent.start();
    client.emitMessage(gameStart());
    client.emitMessage(actionRequestWithId("22222222-2222-4222-8222-222222222222", "req-1"));
    await flushEffects();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.aborted).toBe(false);

    const stopping = agent.stop("host shutdown"); // pends on close forever
    stopping.catch(() => {});

    // The abort must land synchronously, without waiting out the close.
    expect(calls[0]!.aborted).toBe(true);
  });

  it("R15: stop() still aborts decisions and closes the FSM when close() rejects", async () => {
    const client = new FakeReconnectClient();
    client.close = async () => {
      throw new Error("close failed");
    };
    const { provider, calls } = recordingProvider();
    const { agent } = makeHarness({ client, decisionProvider: provider });
    await agent.start();
    client.emitMessage(gameStart());
    client.emitMessage(actionRequestWithId("22222222-2222-4222-8222-222222222222", "req-1"));
    await flushEffects();

    await expect(agent.stop("bye")).rejects.toThrow("close failed");

    expect(calls[0]!.aborted).toBe(true);
    expect(agent.snapshot().state?.phase).toBe("closed");
  });

  // ─── R15 2026-07-26: host callbacks dispatched with isolation — a throwing
  // hook must never interrupt FSM/effect processing. ───

  it("R15: a throwing onState handler does not block effect processing", async () => {
    const { agent, client, onNotify } = makeHarness();
    await agent.start();
    agent.onState(() => {
      throw new Error("host bug");
    });

    expect(() => agent.joinQueue("coup")).not.toThrow();
    await flushEffects();

    expect(client.sent).toEqual([{ type: "join_queue", data: { game: "coup", mode: "ranked" } }]);
    expect(onNotify).toHaveBeenCalledWith(
      expect.objectContaining({ code: "agent.host_callback", level: "error" }),
    );
  });

  it("R15: a throwing onServerMessage does not stop the FSM from seeing the message", async () => {
    const onServerMessage = vi.fn(() => {
      throw new Error("host bug");
    });
    const { agent, client, onNotify } = makeHarness({ autoConfirmMatches: true, onServerMessage });
    await agent.start();

    client.emitMessage(confirmRequest());
    await flushEffects();

    expect(onServerMessage).toHaveBeenCalledOnce();
    expect(client.sent).toEqual([
      { type: "match_confirm", data: { confirm_id: "11111111-1111-4111-8111-111111111111" } },
    ]);
    expect(onNotify).toHaveBeenCalledWith(
      expect.objectContaining({ code: "agent.host_callback", level: "error" }),
    );
    expect(agent.snapshot().stopped).toBe(false);
  });

  it("R15: a throwing onNotify is contained (terminal channel)", async () => {
    const { agent, client, onNotify } = makeHarness();
    await agent.start();
    onNotify.mockImplementation(() => {
      throw new Error("host bug");
    });

    // #notifyFromClientError → #notify → throwing onNotify must not escape
    // back into the ws client's error-dispatch loop.
    expect(() => client.emitError()).not.toThrow();
    expect(onNotify).toHaveBeenCalled();
    expect(agent.snapshot().stopped).toBe(false);
  });
});

// 审查 F5 (重连重设计 2026-07-25): a stop() landing while start() is still
// connecting must ABORT the connect, not wait for it — with the server down
// the first-connect promise legitimately pends forever, and a stop that waits
// hangs the host's whole shutdown for the length of the outage.
describe("AgentInstance — abortable in-flight start", () => {
  it("stop() aborts a pending first connect and start() rejects promptly", async () => {
    const agent = new AgentInstance({
      name: "abort-start",
      ws: {
        url: "ws://127.0.0.1:1/api/ws",
        apiKey: "sk-test",
        expectedProtocolVersion: "v1.0.0",
      },
      decisionProvider: { decide: vi.fn(async () => ({ type: "fold" })) },
      connect: (ws) =>
        new Promise((_resolve, reject) => {
          // A faithful stand-in for a server outage: never resolves, but
          // honours the abort signal exactly like createReconnectingWSClient.
          ws.signal?.addEventListener("abort", () =>
            reject(new Error("aborted by signal")),
          );
        }),
    });

    const started = agent.start();
    started.catch(() => {}); // assertion below re-awaits; avoid unhandledrejection
    await agent.stop("host shutdown");
    await expect(started).rejects.toThrow(/aborted by signal|failed to start/);
  });
});

// D1 (windows-loop). The FSM half of this is covered in
// agent-fsm-phase-derivation.test.ts; this is the OTHER half, and the one that
// actually swallowed the decision first: #isDecisionCurrent used to require
// `state.phase === "deciding"`, so a second match starting while a decision was
// in flight made the finished decision look stale — it was dropped here, with
// only an `agent.stale_decision` warning, before ever reaching the FSM. The turn
// then went unanswered and the server judged a forfeit.
describe("AgentInstance — a concurrent match must not orphan an in-flight decision (D1)", () => {
  const MATCH_A = "22222222-2222-4222-8222-222222222222";
  const MATCH_B = "44444444-4444-4444-8444-444444444444";

  it("delivers match A's decision even though match B started meanwhile", async () => {
    const d = deferred<unknown>();
    const decisionProvider = { decide: vi.fn(() => d.promise) };
    const { agent, client, onNotify } = makeHarness({ decisionProvider });
    await agent.start();
    client.emitMessage(gameStart(MATCH_A));
    client.emitMessage(actionRequest(MATCH_A));
    await flushEffects();

    // Match B starts while A's provider call is still running.
    client.emitMessage(gameStart(MATCH_B));
    await flushEffects();

    d.resolve({ type: "income" });
    await flushEffects();

    expect(
      client.sent.filter((m) => m.type === "action"),
      "A's decision must reach the wire; dropping it is the unanswered turn that gets judged a loss",
    ).toEqual([{ type: "action", match_id: MATCH_A, data: { type: "income" } }]);
    expect(
      onNotify.mock.calls.map(([e]) => e.code),
      "and it must not be reported as stale",
    ).not.toContain("agent.stale_decision");
  });
});

// D2 (windows-loop). The FSM-side recovery is covered in
// agent-fsm-phase-derivation.test.ts; this pins the wiring — that a throwing
// socket actually reaches the FSM instead of stopping at a log line.
describe("AgentInstance — a failed action send is fed back to the FSM (D2)", () => {
  const MATCH = "22222222-2222-4222-8222-222222222222";

  it("restores the unanswered turn instead of pretending it was submitted", async () => {
    const d = deferred<unknown>();
    const decisionProvider = { decide: vi.fn(() => d.promise) };
    const { agent, client, onNotify } = makeHarness({ decisionProvider });
    await agent.start();
    client.emitMessage(gameStart(MATCH));
    client.emitMessage(actionRequest(MATCH));
    await flushEffects();

    client.sendImpl = () => {
      throw new Error("socket closed");
    };
    d.resolve({ type: "income" });
    await flushEffects();

    const state = agent.snapshot().state;
    expect(
      state?.pendingActions?.[MATCH] ?? state?.pendingAction,
      "the agent must not believe it answered a turn the socket never carried",
    ).toBeTruthy();
    expect(state?.phase).toBe("deciding");
    expect(onNotify.mock.calls.map(([e]) => e.code)).toContain("fsm.send_failed");
  });
});
