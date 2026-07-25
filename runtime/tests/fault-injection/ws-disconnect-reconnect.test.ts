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

  // ── 2026-07-25 redesign: identity-based eviction handling. ──
  // The old yield ladder (30-60s → 5-10min, #replacedStreak) is gone: a 4409
  // now parks the facade, which asks the presence endpoint before every
  // re-dial. These tests pin the replacement semantics; the ladder tests they
  // replace lived here until the redesign.

  test("close 4409 parks the seat — blind re-dial only at the ladder-ceiling cadence", async () => {
    // Legacy server: opaque reason text, no probeSeat hook. A blind dial rips
    // the seat holder off unconditionally, so it may NOT happen on the 10s
    // fast path — only at the ~5min cadence the old ladder converged to.
    vi.spyOn(Math, "random").mockReturnValue(0); // pin the probe jitter to 0
    const handles = [makeFakeInner(), makeFakeInner()];
    for (const h of handles) mockedCreate.mockResolvedValueOnce(h.inner as any);

    const facade = await createReconnectingWSClient({ ...baseOpts, jitter: "none" });

    handles[0]!.simulateServerClose(4409, "replaced_by_new_connection");
    await flushMicrotasks();
    expect(facade.state).toBe("parked");

    // Fast first probe (10s): no probe hook → verdict unknown → NO blind dial.
    await vi.advanceTimersByTimeAsync(11_000);
    await flushMicrotasks();
    expect(facade.state).toBe("parked");
    expect(mockedCreate).toHaveBeenCalledTimes(1);

    // Full cadence (300s): blind dial is now allowed → reconnected.
    await vi.advanceTimersByTimeAsync(301_000);
    await flushMicrotasks();
    expect(facade.state).toBe("connected");
    expect(mockedCreate).toHaveBeenCalledTimes(2);
  });

  test("a probing rival keeps us parked; the seat freeing up ends the park", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const handles = [makeFakeInner(), makeFakeInner()];
    for (const h of handles) mockedCreate.mockResolvedValueOnce(h.inner as any);

    const probeSeat = vi
      .fn()
      .mockResolvedValueOnce({ connected: true, instanceMatches: false })
      .mockResolvedValueOnce({ connected: true, instanceMatches: false })
      .mockResolvedValue({ connected: false, instanceMatches: false });

    const facade = await createReconnectingWSClient({
      ...baseOpts,
      jitter: "none",
      probeSeat,
    });

    facade.onMessage(() => {});
    handles[0]!.simulateServerClose(
      4409,
      JSON.stringify({ reason: "replaced_by_new_connection", same_instance: false }),
    );
    await flushMicrotasks();
    expect(facade.state).toBe("parked");

    // Probe 1 (fast, 10s): rival holds the seat → stay parked, NO dial.
    await vi.advanceTimersByTimeAsync(11_000);
    await flushMicrotasks();
    expect(probeSeat).toHaveBeenCalledTimes(1);
    expect(facade.state).toBe("parked");
    expect(mockedCreate).toHaveBeenCalledTimes(1);

    // Probe 2 (full cadence): still held → still parked. The rival is NEVER
    // ripped off the seat by a blind dial while the probe can answer.
    await vi.advanceTimersByTimeAsync(301_000);
    await flushMicrotasks();
    expect(probeSeat).toHaveBeenCalledTimes(2);
    expect(facade.state).toBe("parked");
    expect(mockedCreate).toHaveBeenCalledTimes(1);

    // Probe 3: seat freed → dial → connected.
    await vi.advanceTimersByTimeAsync(301_000);
    await flushMicrotasks();
    expect(probeSeat).toHaveBeenCalledTimes(3);
    expect(facade.state).toBe("connected");
    expect(mockedCreate).toHaveBeenCalledTimes(2);
  });

  test("same_instance=true parks with a superseded-self alarm — never a silent death", async () => {
    // Under single-flight a live facade can never be legitimately replaced by
    // its own process, so same_instance=true means an internal regression or a
    // forged instance id. Either way: alarm + park, NOT a silent stop (审查
    // F7/F9/F10 — a silent stop would be a forgeable kill switch).
    vi.spyOn(Math, "random").mockReturnValue(0);
    const handles = [makeFakeInner(), makeFakeInner()];
    for (const h of handles) mockedCreate.mockResolvedValueOnce(h.inner as any);

    const probeSeat = vi
      .fn()
      .mockResolvedValue({ connected: true, instanceMatches: true });

    const facade = await createReconnectingWSClient({
      ...baseOpts,
      jitter: "none",
      probeSeat,
    });
    const events: Array<{ type: string; severity: string }> = [];
    facade.onReconnect((ev) => events.push({ type: ev.type, severity: ev.severity }));

    handles[0]!.simulateServerClose(
      4409,
      JSON.stringify({ reason: "replaced_by_new_connection", same_instance: true }),
    );
    await flushMicrotasks();

    expect(facade.state).toBe("parked");
    expect(facade.parkedReason).toBe("superseded-self");
    const alarm = events.find((e) => e.type === "superseded-self");
    expect(alarm).toBeDefined();
    expect(alarm!.severity).toBe("error");

    // The holder reports OUR instance id — a zombie of this very process.
    // Reclaiming it disrupts nobody: first probe already authorizes the dial.
    await vi.advanceTimersByTimeAsync(11_000);
    await flushMicrotasks();
    expect(facade.state).toBe("connected");
    expect(mockedCreate).toHaveBeenCalledTimes(2);
  });

  test("after a parked exit, an ordinary disconnect is back on the fast curve", async () => {
    // Once the contention is over nothing about a past eviction may slow the
    // ordinary reconnect path down.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const handles = [makeFakeInner(), makeFakeInner(), makeFakeInner()];
    for (const h of handles) mockedCreate.mockResolvedValueOnce(h.inner as any);

    const probeSeat = vi
      .fn()
      .mockResolvedValue({ connected: false, instanceMatches: false });

    const facade = await createReconnectingWSClient({
      ...baseOpts,
      jitter: "none",
      probeSeat,
    });

    handles[0]!.simulateServerClose(
      4409,
      JSON.stringify({ reason: "replaced_by_new_connection", same_instance: false }),
    );
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(11_000); // probe says empty → dial
    await flushMicrotasks();
    expect(facade.state).toBe("connected");
    expect(mockedCreate).toHaveBeenCalledTimes(2);

    // A normal 1006 now — the seat was not taken from us this time.
    await vi.advanceTimersByTimeAsync(31_000);
    handles[1]!.simulateServerClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    expect(facade.state).toBe("connected");
    expect(mockedCreate).toHaveBeenCalledTimes(3);
  });

  test("close() during an in-flight dial cannot resurrect the facade (P1 single-flight)", async () => {
    // THE zombie guard (2026-07-25 incident): a dial that lands after close()
    // must be discarded, never installed — the pre-redesign code wrote
    // #inner/state unconditionally after the await, resurrecting a facade the
    // caller had been told was closed, as an unowned connection holding the
    // agent seat.
    const first = makeFakeInner();
    mockedCreate.mockResolvedValueOnce(first.inner as any);

    const facade = await createReconnectingWSClient({ ...baseOpts, jitter: "none" });
    const received: unknown[] = [];
    facade.onMessage((m) => {
      received.push(m);
    });

    // Drop the session; the loop schedules a 1s retry whose dial we hold open.
    let releaseDial: ((v: unknown) => void) | null = null;
    const late = makeFakeInner();
    mockedCreate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseDial = resolve as (v: unknown) => void;
        }) as any,
    );
    first.simulateServerClose(1006);
    await vi.advanceTimersByTimeAsync(1_000); // dial 2 now in flight
    expect(mockedCreate).toHaveBeenCalledTimes(2);

    // close() resolves via a setImmediate fallback when the loop is parked on
    // the in-flight dial — fake timers own setImmediate, so pump once.
    const closing = facade.close(1000, "user quit");
    await flushMicrotasks();
    await closing;
    expect(facade.state).toBe("closed");

    // The dial lands AFTER the close — the mock ignores the abort signal, the
    // worst case. The facade must stay closed, hang up the late socket, and
    // never wire handlers onto it.
    releaseDial!(late.inner);
    await flushMicrotasks();
    expect(facade.state).toBe("closed");
    expect(late.inner.close).toHaveBeenCalled();
    late.emitMessage({ type: "ping" });
    expect(received).toHaveLength(0);
  });

  test("poke() during backoff dials immediately instead of waiting out the timer", async () => {
    const handles = [makeFakeInner(), makeFakeInner()];
    for (const h of handles) mockedCreate.mockResolvedValueOnce(h.inner as any);

    const facade = await createReconnectingWSClient({ ...baseOpts, jitter: "none" });

    // Escalate to a 2s delay so an immediate reconnect is distinguishable
    // from the timer just firing.
    await vi.advanceTimersByTimeAsync(31_000);
    handles[0]!.simulateServerClose(1006);
    await flushMicrotasks();
    expect(facade.state).toBe("backoff");

    facade.poke();
    await flushMicrotasks();
    expect(facade.state).toBe("connected");
    expect(mockedCreate).toHaveBeenCalledTimes(2);
  });

  test("a wall-clock jump during backoff reads as a wake: curve reset, dial now", async () => {
    // The machine slept through the retry timer. setTimeout resumes the STALE
    // countdown on wake; the deadline sleep detects the jump instead and
    // dials immediately with a fresh curve (P2/D3).
    const handles = [makeFakeInner(), makeFakeInner()];
    mockedCreate.mockResolvedValueOnce(handles[0]!.inner as any);
    mockedCreate.mockRejectedValueOnce(new WSConnectError("net down"));
    mockedCreate.mockRejectedValueOnce(new WSConnectError("net down"));
    mockedCreate.mockRejectedValueOnce(new WSConnectError("net down"));
    mockedCreate.mockResolvedValueOnce(handles[1]!.inner as any);

    const facade = await createReconnectingWSClient({ ...baseOpts, jitter: "none" });

    // Two failed dials after the flap escalate the curve to a 4s wait.
    handles[0]!.simulateServerClose(1006);
    await vi.advanceTimersByTimeAsync(1_000); // dial #2 fails → next in 2s
    await vi.advanceTimersByTimeAsync(2_000); // dial #3 fails → next in 4s
    await flushMicrotasks();
    expect(facade.state).toBe("backoff");
    expect(mockedCreate).toHaveBeenCalledTimes(3);

    // Sleep the machine mid-backoff: jump the wall clock 1h, then let the
    // frozen timer fire — the overshoot reads as a wake and dials NOW.
    vi.setSystemTime(Date.now() + 3_600_000);
    await vi.advanceTimersByTimeAsync(4_000);
    await flushMicrotasks();
    expect(mockedCreate).toHaveBeenCalledTimes(4); // post-wake dial (fails)

    // The observable proof of the curve RESET: that failed post-wake dial is
    // failure #1 of a fresh cycle, so recovery comes at 1s — without the
    // reset the curve would sit at failure #4 and wait 8s.
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    expect(facade.state).toBe("connected");
    expect(mockedCreate).toHaveBeenCalledTimes(5);
  });

  test("suspend() hands the seat back and schedules nothing; poke() resumes", async () => {
    const handles = [makeFakeInner(), makeFakeInner()];
    for (const h of handles) mockedCreate.mockResolvedValueOnce(h.inner as any);

    const facade = await createReconnectingWSClient({ ...baseOpts, jitter: "none" });

    facade.suspend();
    await flushMicrotasks();
    expect(handles[0]!.inner.close).toHaveBeenCalledWith(1000, "host sleeping");
    expect(facade.state).toBe("suspended");

    // No retries while suspended — a lid-close must not fight the sleep.
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    await flushMicrotasks();
    expect(facade.state).toBe("suspended");
    expect(mockedCreate).toHaveBeenCalledTimes(1);

    facade.poke();
    await flushMicrotasks();
    expect(facade.state).toBe("connected");
    expect(mockedCreate).toHaveBeenCalledTimes(2);
  });

  test("onStateChange projects every edge — including connected (审查 F8)", async () => {
    const handles = [makeFakeInner(), makeFakeInner()];
    for (const h of handles) mockedCreate.mockResolvedValueOnce(h.inner as any);

    const facade = await createReconnectingWSClient({ ...baseOpts, jitter: "none" });

    const seen: Array<{ state: string; seq: number }> = [];
    facade.onStateChange((snap) => seen.push({ state: snap.state, seq: snap.seq }));
    // Late subscriber gets the standing state immediately.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.state).toBe("connected");

    handles[0]!.simulateServerClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    const states = seen.map((s) => s.state);
    // The reconnect must project backoff → connecting → connected. The
    // CONNECTED edge is the one the legacy event stream never carried — its
    // absence is what wedged the desktop UI on "connecting" while online.
    expect(states).toContain("backoff");
    expect(states).toContain("connecting");
    expect(states.lastIndexOf("connected")).toBeGreaterThan(0);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!.seq).toBeGreaterThan(seen[i - 1]!.seq);
    }
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
