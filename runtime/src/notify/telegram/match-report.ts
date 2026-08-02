// The rating line under a match report.
//
// The protocol does not carry per-match rating changes (game_over has none),
// so this is the same honest approximation the daily digest already makes:
// read the public profile, diff it against a local snapshot — here "after the
// previous match" rather than "since yesterday" — and say what moved. The two
// snapshots are separate files on purpose: they answer different questions,
// and sharing one would quietly break the digest's window arithmetic.
//
// Hard rule, inherited from the whole notify layer: enrichment may fail, the
// report may not. Any error here returns the event unchanged.

import fs from "node:fs";
import path from "node:path";

import { fetchNoFollow } from "../../net/guarded-fetch";
import { getRuntimeHome } from "../../store/paths";
import type { NotifyEvent } from "../events";

type MatchResultEvent = Extract<NotifyEvent, { kind: "match.result" }>;

const FETCH_TIMEOUT_MS = 5_000;

/** Ratings settle in the server's game_over callback chain; give them a
 *  moment before reading, or the "after" read races the settlement. */
const SETTLE_DELAY_MS = 1_500;

/** How deep into the board to look for this agent's rank. The server clamps
 *  its own way; an agent below the returned page simply shows no rank. */
const LEADERBOARD_LOOKUP_LIMIT = 200;

/** Ignore float noise; a real match moves the display rating by whole points. */
const DELTA_NOISE = 0.5;

export interface MatchSnapshotEntry {
  readonly rating: number;
  readonly rank?: number;
}

export interface MatchSnapshot {
  readonly ratings: Readonly<Record<string, MatchSnapshotEntry>>;
}

/** Where "the ratings as of the previous match" live. */
export function matchSnapshotPath(): string {
  return path.join(getRuntimeHome(), "telegram-match-snapshot.json");
}

export function readMatchSnapshot(): MatchSnapshot | null {
  try {
    const raw = JSON.parse(fs.readFileSync(matchSnapshotPath(), "utf8")) as Record<string, unknown>;
    if (raw.ratings === null || typeof raw.ratings !== "object") return null;
    const ratings: Record<string, MatchSnapshotEntry> = {};
    for (const [game, value] of Object.entries(raw.ratings as Record<string, unknown>)) {
      const entry = value as Record<string, unknown>;
      if (entry === null || typeof entry !== "object" || typeof entry.rating !== "number") continue;
      ratings[game] = {
        rating: entry.rating,
        ...(typeof entry.rank === "number" ? { rank: entry.rank } : {}),
      };
    }
    return { ratings };
  } catch {
    return null;
  }
}

export function writeMatchSnapshot(state: MatchSnapshot): void {
  try {
    fs.writeFileSync(matchSnapshotPath(), JSON.stringify(state) + "\n", { mode: 0o600 });
  } catch {
    // The next report just has no delta to show.
  }
}

export interface MatchReportEnrichmentDeps {
  readonly baseUrl: string;
  readonly agentId: string;
  readonly fetchImpl?: typeof fetch;
  /** Test seams. */
  readonly delayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly readState?: () => MatchSnapshot | null;
  readonly writeState?: (state: MatchSnapshot) => void;
}

/**
 * Fill in the report's rating line. Runs inside the channel's send chain, so
 * the chat keeps reading in event order — the report is simply a couple of
 * seconds later, which the settlement delay wants anyway.
 */
export async function enrichMatchResult(
  event: MatchResultEvent,
  deps: MatchReportEnrichmentDeps,
): Promise<MatchResultEvent> {
  const game = event.game;
  if (game === undefined) return event;

  try {
    await (deps.sleep ?? defaultSleep)(deps.delayMs ?? SETTLE_DELAY_MS);

    const ratings = await fetchProfileRatings(deps);
    if (ratings === null) return event; // nothing read → nothing written either
    const current = ratings[game];
    if (current === undefined) return event;

    const rank = await fetchLeaderboardRank(deps, game);
    const previous = safe(() => (deps.readState ?? readMatchSnapshot)(), null);
    const before = previous?.ratings[game];

    // Merge: every game's fresh rating, this game's fresh rank, other games'
    // remembered ranks — so a later Coup report still has its rank baseline.
    const merged: Record<string, MatchSnapshotEntry> = {};
    for (const [g, rating] of Object.entries(ratings)) {
      const keptRank = g === game ? rank.rank : previous?.ratings[g]?.rank;
      merged[g] = { rating, ...(keptRank !== undefined ? { rank: keptRank } : {}) };
    }
    safe(() => {
      (deps.writeState ?? writeMatchSnapshot)({ ratings: merged });
      return undefined;
    }, undefined);

    const delta = before !== undefined && Math.abs(current - before.rating) >= DELTA_NOISE
      ? current - before.rating
      : undefined;
    const rankDelta = rank.rank !== undefined && before?.rank !== undefined && before.rank !== rank.rank
      ? before.rank - rank.rank // positive = climbed
      : undefined;

    return {
      ...event,
      rating: {
        game,
        rating: current,
        ...(delta !== undefined ? { delta } : {}),
        ...(rank.rank !== undefined ? { rank: rank.rank } : {}),
        ...(rankDelta !== undefined ? { rankDelta } : {}),
      },
    };
  } catch {
    return event;
  }
}

async function fetchProfileRatings(deps: MatchReportEnrichmentDeps): Promise<Record<string, number> | null> {
  try {
    const res = await fetchNoFollow(
      `${deps.baseUrl.replace(/\/+$/, "")}/api/agents/${encodeURIComponent(deps.agentId)}/profile`,
      { method: "GET", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
      { fetchImpl: deps.fetchImpl },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { ratings?: unknown };
    if (!Array.isArray(body.ratings)) return null;
    const out: Record<string, number> = {};
    for (const entry of body.ratings) {
      const r = entry as Record<string, unknown>;
      // display_rating is the number every other surface shows (site, app,
      // `aifight record`, the digest); the raw Glicko rating sits 2×RD above.
      const shown = typeof r.display_rating === "number" ? r.display_rating : r.rating;
      if (typeof r.game === "string" && typeof shown === "number") out[r.game] = shown;
    }
    return out;
  } catch {
    return null;
  }
}

/** rank: undefined = not on the returned board OR the lookup failed — either
 *  way the report shows no rank and the snapshot drops this game's rank. */
async function fetchLeaderboardRank(
  deps: MatchReportEnrichmentDeps,
  game: string,
): Promise<{ rank?: number }> {
  try {
    const res = await fetchNoFollow(
      `${deps.baseUrl.replace(/\/+$/, "")}/api/leaderboard/${encodeURIComponent(game)}?limit=${LEADERBOARD_LOOKUP_LIMIT}`,
      { method: "GET", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
      { fetchImpl: deps.fetchImpl },
    );
    if (!res.ok) return {};
    const body = (await res.json()) as { leaderboard?: unknown };
    if (!Array.isArray(body.leaderboard)) return {};
    for (const entry of body.leaderboard) {
      const row = entry as Record<string, unknown>;
      if (row.agent_id === deps.agentId && typeof row.rank === "number") {
        return { rank: row.rank };
      }
    }
    return {};
  } catch {
    return {};
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}
