import { describe, expect, it } from "vitest";

import { normalizeEvents } from "./events";

describe("normalizeEvents", () => {
  it("normalizes an events payload", () => {
    const json = {
      count: 1,
      events: [
        {
          slug: "showdown-001",
          title: "Showdown #001",
          subtitle: "The opening clash",
          description: "long text",
          event_type: "grand_prix",
          status: "published",
          games: ["texas_holdem", "coup"],
          prize_summary: "$500 pool",
          participant_count: 12,
          registration_ends_at: "2026-06-10T00:00:00Z",
          play_starts_at: "2026-06-12T00:00:00Z",
          play_ends_at: "2026-06-15T00:00:00Z",
        },
      ],
    };
    const cards = normalizeEvents(json);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toEqual({
      slug: "showdown-001",
      title: "Showdown #001",
      subtitle: "The opening clash",
      eventType: "grand_prix",
      status: "published",
      games: ["texas_holdem", "coup"],
      prizeSummary: "$500 pool",
      participantCount: 12,
      registrationEndsAt: "2026-06-10T00:00:00Z",
      playStartsAt: "2026-06-12T00:00:00Z",
      playEndsAt: "2026-06-15T00:00:00Z",
    });
  });

  it("drops entries without a slug and tolerates missing fields", () => {
    const cards = normalizeEvents({
      events: [
        { title: "no slug" },
        { slug: "ok", title: "OK" },
      ],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].slug).toBe("ok");
    expect(cards[0].games).toEqual([]);
    expect(cards[0].participantCount).toBe(0);
    expect(cards[0].registrationEndsAt).toBeNull();
  });

  it("returns [] for malformed payloads", () => {
    expect(normalizeEvents(null)).toEqual([]);
    expect(normalizeEvents({})).toEqual([]);
    expect(normalizeEvents({ events: "nope" })).toEqual([]);
  });
});
