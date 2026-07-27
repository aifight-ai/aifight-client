// The daily digest: what it counts, when it fires, and what it leaves out
// when the data is not there.

import { describe, expect, it } from "vitest";

import {
  buildDailyDigest,
  localDayKey,
  startDigestScheduler,
  type DigestState,
} from "../src/notify/telegram/digest";
import { createTelegramChannel } from "../src/notify/telegram/companion";
import { defaultTelegramConfig } from "../src/notify/telegram/settings";
import { renderNotifyEvent } from "../src/notify/telegram/render";
import type { LocalMatchSessionListItem } from "../src/session/local-match-session-store";
import type { PriceTable } from "../src/usage/prices";
import type { UsageRecord } from "../src/usage/usage-log";
import type { TelegramApi } from "../src/notify/telegram/api";

const NOW = new Date("2026-07-27T21:00:00").getTime(); // local time on purpose
const TODAY = localDayKey(new Date(NOW));

function session(overrides: Partial<LocalMatchSessionListItem> = {}): LocalMatchSessionListItem {
  return {
    version: 1,
    agent_id: "agent-1",
    agent_name: "PokerMind",
    session_id: `sess-${Math.random().toString(36).slice(2)}`,
    status: "completed",
    game: "coup",
    started_at: new Date(NOW - 60 * 60_000).toISOString(),
    updated_at: new Date(NOW - 30 * 60_000).toISOString(),
    ended_at: new Date(NOW - 30 * 60_000).toISOString(),
    result_label: "1st place",
    inbound_count: 1,
    outbound_count: 1,
    decision_count: 1,
    final_action_count: 1,
    strategy_hashes: [],
    path: "/tmp/sessions/x",
    ...overrides,
  };
}

function profileFetch(ratings: Array<{ game: string; rating: number }>, gamesToday = 3): typeof fetch {
  return (async (url: string | URL) => {
    const text = String(url);
    if (text.endsWith("/api/agents/me/status")) {
      return new Response(JSON.stringify({ games_today: gamesToday }), { status: 200 });
    }
    if (text.includes("/profile")) {
      return new Response(JSON.stringify({ ratings }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}

function deps(overrides: Parameters<typeof buildDailyDigest>[0] extends infer D ? Partial<D> : never = {}) {
  return {
    agentId: "agent-1",
    baseUrl: "https://aifight.ai",
    apiKey: "sk-secret",
    now: () => NOW,
    listSessions: () => [],
    readUsage: () => [],
    loadPrices: () => ({ version: 1, currency: "$", models: {} }) as PriceTable,
    readState: () => null,
    writeState: () => undefined,
    fetchImpl: profileFetch([]),
    ...overrides,
  };
}

describe("buildDailyDigest", () => {
  it("counts today's finished matches by outcome and by game", async () => {
    const event = await buildDailyDigest(deps({
      listSessions: () => [
        session({ result_label: "1st place", game: "coup" }),
        session({ result_label: "2nd place", game: "coup" }),
        session({ result_label: "draw", game: "liars_dice" }),
        session({ result_label: "forfeit", game: "liars_dice" }),
      ],
    }));

    expect(event).toMatchObject({ kind: "digest.daily", date: TODAY, played: 4, wins: 1, losses: 2, draws: 1 });
    expect(event.byGame).toEqual([
      { game: "coup", played: 2, wins: 1 },
      { game: "liars_dice", played: 2, wins: 0 },
    ]);
  });

  // An opponent quitting is neither a win, a loss nor a draw, so the three
  // numbers do not add up to the match count on their own. The line says so
  // instead of leaving the reader to notice a match went missing.
  it("accounts for outcomes that are not a win, a loss or a draw", async () => {
    const event = await buildDailyDigest(deps({
      listSessions: () => [
        session({ result_label: "1st place", game: "coup" }),
        session({ result_label: "opponent forfeit", game: "coup" }),
        session({ result_label: "completed", game: "coup" }),
      ],
    }));

    expect(event).toMatchObject({ played: 3, wins: 1, losses: 0, draws: 0 });
    const text = renderNotifyEvent("en", event, { agentName: "PokerMind" }).text;
    expect(text).toContain("2 other");
    expect(renderNotifyEvent("zh", event, { agentName: "PokerMind" }).text).toContain("其他 2 局");
  });

  // The remainder has to subtract draws too — with a draws=0 fixture, dropping
  // them from the arithmetic passes every test while inventing a ghost match.
  it("does not invent an extra match when the day had a draw", async () => {
    const event = await buildDailyDigest(deps({
      listSessions: () => [
        session({ result_label: "1st place" }),
        session({ result_label: "2nd place" }),
        session({ result_label: "draw" }),
      ],
    }));

    expect(event).toMatchObject({ played: 3, wins: 1, losses: 1, draws: 1 });
    const text = renderNotifyEvent("en", event, { agentName: "PokerMind" }).text;
    expect(text).not.toContain("other");
  });

  it("shows the rating everyone else shows, not the raw Glicko number", async () => {
    const event = await buildDailyDigest(deps({
      readState: () => ({ date: "2026-07-26", at: NOW - 24 * 60 * 60_000, ratings: { coup: 1400 } }),
      fetchImpl: (async (url: string | URL) => {
        const text = String(url);
        if (text.endsWith("/api/agents/me/status")) {
          return new Response(JSON.stringify({ games_today: 1 }), { status: 200 });
        }
        if (text.includes("/profile")) {
          // rating 1600, RD 100 → display_rating 1400: the website says 1400.
          return new Response(
            JSON.stringify({ ratings: [{ game: "coup", rating: 1600, display_rating: 1420, games_played: 9 }] }),
            { status: 200 },
          );
        }
        return new Response("{}", { status: 404 });
      }) as unknown as typeof fetch,
    }));

    expect(event.ratingDeltas).toEqual([{ game: "coup", delta: 20 }]);
  });

  // The window used to start at local midnight while the rating change was
  // measured from the previous digest, so a match played between the digest
  // hour and midnight fell out of BOTH days' counts — and the message could
  // then say "no matches today" directly above "rating change −38".
  it("counts a match played after yesterday's digest, in the window the rating change covers", async () => {
    const yesterdayDigest = new Date("2026-07-26T21:00:00").getTime();
    const event = await buildDailyDigest(deps({
      readState: () => ({ date: "2026-07-26", at: yesterdayDigest, ratings: { coup: 1500 } }),
      fetchImpl: profileFetch([{ game: "coup", rating: 1462 }]),
      listSessions: () => [
        // 22:35 last night: after the previous digest, before midnight.
        session({ ended_at: new Date("2026-07-26T22:35:00").toISOString(), result_label: "2nd place" }),
      ],
    }));

    expect(event.played).toBe(1);
    expect(event.losses).toBe(1);
    expect(event.ratingDeltas).toEqual([{ game: "coup", delta: -38 }]);
    expect(event.since).toBeUndefined(); // still an ordinary day
  });

  it("says what it covers when the bridge was off for days", async () => {
    const event = await buildDailyDigest(deps({
      readState: () => ({
        date: "2026-07-24",
        at: new Date("2026-07-24T21:00:00").getTime(),
        ratings: { coup: 1500 },
      }),
      fetchImpl: profileFetch([{ game: "coup", rating: 1520 }]),
      listSessions: () => [session({ ended_at: new Date("2026-07-26T10:00:00").toISOString() })],
    }));

    expect(event.since).toBe("2026-07-24");
    expect(event.played).toBe(1); // three days back, not just today
    const text = renderNotifyEvent("en", event, { agentName: "PokerMind" }).text;
    expect(text).toContain("since 2026-07-24");
    expect(text).not.toContain("Today");
  });

  it("asks the usage ledger for the same window it reports on", async () => {
    const seen: Array<{ since: number; until: number }> = [];
    const previousAt = new Date("2026-07-26T21:00:00").getTime();
    await buildDailyDigest(deps({
      readState: () => ({ date: "2026-07-26", at: previousAt, ratings: {} }),
      readUsage: (since, until) => {
        seen.push({ since: since.getTime(), until: until.getTime() });
        return [];
      },
    }));

    expect(seen).toEqual([{ since: previousAt, until: NOW }]);
  });

  it("counts only finished matches, even when an unfinished one has an end time", async () => {
    const event = await buildDailyDigest(deps({
      listSessions: () => [
        session({}),
        // A session that stopped mid-match still carries an ended_at, so it is
        // `status` that has to do the deciding here, not the timestamp.
        session({ status: "active", result_label: undefined }),
      ],
    }));

    expect(event.played).toBe(1);
  });

  it("ignores yesterday's matches and ones still running", async () => {
    const event = await buildDailyDigest(deps({
      listSessions: () => [
        session({ ended_at: new Date(NOW - 40 * 60 * 60_000).toISOString() }),
        session({ status: "active", ended_at: undefined }),
        session({}),
      ],
    }));

    expect(event.played).toBe(1);
  });

  it("reports an empty day rather than nothing", async () => {
    const event = await buildDailyDigest(deps());
    expect(event).toMatchObject({ played: 0, wins: 0, byGame: [] });
    expect(renderNotifyEvent("en", event, { agentName: "PokerMind" }).text).toContain("No matches today");
  });

  it("links the first win that has a replay", async () => {
    const event = await buildDailyDigest(deps({
      listSessions: () => [
        session({ result_label: "2nd place", replay_url: "/replay/loss" }),
        session({ result_label: "1st place", replay_url: "/replay/win1" }),
        session({ result_label: "1st place", replay_url: "/replay/win2" }),
      ],
    }));

    expect(event.bestReplayUrl).toBe("https://aifight.ai/replay/win1");
  });

  it("shows a cost only when the model is priced", async () => {
    const record: UsageRecord = {
      ts: new Date(NOW - 60_000).toISOString(),
      model: "claude-opus-5",
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    } as UsageRecord;

    const unpriced = await buildDailyDigest(deps({ readUsage: () => [record] }));
    expect(unpriced.costText).toBeUndefined();

    const priced = await buildDailyDigest(deps({
      readUsage: () => [record],
      loadPrices: () => ({
        version: 1,
        currency: "$",
        models: { "claude-opus-5": { input: 5, output: 25, cacheHit: 0.5 } },
      }) as PriceTable,
    }));
    expect(priced.costText).toBe("$30.00");

    // A price table missing a field would otherwise render "$NaN".
    const broken = await buildDailyDigest(deps({
      readUsage: () => [record],
      loadPrices: () => ({ version: 1, currency: "$", models: { "claude-opus-5": { input: 5 } } }) as unknown as PriceTable,
    }));
    expect(broken.costText).toBeUndefined();
  });

  it("carries the platform's own count of today's matches", async () => {
    const event = await buildDailyDigest(deps({ fetchImpl: profileFetch([], 7) }));
    expect(event.gamesTodayServer).toBe(7);
  });

  it("survives an unreachable platform", async () => {
    const failing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const event = await buildDailyDigest(deps({ fetchImpl: failing, listSessions: () => [session()] }));
    expect(event.played).toBe(1);
    expect(event.gamesTodayServer).toBeUndefined();
    expect(event.ratingDeltas).toBeUndefined();
  });

  it("computes rating change against yesterday's snapshot", async () => {
    const written: DigestState[] = [];
    const event = await buildDailyDigest(deps({
      fetchImpl: profileFetch([{ game: "coup", rating: 1525 }, { game: "coup_new", rating: 1500 }]),
      readState: () => ({ date: "2026-07-26", ratings: { coup: 1500 } }),
      writeState: (state) => written.push(state),
    }));

    // Only games present in both snapshots can have a delta.
    expect(event.ratingDeltas).toEqual([{ game: "coup", delta: 25 }]);
    // ...and today's numbers are stored for tomorrow.
    expect(written).toEqual([{ date: TODAY, at: NOW, ratings: { coup: 1525, coup_new: 1500 } }]);
  });

  it("has no delta on the first day, but still records the baseline", async () => {
    const written: DigestState[] = [];
    const event = await buildDailyDigest(deps({
      fetchImpl: profileFetch([{ game: "coup", rating: 1500 }]),
      readState: () => null,
      writeState: (state) => written.push(state),
    }));

    expect(event.ratingDeltas).toBeUndefined();
    expect(written).toHaveLength(1);
  });

  it("does not report a delta against a snapshot taken today", async () => {
    const event = await buildDailyDigest(deps({
      fetchImpl: profileFetch([{ game: "coup", rating: 1600 }]),
      readState: () => ({ date: TODAY, ratings: { coup: 1500 } }),
    }));
    expect(event.ratingDeltas).toBeUndefined();
  });
});

describe("digest scheduler", () => {
  function scheduler(startAt: string, digestAt = "22:00") {
    let clock = new Date(startAt).getTime();
    const fired: number[] = [];
    const sched = startDigestScheduler({
      digestAt: () => digestAt,
      onDigest: () => {
        fired.push(clock);
      },
      now: () => clock,
      tickMs: 1_000_000, // the interval never fires on its own; tests tick by hand
    });
    return {
      fired,
      advanceTo: (iso: string) => {
        clock = new Date(iso).getTime();
        sched.tick();
      },
      stop: () => sched.stop(),
    };
  }

  it("fires once, after the slot comes round", () => {
    const s = scheduler("2026-07-27T09:00:00");
    s.advanceTo("2026-07-27T21:59:00");
    expect(s.fired).toHaveLength(0);
    s.advanceTo("2026-07-27T22:00:00");
    expect(s.fired).toHaveLength(1);
    s.advanceTo("2026-07-27T22:01:00");
    expect(s.fired).toHaveLength(1); // not again the same day
    s.stop();
  });

  it("fires again the next day", () => {
    const s = scheduler("2026-07-27T09:00:00");
    s.advanceTo("2026-07-27T22:00:00");
    s.advanceTo("2026-07-28T22:00:00");
    expect(s.fired).toHaveLength(2);
    s.stop();
  });

  // Otherwise every evening restart would send another digest.
  it("does not fire for a slot that had already passed when it started", () => {
    const s = scheduler("2026-07-27T23:00:00");
    s.advanceTo("2026-07-27T23:30:00");
    expect(s.fired).toHaveLength(0);
    s.advanceTo("2026-07-28T22:00:00");
    expect(s.fired).toHaveLength(1);
    s.stop();
  });

  // A laptop shut at 22:00 and opened at 23:30 should still get its day's digest.
  it("catches up after the machine was asleep through the slot", () => {
    const s = scheduler("2026-07-27T09:00:00");
    s.advanceTo("2026-07-27T23:30:00");
    expect(s.fired).toHaveLength(1);
    s.stop();
  });

  it("never fires on an unparseable time", () => {
    const s = scheduler("2026-07-27T09:00:00", "later");
    s.advanceTo("2026-07-27T23:59:00");
    expect(s.fired).toHaveLength(0);
    s.stop();
  });
});

// ── The photo path ───────────────────────────────────────────────────

function apiStub(overrides: { failPhoto?: boolean } = {}): {
  api: TelegramApi;
  photos: Array<{ photoUrl: string; caption?: string }>;
  texts: string[];
} {
  const photos: Array<{ photoUrl: string; caption?: string }> = [];
  const texts: string[] = [];
  const api = {
    sendPhoto: async (p: { photoUrl: string; caption?: string }) => {
      if (overrides.failPhoto === true) throw new Error("Bad Request: wrong file identifier");
      photos.push(p);
      return { message_id: 1, chat: { id: 1 } };
    },
    sendMessage: async (p: { text: string }) => {
      texts.push(p.text);
      return { message_id: 2, chat: { id: 1 } };
    },
  } as unknown as TelegramApi;
  return { api, photos, texts };
}

const WIN_WITH_REPLAY = {
  kind: "match.result",
  game: "coup",
  selfLabel: "1st place",
  won: true,
  draw: false,
  forfeitedSelf: false,
  opponents: ["GPTShark"],
  replayUrl: "https://aifight.ai/replay/abc123",
  playerCount: 4,
  matchId: "m1",
} as const;

describe("match report cards", () => {
  it("sends the replay's share card as the picture", async () => {
    const stub = apiStub();
    const channel = createTelegramChannel({
      api: stub.api,
      settings: () => defaultTelegramConfig(4242),
      agentName: () => "PokerMind",
    });

    channel.deliver(WIN_WITH_REPLAY);
    await channel.stop();

    expect(stub.photos).toHaveLength(1);
    expect(stub.photos[0]!.photoUrl).toBe("https://aifight.ai/og/replay/abc123.png");
    expect(stub.photos[0]!.caption).toContain("Win");
    expect(stub.texts).toHaveLength(0);
  });

  it("falls back to text when Telegram cannot fetch the card", async () => {
    const stub = apiStub({ failPhoto: true });
    const logs: string[] = [];
    const channel = createTelegramChannel({
      api: stub.api,
      settings: () => defaultTelegramConfig(4242),
      agentName: () => "PokerMind",
      onLog: (e) => logs.push(e.code),
    });

    channel.deliver(WIN_WITH_REPLAY);
    await channel.stop();

    expect(stub.texts).toHaveLength(1);
    expect(stub.texts[0]).toContain("Win");
    expect(logs).toContain("telegram.photo_fallback");
  });

  it("stays text-only for a forfeit, which has no replay to show", async () => {
    const stub = apiStub();
    const channel = createTelegramChannel({
      api: stub.api,
      settings: () => defaultTelegramConfig(4242),
      agentName: () => "PokerMind",
    });

    channel.deliver({ ...WIN_WITH_REPLAY, won: false, forfeitedSelf: true, replayUrl: undefined, selfLabel: "forfeit" });
    await channel.stop();

    expect(stub.photos).toHaveLength(0);
    expect(stub.texts).toHaveLength(1);
  });

  it("stays text-only for a replay URL it cannot read an id out of", async () => {
    const stub = apiStub();
    const channel = createTelegramChannel({
      api: stub.api,
      settings: () => defaultTelegramConfig(4242),
      agentName: () => "PokerMind",
    });

    channel.deliver({ ...WIN_WITH_REPLAY, replayUrl: "https://aifight.ai/matches" });
    await channel.stop();

    expect(stub.photos).toHaveLength(0);
    expect(stub.texts).toHaveLength(1);
  });
});

describe("mute windows", () => {
  const digestEvent = {
    kind: "digest.daily",
    date: TODAY,
    played: 2,
    wins: 1,
    losses: 1,
    draws: 0,
    byGame: [],
  } as const;

  it("holds the digest back inside the window and lets it through after", async () => {
    const muted = apiStub();
    const mutedChannel = createTelegramChannel({
      api: muted.api,
      settings: () => ({ ...defaultTelegramConfig(1), results: "daily", mutedUntil: NOW + 60_000 }),
      agentName: () => "PokerMind",
      now: () => NOW,
    });
    mutedChannel.deliver(digestEvent);
    await mutedChannel.stop();
    expect(muted.texts).toHaveLength(0);

    const expired = apiStub();
    const expiredChannel = createTelegramChannel({
      api: expired.api,
      settings: () => ({ ...defaultTelegramConfig(1), results: "daily", mutedUntil: NOW - 60_000 }),
      agentName: () => "PokerMind",
      now: () => NOW,
    });
    expiredChannel.deliver(digestEvent);
    await expiredChannel.stop();
    expect(expired.texts).toHaveLength(1);
  });
});
