// Normalize the platform's public /api/events payload into renderer-ready cards.
// Pure (no Electron / no network) so it is unit-tested.
//
//   /api/events → { events: [{ slug, title, subtitle, status, games, prize_summary,
//                              participant_count, registration_ends_at, play_starts_at,
//                              play_ends_at, … }], count }

import type { EventCard } from "../shared/ipc";

interface RawEvent {
  readonly slug?: unknown;
  readonly title?: unknown;
  readonly subtitle?: unknown;
  readonly event_type?: unknown;
  readonly status?: unknown;
  readonly games?: unknown;
  readonly prize_summary?: unknown;
  readonly participant_count?: unknown;
  readonly registration_ends_at?: unknown;
  readonly play_starts_at?: unknown;
  readonly play_ends_at?: unknown;
}

const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const optStr = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Map a raw /api/events response to normalized cards. Never throws; bad input → []. */
export function normalizeEvents(json: unknown): EventCard[] {
  const arr = (json as { events?: unknown } | null)?.events;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((raw: RawEvent): EventCard => {
      const games = Array.isArray(raw.games) ? raw.games.filter((g): g is string => typeof g === "string") : [];
      return {
        slug: str(raw.slug),
        title: str(raw.title, "—"),
        subtitle: str(raw.subtitle),
        eventType: str(raw.event_type),
        status: str(raw.status),
        games,
        prizeSummary: str(raw.prize_summary),
        participantCount: num(raw.participant_count),
        registrationEndsAt: optStr(raw.registration_ends_at),
        playStartsAt: optStr(raw.play_starts_at),
        playEndsAt: optStr(raw.play_ends_at),
      };
    })
    .filter((e) => e.slug !== "");
}
