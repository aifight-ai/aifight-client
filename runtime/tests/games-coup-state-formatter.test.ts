// Tests for runtime/src/games/coup/state-formatter.ts.
//
// Hand-written fixtures, contains-string assertions, no snapshot.
// Covers 6 phases + 17 event types + PlayerInfo.data shape guard.

import { describe, expect, it } from "vitest";

import { formatCoupState } from "../src/games/coup/state-formatter";
import type { CoupRules, CoupState, Event, PlayerInfo } from "../src/protocol/types";

const RULES: CoupRules = {
  name: "Coup",
  summary: "Bluff your role; lose all influence to be eliminated.",
  available_actions: {
    income: "Take 1 coin",
    foreign_aid: "Take 2 coins (blockable by Duke)",
    coup: "Pay 7 to eliminate one influence",
    tax: "Take 3 coins (claim Duke)",
    assassinate: "Pay 3, eliminate target's influence (claim Assassin)",
    steal: "Take 2 coins from target (claim Captain)",
    exchange: "Swap cards with deck (claim Ambassador)",
    challenge: "Challenge a role claim",
    pass: "Pass on challenge / block",
    block: "Block an action with claimed role",
    lose_card: "Choose which influence to reveal",
    return_cards: "Return exchange cards to deck",
  },
  key_rules: ["Mandatory coup at 10 coins."],
};

function baseState(over: Partial<CoupState> = {}): CoupState {
  return {
    phase: "action",
    current_turn: "p0",
    your_cards: ["Duke", "Assassin"],
    your_revealed: [],
    coins: 3,
    ...over,
  };
}

const PLAYERS: readonly PlayerInfo[] = [
  {
    id: "p0",
    name: "Player 1",
    status: "active",
    data: { coins: 3, hidden_cards: 2, revealed: [] },
  },
  {
    id: "p1",
    name: "Player 2",
    status: "active",
    data: { coins: 5, hidden_cards: 2, revealed: [] },
  },
];

describe("formatCoupState", () => {
  it("stateBlock core fields", () => {
    const out = formatCoupState({
      publicState: baseState(),
      rules: RULES,
      players: PLAYERS,
      recentEvents: [],
      yourPlayerId: "p1",
    });
    expect(out.stateBlock).toContain("Phase: action");
    expect(out.stateBlock).toContain("Current turn (actor): Player 1 (p0)");
    expect(out.stateBlock).toContain("Your unrevealed cards: [Duke, Assassin]");
    expect(out.stateBlock).toContain("Your revealed cards: []");
    expect(out.stateBlock).toContain("Your coins: 3");
  });

  it("six phases each render expected fields", () => {
    // action phase — base case already covered

    // challenge_action: pending_action + claimed_role visible
    let out = formatCoupState({
      publicState: baseState({
        phase: "challenge_action",
        pending_action: "tax",
        claimed_role: "Duke",
      }),
      rules: RULES,
      players: PLAYERS,
      recentEvents: [],
      yourPlayerId: "p1",
    });
    expect(out.stateBlock).toContain("Phase: challenge_action");
    expect(out.stateBlock).toContain("Pending action: tax");
    expect(out.stateBlock).toContain("claimed_role: Duke");

    // block phase
    out = formatCoupState({
      publicState: baseState({
        phase: "block",
        pending_action: "foreign_aid",
        pending_target: "p1",
      }),
      rules: RULES,
      players: PLAYERS,
      recentEvents: [],
      yourPlayerId: "p1",
    });
    expect(out.stateBlock).toContain("Phase: block");
    expect(out.stateBlock).toContain("Pending action: foreign_aid");
    expect(out.stateBlock).toContain("target: you (p1)");

    // challenge_block: blocker + block_role visible
    out = formatCoupState({
      publicState: baseState({
        phase: "challenge_block",
        blocker: "p1",
        block_role: "Duke",
      }),
      rules: RULES,
      players: PLAYERS,
      recentEvents: [],
      yourPlayerId: "p1",
    });
    expect(out.stateBlock).toContain("Phase: challenge_block");
    expect(out.stateBlock).toContain("Blocker: you (p1) claiming role Duke");

    // lose_influence
    out = formatCoupState({
      publicState: baseState({ phase: "lose_influence", influence_loser: "p0" }),
      rules: RULES,
      players: PLAYERS,
      recentEvents: [],
      yourPlayerId: "p1",
    });
    expect(out.stateBlock).toContain("Phase: lose_influence");
    expect(out.stateBlock).toContain("Influence loser: Player 1 (p0)");

    // exchange_return: all_exchange_options visible (indexed)
    out = formatCoupState({
      publicState: baseState({
        phase: "exchange_return",
        exchange_cards: ["Captain", "Ambassador"],
        all_exchange_options: ["Duke", "Assassin", "Captain", "Ambassador"],
      }),
      rules: RULES,
      players: PLAYERS,
      recentEvents: [],
      yourPlayerId: "p1",
    });
    expect(out.stateBlock).toContain("Phase: exchange_return");
    expect(out.stateBlock).toContain("Exchange options (indexed):");
    expect(out.stateBlock).toContain("0=Duke");
    expect(out.stateBlock).toContain("1=Assassin");
    expect(out.stateBlock).toContain("2=Captain");
    expect(out.stateBlock).toContain("3=Ambassador");
  });

  it("turn_log multi-step entries render correctly", () => {
    const out = formatCoupState({
      publicState: baseState({
        phase: "challenge_action",
        turn_log: {
          action: "tax",
          actor: "p0",
          claimed_role: "Duke",
          challenger: "p1",
          challenge_result: "fail",
        },
      }),
      rules: RULES,
      players: PLAYERS,
      recentEvents: [],
      yourPlayerId: "p1",
    });
    expect(out.stateBlock).toContain("Turn log:");
    expect(out.stateBlock).toContain("action=tax");
    expect(out.stateBlock).toContain("actor=Player 1 (p0)");
    expect(out.stateBlock).toContain("claimed_role=Duke");
    expect(out.stateBlock).toContain("challenger=you (p1)");
    expect(out.stateBlock).toContain("challenge_result=fail");
  });

  it("block path shows blocker + block_role", () => {
    const out = formatCoupState({
      publicState: baseState({
        phase: "challenge_block",
        pending_action: "foreign_aid",
        blocker: "p1",
        block_role: "Duke",
      }),
      rules: RULES,
      players: PLAYERS,
      recentEvents: [],
      yourPlayerId: "p0",
    });
    expect(out.stateBlock).toContain("Blocker: Player 2 (p1) claiming role Duke");
  });

  it("recentEventsBlock renders representative event templates (subset of 17)", () => {
    const events: Event[] = [
      { type: "action", player: "p0", seq: 1, data: { action: "tax", claimed_role: "Duke" } },
      { type: "challenge_pass", player: "p1", seq: 2, data: { player: "p1" } },
      {
        type: "challenge",
        player: "p1",
        seq: 3,
        data: { challenger: "p1", actor: "p0", claimed_role: "Duke" },
      },
      {
        type: "challenge_result",
        seq: 4,
        data: { result: "success", actor: "p0", challenger: "p1" },
      },
      { type: "block_pass", player: "p0", seq: 5, data: { player: "p0" } },
      {
        type: "block",
        player: "p1",
        seq: 6,
        data: { blocker: "p1", claimed_role: "Duke", action: "foreign_aid" },
      },
      { type: "block_challenge_pass", player: "p0", seq: 7, data: { player: "p0" } },
      { type: "block_accepted", seq: 8, data: { blocker: "p1" } },
      {
        type: "challenge_block",
        player: "p0",
        seq: 9,
        data: { challenger: "p0", blocker: "p1", claimed_role: "Duke" },
      },
      {
        type: "challenge_block_result",
        seq: 10,
        data: { result: "fail", blocker: "p1", challenger: "p0", revealed_card: "Duke" },
      },
      {
        type: "influence_lost",
        player: "p0",
        seq: 11,
        data: { player: "p0", card: "Assassin", card_index: 0 },
      },
      { type: "player_eliminated", player: "p0", seq: 12, data: { player: "p0" } },
      { type: "exchange_draw", player: "p1", seq: 13, data: { action: "exchange", drawn_count: 2 } },
      { type: "exchange_complete", player: "p1", seq: 14, data: { player: "p1", returned_count: 2 } },
      {
        type: "action_resolved",
        player: "p1",
        seq: 15,
        data: { action: "steal", target: "p0", stolen: 2, coins_now: 5 },
      },
      { type: "game_over", seq: 16, data: { winner: "p1" } },
      { type: "player_disconnected", player: "p0", seq: 17, data: { player: "p0" } },
    ];
    const out = formatCoupState({
      publicState: baseState(),
      rules: RULES,
      players: PLAYERS,
      recentEvents: events,
      yourPlayerId: "p1",
    });
    // 17 type strings each get at least one expected anchor
    expect(out.recentEventsBlock).toContain("Player 1 (p0) attempts: tax (claims Duke)");
    expect(out.recentEventsBlock).toContain("you (p1) passed (no challenge)");
    expect(out.recentEventsBlock).toContain("you (p1) challenged Player 1 (p0)'s claim of Duke");
    expect(out.recentEventsBlock).toContain("Challenge result: success");
    expect(out.recentEventsBlock).toContain("Player 1 (p0) was lying, loses influence");
    expect(out.recentEventsBlock).toContain("Player 1 (p0) passed (no block)");
    expect(out.recentEventsBlock).toContain("you (p1) blocks foreign_aid claiming Duke");
    expect(out.recentEventsBlock).toContain("Player 1 (p0) passed (no challenge to block)");
    expect(out.recentEventsBlock).toContain("Block accepted (blocker: you (p1))");
    expect(out.recentEventsBlock).toContain("Player 1 (p0) challenged you (p1)'s block (claimed Duke)");
    expect(out.recentEventsBlock).toContain("Block challenge result: fail");
    expect(out.recentEventsBlock).toContain("Player 1 (p0) revealed Assassin (lost influence)");
    expect(out.recentEventsBlock).toContain("Player 1 (p0) eliminated");
    expect(out.recentEventsBlock).toContain("you (p1) drew exchange cards (count: 2)");
    expect(out.recentEventsBlock).toContain("you (p1) completed exchange (returned: 2)");
    expect(out.recentEventsBlock).toContain("you (p1) resolved: steal (target: Player 1 (p0)) | stolen=2 | coins_now=5");
    expect(out.recentEventsBlock).toContain("Game over. Winner: you (p1)");
    expect(out.recentEventsBlock).toContain("Player 1 (p0) disconnected");
  });

  it("Opponents render with PlayerInfo.data shape guard (4 sub-cases)", () => {
    const players: PlayerInfo[] = [
      // (a) full data
      {
        id: "p0",
        name: "Player 1",
        status: "active",
        data: { coins: 3, hidden_cards: 2, revealed: ["Duke"] },
      },
      // self
      { id: "p1", name: "Player 2", status: "active" },
      // (b) data missing
      { id: "p2", name: "Player 3", status: "active" },
      // (c) revealed not array
      {
        id: "p3",
        name: "Player 4",
        status: "active",
        data: { coins: 4, hidden_cards: 2, revealed: "Duke" } as unknown as Record<string, unknown>,
      },
      // (d) coins / hidden_cards not number
      {
        id: "p4",
        name: "Player 5",
        status: "eliminated",
        data: { coins: "bad", hidden_cards: null, revealed: [] } as unknown as Record<string, unknown>,
      },
      // (e) revealed: [] empty array shown explicitly
      {
        id: "p5",
        name: "Player 6",
        status: "active",
        data: { coins: 1, hidden_cards: 1, revealed: [] },
      },
    ];
    const out = formatCoupState({
      publicState: baseState(),
      rules: RULES,
      players,
      recentEvents: [],
      yourPlayerId: "p1",
    });
    // (a)
    expect(out.stateBlock).toContain(
      "Player 1 (p0): status=active | coins=3 | hidden_cards=2 | revealed=[Duke]",
    );
    // self excluded
    expect(out.stateBlock).not.toContain("Player 2 (p1):");
    // (b) data missing → only status, no coins/hidden_cards/revealed
    expect(out.stateBlock).toContain("Player 3 (p2): status=active");
    expect(out.stateBlock).not.toContain("Player 3 (p2): status=active |");
    // (c) revealed wrong-type — omit revealed only
    expect(out.stateBlock).toContain("Player 4 (p3): status=active | coins=4 | hidden_cards=2");
    expect(out.stateBlock).not.toContain("Player 4 (p3): status=active | coins=4 | hidden_cards=2 | revealed=");
    // (d) coins / hidden_cards wrong-type omitted; revealed=[] kept
    expect(out.stateBlock).toContain("Player 5 (p4): status=eliminated | revealed=[]");
    expect(out.stateBlock).not.toContain("coins=bad");
    // (e) revealed=[] empty array shown explicitly
    expect(out.stateBlock).toContain("Player 6 (p5): status=active | coins=1 | hidden_cards=1 | revealed=[]");
  });

  it("your_cards vs your_revealed labels are distinct", () => {
    const out = formatCoupState({
      publicState: baseState({ your_cards: ["Captain"], your_revealed: ["Assassin"] }),
      rules: RULES,
      players: PLAYERS,
      recentEvents: [],
      yourPlayerId: "p1",
    });
    expect(out.stateBlock).toContain("Your unrevealed cards: [Captain]");
    expect(out.stateBlock).toContain("Your revealed cards: [Assassin]");
  });

  it("empty recentEvents → placeholder string", () => {
    const out = formatCoupState({
      publicState: baseState(),
      rules: RULES,
      players: PLAYERS,
      recentEvents: [],
      yourPlayerId: "p1",
    });
    expect(out.recentEventsBlock).toBe("(no events since your last turn)");
  });

  it("missing turn fields at phase=done do not throw", () => {
    const out = formatCoupState({
      publicState: baseState({
        phase: "done",
        current_turn: undefined as unknown as string,
        winner: "p1",
      }),
      rules: RULES,
      players: PLAYERS,
      recentEvents: [],
      yourPlayerId: "p1",
    });
    expect(out.stateBlock).toContain("Phase: done");
    expect(out.stateBlock).not.toContain("Current turn (actor):");
  });
});
