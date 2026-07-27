// The daily digest: one message a day that says how the agent actually did.
//
// Everything in it comes from data this machine already has — the local match
// sessions the bridge writes, the local token ledger, and two read-only calls
// to AIFight. Nothing new is recorded to produce it.
//
// Two honest limits, both visible in the wording:
//   - Per-match rating change does not exist anywhere a client can see, so the
//     daily delta is computed against yesterday's own snapshot. It is a good
//     approximation, not the server's ledger.
//   - Cost only appears when the user has configured prices (`aifight prices`),
//     because an unpriced model would otherwise read as "free".

import fs from "node:fs";
import path from "node:path";

import { fetchNoFollow } from "../../net/guarded-fetch";
import { getRuntimeHome } from "../../store/paths";
import type { LocalMatchSessionListItem } from "../../session/local-match-session-store";
import { createLocalMatchSessionStore } from "../../session/local-match-session-store";
import { loadPriceTable, type PriceTable } from "../../usage/prices";
import { summarizeUsage } from "../../usage/stats";
import { readUsageRecordsSince, type UsageRecord } from "../../usage/usage-log";
import type { NotifyEvent } from "../events";
import { sameOriginUrl } from "../safe-url";

const PROFILE_TIMEOUT_MS = 5_000;

/** Where yesterday's ratings live, so today's digest can show a change. */
export function digestStatePath(): string {
  return path.join(getRuntimeHome(), "telegram-digest.json");
}

export interface DigestState {
  /** Local YYYY-MM-DD the snapshot was taken on. */
  readonly date: string;
  /** Exact instant of the snapshot. The report's window starts here, so the
   *  match tally and the rating change describe the SAME stretch of time —
   *  counting from local midnight instead left every match played between the
   *  digest hour and midnight out of both days' counts while its rating change
   *  still showed up. */
  readonly at?: number;
  readonly ratings: Readonly<Record<string, number>>;
}

/** Past this much, a report is no longer "today" and says what it covers. */
const DAY_WINDOW_MS = 26 * 60 * 60_000;

/** However long the bridge was off, never report on more than this. */
const MAX_WINDOW_MS = 7 * 24 * 60 * 60_000;

export interface DigestDeps {
  readonly agentId: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  // ── test seams: every one of these is real I/O by default ──
  readonly listSessions?: () => readonly LocalMatchSessionListItem[];
  readonly readUsage?: (since: Date, now: Date) => readonly UsageRecord[];
  readonly loadPrices?: () => PriceTable;
  readonly readState?: () => DigestState | null;
  readonly writeState?: (state: DigestState) => void;
}

/** Build today's digest event. Never throws: a digest that cannot be assembled
 *  in full is still worth sending in part. */
export async function buildDailyDigest(deps: DigestDeps): Promise<Extract<NotifyEvent, { kind: "digest.daily" }>> {
  const now = new Date(deps.now?.() ?? Date.now());
  const dayKey = localDayKey(now);
  const previous = safe(() => (deps.readState ?? readDigestState)(), null);
  const windowStart = new Date(resolveWindowStart(previous, now));

  const sessions = safe(() => (deps.listSessions ?? defaultListSessions)(), []);
  const todays = sessions.filter(
    (s) => s.status === "completed" && s.ended_at !== undefined && Date.parse(s.ended_at) >= windowStart.getTime(),
  );

  let wins = 0;
  let losses = 0;
  let draws = 0;
  const perGame = new Map<string, { played: number; wins: number }>();
  let bestReplayUrl: string | undefined;

  for (const session of todays) {
    const label = session.result_label ?? "";
    const won = label === "1st place";
    if (won) wins += 1;
    else if (label === "draw") draws += 1;
    else if (label === "forfeit" || /^\d+(st|nd|rd|th) place$/.test(label)) losses += 1;

    const game = session.game ?? "unknown";
    const row = perGame.get(game) ?? { played: 0, wins: 0 };
    perGame.set(game, { played: row.played + 1, wins: row.wins + (won ? 1 : 0) });

    // "Best" is deliberately simple: the first win with a replay to show.
    if (bestReplayUrl === undefined && won && session.replay_url !== undefined) {
      bestReplayUrl = absoluteUrl(deps.baseUrl, session.replay_url);
    }
  }

  const costText = safe(() => {
    const records = (deps.readUsage ?? readUsageRecordsSince)(windowStart, now);
    const summary = summarizeUsage([...records], (deps.loadPrices ?? loadPriceTable)());
    const cost = summary.total.estimatedCost;
    // A hand-edited prices.json with a missing field yields NaN; show nothing
    // rather than "$NaN".
    if (cost === undefined || !Number.isFinite(cost)) return undefined;
    return `${summary.currency}${cost.toFixed(2)}`;
  }, undefined);

  const gamesTodayServer = await fetchGamesToday(deps);
  const ratings = await fetchRatings(deps);
  const ratingDeltas = computeDeltas(deps, dayKey, now, previous, ratings);
  const longWindow = now.getTime() - windowStart.getTime() > DAY_WINDOW_MS;

  return {
    kind: "digest.daily",
    date: dayKey,
    ...(longWindow ? { since: localDayKey(windowStart) } : {}),
    played: todays.length,
    wins,
    losses,
    draws,
    byGame: [...perGame.entries()]
      .map(([game, row]) => ({ game, played: row.played, wins: row.wins }))
      .sort((a, b) => b.played - a.played),
    ...(bestReplayUrl !== undefined ? { bestReplayUrl } : {}),
    ...(costText !== undefined ? { costText } : {}),
    ...(gamesTodayServer !== undefined ? { gamesTodayServer } : {}),
    ...(ratingDeltas.length > 0 ? { ratingDeltas } : {}),
  };
}

/** Where this report starts: the last one's snapshot, so the tally and the
 *  rating change cover the same window. Falls back to local midnight the first
 *  time, and refuses to reach back further than MAX_WINDOW_MS. */
function resolveWindowStart(previous: DigestState | null, now: Date): number {
  const at = previous?.at;
  if (at === undefined || !Number.isFinite(at)) return startOfLocalDay(now).getTime();
  return Math.min(Math.max(at, now.getTime() - MAX_WINDOW_MS), now.getTime());
}

function computeDeltas(
  deps: DigestDeps,
  dayKey: string,
  now: Date,
  previous: DigestState | null,
  ratings: Readonly<Record<string, number>> | null,
): Array<{ game: string; delta: number }> {
  if (ratings === null) return [];
  // Always record today's numbers, even when there is nothing to compare to —
  // that is what makes tomorrow's digest able to show a change.
  safe(() => {
    (deps.writeState ?? writeDigestState)({ date: dayKey, at: now.getTime(), ratings });
    return undefined;
  }, undefined);

  if (previous === null || previous.date === dayKey) return [];
  const deltas: Array<{ game: string; delta: number }> = [];
  for (const [game, rating] of Object.entries(ratings)) {
    const before = previous.ratings[game];
    if (before === undefined) continue;
    const delta = rating - before;
    if (Math.abs(delta) >= 0.5) deltas.push({ game, delta });
  }
  return deltas;
}

async function fetchGamesToday(deps: DigestDeps): Promise<number | undefined> {
  try {
    const res = await fetchNoFollow(
      `${deps.baseUrl.replace(/\/+$/, "")}/api/agents/me/status`,
      { method: "GET", headers: { "X-API-Key": deps.apiKey }, signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS) },
      { fetchImpl: deps.fetchImpl },
    );
    if (!res.ok) return undefined;
    const body = (await res.json()) as Record<string, unknown>;
    return typeof body.games_today === "number" ? body.games_today : undefined;
  } catch {
    return undefined;
  }
}

async function fetchRatings(deps: DigestDeps): Promise<Record<string, number> | null> {
  try {
    const res = await fetchNoFollow(
      `${deps.baseUrl.replace(/\/+$/, "")}/api/agents/${encodeURIComponent(deps.agentId)}/profile`,
      { method: "GET", signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS) },
      { fetchImpl: deps.fetchImpl },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { ratings?: unknown };
    if (!Array.isArray(body.ratings)) return null;
    const out: Record<string, number> = {};
    for (const entry of body.ratings) {
      const r = entry as Record<string, unknown>;
      // display_rating (= rating − 2×RD) is the number the website, the desktop
      // app and `aifight record` all show. Reporting the raw Glicko rating here
      // would put the phone 120–400 points above every other surface.
      const shown = typeof r.display_rating === "number" ? r.display_rating : r.rating;
      if (typeof r.game === "string" && typeof shown === "number") out[r.game] = shown;
    }
    return out;
  } catch {
    return null;
  }
}

// ── scheduler ────────────────────────────────────────────────────────

/** How often the clock is checked. A tick, not a one-shot timer: a laptop that
 *  slept through 22:00 still gets its digest when it wakes, and a single long
 *  setTimeout would simply fire late (or, across a DST change, wrong). */
const TICK_MS = 60_000;

export interface DigestSchedulerOptions {
  /** Read fresh, so changing the time in the chat takes effect immediately. */
  readonly digestAt: () => string;
  readonly onDigest: () => void | Promise<void>;
  readonly now?: () => number;
  readonly tickMs?: number;
}

export interface DigestScheduler {
  stop(): void;
  /** Test seam: run one tick synchronously. */
  tick(): void;
}

export function startDigestScheduler(opts: DigestSchedulerOptions): DigestScheduler {
  const now = opts.now ?? Date.now;
  // A bridge that starts after today's slot does NOT fire immediately — that
  // would mean a digest on every evening restart. Today is treated as done.
  let lastFiredDay: string | null = targetPassed(new Date(now()), opts.digestAt())
    ? localDayKey(new Date(now()))
    : null;

  const tick = (): void => {
    const at = new Date(now());
    const dayKey = localDayKey(at);
    if (lastFiredDay === dayKey) return;
    if (!targetPassed(at, opts.digestAt())) return;
    lastFiredDay = dayKey;
    void Promise.resolve(opts.onDigest()).catch(() => undefined);
  };

  const timer = setInterval(tick, opts.tickMs ?? TICK_MS);
  // Never let the digest clock be the reason a process stays alive.
  (timer as { unref?: () => void }).unref?.();

  return {
    stop: () => clearInterval(timer),
    tick,
  };
}

/** Has today's HH:MM slot already come around? */
function targetPassed(at: Date, digestAt: string): boolean {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(digestAt.trim());
  if (match === null) return false; // an unparseable time never fires
  const hour = Number.parseInt(match[1]!, 10);
  const minute = Number.parseInt(match[2]!, 10);
  return at.getHours() > hour || (at.getHours() === hour && at.getMinutes() >= minute);
}

export function localDayKey(at: Date): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, "0");
  const d = String(at.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function startOfLocalDay(at: Date): Date {
  const start = new Date(at);
  start.setHours(0, 0, 0, 0);
  return start;
}

// ── default I/O ──────────────────────────────────────────────────────

function defaultListSessions(): readonly LocalMatchSessionListItem[] {
  return createLocalMatchSessionStore().listSessions();
}

export function readDigestState(): DigestState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(digestStatePath(), "utf8")) as Record<string, unknown>;
    if (typeof raw.date !== "string" || raw.ratings === null || typeof raw.ratings !== "object") return null;
    const ratings: Record<string, number> = {};
    for (const [game, value] of Object.entries(raw.ratings as Record<string, unknown>)) {
      if (typeof value === "number") ratings[game] = value;
    }
    // `at` is absent in files written before the window fix; the caller then
    // falls back to local midnight, exactly as it used to.
    return { date: raw.date, ...(typeof raw.at === "number" ? { at: raw.at } : {}), ratings };
  } catch {
    return null;
  }
}

export function writeDigestState(state: DigestState): void {
  try {
    fs.writeFileSync(digestStatePath(), JSON.stringify(state) + "\n", { mode: 0o600 });
  } catch {
    // The digest is worth more than its rating line — carry on without it.
  }
}

/** Same-origin only — see notify/safe-url.ts. */
function absoluteUrl(baseUrl: string, pathOrUrl: string): string | undefined {
  return sameOriginUrl(baseUrl, pathOrUrl);
}

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}
