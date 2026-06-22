// M5-01 fault-injection shared helpers.
//
// 3 utilities used across fault-injection/*.test.ts:
//   - makeFakeClock(initialMs) — injectable SchedulerClock with manual setNow
//     and advance(ms) that drains pending setTimeouts. Subset of the helper in
//     scheduler-daily.test.ts (sealed by M1-15) — re-implemented here so the
//     fault-injection suite stays standalone.
//   - makeAbortHonoringHangingClient() — DirectModelClient whose generate()
//     returns a Promise that rejects only when the AbortSignal fires
//     (mirrors a well-behaved real client under decisionBudgetMs trip).
//   - makeFsOpenSyncError(matcher, code) — wraps fs.openSync via vi.spyOn so
//     selected tmp paths throw an Error with the given errno code. Returns a
//     restore() callback callers must invoke in afterEach.
//
// Sealed surface (M5-01 lock): the three exported factories' option shapes
// (initialMs / DirectModelClient.generate signature / matcher+code pair).
// Tests inside fault-injection/*.test.ts may add new factories here but MUST
// NOT change the existing factory signatures without bumping M5-01.

import { vi } from "vitest";
import fs from "node:fs";

import type {
  SchedulerClock,
  SchedulerTimerHandle,
} from "../../src/scheduler/daily";
import { DirectModelAbortedError } from "../../src/decision/direct-model/errors";
import type {
  DirectModelClient,
  DirectModelGenerateRequest,
  DirectModelGenerateResponse,
} from "../../src/decision/direct-model/types";

// ─── Fake clock ─────────────────────────────────────────────────────────

export interface FakeClockHandle {
  readonly clock: SchedulerClock;
  /** Drain timers up through `nowMs + deltaMs`, advancing `nowMs` step-by-step
   *  to each fire time so cb sees a consistent now(). Microtasks are NOT
   *  drained — caller `await flushAsync()` after for chained awaits. */
  advance(deltaMs: number): void;
  /** Set absolute now() — does NOT trigger any pending timers. Use for
   *  clock-skew scenarios where the wall clock jumps without timers firing. */
  setNow(ms: number): void;
  now(): number;
  pendingTimerCount(): number;
}

export function makeFakeClock(
  initialMs: number = Date.UTC(2026, 3, 27, 12, 0, 0),
): FakeClockHandle {
  let nowMs = initialMs;
  const timers = new Map<number, { fireAt: number; cb: () => void }>();
  let nextHandle = 1;
  return {
    clock: {
      now: () => nowMs,
      setTimeout: (cb, ms) => {
        const h = nextHandle++;
        timers.set(h, {
          fireAt: nowMs + Math.max(0, Math.floor(ms)),
          cb,
        });
        return h;
      },
      clearTimeout: (h: SchedulerTimerHandle) => {
        if (typeof h === "number") timers.delete(h);
      },
    },
    advance(deltaMs) {
      const target = nowMs + deltaMs;
      let safety = 200_000;
      while (safety-- > 0) {
        let nextFireAt = Infinity;
        let nextHandleId: number | null = null;
        for (const [h, t] of timers) {
          if (t.fireAt < nextFireAt) {
            nextFireAt = t.fireAt;
            nextHandleId = h;
          }
        }
        if (nextHandleId === null || nextFireAt > target) break;
        nowMs = nextFireAt;
        const t = timers.get(nextHandleId)!;
        timers.delete(nextHandleId);
        t.cb();
      }
      nowMs = target;
    },
    setNow(ms) {
      nowMs = ms;
    },
    now() {
      return nowMs;
    },
    pendingTimerCount() {
      return timers.size;
    },
  };
}

export async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

// ─── DirectModelClient stubs ─────────────────────────────────────────────

/** Returns a DirectModelClient whose generate() returns a Promise that pends
 *  forever unless the request's AbortSignal fires, at which point it rejects
 *  with DirectModelAbortedError. Mirrors real M1-11 anthropic.ts / openai.ts
 *  behavior under decisionBudgetMs trip — fetch's signal abort path. Used to
 *  test that the daemon's outer AbortController correctly aborts a slow LLM. */
export function makeAbortHonoringHangingClient(
  provider: "anthropic" | "openai" = "anthropic",
  model = "claude-opus-4-7",
): {
  client: DirectModelClient;
  generate: ReturnType<typeof vi.fn>;
} {
  const generate = vi.fn(
    (req: DirectModelGenerateRequest): Promise<DirectModelGenerateResponse> =>
      new Promise<DirectModelGenerateResponse>((_, reject) => {
        if (req.signal?.aborted) {
          reject(new DirectModelAbortedError(provider, "aborted"));
          return;
        }
        req.signal?.addEventListener("abort", () => {
          reject(new DirectModelAbortedError(provider, "aborted"));
        });
      }),
  );
  return {
    client: { provider, model, generate },
    generate,
  };
}

// ─── fs error injection ──────────────────────────────────────────────────

/** vi.spyOn(fs, "openSync") that throws { code } for paths matching `matcher`,
 *  and delegates to the real openSync for everything else. Returns a callback
 *  the caller invokes in afterEach to restore. Code typically "ENOSPC" or
 *  "EACCES" — both flow through the same atomicWrite catch path. */
export function injectFsOpenSyncError(
  matcher: (filePath: string) => boolean,
  code: string,
): { restore: () => void; spy: { mockRestore(): void } } {
  const realOpenSync = fs.openSync;
  const spy = vi.spyOn(fs, "openSync").mockImplementation((p, ...rest) => {
    if (typeof p === "string" && matcher(p)) {
      const err = Object.assign(new Error(code), { code });
      throw err;
    }
    return (realOpenSync as unknown as (...args: unknown[]) => number)(
      p,
      ...rest,
    );
  });
  return {
    spy,
    restore: () => {
      spy.mockRestore();
    },
  };
}
