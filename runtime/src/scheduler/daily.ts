// M1-15 cron-like daily scheduler — per-agent, injectable clock,
// in-memory schedule config. plan §5.1 + §5.2 + §5.9.
//
// Internal-only — not re-exported from runtime/src/index.ts (M1-15
// rev1 decision #9). Daemon lifecycle (M1-18) wires one DailyScheduler
// per AgentInstance; control API (M1-16) / CLI (M1-17) own the config
// surface (read/write SQLite).

import type { AgentInstanceSnapshot } from "../agents/agent";
import type { GameType } from "../decision/types";
import type {
  DailyScheduleConfig,
  DailySchedulerLastAttempt,
  DailySchedulerNotifyEvent,
  DailySchedulerSnapshot,
} from "./types";

// ─── Public surface — agent / clock adapters ────────────────────────────

export interface SchedulerAgentTarget {
  readonly name: string;
  joinQueue(game: string, mode?: string): void;
  snapshot(): AgentInstanceSnapshot;
  onState(handler: (snapshot: AgentInstanceSnapshot) => void): () => void;
}

export type SchedulerTimerHandle = unknown;

export interface SchedulerClock {
  readonly now: () => number;
  readonly setTimeout: (cb: () => void, ms: number) => SchedulerTimerHandle;
  readonly clearTimeout: (h: SchedulerTimerHandle) => void;
}

// ─── Factory options ────────────────────────────────────────────────────

export interface DailySchedulerOptions {
  readonly agent: SchedulerAgentTarget;
  /** Initial schedule snapshot taken once at construction; copied into
   *  the scheduler's internal `currentSchedule` field. After construction
   *  the only way to change schedule is `scheduler.setSchedule(cfg)`.
   *  rev2 fix #3 single authority. */
  readonly initialSchedule?: DailyScheduleConfig | null;
  /** Optional health gate. Resolves true → join allowed; false / throw →
   *  skip + notify. Scheduler does NOT hold a DecisionProvider instance
   *  (rev1 decision #7). */
  readonly healthCheck?: () => Promise<boolean>;
  /** Default = real wall clock + globalThis.{setTimeout, clearTimeout}. */
  readonly clock?: SchedulerClock;
  readonly onNotify?: (event: DailySchedulerNotifyEvent) => void;
}

// ─── Public surface — DailyScheduler ────────────────────────────────────

export interface DailyScheduler {
  start(): void;
  stop(): void;
  snapshot(): DailySchedulerSnapshot;
  /** rev2 fix #3 — single authority: replace internal `currentSchedule`.
   *  `cfg` is sync-validated; invalid throws DailySchedulerError. `null`
   *  means "no schedule" (scheduler keeps running; every fire goes to
   *  skip_disabled). NOT equivalent to stop(). */
  setSchedule(cfg: DailyScheduleConfig | null): void;
}

// ─── Error class (concrete, kind discriminator) ─────────────────────────

export type DailySchedulerErrorKind =
  | "invalid_timezone"
  | "invalid_count"
  | "invalid_min_interval"
  | "invalid_state";

export class DailySchedulerError extends Error {
  override readonly name = "DailySchedulerError";
  readonly kind: DailySchedulerErrorKind;
  override readonly cause: unknown;

  constructor(
    kind: DailySchedulerErrorKind,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.kind = kind;
    this.cause = cause;
  }
}

// ─── Internal constants ─────────────────────────────────────────────────

const MS_PER_HOUR = 3_600_000;
const GAME_ORDER: readonly GameType[] = ["texas_holdem", "liars_dice", "coup"];
const DEFAULT_MIN_INTERVAL_SEC = 60;
const IDLE_POLL_MS = 60_000;

// ─── Helpers ────────────────────────────────────────────────────────────

function isEmptyDays(days: Partial<Record<GameType, unknown>>): boolean {
  return Object.keys(days).length === 0;
}

function isNonNegativeInteger(n: unknown): n is number {
  return (
    typeof n === "number" &&
    Number.isFinite(n) &&
    Number.isInteger(n) &&
    n >= 0
  );
}

function validateConfig(cfg: DailyScheduleConfig): void {
  // timezone: probe Intl.DateTimeFormat construction (RangeError if invalid).
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: cfg.timezone });
  } catch (e) {
    throw new DailySchedulerError(
      "invalid_timezone",
      `invalid IANA timezone: ${String(cfg.timezone)}`,
      e,
    );
  }

  for (const [game, quota] of Object.entries(cfg.days)) {
    if (!quota) continue;
    if (!isNonNegativeInteger(quota.count)) {
      throw new DailySchedulerError(
        "invalid_count",
        `count for game ${game} must be a non-negative integer (got ${String(quota.count)})`,
      );
    }
  }

  if (
    cfg.minIntervalSec !== undefined &&
    !isNonNegativeInteger(cfg.minIntervalSec)
  ) {
    throw new DailySchedulerError(
      "invalid_min_interval",
      `minIntervalSec must be a non-negative integer (got ${String(cfg.minIntervalSec)})`,
    );
  }
}

function makeYMDFormatter(tz: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function formatLocalYMD(nowMs: number, fmt: Intl.DateTimeFormat): string {
  const parts = fmt.formatToParts(new Date(nowMs));
  let year = "";
  let month = "";
  let day = "";
  for (const p of parts) {
    if (p.type === "year") year = p.value;
    else if (p.type === "month") month = p.value;
    else if (p.type === "day") day = p.value;
  }
  return `${year}-${month}-${day}`;
}

function msUntilNextLocalMidnight(
  nowMs: number,
  fmt: Intl.DateTimeFormat,
  tz: string,
): number {
  const today = formatLocalYMD(nowMs, fmt);
  let lo = nowMs + 1;
  let hi = nowMs + 26 * MS_PER_HOUR;

  if (formatLocalYMD(hi, fmt) === today) {
    throw new DailySchedulerError(
      "invalid_timezone",
      `timezone '${tz}' did not advance the local date within 26h`,
    );
  }

  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (formatLocalYMD(mid, fmt) === today) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return hi - nowMs;
}

function pickNextGame(
  days: Partial<Record<GameType, { count: number }>>,
  used: Partial<Record<GameType, number>>,
  lastGame: GameType | null,
): GameType | null {
  const startIdx =
    lastGame === null
      ? 0
      : (GAME_ORDER.indexOf(lastGame) + 1) % GAME_ORDER.length;
  for (let i = 0; i < GAME_ORDER.length; i++) {
    const g = GAME_ORDER[(startIdx + i) % GAME_ORDER.length]!;
    const cap = days[g]?.count ?? 0;
    const u = used[g] ?? 0;
    if (cap > u) return g;
  }
  return null;
}

function totalRemainingQuota(
  days: Partial<Record<GameType, { count: number }>>,
  used: Partial<Record<GameType, number>>,
): number {
  let total = 0;
  for (const g of GAME_ORDER) {
    const cap = days[g]?.count ?? 0;
    const u = used[g] ?? 0;
    if (cap > u) total += cap - u;
  }
  return total;
}

function nextFireDelay(
  cfg: DailyScheduleConfig,
  used: Partial<Record<GameType, number>>,
  nowMs: number,
  fmt: Intl.DateTimeFormat,
  tz: string,
): number {
  const remainingTodayMs = msUntilNextLocalMidnight(nowMs, fmt, tz);
  const remainingQuota = totalRemainingQuota(cfg.days, used);
  if (remainingQuota === 0) {
    return remainingTodayMs + 1000;
  }
  const evenSpaceMs = Math.floor(remainingTodayMs / remainingQuota);
  const minIntervalMs =
    (cfg.minIntervalSec ?? DEFAULT_MIN_INTERVAL_SEC) * 1000;
  return Math.max(minIntervalMs, evenSpaceMs);
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ─── Defaults ───────────────────────────────────────────────────────────

const DEFAULT_CLOCK: SchedulerClock = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (h) =>
    globalThis.clearTimeout(
      h as Parameters<typeof globalThis.clearTimeout>[0],
    ),
};

// ─── Factory ────────────────────────────────────────────────────────────

export function createDailyScheduler(
  opts: DailySchedulerOptions,
): DailyScheduler {
  const clock = opts.clock ?? DEFAULT_CLOCK;
  const agent = opts.agent;
  const healthCheck = opts.healthCheck;
  const onNotify = opts.onNotify;

  // Construction-time validate of initialSchedule (sync throw → caller
  // learns config errors immediately, same pattern as M1-14 Step 2b).
  let currentSchedule: DailyScheduleConfig | null =
    opts.initialSchedule ?? null;
  if (currentSchedule) validateConfig(currentSchedule);

  // Per-tz formatter cache. Rebuild only when timezone changes.
  let formatter: Intl.DateTimeFormat | null = null;
  let formatterTz: string | null = null;
  const ensureFormatter = (tz: string): Intl.DateTimeFormat => {
    if (formatter && formatterTz === tz) return formatter;
    formatter = makeYMDFormatter(tz);
    formatterTz = tz;
    return formatter;
  };
  if (currentSchedule) ensureFormatter(currentSchedule.timezone);

  let started = false;
  let stopped = false;
  let disposed = false;

  let cachedToday: string | null = null;
  let quotaUsedToday: Partial<Record<GameType, number>> = {};
  let lastGame: GameType | null = null;
  let lastFireAt = 0;
  let lastAttempt: DailySchedulerLastAttempt | null = null;

  let timerHandle: SchedulerTimerHandle | null = null;
  let nextFireScheduledAt: number | null = null;
  let inFlight = false;

  let unsubAgent: (() => void) | null = null;

  // Monotonic version counter — bumped on every successful setSchedule.
  // fire() captures the version at entry and re-checks across every
  // await boundary so that a setSchedule(null) / setSchedule(disabled) /
  // setSchedule(different days) made while fire is suspended on
  // healthCheck cannot race past and joinQueue with the stale cfg.
  // setSchedule itself reschedules the next timer, so a drifted fire
  // must NOT call scheduleNext at the tail (which would clobber the
  // newly authoritative timer).
  let scheduleVersion = 0;

  // ─── Notify helper (best-effort; never throws back to scheduler) ──────

  const safeNotify = (event: DailySchedulerNotifyEvent): void => {
    if (!onNotify) return;
    try {
      onNotify(event);
    } catch {
      // Listener bug — swallow.
    }
  };

  // ─── Timer scheduling ─────────────────────────────────────────────────

  const clearTimer = (): void => {
    if (timerHandle !== null) {
      clock.clearTimeout(timerHandle);
      timerHandle = null;
      nextFireScheduledAt = null;
    }
  };

  const scheduleNext = (delayMs: number): void => {
    clearTimer();
    if (disposed) return;
    const ms = Math.max(1, Math.floor(delayMs));
    nextFireScheduledAt = clock.now() + ms;
    timerHandle = clock.setTimeout(() => {
      timerHandle = null;
      nextFireScheduledAt = null;
      void runFire();
    }, ms);
  };

  // ─── Fire wrapper (top-level try/catch — Group 6 case 35) ─────────────

  const runFire = async (): Promise<void> => {
    if (disposed) return;
    if (inFlight) return; // guard against double-fire from onState
    inFlight = true;
    try {
      await fire();
    } catch (err) {
      safeNotify({
        level: "error",
        code: "internal_error",
        message: `daily scheduler fire callback threw: ${describeError(err)}`,
        agent: agent.name,
        cause: err,
      });
      stopInternal();
    } finally {
      inFlight = false;
    }
  };

  // ─── Fire body ────────────────────────────────────────────────────────

  const fire = async (): Promise<void> => {
    // Capture schedule generation at entry. Any setSchedule call during
    // this fire's awaits bumps scheduleVersion; we re-check below so that
    // an in-flight setSchedule(null/disabled/different days) cannot be
    // raced past by a stale joinQueue. setSchedule already calls
    // scheduleNext, so on drift we return WITHOUT scheduleNext to avoid
    // clobbering the new authoritative timer.
    const fireVersion = scheduleVersion;
    const cfg = currentSchedule;
    const nowMs = clock.now();

    if (!cfg || !cfg.enabled || isEmptyDays(cfg.days)) {
      safeNotify({
        level: "info",
        code: "skip_disabled",
        message: "scheduler disabled or no days configured",
        agent: agent.name,
      });
      scheduleNext(IDLE_POLL_MS);
      return;
    }

    const fmt = ensureFormatter(cfg.timezone);

    // Day rollover (also covers first-fire when cachedToday === null).
    const today = formatLocalYMD(nowMs, fmt);
    if (today !== cachedToday) {
      cachedToday = today;
      quotaUsedToday = {};
      lastGame = null;
      safeNotify({
        level: "info",
        code: "day_rolled_over",
        message: `day rolled over to ${today}`,
        agent: agent.name,
      });
    }

    // Pick next game with cursor round-robin (rev2 fix #4).
    const game = pickNextGame(cfg.days, quotaUsedToday, lastGame);
    if (game === null) {
      safeNotify({
        level: "info",
        code: "skip_no_quota",
        message: "no quota remaining today",
        agent: agent.name,
      });
      const untilMidnight = msUntilNextLocalMidnight(nowMs, fmt, cfg.timezone);
      scheduleNext(untilMidnight + 1000);
      return;
    }

    // Snapshot (defensive try/catch — Group 6 case 34 snapshot_threw).
    let snap: AgentInstanceSnapshot;
    try {
      snap = agent.snapshot();
    } catch (err) {
      safeNotify({
        level: "error",
        code: "snapshot_threw",
        message: `agent.snapshot() threw: ${describeError(err)}`,
        agent: agent.name,
        cause: err,
      });
      scheduleNext(retryDelay(cfg, clock.now(), fmt));
      return;
    }

    // Agent state gating — short-circuit, lowercase phase (rev2 fix #1).
    if (!snap.started) {
      safeNotify({
        level: "info",
        code: "skip_agent_not_started",
        message: "agent has not been started",
        agent: agent.name,
        game,
      });
      scheduleNext(retryDelay(cfg, clock.now(), fmt));
      return;
    }
    if (snap.stopped) {
      safeNotify({
        level: "info",
        code: "skip_agent_stopped",
        message: "agent has been stopped",
        agent: agent.name,
        game,
      });
      scheduleNext(retryDelay(cfg, clock.now(), fmt));
      return;
    }
    if (snap.state === null) {
      safeNotify({
        level: "info",
        code: "skip_state_unavailable",
        message: "agent state is null (welcome not received)",
        agent: agent.name,
        game,
      });
      scheduleNext(retryDelay(cfg, clock.now(), fmt));
      return;
    }
    if (snap.transport !== "connected") {
      safeNotify({
        level: "info",
        code: "skip_transport_disconnected",
        message: `agent transport=${snap.transport}`,
        agent: agent.name,
        game,
      });
      scheduleNext(retryDelay(cfg, clock.now(), fmt));
      return;
    }
    if (snap.state.phase !== "connected") {
      safeNotify({
        level: "info",
        code: "skip_state_busy",
        message: `agent phase=${snap.state.phase}`,
        agent: agent.name,
        game,
      });
      scheduleNext(retryDelay(cfg, clock.now(), fmt));
      return;
    }

    // Min interval gate.
    const minIntervalMs =
      (cfg.minIntervalSec ?? DEFAULT_MIN_INTERVAL_SEC) * 1000;
    if (lastFireAt > 0 && nowMs - lastFireAt < minIntervalMs) {
      const remaining = minIntervalMs - (nowMs - lastFireAt);
      safeNotify({
        level: "info",
        code: "skip_min_interval",
        message: `within minIntervalSec floor (${remaining}ms remaining)`,
        agent: agent.name,
        game,
      });
      scheduleNext(remaining);
      return;
    }

    // Health check.
    if (healthCheck) {
      let ok: boolean;
      try {
        ok = await healthCheck();
      } catch (err) {
        // Schedule may have been replaced during the await. setSchedule
        // already scheduled the next timer; do nothing here.
        if (scheduleVersion !== fireVersion) return;
        safeNotify({
          level: "warning",
          code: "health_check_threw",
          message: `healthCheck threw: ${describeError(err)}`,
          agent: agent.name,
          game,
          cause: err,
        });
        scheduleNext(retryDelay(cfg, clock.now(), fmt));
        return;
      }
      if (disposed) return; // stop() during in-flight health (Risks #10).
      // Schedule replaced during the resolved-true await branch.
      if (scheduleVersion !== fireVersion) return;
      if (!ok) {
        safeNotify({
          level: "info",
          code: "skip_health_check",
          message: "healthCheck returned false",
          agent: agent.name,
          game,
        });
        scheduleNext(retryDelay(cfg, clock.now(), fmt));
        return;
      }
    }

    if (disposed) return;
    // Final safety net: setSchedule(null/disabled/different days) during
    // healthCheck must not be raced past by joinQueue with stale cfg.
    if (scheduleVersion !== fireVersion) return;

    safeNotify({
      level: "info",
      code: "join_attempted",
      message: `joining queue for ${game}`,
      agent: agent.name,
      game,
    });

    let outcome: DailySchedulerLastAttempt["outcome"];
    let cause: unknown;
    try {
      agent.joinQueue(game);
      lastFireAt = clock.now();
      quotaUsedToday[game] = (quotaUsedToday[game] ?? 0) + 1;
      lastGame = game; // rev3 fix #3 — cursor advances ONLY on success.
      outcome = "join_succeeded";
      safeNotify({
        level: "info",
        code: "join_succeeded",
        message: `joinQueue(${game}) succeeded`,
        agent: agent.name,
        game,
      });
    } catch (err) {
      outcome = "join_threw";
      cause = err;
      safeNotify({
        level: "error",
        code: "join_threw",
        message: `joinQueue(${game}) threw: ${describeError(err)}`,
        agent: agent.name,
        game,
        cause: err,
      });
    }
    lastAttempt = { atMs: clock.now(), game, outcome, cause };

    // Tail scheduleNext: if setSchedule was invoked synchronously inside
    // agent.joinQueue (defensive — joinQueue is sync agent code, but a
    // host could plug observers), the new authority owns the timer.
    // Otherwise schedule using the same cfg/fmt we've held throughout.
    if (scheduleVersion !== fireVersion) return;
    scheduleNext(
      nextFireDelay(cfg, quotaUsedToday, clock.now(), fmt, cfg.timezone),
    );
  };

  // Retry delay = max(minIntervalMs, evenSpaceMs); used for skip paths.
  const retryDelay = (
    cfg: DailyScheduleConfig,
    nowMs: number,
    fmt: Intl.DateTimeFormat,
  ): number => {
    return nextFireDelay(cfg, quotaUsedToday, nowMs, fmt, cfg.timezone);
  };

  // ─── Agent state subscription (quick-fire on connected transition) ────

  const handleAgentState = (snap: AgentInstanceSnapshot): void => {
    if (snap.stopped) {
      stopInternal();
      return;
    }
    if (inFlight || timerHandle === null) return;
    if (
      !currentSchedule ||
      !currentSchedule.enabled ||
      isEmptyDays(currentSchedule.days)
    ) {
      return;
    }
    if (
      snap.state !== null &&
      snap.transport === "connected" &&
      snap.state.phase === "connected"
    ) {
      clearTimer();
      scheduleNext(1);
    }
  };

  // ─── Lifecycle ────────────────────────────────────────────────────────

  const stopInternal = (): void => {
    if (stopped) return;
    if (started) {
      safeNotify({
        level: "info",
        code: "stopped",
        message: "scheduler stopped",
        agent: agent.name,
      });
    }
    stopped = true;
    disposed = true;
    clearTimer();
    if (unsubAgent) {
      try {
        unsubAgent();
      } catch {
        // swallow listener teardown errors
      }
      unsubAgent = null;
    }
  };

  const start = (): void => {
    if (stopped) {
      throw new DailySchedulerError(
        "invalid_state",
        "scheduler has already been stopped; cannot restart",
      );
    }
    if (started) {
      throw new DailySchedulerError(
        "invalid_state",
        "scheduler has already been started",
      );
    }
    started = true;
    safeNotify({
      level: "info",
      code: "started",
      message: "scheduler started",
      agent: agent.name,
    });
    unsubAgent = agent.onState(handleAgentState);
    // First fire: 1ms (avoid sync recursion; let setTimeout callback run async).
    scheduleNext(1);
  };

  const stop = (): void => {
    if (!started) {
      // Pre-start no-op (Error Contract row 6); do not flip stopped flag,
      // so test fixtures calling stop() in cleanup don't poison later state.
      return;
    }
    stopInternal();
  };

  const setSchedule = (cfg: DailyScheduleConfig | null): void => {
    if (stopped) {
      throw new DailySchedulerError(
        "invalid_state",
        "scheduler has been stopped; cannot setSchedule",
      );
    }
    if (cfg) validateConfig(cfg);
    currentSchedule = cfg;
    if (cfg) ensureFormatter(cfg.timezone);
    // Bump version BEFORE rescheduling so that any in-flight fire
    // suspended on `await healthCheck()` will detect the drift the
    // moment its await resumes.
    scheduleVersion++;
    safeNotify({
      level: "info",
      code: "schedule_changed",
      message: cfg === null ? "schedule cleared" : "schedule updated",
      agent: agent.name,
    });
    if (started && !stopped) {
      // Re-evaluate next delay; do NOT fire immediately (Risks #12 lock).
      const nowMs = clock.now();
      let delay: number;
      if (!cfg || !cfg.enabled || isEmptyDays(cfg.days)) {
        delay = IDLE_POLL_MS;
      } else {
        const fmt = ensureFormatter(cfg.timezone);
        delay = nextFireDelay(cfg, quotaUsedToday, nowMs, fmt, cfg.timezone);
      }
      scheduleNext(delay);
    }
  };

  const snapshotFn = (): DailySchedulerSnapshot => {
    const remaining: Partial<Record<GameType, number>> = {};
    if (currentSchedule) {
      for (const g of GAME_ORDER) {
        const cap = currentSchedule.days[g]?.count;
        if (cap === undefined) continue;
        const used = quotaUsedToday[g] ?? 0;
        remaining[g] = Math.max(0, cap - used);
      }
    }
    return {
      running: started && !stopped,
      today: cachedToday,
      remaining,
      lastAttempt,
      nextFireInMs:
        nextFireScheduledAt === null
          ? null
          : nextFireScheduledAt - clock.now(),
    };
  };

  return {
    start,
    stop,
    snapshot: snapshotFn,
    setSchedule,
  };
}
