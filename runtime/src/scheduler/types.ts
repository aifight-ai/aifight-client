// M1-15 daily scheduler shared types.
//
// Internal-only. The daemon (M1-18) wires DailyScheduler instances
// per-agent; control API (M1-16) and CLI (M1-17) read/write the
// DailyScheduleConfig shape via SQLite or JSON; M1-15 itself just
// receives an in-memory config and an agent target.

import type { GameType } from "../decision/types";

export interface DailyGameQuota {
  /** Non-negative integer. 0 = this game is configured but not scheduled. */
  readonly count: number;
}

export interface DailyScheduleConfig {
  /** Master toggle. false → scheduler stays idle; existing config retained. */
  readonly enabled: boolean;
  /** IANA timezone name, e.g. "Asia/Shanghai" / "UTC". Day boundary is computed in this timezone. */
  readonly timezone: string;
  /** Per-game daily count. Empty object ⇔ disabled (no work). */
  readonly days: Partial<Record<GameType, DailyGameQuota>>;
  /** Minimum delay between any two `joinQueue` calls. Default 60. */
  readonly minIntervalSec?: number;
}

export interface DailySchedulerSnapshot {
  /** Whether start() has been called and stop() has not. */
  readonly running: boolean;
  /** Local YYYY-MM-DD in opts.config.timezone (or null when scheduler stopped). */
  readonly today: string | null;
  /** Remaining quota per game today (config.days minus today's fired count). */
  readonly remaining: Partial<Record<GameType, number>>;
  /** Most recent fire attempt outcome (or null pre-first-fire). */
  readonly lastAttempt: DailySchedulerLastAttempt | null;
  /** Estimated millis until next fire (relative to clock.now()), or null when no fire scheduled. */
  readonly nextFireInMs: number | null;
}

export interface DailySchedulerLastAttempt {
  readonly atMs: number;
  readonly game: GameType;
  readonly outcome:
    | "join_succeeded"
    | "join_threw"
    | `skip_${string}`;
  readonly cause?: unknown;
}

export interface DailySchedulerNotifyEvent {
  readonly level: "info" | "warning" | "error";
  readonly code: DailySchedulerNotifyCode;
  readonly message: string;
  readonly agent?: string;
  readonly game?: GameType;
  readonly cause?: unknown;
}

export type DailySchedulerNotifyCode =
  | "started"
  | "stopped"
  | "schedule_changed"
  | "day_rolled_over"
  | "join_attempted"
  | "join_succeeded"
  | "join_threw"
  | "skip_disabled"
  | "skip_no_quota"
  | "skip_agent_not_started"
  | "skip_agent_stopped"
  | "skip_state_unavailable"
  | "skip_transport_disconnected"
  | "skip_state_busy"
  | "skip_min_interval"
  | "skip_health_check"
  | "health_check_threw"
  | "snapshot_threw"
  | "internal_error";
