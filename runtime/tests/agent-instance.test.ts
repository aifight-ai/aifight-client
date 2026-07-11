import { describe, expect, it, vi } from "vitest";

import {
  AgentInstance,
  AgentInstanceNotStartedError,
  AgentInstanceStartError,
  AgentInstanceStoppedError,
  type AgentDecisionProvider,
  type AgentInstanceNotify,
} from "../src/agents/agent";
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
});
