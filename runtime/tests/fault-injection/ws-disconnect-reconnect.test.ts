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
import { WSConnectError } from "../../src/wsclient/errors";

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
  // One case pins Math.random to make the yield timings exact — never let that
  // leak into a neighbour that is meant to run under real jitter.
  vi.restoreAllMocks();
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

    // Backoff escalates across the three drops: 1s, 2s, 4s. A success only
    // resets the curve once the session outlived the stability window (30s);
    // these sessions are instant, so each drop counts as one more failure in
    // the same flap. See the flap-escalation suite below for why.

    // Disconnect 1: 1006 → reconnect to inner 1 (1s backoff)
    handles[0]!.simulateServerClose(1006);
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(facade.state).toBe("connected");
    handles[1]!.emitMessage({ type: "ping", data: { seq: 1 } });

    // Disconnect 2: 1006 → reconnect to inner 2 (2s backoff)
    handles[1]!.simulateServerClose(1006);
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(facade.state).toBe("connected");
    handles[2]!.emitMessage({ type: "ping", data: { seq: 2 } });

    // Disconnect 3: 1006 → reconnect to inner 3 (4s backoff)
    handles[2]!.simulateServerClose(1006);
    await vi.advanceTimersByTimeAsync(4000);
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

// 2026-07-24 connect/evict storm: two Bridges sharing one agent identity took
// turns kicking each other off ~1×/s for as long as both were running. Two
// separate defects made that possible — this suite pins both fixes.
describe("connect/evict storm — flap escalation + replaced-seat yield", () => {
  test("instant re-drops escalate the curve (1s → 2s), a long session resets it", async () => {
    const handles = [makeFakeInner(), makeFakeInner(), makeFakeInner(), makeFakeInner()];
    for (const h of handles) mockedCreate.mockResolvedValueOnce(h.inner as any);

    const facade = await createReconnectingWSClient({ ...baseOpts, jitter: "none" });

    // Defect 1 was here: a successful connect used to zero the failure count
    // unconditionally, so a connection that died the instant it came up still
    // retried in 1s — forever, at full speed. Now a success only clears the
    // curve once it has held for the stability window (30s).
    handles[0]!.simulateServerClose(1006);
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(facade.state).toBe("connected");

    // Second instant drop: 1s is no longer enough.
    handles[1]!.simulateServerClose(1006);
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(facade.state).toBe("backoff");
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(facade.state).toBe("connected");

    // Hold the line past the stability window: the flap is over, so the next
    // blip must recover fast again rather than inherit the escalated delay.
    await vi.advanceTimersByTimeAsync(31_000);
    handles[2]!.simulateServerClose(1006);
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(facade.state).toBe("connected");
    expect(mockedCreate).toHaveBeenCalledTimes(4);
  });

  test("close 4409 (replaced) yields the seat for minutes instead of racing back", async () => {
    const handles = [makeFakeInner(), makeFakeInner()];
    for (const h of handles) mockedCreate.mockResolvedValueOnce(h.inner as any);

    const facade = await createReconnectingWSClient({ ...baseOpts, jitter: "none" });

    // Defect 2: the server evicted the older connection with a bare TCP close,
    // which the loser read as 1006 — a routine blip — and came straight back,
    // evicting the winner in turn. The server now says 4409 ("someone else took
    // this agent"), and the loser stands down for minutes: whoever the user
    // actually wants gets to keep the seat. Still retriable, though — the other
    // side may be a machine that goes to sleep.
    handles[0]!.simulateServerClose(4409, "replaced_by_new_connection");
    await flushMicrotasks();

    // Equal jitter over a 60s base ⇒ the delay lands in [30s, 60s).
    await vi.advanceTimersByTimeAsync(20_000);
    await flushMicrotasks();
    expect(facade.state).toBe("backoff");
    expect(mockedCreate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    expect(facade.state).toBe("connected");
    expect(mockedCreate).toHaveBeenCalledTimes(2);
  });

  test("the yield survives a failed attempt instead of collapsing to the fast curve", async () => {
    // Pin the jitter: the yield forces "equal" regardless of options, so with
    // random()=0 every yield is exactly half its base and the timings below are
    // exact rather than a range.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const handles = [makeFakeInner(), makeFakeInner()];
    mockedCreate.mockResolvedValueOnce(handles[0]!.inner as any);
    // The attempt that follows the yield fails — a flaky link, not the peer
    // letting go. If that reset us to the ordinary curve we would be back
    // within ~2s and evict the winner all over again.
    mockedCreate.mockRejectedValueOnce(new WSConnectError("network hiccup"));
    mockedCreate.mockResolvedValueOnce(handles[1]!.inner as any);

    const facade = await createReconnectingWSClient({ ...baseOpts, jitter: "none" });

    handles[0]!.simulateServerClose(4409, "replaced_by_new_connection");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(30_000); // yield elapses; attempt 2 fails
    await flushMicrotasks();
    expect(mockedCreate).toHaveBeenCalledTimes(2);

    // Still yielding — NOT back on the ~2s curve.
    await vi.advanceTimersByTimeAsync(29_000);
    await flushMicrotasks();
    expect(facade.state).toBe("backoff");
    expect(mockedCreate).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();
    expect(facade.state).toBe("connected");
  });

  test("repeated evictions escalate the yield even though each session outlasts the window", async () => {
    // The trap this pins: the yield's own minimum (30s) is >= the stability
    // window (30s), so the session between two evictions ALWAYS looks stable.
    // Clearing the eviction streak there made the ladder unreachable — two
    // clients then swapped the seat ~80×/hour forever, in turns far too short
    // to finish a match, while every log line still read "attempt 1".
    vi.spyOn(Math, "random").mockReturnValue(0); // equal jitter → exactly base/2
    const handles = [makeFakeInner(), makeFakeInner(), makeFakeInner()];
    for (const h of handles) mockedCreate.mockResolvedValueOnce(h.inner as any);

    const facade = await createReconnectingWSClient({ ...baseOpts, jitter: "none" });

    // Eviction 1: base 60s → 30s.
    handles[0]!.simulateServerClose(4409, "replaced_by_new_connection");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(30_000);
    await flushMicrotasks();
    expect(facade.state).toBe("connected");

    // Eviction 2 after a seat we held for a while: base 120s → 60s. The old
    // code came back after 30s here, forever.
    await vi.advanceTimersByTimeAsync(31_000);
    handles[1]!.simulateServerClose(4409, "replaced_by_new_connection");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(59_000);
    await flushMicrotasks();
    expect(facade.state).toBe("backoff");
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();
    expect(facade.state).toBe("connected");
  });

  test("an ordinary disconnect ends the yield, so the peer leaving restores the fast curve", async () => {
    // Once the competitor is gone, nothing about a past eviction should still be
    // slowing us down: a plain network drop must retry in ~1s, not minutes.
    const handles = [makeFakeInner(), makeFakeInner(), makeFakeInner()];
    for (const h of handles) mockedCreate.mockResolvedValueOnce(h.inner as any);

    const facade = await createReconnectingWSClient({ ...baseOpts, jitter: "none" });

    handles[0]!.simulateServerClose(4409, "replaced_by_new_connection");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    expect(facade.state).toBe("connected");

    // A normal 1006 now — the seat was not taken from us this time.
    await vi.advanceTimersByTimeAsync(31_000);
    handles[1]!.simulateServerClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    expect(facade.state).toBe("connected");
    expect(mockedCreate).toHaveBeenCalledTimes(3);
  });

  test("a run of failed connects does not push the next short session to the cap", async () => {
    const handles = [makeFakeInner(), makeFakeInner()];
    mockedCreate.mockResolvedValueOnce(handles[0]!.inner as any);
    // Six dead attempts — someone's wi-fi was off.
    for (let i = 0; i < 6; i += 1) {
      mockedCreate.mockRejectedValueOnce(new WSConnectError("offline"));
    }
    mockedCreate.mockResolvedValueOnce(handles[1]!.inner as any);

    const facade = await createReconnectingWSClient({ ...baseOpts, jitter: "none" });
    handles[0]!.simulateServerClose(1006);
    // 1s, then 2+4+8+16+30+30s across the six dead attempts.
    await vi.advanceTimersByTimeAsync(91_000);
    await flushMicrotasks();
    expect(facade.state).toBe("connected");

    // The outage is over. The short session that follows is a FLAP, and only
    // the second one at that — it must retry in a couple of seconds, not
    // inherit the outage's failure count and sit at the 30s ceiling.
    handles[1]!.simulateServerClose(1006);
    const third = makeFakeInner();
    mockedCreate.mockResolvedValueOnce(third.inner as any);
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();
    expect(facade.state).toBe("connected");
  });

  test("escalation still bites under the production jitter setting", async () => {
    // Everything above pins jitter:"none" for exact timings; the bridge ships
    // with the default, which draws from [0, base) and would otherwise let an
    // escalating flap keep firing sub-second retries.
    const handles = [makeFakeInner(), makeFakeInner(), makeFakeInner()];
    for (const h of handles) mockedCreate.mockResolvedValueOnce(h.inner as any);

    const facade = await createReconnectingWSClient(baseOpts); // no jitter override
    handles[0]!.simulateServerClose(1006);
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(facade.state).toBe("connected");

    // Second instant drop ⇒ base 2s with equal jitter ⇒ at least 1s.
    handles[1]!.simulateServerClose(1006);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(900);
    await flushMicrotasks();
    expect(facade.state).toBe("backoff");
    await vi.advanceTimersByTimeAsync(1200);
    await flushMicrotasks();
    expect(facade.state).toBe("connected");
  });

  test("1005 and 1013 reconnect instead of killing the bridge", async () => {
    // 1005 = "no status received": what a close frame with an EMPTY payload
    // looks like. Our own server produced those, and treating them as terminal
    // left the bridge dead until the user relaunched it.
    for (const code of [1005, 1013]) {
      mockedCreate.mockReset();
      const handles = [makeFakeInner(), makeFakeInner()];
      for (const h of handles) mockedCreate.mockResolvedValueOnce(h.inner as any);

      const facade = await createReconnectingWSClient({ ...baseOpts, jitter: "none" });
      handles[0]!.simulateServerClose(code);
      await vi.advanceTimersByTimeAsync(1000);
      await flushMicrotasks();
      expect(facade.state, `close code ${code} must be retriable`).toBe("connected");
    }
  });
});
