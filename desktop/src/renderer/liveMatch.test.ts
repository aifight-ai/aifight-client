// D10 — tests for the protocol→renderer reducer. These lock down the two binding
// rules in executable form: (1) only the OWNER's own private info is ever
// surfaced, and (2) a new match resets state (session isolation).

import { describe, it, expect } from "vitest";

import { emptyLiveMatch, mergePolledEvents, injectFinalAction, reduceServerMessage, type LiveMatchState } from "./liveMatch";
import type { ServerMessage } from "../shared/ipc";

const OWNER = "p0";
const OPP = "p1";
const SESSION = "11111111-1111-1111-1111-111111111111";

function gameStart(game: string, sessionId = SESSION): ServerMessage {
  return {
    type: "game_start",
    data: {
      match_id: sessionId,
      game,
      your_position: 0,
      your_player_id: OWNER,
      players: [
        { position: 0, name: "Player 1", player_id: OWNER },
        { position: 1, name: "Player 2", player_id: OPP },
      ],
    },
  } as unknown as ServerMessage;
}

function actionRequest(
  state: Record<string, unknown>,
  newEvents: Array<Record<string, unknown>> | null,
  sessionId = SESSION,
  extra: Record<string, unknown> = {},
): ServerMessage {
  return {
    type: "action_request",
    data: { match_id: sessionId, state, legal_actions: [], players: [], timeout_ms: 300000, new_events: newEvents, ...extra },
  } as unknown as ServerMessage;
}

function feed(msgs: ServerMessage[], from: LiveMatchState = emptyLiveMatch()): LiveMatchState {
  return msgs.reduce(reduceServerMessage, from);
}

describe("emptyLiveMatch", () => {
  it("starts blank", () => {
    const s = emptyLiveMatch();
    expect(s.sessionId).toBeNull();
    expect(s.match).toBeNull();
    expect(s.events).toEqual([]);
    expect(s.finished).toBe(false);
    expect(s.outcome).toBe("unknown");
  });
});

describe("game_start", () => {
  it("builds a match, labels owner 'You', anonymizes opponents", () => {
    const s = feed([gameStart("texas_holdem")]);
    expect(s.sessionId).toBe(SESSION);
    expect(s.game).toBe("texas_holdem");
    expect(s.ownerPlayerId).toBe(OWNER);
    expect(s.match?.status).toBe("live");
    const owner = s.match?.players.find((p) => p.player_id === OWNER);
    const opp = s.match?.players.find((p) => p.player_id === OPP);
    expect(owner?.agent_name).toBe("You");
    expect(opp?.agent_name).toBe("Player 2"); // anonymized during play
  });

  it("accepts a server-started game this build can't render (backend is the authority)", () => {
    // The live-game list follows the backend; a newly launched game must still
    // fold into the match model (banner/events/outcome work; the board degrades).
    const s = feed([gameStart("chess")]);
    expect(s.sessionId).toBe(SESSION);
    expect(s.game).toBe("chess");
    expect(s.match?.status).toBe("live");
  });

  it("rejects a malformed game name (shape gate, not an allow-list)", () => {
    for (const bad of ["../etc", "Chess", "", "a b"]) {
      const s = feed([gameStart(bad)]);
      expect(s.sessionId).toBeNull();
    }
  });
});

describe("action_request — event mapping", () => {
  it("maps protocol events (player→player_id, ts→created_at) and dedupes by seq", () => {
    const s = feed([
      gameStart("texas_holdem"),
      actionRequest({ hand_num: 1 }, [
        { type: "new_hand", data: { hand_num: 1, chips: { p0: 10000, p1: 10000 } }, seq: 0, ts: "2026-06-02T00:00:00Z" },
        { type: "player_action", player: OPP, data: { action: "call", amount: 50 }, seq: 1, ts: "2026-06-02T00:00:01Z" },
      ]),
      // overlapping resend: seq 1 must NOT duplicate; seq 2 is new
      actionRequest({ hand_num: 1 }, [
        { type: "player_action", player: OPP, data: { action: "call" }, seq: 1, ts: "x" },
        { type: "community_cards", data: { cards: ["Ah", "7d", "2c"] }, seq: 2, ts: "y" },
      ]),
    ]);
    const engine = s.events.filter((e) => e.type !== "cards_dealt");
    expect(engine.map((e) => e.type)).toEqual(["new_hand", "player_action", "community_cards"]);
    const pa = engine.find((e) => e.type === "player_action");
    expect(pa?.player_id).toBe(OPP); // mapped from `player`
    expect(pa?.created_at).toBe("2026-06-02T00:00:01Z"); // mapped from `ts`
  });

  it("treats null new_events as empty", () => {
    const s = feed([gameStart("liars_dice"), actionRequest({ phase: "bidding", round: 1 }, null)]);
    expect(s.events).toEqual([]);
  });
});

describe("🔒 information hiding", () => {
  it("injects ONLY the owner's hole cards (poker), once per hand, attributed to the owner", () => {
    const s = feed([
      gameStart("texas_holdem"),
      actionRequest({ hand_num: 1, your_hand: ["As", "Ks"], your_chips: 9950 }, [
        { type: "new_hand", data: { hand_num: 1 }, seq: 0, ts: "t0" },
      ]),
      // same hand, another turn — must NOT re-inject (state is a full snapshot each time)
      actionRequest({ hand_num: 1, your_hand: ["As", "Ks"], your_chips: 9950 }, [
        { type: "player_action", player: OWNER, data: { action: "check" }, seq: 1, ts: "t1" },
      ]),
    ]);
    const dealt = s.events.filter((e) => e.type === "cards_dealt");
    expect(dealt).toHaveLength(1);
    expect(dealt[0].player_id).toBe(OWNER);
    expect(dealt[0].data.cards).toEqual(["As", "Ks"]);
    // owner private snapshot surfaced
    expect(s.ownerPrivate.holeCards).toEqual(["As", "Ks"]);
    expect(s.ownerPrivate.chips).toBe(9950);
  });

  it("re-injects when a new hand deals new cards", () => {
    const s = feed([
      gameStart("texas_holdem"),
      actionRequest({ hand_num: 1, your_hand: ["As", "Ks"] }, [{ type: "new_hand", data: { hand_num: 1 }, seq: 0, ts: "t" }]),
      actionRequest({ hand_num: 2, your_hand: ["Qd", "Qc"] }, [{ type: "new_hand", data: { hand_num: 2 }, seq: 5, ts: "t" }]),
    ]);
    const dealt = s.events.filter((e) => e.type === "cards_dealt");
    expect(dealt).toHaveLength(2);
    expect(dealt[1].data.cards).toEqual(["Qd", "Qc"]);
  });

  it("NEVER injects a private event for a non-owner — no cards_dealt belongs to an opponent", () => {
    const s = feed([
      gameStart("texas_holdem"),
      // even if a (malformed) state carried opponent-ish fields, we only read your_hand
      actionRequest({ hand_num: 1, your_hand: ["As", "Ks"], p1_hand: ["2c", "3d"] }, [
        { type: "player_action", player: OPP, data: { action: "raise", amount: 200 }, seq: 0, ts: "t" },
      ]),
    ]);
    const injected = s.events.filter((e) => e.type === "cards_dealt");
    expect(injected.every((e) => e.player_id === OWNER)).toBe(true);
    // no event reveals opponent hole cards
    expect(s.events.some((e) => e.player_id === OPP && e.type === "cards_dealt")).toBe(false);
  });

  it("surfaces dice/coup own info WITHOUT injecting board events", () => {
    const dice = feed([gameStart("liars_dice"), actionRequest({ phase: "bidding", round: 1, your_dice: [2, 5, 5, 3, 6] }, [
      { type: "bid", player: OPP, data: { quantity: 2, face: 5 }, seq: 0, ts: "t" },
    ])]);
    expect(dice.ownerPrivate.dice).toEqual([2, 5, 5, 3, 6]);
    expect(dice.events.some((e) => e.type === "cards_dealt")).toBe(false);

    const coup = feed([gameStart("coup"), actionRequest({ phase: "action", current_turn: OWNER, your_cards: ["Duke", "Captain"], coins: 2 }, null)]);
    expect(coup.ownerPrivate.influence).toEqual(["Duke", "Captain"]);
    expect(coup.ownerPrivate.coins).toBe(2);
    expect(coup.events).toEqual([]);
  });
});

describe("🔒 session isolation", () => {
  it("a new game_start resets the prior match entirely", () => {
    const after = feed([
      gameStart("texas_holdem", SESSION),
      actionRequest({ hand_num: 1, your_hand: ["As", "Ks"] }, [{ type: "new_hand", data: { hand_num: 1 }, seq: 0, ts: "t" }], SESSION),
      gameStart("coup", "22222222-2222-2222-2222-222222222222"),
    ]);
    expect(after.sessionId).toBe("22222222-2222-2222-2222-222222222222");
    expect(after.game).toBe("coup");
    expect(after.events).toEqual([]); // no carry-over from the poker match
    expect(after.ownerPrivate.holeCards).toBeUndefined();
  });

  it("ignores an action_request for a different session", () => {
    const s = feed([
      gameStart("texas_holdem", SESSION),
      actionRequest({ hand_num: 1 }, [{ type: "new_hand", data: {}, seq: 0, ts: "t" }], "99999999-9999-9999-9999-999999999999"),
    ]);
    expect(s.events).toEqual([]);
  });

  it("ignores action_request before any game_start", () => {
    const s = feed([actionRequest({ hand_num: 1 }, [{ type: "new_hand", data: {}, seq: 0, ts: "t" }])]);
    expect(s.match).toBeNull();
  });
});

describe("reconnect", () => {
  it("event_history replaces the event log", () => {
    const s = feed([
      gameStart("texas_holdem"),
      actionRequest({ hand_num: 1 }, [{ type: "player_action", player: OPP, data: { action: "call" }, seq: 7, ts: "a" }]),
      actionRequest({ hand_num: 1 }, null, SESSION, {
        is_reconnect: true,
        event_history: [
          { type: "new_hand", data: { hand_num: 1 }, seq: 0, ts: "h0" },
          { type: "player_action", player: OPP, data: { action: "raise" }, seq: 1, ts: "h1" },
        ],
      }),
    ]);
    const engine = s.events.filter((e) => e.type !== "cards_dealt");
    expect(engine.map((e) => e.type)).toEqual(["new_hand", "player_action"]);
    expect(engine[1].data.action).toBe("raise"); // from history, not the earlier "call"
  });
});

describe("game_over", () => {
  function gameOver(result: Record<string, unknown>, players?: Array<Record<string, unknown>>): ServerMessage {
    return {
      type: "game_over",
      data: {
        match_id: "real-id",
        session_id: SESSION,
        result,
        players: players ?? [
          { player_id: OWNER, position: 0, agent_id: "uuid-0", agent_name: "My Agent" },
          { player_id: OPP, position: 1, agent_id: "uuid-1", agent_name: "Rival GPT" },
        ],
        replay_url: "/replay/real-id",
      },
    } as unknown as ServerMessage;
  }

  it("marks finished, reveals real opponent names, keeps owner 'You', sets replay path", () => {
    const s = feed([gameStart("texas_holdem"), gameOver({ winner: OWNER, payoffs: { p0: 100, p1: -100 }, is_draw: false })]);
    expect(s.finished).toBe(true);
    expect(s.outcome).toBe("win");
    expect(s.replayPath).toBe("/replay/real-id");
    expect(s.match?.status).toBe("completed");
    expect(s.match?.players.find((p) => p.player_id === OPP)?.agent_name).toBe("Rival GPT");
    expect(s.match?.players.find((p) => p.player_id === OWNER)?.agent_name).toBe("You");
  });

  it("computes loss / draw / payoff-fallback", () => {
    expect(feed([gameStart("coup"), gameOver({ winner: OPP, is_draw: false })]).outcome).toBe("loss");
    expect(feed([gameStart("coup"), gameOver({ winner: "", is_draw: true })]).outcome).toBe("draw");
    expect(feed([gameStart("texas_holdem"), gameOver({ winner: "", is_draw: false, payoffs: { p0: 250, p1: -250 } })]).outcome).toBe("win");
    expect(feed([gameStart("texas_holdem"), gameOver({ winner: "", is_draw: false, payoffs: { p0: -250, p1: 250 } })]).outcome).toBe("loss");
  });
});

describe("unrelated frames", () => {
  it("ignores welcome / queue messages", () => {
    const start = feed([gameStart("texas_holdem")]);
    const after = reduceServerMessage(start, { type: "welcome", data: {} } as ServerMessage);
    expect(after).toBe(start); // unchanged reference
  });
});

// ── F1: participant event-feed merge ─────────────────────────────────────────

describe("mergePolledEvents (F1)", () => {
  const pollPage = [
    { type: "new_hand", data: { hand_num: 1 }, seq: 0, ts: "t0" },
    { type: "player_action", player: OPP, data: { action: "raise", amount: 200 }, seq: 1, ts: "t1" },
    { type: "player_action", player: OPP, data: { action: "call", amount: 200 }, seq: 2, ts: "t2" },
  ];

  it("appends only events past maxSeq from the full-history feed (dedupe vs new_events)", () => {
    const s0 = feed([
      gameStart("texas_holdem"),
      actionRequest({ hand_num: 1 }, [pollPage[0], pollPage[1]]), // seq 0,1 already here
    ]);
    const s1 = mergePolledEvents(s0, SESSION, pollPage); // full history: 0,1,2
    expect(s1.events.map((e) => [e.seq, e.type])).toEqual([
      [0, "new_hand"],
      [1, "player_action"],
      [2, "player_action"],
    ]);
    expect(s1.maxSeq).toBe(2);
    expect(s1.events[2].player_id).toBe(OPP); // player→player_id mapped
    expect(s1.events[2].created_at).toBe("t2"); // ts→created_at mapped
  });

  it("is a no-op (same reference) when the page brings nothing new", () => {
    const s0 = feed([gameStart("texas_holdem"), actionRequest({ hand_num: 1 }, pollPage)]);
    expect(mergePolledEvents(s0, SESSION, pollPage)).toBe(s0);
    expect(mergePolledEvents(s0, SESSION, [])).toBe(s0);
  });

  it("ignores a page for another session or before any game_start", () => {
    const s0 = feed([gameStart("texas_holdem")]);
    expect(mergePolledEvents(s0, "99999999-9999-9999-9999-999999999999", pollPage)).toBe(s0);
    const blank = emptyLiveMatch();
    expect(mergePolledEvents(blank, SESSION, pollPage)).toBe(blank);
  });

  it("skips seqless entries instead of duplicating them on every poll", () => {
    const s0 = feed([gameStart("texas_holdem"), actionRequest({ hand_num: 1 }, [pollPage[0]])]);
    const s1 = mergePolledEvents(s0, SESSION, [
      pollPage[0],
      { type: "weird_no_seq", data: {} },
      pollPage[1],
    ]);
    expect(s1.events.some((e) => e.type === "weird_no_seq")).toBe(false);
    expect(s1.events.map((e) => e.seq)).toEqual([0, 1]);
  });
});

// ── Phase 2: server-pushed match_feed (same merge path as the polled feed) ───

describe("match_feed (Phase 2 server push)", () => {
  const pushEvents = [
    { type: "new_hand", data: { hand_num: 1 }, seq: 0, ts: "t0" },
    { type: "player_action", player: OPP, data: { action: "raise", amount: 200 }, seq: 1, ts: "t1" },
    { type: "player_action", player: OPP, data: { action: "call", amount: 200 }, seq: 2, ts: "t2" },
  ];
  const matchFeed = (events: Array<Record<string, unknown>> | null, sessionId = SESSION): ServerMessage =>
    ({ type: "match_feed", data: { match_id: sessionId, events } }) as unknown as ServerMessage;

  it("appends pushed events past maxSeq, mapping player/ts exactly like new_events", () => {
    const s = feed([
      gameStart("texas_holdem"),
      matchFeed([pushEvents[0], pushEvents[1]]),
      matchFeed([pushEvents[1], pushEvents[2]]), // overlap: seq 1 again + new seq 2
    ]);
    expect(s.events.map((e) => [e.seq, e.type])).toEqual([
      [0, "new_hand"],
      [1, "player_action"],
      [2, "player_action"],
    ]);
    expect(s.maxSeq).toBe(2);
    expect(s.events[2].player_id).toBe(OPP); // player→player_id mapped
    expect(s.events[2].created_at).toBe("t2"); // ts→created_at mapped
  });

  it("dedupes against action_request.new_events in EITHER order (shared seq space)", () => {
    // Push wins the race: the later action_request's overlap is skipped.
    const s1 = feed([
      gameStart("texas_holdem"),
      matchFeed([pushEvents[0], pushEvents[1]]),
      actionRequest({ hand_num: 1 }, pushEvents),
    ]);
    expect(s1.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    // new_events first: the push frame's overlap is skipped.
    const s2 = feed([
      gameStart("texas_holdem"),
      actionRequest({ hand_num: 1 }, pushEvents),
      matchFeed(pushEvents),
    ]);
    expect(s2.events.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it("interleaves with the polled REST feed (both fold through the one merge)", () => {
    const s0 = feed([gameStart("texas_holdem"), matchFeed([pushEvents[0]])]);
    // The poll's full-history page repeats seq 0 and adds 1 — only 1 lands.
    const s1 = mergePolledEvents(s0, SESSION, [pushEvents[0], pushEvents[1]]);
    expect(s1.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(s1.maxSeq).toBe(1);
  });

  it("ignores frames for another session, before any game_start, or malformed data", () => {
    const s0 = feed([gameStart("texas_holdem")]);
    // Session isolation — same guard as mergePolledEvents.
    expect(feed([matchFeed(pushEvents, "99999999-9999-9999-9999-999999999999")], s0)).toBe(s0);
    const blank = emptyLiveMatch();
    expect(feed([matchFeed(pushEvents)], blank)).toBe(blank);
    // Malformed: null events, missing match_id, missing data altogether.
    expect(feed([matchFeed(null)], s0)).toBe(s0);
    expect(feed([{ type: "match_feed", data: { events: pushEvents } } as unknown as ServerMessage], s0)).toBe(s0);
    expect(feed([{ type: "match_feed" } as unknown as ServerMessage], s0)).toBe(s0);
  });

  it("confirms a pending synthetic own-action through the push (F2 reconcile rides along)", () => {
    const s0 = feed([gameStart("texas_holdem"), actionRequest({ hand_num: 1 }, [pushEvents[0]])]);
    const s1 = injectFinalAction(s0, { matchId: SESSION, action: { type: "raise", data: { amount: 400 } } });
    const s2 = feed([matchFeed([
      pushEvents[0],
      { type: "player_action", player: OWNER, data: { action: "raise", amount: 400, total_bet: 400 }, seq: 1, ts: "t1" },
    ])], s1);
    expect(s2.pendingAction).toBeNull();
    expect(s2.events.filter((e) => e.type === "player_action")).toHaveLength(1);
    expect(s2.syncNotice).toBeNull();
  });
});

// ── F2: synthetic own-action (inject → dedupe → rollback) ────────────────────

describe("injectFinalAction + reconcile (F2)", () => {
  const finalAction = (type: string, data?: Record<string, unknown>, matchId = SESSION) => ({
    matchId,
    action: { type, ...(data !== undefined ? { data } : {}) },
  });

  function pokerWithHand(): LiveMatchState {
    // game_start + new_hand (seq 0); no your_hand → no cards_dealt noise.
    return feed([gameStart("texas_holdem"), actionRequest({ hand_num: 1 }, [{ type: "new_hand", data: { hand_num: 1 }, seq: 0, ts: "t0" }])]);
  }

  it("injects the owner's action as a synthetic event WITHOUT advancing maxSeq", () => {
    const s0 = pokerWithHand();
    const s1 = injectFinalAction(s0, finalAction("fold"));
    expect(s1.events).toHaveLength(2);
    const syn = s1.events[1];
    expect(syn.type).toBe("player_action");
    expect(syn.player_id).toBe(OWNER);
    expect(syn.data.action).toBe("fold");
    expect(s1.maxSeq).toBe(0); // untouched — the real event still dedupes against 0
    expect(s1.pendingAction).not.toBeNull();
    expect(s1.syncNotice).toBeNull();
  });

  it("confirm: the server's real event replaces the synthetic (exactly one survives)", () => {
    const s1 = injectFinalAction(pokerWithHand(), finalAction("fold"));
    const s2 = feed([actionRequest({ hand_num: 1 }, [{ type: "player_action", player: OWNER, data: { action: "fold", total_bet: 0 }, seq: 1, ts: "t1" }])], s1);
    expect(s2.pendingAction).toBeNull();
    const folds = s2.events.filter((e) => e.type === "player_action" && e.player_id === OWNER);
    expect(folds).toHaveLength(1);
    expect(folds[0].seq).toBe(1); // the REAL one, with the real seq/ts
    expect(folds[0].created_at).toBe("t1");
    expect(s2.maxSeq).toBe(1);
    expect(s2.syncNotice).toBeNull();
  });

  it("confirm also works through the polled feed (mergePolledEvents)", () => {
    const s1 = injectFinalAction(pokerWithHand(), finalAction("raise", { amount: 400 }));
    const s2 = mergePolledEvents(s1, SESSION, [
      { type: "new_hand", data: { hand_num: 1 }, seq: 0, ts: "t0" },
      { type: "player_action", player: OWNER, data: { action: "raise", amount: 400, total_bet: 400 }, seq: 1, ts: "t1" },
    ]);
    expect(s2.pendingAction).toBeNull();
    expect(s2.events.filter((e) => e.type === "player_action")).toHaveLength(1);
    expect(s2.syncNotice).toBeNull();
  });

  it("amount must match: a real raise of a DIFFERENT size rolls the synthetic back", () => {
    const s1 = injectFinalAction(pokerWithHand(), finalAction("raise", { amount: 400 }));
    const s2 = feed([actionRequest({ hand_num: 1 }, [{ type: "player_action", player: OWNER, data: { action: "raise", amount: 800 }, seq: 1, ts: "t1" }])], s1);
    expect(s2.pendingAction).toBeNull();
    expect(s2.syncNotice).toBe("action_unconfirmed");
    const raises = s2.events.filter((e) => e.type === "player_action");
    expect(raises).toHaveLength(1);
    expect(raises[0].data.amount).toBe(800); // only the server's version stays
  });

  it("mismatch rollback: the server recorded a forced fold where we injected a raise", () => {
    const s1 = injectFinalAction(pokerWithHand(), finalAction("raise", { amount: 400 }));
    const s2 = feed([actionRequest({ hand_num: 1 }, [{ type: "player_action", player: OWNER, data: { action: "fold" }, seq: 1, ts: "t1" }])], s1);
    expect(s2.syncNotice).toBe("action_unconfirmed");
    expect(s2.events.filter((e) => e.type === "player_action")).toHaveLength(1);
    expect(s2.events.find((e) => e.type === "player_action")?.data.action).toBe("fold");
  });

  it("boundary rollback: a new hand starting before any confirmation means it never landed", () => {
    const s1 = injectFinalAction(pokerWithHand(), finalAction("raise", { amount: 400 }));
    const s2 = feed([actionRequest({ hand_num: 2 }, [{ type: "new_hand", data: { hand_num: 2 }, seq: 1, ts: "t1" }])], s1);
    expect(s2.syncNotice).toBe("action_unconfirmed");
    expect(s2.pendingAction).toBeNull();
    expect(s2.events.filter((e) => e.type === "player_action")).toHaveLength(0); // synthetic gone
    expect(s2.events.some((e) => e.type === "new_hand" && e.data.hand_num === 2)).toBe(true);
  });

  it("confirm wins over the boundary when both arrive in one batch (order matters)", () => {
    const s1 = injectFinalAction(pokerWithHand(), finalAction("fold"));
    const s2 = feed([actionRequest({ hand_num: 2 }, [
      { type: "player_action", player: OWNER, data: { action: "fold" }, seq: 1, ts: "t1" },
      { type: "hand_result", data: { pot: 100 }, seq: 2, ts: "t2" },
      { type: "new_hand", data: { hand_num: 2 }, seq: 3, ts: "t3" },
    ])], s1);
    expect(s2.pendingAction).toBeNull();
    expect(s2.syncNotice).toBeNull();
    expect(s2.events.filter((e) => e.type === "player_action")).toHaveLength(1);
  });

  it("action_stale rolls the synthetic back with the notice", () => {
    const s1 = injectFinalAction(pokerWithHand(), finalAction("fold"));
    const s2 = reduceServerMessage(s1, { type: "action_stale", data: { reason: "superseded" } } as unknown as ServerMessage);
    expect(s2.pendingAction).toBeNull();
    expect(s2.syncNotice).toBe("action_unconfirmed");
    expect(s2.events.filter((e) => e.type === "player_action")).toHaveLength(0);
    // Benign when nothing is pending (Coup response window closed by another player).
    const s3 = reduceServerMessage(pokerWithHand(), { type: "action_stale", data: {} } as unknown as ServerMessage);
    expect(s3.pendingAction).toBeNull();
    expect(s3.syncNotice).toBeNull();
  });

  it("allin matches kind-only (the synthetic carries no amount, the real one does)", () => {
    const s1 = injectFinalAction(pokerWithHand(), finalAction("allin"));
    const s2 = feed([actionRequest({ hand_num: 1 }, [{ type: "player_action", player: OWNER, data: { action: "allin", amount: 9950 }, seq: 1, ts: "t1" }])], s1);
    expect(s2.pendingAction).toBeNull();
    expect(s2.syncNotice).toBeNull();
    expect(s2.events.filter((e) => e.type === "player_action")).toHaveLength(1);
  });

  it("an opponent's action never confirms nor contradicts our synthetic", () => {
    const s1 = injectFinalAction(pokerWithHand(), finalAction("fold"));
    const s2 = feed([actionRequest({ hand_num: 1 }, [{ type: "player_action", player: OPP, data: { action: "fold" }, seq: 1, ts: "t1" }])], s1);
    expect(s2.pendingAction).not.toBeNull(); // still waiting
    expect(s2.events.filter((e) => e.type === "player_action")).toHaveLength(2); // synthetic + opp's
  });

  it("a newer final_action supersedes an unconfirmed synthetic quietly", () => {
    const s1 = injectFinalAction(pokerWithHand(), finalAction("raise", { amount: 400 }));
    const s2 = injectFinalAction(s1, finalAction("call", { amount: 200 }));
    expect(s2.syncNotice).toBeNull(); // supersede is not a server-side rejection
    const actions = s2.events.filter((e) => e.type === "player_action");
    expect(actions).toHaveLength(1);
    expect(actions[0].data.action).toBe("call");
  });

  it("game_over drops a pending synthetic silently (no notice)", () => {
    const s1 = injectFinalAction(pokerWithHand(), finalAction("fold"));
    const s2 = feed([{
      type: "game_over",
      data: { match_id: "real", session_id: SESSION, result: { winner: OPP, is_draw: false }, players: [] },
    } as unknown as ServerMessage], s1);
    expect(s2.pendingAction).toBeNull();
    expect(s2.syncNotice).toBeNull();
    expect(s2.events.filter((e) => e.type === "player_action")).toHaveLength(0);
  });

  it("ignores traces for another session, a finished match, or unmappable kinds", () => {
    const s0 = pokerWithHand();
    expect(injectFinalAction(s0, finalAction("fold", undefined, "99999999-9999-9999-9999-999999999999"))).toBe(s0);
    const fin = feed([{
      type: "game_over",
      data: { match_id: "real", session_id: SESSION, result: { winner: OWNER, is_draw: false }, players: [] },
    } as unknown as ServerMessage], s0);
    expect(injectFinalAction(fin, finalAction("fold"))).toBe(fin);
    expect(injectFinalAction(s0, finalAction("surrender"))).toBe(s0); // not a poker action
  });

  it("dice: bid injects + confirms; challenge is NEVER synthesized (engine-computed fields)", () => {
    const d0 = feed([gameStart("liars_dice"), actionRequest({ round: 1 }, [{ type: "round_start", data: { round: 1 }, seq: 0, ts: "t0" }])]);
    const d1 = injectFinalAction(d0, finalAction("bid", { quantity: 3, face: 4 }));
    expect(d1.events[1]).toMatchObject({ type: "bid", player_id: OWNER, data: { quantity: 3, face: 4 } });
    const d2 = feed([actionRequest({ round: 1 }, [{ type: "bid", player: OWNER, data: { quantity: 3, face: 4 }, seq: 1, ts: "t1" }])], d1);
    expect(d2.pendingAction).toBeNull();
    expect(d2.events.filter((e) => e.type === "bid")).toHaveLength(1);
    // challenge → no injection at all
    expect(injectFinalAction(d0, finalAction("challenge"))).toBe(d0);
  });

  it("dice: a new round starting rolls an unconfirmed bid back", () => {
    const d0 = feed([gameStart("liars_dice"), actionRequest({ round: 1 }, [{ type: "round_start", data: { round: 1 }, seq: 0, ts: "t0" }])]);
    const d1 = injectFinalAction(d0, finalAction("bid", { quantity: 3, face: 4 }));
    const d2 = feed([actionRequest({ round: 2 }, [{ type: "round_start", data: { round: 2 }, seq: 1, ts: "t1" }])], d1);
    expect(d2.syncNotice).toBe("action_unconfirmed");
    expect(d2.events.filter((e) => e.type === "bid")).toHaveLength(0);
  });

  it("coup: turn action injects + confirms with target; a different target rolls back", () => {
    const c0 = feed([gameStart("coup"), actionRequest({ phase: "action" }, null)]);
    const c1 = injectFinalAction(c0, finalAction("tax"));
    expect(c1.events[0]).toMatchObject({ type: "action", player_id: OWNER, data: { action: "tax" } });
    const c2 = feed([actionRequest({ phase: "challenge" }, [{ type: "action", player: OWNER, data: { action: "tax", claimed_role: "duke" }, seq: 0, ts: "t0" }])], c1);
    expect(c2.pendingAction).toBeNull();
    expect(c2.events.filter((e) => e.type === "action")).toHaveLength(1);

    const s1 = injectFinalAction(c0, finalAction("assassinate", { target: OPP }));
    const s2 = feed([actionRequest({ phase: "block" }, [{ type: "action", player: OWNER, data: { action: "assassinate", target: "p9" }, seq: 0, ts: "t0" }])], s1);
    expect(s2.syncNotice).toBe("action_unconfirmed");
    // phase responses are never synthesized
    expect(injectFinalAction(c0, finalAction("challenge"))).toBe(c0);
    expect(injectFinalAction(c0, finalAction("block", { role: "duke" }))).toBe(c0);
    expect(injectFinalAction(c0, finalAction("pass"))).toBe(c0);
  });

  it("reconnect history reconciles: the full log confirms (or contradicts) the synthetic", () => {
    const s1 = injectFinalAction(pokerWithHand(), finalAction("fold"));
    const s2 = feed([actionRequest({ hand_num: 1 }, null, SESSION, {
      is_reconnect: true,
      event_history: [
        { type: "new_hand", data: { hand_num: 1 }, seq: 0, ts: "h0" },
        { type: "player_action", player: OWNER, data: { action: "fold" }, seq: 1, ts: "h1" },
      ],
    })], s1);
    expect(s2.pendingAction).toBeNull();
    expect(s2.syncNotice).toBeNull();
    expect(s2.events.filter((e) => e.type === "player_action")).toHaveLength(1);
  });
});
