// M5-01 fault class 2: WS 断开 → wsclient auto-reconnect (plan §5.9).
//
// Adjacent to wsclient-reconnect.test.ts (sealed M1-07): that suite proves
// the unit contract for each close-code path in isolation. This file covers
// 2 fault-stress scenarios:
//   1. 3 sequential server closes (1006) — facade must reconnect each time
//      and onMessage handlers MUST stay registered across all 3 reconnects
//      (rev2 Codex C3 case 10 was 1 disconnect; this is N=3 stress).
//   2. fatal close 4001 + caller-attached onClose handler — single fatal
//      terminates without retry storm; facade.state reaches "closed".
//
// Uses the same hoisted vi.mock pattern as wsclient-reconnect.test.ts (the
// only mock shape that survives ESM static-import binding in reconnect.ts).
// fakeInner factory is duplicated locally — copying a sealed test helper is
// safer than depending on a sealed neighbor's internal helper.

import { vi, describe, beforeEach, afterEach, test, expect } from "vitest";

vi.mock("../../src/wsclient/client", () => ({
  createWSClient: vi.fn(),
}));

import {
  createReconnectingWSClient,
  type ReconnectingWSClientOptions,
} from "../../src/wsclient/reconnect";

import { createWSClient } from "../../src/wsclient/client";

const mockedCreate = vi.mocked(createWSClient);

// ─── fakeInner factory (mirror of wsclient-reconnect.test.ts) ────────

function makeFakeInner(welcomeOverride?: object) {
  const messageHandlers = new Set<(msg: any) => void>();
  const closeHandlers = new Set<(info: any) => void>();
  const sentMessages: unknown[] = [];
  let closedAlready = false;

  const welcome = welcomeOverride ?? {
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
    onError() {
      return () => {};
    },
    onClose(h: (info: any) => void) {
      closeHandlers.add(h);
      return () => {
        closeHandlers.delete(h);
      };
    },
    close: vi.fn(async (code?: number) => {
      if (closedAlready) return;
      closedAlready = true;
      for (const h of [...closeHandlers]) {
        h({ code: code ?? 1000, reason: "", initiator: "client" as const });
      }
    }),
  };

  return {
    inner,
    sentMessages,
    simulateServerClose: (code: number, reason: string = "") => {
      if (closedAlready) return;
      closedAlready = true;
      for (const h of [...closeHandlers]) {
        h({ code, reason, initiator: "server" as const });
      }
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

async function flushMicrotasks(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("M5-01 WS disconnect — auto-reconnect stress + fatal-close terminator", () => {
  test("3 sequential 1006 disconnects → 3 reconnects; onMessage handler fires on all 4 inners", async () => {
    // Build 4 inners (one initial + 3 post-reconnect).
    const handles = [
      makeFakeInner(),
      makeFakeInner(),
      makeFakeInner(),
      makeFakeInner(),
    ];
    for (const h of handles) {
      mockedCreate.mockResolvedValueOnce(h.inner as any);
    }

    const facade = await createReconnectingWSClient({
      ...baseOpts,
      jitter: "none",
    });

    const received: unknown[] = [];
    facade.onMessage((msg) => {
      received.push(msg);
    });

    // Phase 1: msg on inner 0
    handles[0]!.emitMessage({ type: "ping", data: { seq: 0 } });
    expect(received).toHaveLength(1);

    // Disconnect 1: 1006 → reconnect to inner 1 (1s backoff)
    handles[0]!.simulateServerClose(1006);
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(facade.state).toBe("connected");
    handles[1]!.emitMessage({ type: "ping", data: { seq: 1 } });

    // Disconnect 2: 1006 → reconnect to inner 2 (after another 1s; #failures
    // reset on success, so backoff is again 1s)
    handles[1]!.simulateServerClose(1006);
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(facade.state).toBe("connected");
    handles[2]!.emitMessage({ type: "ping", data: { seq: 2 } });

    // Disconnect 3: 1006 → reconnect to inner 3
    handles[2]!.simulateServerClose(1006);
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(facade.state).toBe("connected");
    handles[3]!.emitMessage({ type: "ping", data: { seq: 3 } });

    // Handler must have re-attached on every inner; all 4 messages received.
    expect(received).toEqual([
      { type: "ping", data: { seq: 0 } },
      { type: "ping", data: { seq: 1 } },
      { type: "ping", data: { seq: 2 } },
      { type: "ping", data: { seq: 3 } },
    ]);
    expect(mockedCreate).toHaveBeenCalledTimes(4);
  });

  test("fatal close 4001 → state=closed, no reconnect attempt, mockedCreate stays at 1", async () => {
    const { inner, simulateServerClose } = makeFakeInner();
    mockedCreate.mockResolvedValueOnce(inner as any);

    const facade = await createReconnectingWSClient(baseOpts);
    expect(facade.state).toBe("connected");
    expect(mockedCreate).toHaveBeenCalledTimes(1);

    simulateServerClose(4001, "auth revoked");
    await flushMicrotasks();

    // Advance generously — if there were a bug retrying on 4001, mockedCreate
    // would be called again. 60s covers full backoff curve cap (30s × 2).
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    expect(facade.state).toBe("closed");
    expect(mockedCreate).toHaveBeenCalledTimes(1);
  });
});
