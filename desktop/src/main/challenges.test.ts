import { describe, expect, it } from "vitest";

import { normalizeChallenges } from "./challenges";

const ME = "agent-1";

describe("normalizeChallenges", () => {
  it("maps hosted + guest rows with role and opponent name", () => {
    const out = normalizeChallenges(
      {
        duels: [
          {
            id: "d1",
            host_agent_id: ME,
            host_agent_name: "alpha",
            game: "texas_holdem",
            status: "pending",
            guest_agent_name: "",
            created_at: "2026-07-29T20:00:00Z",
            expires_at: "2026-07-30T20:00:00Z",
          },
          {
            id: "d2",
            host_agent_id: "agent-9",
            host_agent_name: "omega",
            game: "coup",
            status: "accepted",
            guest_agent_id: ME,
            guest_agent_name: "alpha",
            created_at: "2026-07-29T21:00:00Z",
            expires_at: "2026-07-30T21:00:00Z",
          },
        ],
        count: 2,
      },
      ME,
    );
    expect(out).toEqual([
      {
        id: "d1",
        game: "texas_holdem",
        status: "pending",
        isHost: true,
        opponentName: "",
        createdAt: "2026-07-29T20:00:00Z",
        expiresAt: "2026-07-30T20:00:00Z",
      },
      {
        id: "d2",
        game: "coup",
        status: "accepted",
        isHost: false,
        opponentName: "omega",
        createdAt: "2026-07-29T21:00:00Z",
        expiresAt: "2026-07-30T21:00:00Z",
      },
    ]);
  });

  it("returns [] for missing/malformed payloads and drops id-less rows", () => {
    expect(normalizeChallenges(null, ME)).toEqual([]);
    expect(normalizeChallenges({}, ME)).toEqual([]);
    expect(normalizeChallenges({ duels: "nope" }, ME)).toEqual([]);
    expect(normalizeChallenges({ duels: [{ status: "pending" }, null, { id: "d3", status: "pending" }] }, ME)).toEqual([
      { id: "d3", game: "", status: "pending", isHost: false, opponentName: "", createdAt: "", expiresAt: "" },
    ]);
  });
});
