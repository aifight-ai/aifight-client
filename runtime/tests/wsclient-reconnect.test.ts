// M1-07 reconnect manager tests — vitest with hoisted vi.mock.
//
// Test infrastructure (rev 2 Codex C5 lock):
//   - hoisted `vi.mock('../src/wsclient/client', ...)` replaces createWSClient
//     module-wide BEFORE reconnect.ts imports it. This is the only mock
//     shape that survives ESM static-import binding.
//   - NO `vi.spyOn` (won't replace already-bound import in reconnect.ts).
//   - NO `_factoryOverride` public option (would pollute facade API).
//
// Coverage matrix (rev 4 self-check + rev 5 backoff fix):
//   1.  happy path first connect
//   2.  transient first failure → Promise pending until attempt 2 (Codex C2)
//   3.  fatal WSHandshakeError(401) → Promise reject (Codex C2)
//   4.  fatal WSProtocolVersionError → Promise reject
//   5.  retriable close 1006 → reconnect succeeds
//   6.  fatal close 1000 → onClose kind="fatal-close" (Roy 拍板 #5)
//   7.  fatal close 4001 → onClose kind="fatal-close" (Roy 拍板 #5, 4xxx)
//   8.  backoff curve jitter="none": 1s/2s/4s/8s/16s/30s/30s (rev 5 fix)
//   9.  jitter="full" produces delays in [0, cappedBase)
//   10. handler re-wire: onMessage registered once, fires across 2 inners
//   11. welcome refresh after reconnect (TED rev 4 case 18)
//   12. caller close() emits onClose kind="caller-close"
//   13. AbortSignal pre-aborted → Promise reject kind="signal"
//   14. maxAttempts=3 → fail kind="max-attempts"
//   15. send() in backoff state throws WSClosedError
//   16. ReconnectCloseInfo has no wasClean field (Codex C3 防回归)

import { vi, describe, beforeEach, afterEach, test, expect } from "vitest";

// ─── Hoisted mock — must be at top, before any import from the mocked module ───
vi.mock("../src/wsclient/client", () => ({
  createWSClient: vi.fn(),
}));

import {
  createReconnectingWSClient,
  ReconnectStoppedError,
  type ReconnectingWSClient,
  type ReconnectingWSClientOptions,
  type ReconnectCloseInfo,
  type ReconnectEvent,
} from "../src/wsclient/reconnect";

import { createWSClient } from "../src/wsclient/client";
import {
  WSConnectError,
  WSHandshakeError,
  WSProtocolVersionError,
  WSClosedError,
  WSAbortedError,
} from "../src/wsclient/errors";

const mockedCreate = vi.mocked(createWSClient);

// ─── Fake inner WSClient builder ───────────────────────────────────

interface FakeInnerHandle {
  inner: any;
  simulateServerClose: (code: number, reason?: string) => void;
  emitMessage: (msg: unknown) => void;
  sentMessages: unknown[];
}

function makeFakeInner(opts?: { welcome?: object }): FakeInnerHandle {
  const messageHandlers = new Set<(msg: any) => void>();
  const errorHandlers = new Set<(err: any) => void>();
  const closeHandlers = new Set<(info: any) => void>();
  const sentMessages: unknown[] = [];
  let closedAlready = false;

  const welcome = opts?.welcome ?? {
    type: "welcome",
    data: {
      server_protocol_version: "1.0.0",
      agent_id: "agent-test",
      agent_name: "test",
      server_time: "2026-04-25T00:00:00.000Z",
      games: ["coup"],
    },
  };

  const inner = {
    state: "connected" as const,
    welcome,
    send(msg: unknown) {
      sentMessages.push(msg);
    },
    onMessage(h: (msg: any) => void) {
      messageHandlers.add(h);
      return () => {
        messageHandlers.delete(h);
      };
    },
    onError(h: (err: any) => void) {
      errorHandlers.add(h);
      return () => {
        errorHandlers.delete(h);
      };
    },
    onClose(h: (info: any) => void) {
      closeHandlers.add(h);
      return () => {
        closeHandlers.delete(h);
      };
    },
    close: vi.fn(async (code?: number, reason?: string) => {
      if (closedAlready) return;
      closedAlready = true;
      const info = {
        code: code ?? 1000,
        reason: reason ?? "",
        initiator: "client" as const,
      };
      for (const h of [...closeHandlers]) h(info);
    }),
  };

  return {
    inner,
    sentMessages,
    simulateServerClose: (code: number, reason: string = "") => {
      if (closedAlready) return;
      closedAlready = true;
      const info = {
        code,
        reason,
        initiator: "server" as const,
      };
      for (const h of [...closeHandlers]) h(info);
    },
    emitMessage: (msg: unknown) => {
      for (const h of [...messageHandlers]) h(msg);
    },
  };
}

const baseOpts: ReconnectingWSClientOptions = {
  url: "ws://localhost:0/api/ws",
  apiKey: "test-key",
  expectedProtocolVersion: "1.0.0",
};

beforeEach(() => {
  vi.useFakeTimers();
  mockedCreate.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

// Helper: flush pending microtasks so mock resolutions propagate
async function flushMicrotasks(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

// ───────────────────────────────────────────────────────────────────
// Test cases
// ───────────────────────────────────────────────────────────────────

describe("createReconnectingWSClient — first connect", () => {
  test("case 1: happy path — first connect succeeds", async () => {
    const { inner } = makeFakeInner();
    mockedCreate.mockResolvedValueOnce(inner as any);

    const facade = await createReconnectingWSClient(baseOpts);

    expect(facade.state).toBe("connected");
    expect(facade.welcome).toBe(inner.welcome);
    expect(facade.attempt).toBe(0);
    expect(mockedCreate).toHaveBeenCalledTimes(1);
  });

  test("case 2: transient first failure → Promise pending until attempt 2 succeeds (Codex C2)", async () => {
    const { inner } = makeFakeInner();
    mockedCreate.mockRejectedValueOnce(new WSConnectError("DNS failed"));
    mockedCreate.mockResolvedValueOnce(inner as any);

    const facadePromise = createReconnectingWSClient({
      ...baseOpts,
      jitter: "none",
    });

    // After attempt 1 fails (microtask), Promise must still be pending
    let settled: "resolved" | "rejected" | undefined;
    facadePromise.then(
      () => {
        settled = "resolved";
      },
      () => {
        settled = "rejected";
      },
    );
    await flushMicrotasks();
    expect(settled).toBeUndefined();
    expect(mockedCreate).toHaveBeenCalledTimes(1);

    // Advance past 1s backoff (jitter="none" → exactly 1000 ms)
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    const facade = await facadePromise;
    expect(facade.state).toBe("connected");
    expect(mockedCreate).toHaveBeenCalledTimes(2);
  });

  test("case 3: fatal WSHandshakeError(401) → Promise rejects with ReconnectStoppedError(kind=fatal-error)", async () => {
    mockedCreate.mockRejectedValueOnce(
      new WSHandshakeError(401, "Unauthorized", "auth failed"),
    );

    await expect(
      createReconnectingWSClient(baseOpts),
    ).rejects.toMatchObject({
      name: "ReconnectStoppedError",
      kind: "fatal-error",
    });
  });

  test("case 4: fatal WSProtocolVersionError → Promise rejects", async () => {
    mockedCreate.mockRejectedValueOnce(
      new WSProtocolVersionError("1.0.0", "2.0.0", "major mismatch"),
    );

    await expect(
      createReconnectingWSClient(baseOpts),
    ).rejects.toBeInstanceOf(ReconnectStoppedError);
  });
});

describe("createReconnectingWSClient — close-code dispatch (Roy 拍板 #5)", () => {
  test("case 5: retriable close 1006 → reconnect succeeds; welcome refreshes", async () => {
    const h1 = makeFakeInner({
      welcome: {
        type: "welcome",
        data: {
          server_protocol_version: "1.0.0",
          agent_id: "agent-test",
          agent_name: "test",
          server_time: "2026-04-25T00:00:00.000Z",
          games: ["coup"],
        },
      },
    });
    const h2 = makeFakeInner({
      welcome: {
        type: "welcome",
        data: {
          server_protocol_version: "1.0.0",
          agent_id: "agent-test",
          agent_name: "test",
          server_time: "2026-04-25T00:00:05.000Z", // newer
          games: ["coup"],
        },
      },
    });
    mockedCreate.mockResolvedValueOnce(h1.inner as any);
    mockedCreate.mockResolvedValueOnce(h2.inner as any);

    const facade = await createReconnectingWSClient({
      ...baseOpts,
      jitter: "none",
    });
    expect(facade.welcome).toBe(h1.inner.welcome);

    h1.simulateServerClose(1006);
    // close-driven backoff sets #failures = 1 → next attempt 1s later
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(facade.state).toBe("connected");
    expect(facade.welcome).toBe(h2.inner.welcome);
    expect(mockedCreate).toHaveBeenCalledTimes(2);
  });

  test("case 6: fatal close 1000 → onClose fires with kind=fatal-close, code=1000", async () => {
    const { inner, simulateServerClose } = makeFakeInner();
    mockedCreate.mockResolvedValueOnce(inner as any);

    const facade = await createReconnectingWSClient(baseOpts);
    let received: ReconnectCloseInfo | undefined;
    facade.onClose((info) => {
      received = info;
    });

    simulateServerClose(1000, "normal");
    await flushMicrotasks();

    expect(received).toBeDefined();
    expect(received!.kind).toBe("fatal-close");
    expect(received!.code).toBe(1000);
    expect(received!.cause).toBeInstanceOf(ReconnectStoppedError);
    expect(facade.state).toBe("closed");
  });

  test("case 7: fatal close 4001 (application-defined) → onClose kind=fatal-close, code=4001", async () => {
    const { inner, simulateServerClose } = makeFakeInner();
    mockedCreate.mockResolvedValueOnce(inner as any);

    const facade = await createReconnectingWSClient(baseOpts);
    let received: ReconnectCloseInfo | undefined;
    facade.onClose((info) => {
      received = info;
    });

    simulateServerClose(4001, "auth revoked");
    await flushMicrotasks();

    expect(received!.kind).toBe("fatal-close");
    expect(received!.code).toBe(4001);
  });
});

describe("createReconnectingWSClient — backoff curve (rev 5 fix)", () => {
  test("case 8: jitter=none — exact gap sequence 1s/2s/4s/8s/16s/30s/30s", async () => {
    // 8 transient failures, then success on 9th attempt
    for (let i = 0; i < 8; i++) {
      mockedCreate.mockRejectedValueOnce(new WSConnectError(`fail ${i + 1}`));
    }
    const { inner } = makeFakeInner();
    mockedCreate.mockResolvedValueOnce(inner as any);

    const facadePromise = createReconnectingWSClient({
      ...baseOpts,
      jitter: "none",
    });
    // Suppress unhandled — we await at the end
    facadePromise.catch(() => {
      /* swallowed; handled by await below */
    });

    // attempt 1 fires immediately (synchronous start)
    await flushMicrotasks();
    expect(mockedCreate).toHaveBeenCalledTimes(1);

    // expected gaps: failure→delay→next attempt
    //   1st fail → 1000ms → attempt 2
    //   2nd fail → 2000ms → attempt 3
    //   3rd fail → 4000ms → attempt 4
    //   4th fail → 8000ms → attempt 5
    //   5th fail → 16000ms → attempt 6
    //   6th fail → 30000ms (cap) → attempt 7
    //   7th fail → 30000ms (cap) → attempt 8
    //   8th fail → 30000ms (cap) → attempt 9 (succeeds)
    const expectedGaps = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000];
    let expectedAttempts = 1;
    for (const gap of expectedGaps) {
      // Just below the gap → no new attempt yet
      await vi.advanceTimersByTimeAsync(gap - 1);
      await flushMicrotasks();
      expect(mockedCreate).toHaveBeenCalledTimes(expectedAttempts);
      // Cross the gap → new attempt
      await vi.advanceTimersByTimeAsync(1);
      await flushMicrotasks();
      expectedAttempts++;
      expect(mockedCreate).toHaveBeenCalledTimes(expectedAttempts);
    }

    const facade = await facadePromise;
    expect(facade.state).toBe("connected");
    expect(mockedCreate).toHaveBeenCalledTimes(9);
  });

  test("case 9: jitter=full — delay ∈ [0, cappedBase) for 1st failure", async () => {
    // Force Math.random to return a known fraction
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);

    const { inner } = makeFakeInner();
    mockedCreate.mockRejectedValueOnce(new WSConnectError("transient"));
    mockedCreate.mockResolvedValueOnce(inner as any);

    const facadePromise = createReconnectingWSClient({
      ...baseOpts,
      jitter: "full", // [0, 1000) for 1st failure
    });
    facadePromise.catch(() => {});

    await flushMicrotasks();
    // 0.5 * 1000 = 500
    // Just below 500ms → no new attempt
    await vi.advanceTimersByTimeAsync(499);
    await flushMicrotasks();
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    // Cross 500ms → new attempt
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(mockedCreate).toHaveBeenCalledTimes(2);

    await facadePromise;
    randomSpy.mockRestore();
  });
});

describe("createReconnectingWSClient — handler re-wire + send", () => {
  test("case 10: onMessage handler persists across reconnects", async () => {
    const h1 = makeFakeInner();
    const h2 = makeFakeInner();
    mockedCreate.mockResolvedValueOnce(h1.inner as any);
    mockedCreate.mockResolvedValueOnce(h2.inner as any);

    const facade = await createReconnectingWSClient({
      ...baseOpts,
      jitter: "none",
    });

    const received: unknown[] = [];
    facade.onMessage((msg) => {
      received.push(msg);
    });

    h1.emitMessage({ type: "queue_joined" });
    expect(received).toEqual([{ type: "queue_joined" }]);

    h1.simulateServerClose(1006);
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(facade.state).toBe("connected");
    h2.emitMessage({ type: "match_confirm_request" });
    expect(received).toEqual([
      { type: "queue_joined" },
      { type: "match_confirm_request" },
    ]);
  });

  test("case 11: send() in connected state forwards to inner", async () => {
    const { inner, sentMessages } = makeFakeInner();
    mockedCreate.mockResolvedValueOnce(inner as any);

    const facade = await createReconnectingWSClient(baseOpts);
    facade.send({ type: "join_queue", data: { game: "coup" } } as any);

    expect(sentMessages).toEqual([
      { type: "join_queue", data: { game: "coup" } },
    ]);
  });

  test("case 12: send() in backoff state throws WSClosedError", async () => {
    const { inner, simulateServerClose } = makeFakeInner();
    mockedCreate.mockResolvedValueOnce(inner as any);
    mockedCreate.mockRejectedValueOnce(new WSConnectError("fail"));

    const facade = await createReconnectingWSClient({
      ...baseOpts,
      jitter: "none",
    });
    simulateServerClose(1006);
    await flushMicrotasks();
    // Now in backoff (1s pending)
    expect(facade.state).toBe("backoff");
    expect(() =>
      facade.send({ type: "leave_queue" } as any),
    ).toThrow(WSClosedError);
  });
});

describe("createReconnectingWSClient — caller close + AbortSignal", () => {
  test("case 13: caller close() emits onClose kind=caller-close, default code 1000", async () => {
    const { inner } = makeFakeInner();
    mockedCreate.mockResolvedValueOnce(inner as any);

    const facade = await createReconnectingWSClient(baseOpts);
    let received: ReconnectCloseInfo | undefined;
    facade.onClose((info) => {
      received = info;
    });

    await facade.close();
    await flushMicrotasks();

    expect(received).toBeDefined();
    expect(received!.kind).toBe("caller-close");
    expect(received!.code).toBe(1000);
    expect(received!.cause).toBeUndefined();
    expect(facade.state).toBe("closed");
  });

  test("case 14: AbortSignal pre-aborted → Promise rejects with kind=signal", async () => {
    const ac = new AbortController();
    ac.abort();

    await expect(
      createReconnectingWSClient({
        ...baseOpts,
        signal: ac.signal,
      }),
    ).rejects.toMatchObject({
      name: "ReconnectStoppedError",
      kind: "signal",
    });
  });
});

describe("createReconnectingWSClient — maxAttempts + ReconnectCloseInfo invariants", () => {
  test("case 15: maxAttempts=3 → fail with kind=max-attempts after 3 transient failures", async () => {
    for (let i = 0; i < 3; i++) {
      mockedCreate.mockRejectedValueOnce(new WSConnectError(`fail ${i + 1}`));
    }

    const facadePromise = createReconnectingWSClient({
      ...baseOpts,
      jitter: "none",
      maxAttempts: 3,
    });
    facadePromise.catch(() => {});

    // Advance through backoffs: 1s + 2s = 3s for the gaps between 3 attempts
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1000); // attempt 2
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000); // attempt 3
    await flushMicrotasks();
    // attempt 3 also fails → maxAttempts hit (no further attempt scheduled)

    await expect(facadePromise).rejects.toMatchObject({
      name: "ReconnectStoppedError",
      kind: "max-attempts",
    });
    expect(mockedCreate).toHaveBeenCalledTimes(3);
  });

  test("case 16: ReconnectCloseInfo never has wasClean field (Codex C3 invariant)", async () => {
    const { inner, simulateServerClose } = makeFakeInner();
    mockedCreate.mockResolvedValueOnce(inner as any);

    const facade = await createReconnectingWSClient(baseOpts);
    let received: ReconnectCloseInfo | undefined;
    facade.onClose((info) => {
      received = info;
    });

    simulateServerClose(1000, "normal");
    await flushMicrotasks();

    expect(received).toBeDefined();
    expect("wasClean" in (received as object)).toBe(false);
  });
});
