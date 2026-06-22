// D10 — tests for the protocol→renderer reducer. These lock down the two binding
// rules in executable form: (1) only the OWNER's own private info is ever
// surfaced, and (2) a new match resets state (session isolation).

import { describe, it, expect } from "vitest";

import { emptyLiveMatch, reduceServerMessage, type LiveMatchState } from "./liveMatch";
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
