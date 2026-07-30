// fetchParticipantEvents (LIVE_MATCH_FEED F1) fetches one full-history page of
// the participant event feed. The contract mirrors the server: agent-key auth
// header, { events: [...] } body, and ANY failure (network / non-OK / malformed)
// collapses to null so the poller backs off silently instead of feeding the
// renderer a partial page.

import { describe, expect, it } from "vitest";

import { fetchParticipantEvents } from "./match-events";

type Page = { status?: number; body?: unknown; fail?: boolean };

function fakeFetch(page: Page, log: { url: string; headers?: Record<string, string> }[] = []) {
  return (url: string, init?: { headers?: Record<string, string> }) => {
    log.push({ url, headers: init?.headers });
    if (page.fail === true) return Promise.reject(new Error("network down"));
    return Promise.resolve({
      ok: (page.status ?? 200) >= 200 && (page.status ?? 200) < 300,
      status: page.status ?? 200,
      json: () => Promise.resolve(page.body),
    });
  };
}

const SID = "11111111-1111-1111-1111-111111111111";

describe("fetchParticipantEvents", () => {
  it("GETs the participant endpoint with the agent key and returns the events", async () => {
    const log: { url: string; headers?: Record<string, string> }[] = [];
    const out = await fetchParticipantEvents(
      "https://x.test/",
      SID,
      "key-123",
      fakeFetch({ body: { match_id: SID, count: 2, is_full_history: true, events: [
        { type: "new_hand", seq: 0, ts: "t0" },
        { type: "player_action", player: "p1", data: { action: "call", amount: 50 }, seq: 1, ts: "t1" },
      ] } }, log),
    );
    expect(log).toHaveLength(1);
    expect(log[0]!.url).toBe(`https://x.test/api/agents/me/matches/${SID}/events`);
    expect(log[0]!.headers?.["X-API-Key"]).toBe("key-123");
    expect(out).toHaveLength(2);
    expect(out![1]!.player).toBe("p1");
  });

  it("returns null on non-OK (session gone / not a participant)", async () => {
    expect(await fetchParticipantEvents("https://x.test", SID, "k", fakeFetch({ status: 404, body: { error: "session not found" } }))).toBeNull();
    expect(await fetchParticipantEvents("https://x.test", SID, "k", fakeFetch({ status: 403, body: { error: "not a participant" } }))).toBeNull();
  });

  it("returns null on a network failure — never throws", async () => {
    expect(await fetchParticipantEvents("https://x.test", SID, "k", fakeFetch({ fail: true }))).toBeNull();
  });

  it("returns null on a malformed body (no events array / bad entry)", async () => {
    expect(await fetchParticipantEvents("https://x.test", SID, "k", fakeFetch({ body: {} }))).toBeNull();
    expect(await fetchParticipantEvents("https://x.test", SID, "k", fakeFetch({ body: { events: [{ seq: 1 }] } }))).toBeNull();
    expect(await fetchParticipantEvents("https://x.test", SID, "k", fakeFetch({ body: { events: ["nope"] } }))).toBeNull();
  });

  it("returns null on empty inputs without hitting the network", async () => {
    const log: { url: string }[] = [];
    expect(await fetchParticipantEvents("", SID, "k", fakeFetch({ body: { events: [] } }, log))).toBeNull();
    expect(await fetchParticipantEvents("https://x.test", "", "k", fakeFetch({ body: { events: [] } }, log))).toBeNull();
    expect(await fetchParticipantEvents("https://x.test", SID, "", fakeFetch({ body: { events: [] } }, log))).toBeNull();
    expect(log).toHaveLength(0);
  });
});
