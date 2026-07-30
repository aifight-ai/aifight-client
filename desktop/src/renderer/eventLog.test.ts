// D11 event-log formatting + trace correlation — pure tests, no DOM. Covers:
// per-game log-line formatting (WITH amounts — the web log lacks them),
// per-player color determinism, the owner "You/我" mapping, skipped event
// types, and the trace-group anchoring/clamping rules. i18n defaults to en
// under node (see i18n.ts); zh cases switch language explicitly and restore.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { agentGradient } from "@aifight/ui";
import type { MatchEvent } from "@aifight/api-types";
import i18n from "./i18n";
import {
  anchorTraceGroups,
  describeEvent,
  displayName,
  fmtChips,
  groupsByPosition,
  playerNameColor,
  type LogContext,
  type TFunc,
} from "./eventLog";
import type { Game } from "./liveMatch";
import type { StampedTrace } from "./liveStore";

const t: TFunc = (k, o) => i18n.t(k, o);

const players = [
  { agent_id: "a0", agent_name: "Claude Opus", player_id: "p0", position: 0 },
  { agent_id: "a1", agent_name: "GPT-5", player_id: "p1", position: 1 },
  { agent_id: "a2", agent_name: "Kimi K3", player_id: "p2", position: 2 },
];

const ctxFor = (game: Game, ownerPlayerId = "p0"): LogContext => ({ game, players, ownerPlayerId, t });

function ev(type: string, data: Record<string, unknown> = {}, player_id?: string): MatchEvent {
  return { seq: 0, type, data, created_at: "", ...(player_id !== undefined ? { player_id } : {}) };
}

describe("fmtChips — thousands separators", () => {
  it("formats like the SeatCard precedent", () => {
    expect(fmtChips(400)).toBe("400");
    expect(fmtChips(1200)).toBe("1,200");
    expect(fmtChips(8700)).toBe("8,700");
  });
});

describe("poker log lines (amount semantics: call=added, raise/allin=raise-to)", () => {
  const ctx = ctxFor("texas_holdem");

  it("fold/check carry no amount", () => {
    expect(describeEvent(ev("player_action", { action: "fold" }, "p1"), ctx)).toEqual({
      kind: "action",
      playerId: "p1",
      tail: "fold",
    });
    expect(describeEvent(ev("player_action", { action: "check", total_bet: 0 }, "p1"), ctx)?.tail).toBe("check");
  });

  it("call shows the chips added THIS action", () => {
    expect(describeEvent(ev("player_action", { action: "call", amount: 400, total_bet: 600 }, "p1"), ctx)?.tail).toBe(
      "call 400",
    );
  });

  it("raise/all-in show the raise-to TOTAL", () => {
    expect(describeEvent(ev("player_action", { action: "raise", amount: 800, total_bet: 800 }, "p2"), ctx)?.tail).toBe(
      "raise to 800",
    );
    expect(describeEvent(ev("player_action", { action: "allin", amount: 12500, total_bet: 12500 }, "p2"), ctx)?.tail).toBe(
      "all-in to 12,500",
    );
  });

  it("blinds are logged with their posted amounts", () => {
    expect(describeEvent(ev("player_action", { action: "small_blind", amount: 100 }, "p0"), ctx)?.tail).toBe(
      "small blind 100",
    );
    expect(describeEvent(ev("player_action", { action: "big_blind", amount: 200 }, "p1"), ctx)?.tail).toBe(
      "big blind 200",
    );
  });

  it("legacy 'bet' (demo fixture) renders with its amount", () => {
    expect(describeEvent(ev("player_action", { action: "bet", amount: 400 }, "p0"), ctx)?.tail).toBe("bet 400");
  });

  it("new_hand is a phase separator; community_cards an info line", () => {
    expect(describeEvent(ev("new_hand", { hand_num: 3 }), ctx)).toEqual({
      kind: "phase",
      playerId: null,
      tail: "Hand 3 begins",
    });
    expect(describeEvent(ev("community_cards", { cards: ["Ah", "7d", "2c"] }), ctx)).toEqual({
      kind: "info",
      playerId: null,
      tail: "Board: Ah 7d 2c",
    });
  });

  it("hand_result: winner + pot + localized reason, emphasized", () => {
    const row = describeEvent(
      ev("hand_result", { winners: ["p2"], pot: 8700, hand: 2, reason: "all_folded" }),
      ctx,
    );
    expect(row?.kind).toBe("result");
    expect(row?.tail).toBe("Hand 2: Kimi K3 won the pot of 8,700 (all folded)");
  });

  it("hand_result: split pot and showdown reason", () => {
    const row = describeEvent(
      ev("hand_result", { winners: ["p0", "p1"], pot: 1000, hand: 5, reason: "showdown" }),
      ctx,
    );
    expect(row?.tail).toBe("Hand 5: You, GPT-5 split the pot of 1,000 (showdown)");
  });

  it("hand_result: pre-pot rows omit the amount instead of showing 0", () => {
    const row = describeEvent(ev("hand_result", { winners: ["p1"], hand: 1, reason: "showdown" }), ctx);
    expect(row?.tail).toBe("Hand 1: GPT-5 won the pot (showdown)");
  });

  it("match_result: winner / draw / bare", () => {
    expect(describeEvent(ev("match_result", { winner: "p1", winners: ["p1"], is_draw: false }), ctx)?.tail).toBe(
      "Match over — winner: GPT-5",
    );
    expect(describeEvent(ev("match_result", { winner: "", winners: ["p0", "p1"], is_draw: true }), ctx)?.tail).toBe(
      "Match over — draw",
    );
    expect(describeEvent(ev("match_result", {}), ctx)?.tail).toBe("Match over");
  });
});

describe("liar's dice log lines", () => {
  const ctx = ctxFor("liars_dice");

  it("bid carries quantity×face", () => {
    expect(describeEvent(ev("bid", { quantity: 3, face: 4 }, "p1"), ctx)).toEqual({
      kind: "action",
      playerId: "p1",
      tail: "bid 3×4",
    });
  });

  it("challenge carries the round resolution inline (caught / stood + loser)", () => {
    const caught = describeEvent(
      ev("challenge", { challenger: "p1", bidder: "p0", bid_quantity: 4, bid_face: 5, actual_count: 2, bid_met: false, loser: "p0" }, "p1"),
      ctx,
    );
    // Owner is the loser → the en "you lose" conjugation variant.
    expect(caught?.tail).toBe("challenge — bluff caught (2×5 on the table); you lose a die");
    const stood = describeEvent(
      ev("challenge", { challenger: "p0", bidder: "p1", bid_quantity: 3, bid_face: 6, actual_count: 5, bid_met: true, loser: "p0" }, "p0"),
      ctx,
    );
    expect(stood?.tail).toBe("challenge — bid stood (5×6 on the table); you lose a die");
    const namedLoser = describeEvent(
      ev("challenge", { challenger: "p0", bidder: "p1", bid_quantity: 4, bid_face: 4, actual_count: 1, bid_met: false, loser: "p1" }, "p0"),
      ctx,
    );
    expect(namedLoser?.tail).toBe("challenge — bluff caught (1×4 on the table); GPT-5 loses a die");
  });

  it("round_start is a phase separator; elimination a result row on the player", () => {
    expect(describeEvent(ev("round_start", { round: 2 }), ctx)).toEqual({
      kind: "phase",
      playerId: null,
      tail: "Round 2 begins",
    });
    expect(describeEvent(ev("player_eliminated", { player: "p1" }, "p1"), ctx)).toEqual({
      kind: "result",
      playerId: "p1",
      tail: "eliminated",
    });
  });

  it("game_over with a winner", () => {
    expect(describeEvent(ev("game_over", { winner: "p0" }), ctx)?.tail).toBe("Match over — winner: You");
  });
});

describe("coup log lines", () => {
  const ctx = ctxFor("coup");

  it("actions show verb, target, and claimed role", () => {
    expect(describeEvent(ev("action", { action: "income" }, "p1"), ctx)?.tail).toBe("income");
    expect(describeEvent(ev("action", { action: "coup", target: "p1" }, "p0"), ctx)?.tail).toBe("coup → GPT-5");
    expect(describeEvent(ev("action", { action: "tax", claimed_role: "Duke" }, "p1"), ctx)?.tail).toBe("tax (Duke)");
    expect(
      describeEvent(ev("action", { action: "assassinate", target: "p2", claimed_role: "Assassin" }, "p1"), ctx)?.tail,
    ).toBe("assassinate → Kimi K3 (Assassin)");
  });

  it("challenge / block carry the claimed role", () => {
    expect(describeEvent(ev("challenge", { challenger: "p1", actor: "p0", claimed_role: "Duke" }, "p1"), ctx)?.tail).toBe(
      "challenge (Duke)",
    );
    expect(describeEvent(ev("block", { blocker: "p2", claimed_role: "Contessa", action: "assassinate" }, "p2"), ctx)?.tail).toBe(
      "block (Contessa)",
    );
    expect(
      describeEvent(ev("challenge_block", { challenger: "p1", blocker: "p2", claimed_role: "Contessa" }, "p1"), ctx)?.tail,
    ).toBe("challenge the block (Contessa)");
  });

  it("passes are dim info lines, not full action rows", () => {
    for (const type of ["block_pass", "challenge_pass", "block_challenge_pass"]) {
      expect(describeEvent(ev(type, { player: "p1" }, "p1"), ctx)).toEqual({
        kind: "info",
        playerId: "p1",
        tail: "pass",
      });
    }
  });

  it("challenge_result: fail = claim was true (card revealed), success = bluff caught", () => {
    // Past tense everywhere: "You had…" and "GPT-5 had…" both conjugate correctly.
    expect(
      describeEvent(ev("challenge_result", { result: "fail", revealed_card: "Duke", actor: "p1", challenger: "p0" }, "p1"), ctx)
        ?.tail,
    ).toBe("Challenge failed — GPT-5 had the Duke");
    expect(
      describeEvent(ev("challenge_result", { result: "success", actor: "p1", challenger: "p0" }, "p1"), ctx)?.tail,
    ).toBe("Challenge succeeded — GPT-5 didn't hold the role");
    expect(
      describeEvent(
        ev("challenge_block_result", { result: "fail", revealed_card: "Contessa", blocker: "p2", challenger: "p1" }, "p2"),
        ctx,
      )?.tail,
    ).toBe("Block stood — Kimi K3 had the Contessa");
  });

  it("influence_lost and elimination name the player", () => {
    expect(describeEvent(ev("influence_lost", { player: "p1", card: "Duke", card_index: 0 }, "p1"), ctx)).toEqual({
      kind: "action",
      playerId: "p1",
      tail: "influence lost (Duke)",
    });
    expect(describeEvent(ev("player_eliminated", { player: "p1" }, "p1"), ctx)?.kind).toBe("result");
  });

  it("block_accepted is an info line", () => {
    expect(describeEvent(ev("block_accepted", { blocker: "p2" }, "p2"), ctx)).toEqual({
      kind: "info",
      playerId: null,
      tail: "Block accepted — the action is cancelled",
    });
  });
});

describe("skipped + fallback event types", () => {
  const ctx = ctxFor("texas_holdem");
  it("protocol markers, the synthetic cards_dealt, and coup mechanical echoes render nothing", () => {
    for (const type of ["game_start", "game_setup", "cards_dealt", "action_resolved", "exchange_draw", "exchange_complete"]) {
      expect(describeEvent(ev(type, {}, "p0"), ctx)).toBeNull();
    }
  });
  it("unknown types degrade to the web log's fallback (type name with spaces)", () => {
    expect(describeEvent(ev("player_disconnected", {}, "p1"), ctxFor("liars_dice"))).toEqual({
      kind: "info",
      playerId: "p1",
      tail: "player disconnected",
    });
  });
});

describe("displayName + per-player color", () => {
  const ctx = ctxFor("coup");
  it("the owner's own seat is the localized You; opponents use their match name", () => {
    expect(displayName("p0", ctx)).toBe("You");
    expect(displayName("p1", ctx)).toBe("GPT-5");
    expect(displayName("unknown-id", ctx)).toBe("unknown-id");
  });
  it("color is deterministic per player_id (deep end of the shared gradient)", () => {
    expect(playerNameColor("p1", ctx)).toBe(agentGradient("p1")[1]);
    expect(playerNameColor("p1", ctx)).toBe(playerNameColor("p1", ctx));
    // The owner's own rows keep the cockpit accent treatment instead (undefined → CSS class).
    expect(playerNameColor("p0", ctx)).toBeUndefined();
  });
});

describe("trace correlation: group + anchor + clamp", () => {
  const tr = (partial: Record<string, unknown>): StampedTrace => partial as unknown as StampedTrace;
  const decision = (step?: number) =>
    tr({ type: "decision_request", matchId: "m", game: "coup", legalActionCount: 3, timeoutMs: 1000, ...(step !== undefined ? { step } : {}) });
  const success = (step: number, preview: string) =>
    tr({ type: "runtime_success", matchId: "m", attempt: 1, raw: { kind: "text", sha256: "x", bytes: 1, preview }, step });

  it("a new group opens at each decision_request; anchor = the group's stamped step", () => {
    const groups = anchorTraceGroups([decision(1), success(1, "a"), decision(3), success(3, "b")]);
    expect(groups.map((g) => g.anchor)).toEqual([1, 3]);
    expect(groups[0]?.traces).toHaveLength(2);
    expect(groups[1]?.traces).toHaveLength(2);
  });

  it("traces before the first decision_request form a preamble group; fully-unstamped groups sort last (tip)", () => {
    const groups = anchorTraceGroups([success(1, "early"), decision(2)]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.anchor).toBe(1); // stamped preamble sorts by its step
    expect(groups[1]?.anchor).toBe(2);
    const unstamped = anchorTraceGroups([
      tr({ type: "runtime_success", matchId: "m", attempt: 1, raw: { kind: "text", sha256: "x", bytes: 1, preview: "old" } }),
      decision(2),
    ]);
    // Unstamped sorts last — it anchors at the tip regardless of stream position.
    expect(unstamped[0]?.anchor).toBe(2);
    expect(unstamped[1]?.anchor).toBeUndefined();
  });

  it("groups with the same anchor keep arrival order; anchors clamp into [0, rowCount]", () => {
    const groups = anchorTraceGroups([decision(2), success(2, "a"), decision(2), success(2, "b"), decision(9)]);
    const byPos = groupsByPosition(groups, 4);
    // step-2 groups sit at position 2, in arrival order; step 9 clamps to the tip (4).
    expect(byPos.get(2)).toHaveLength(2);
    expect(byPos.get(2)?.[0]?.traces[0]).toBe(groups[0]?.traces[0]);
    expect(byPos.get(4)).toHaveLength(1);
    expect(byPos.get(0)).toBeUndefined();
  });

  it("unstamped groups anchor at the tip regardless of rowCount", () => {
    const groups = anchorTraceGroups([decision(undefined)]);
    expect(groupsByPosition(groups, 0).get(0)).toHaveLength(1);
    expect(groupsByPosition(groups, 7).get(7)).toHaveLength(1);
  });
});

describe("zh log lines", () => {
  beforeAll(() => i18n.changeLanguage("zh"));
  afterAll(() => i18n.changeLanguage("en"));

  it("actions, owner name, phases and results are localized", () => {
    const ctx = ctxFor("texas_holdem");
    expect(displayName("p0", ctx)).toBe("我");
    expect(describeEvent(ev("player_action", { action: "raise", amount: 800 }, "p1"), ctx)?.tail).toBe("加注到 800");
    expect(describeEvent(ev("player_action", { action: "call", amount: 400 }, "p0"), ctx)?.tail).toBe("跟注 400");
    expect(describeEvent(ev("new_hand", { hand_num: 3 }), ctx)?.tail).toBe("第 3 手开始");
    expect(
      describeEvent(ev("hand_result", { winners: ["p0"], pot: 8700, hand: 2, reason: "all_folded" }), ctx)?.tail,
    ).toBe("第 2 手:我 赢得底池 8,700(全部弃牌)");
    expect(describeEvent(ev("match_result", { winner: "p1" }), ctx)?.tail).toBe("对局结束——胜者:GPT-5");
  });

  it("dice + coup lines are localized too", () => {
    const dice = ctxFor("liars_dice");
    expect(describeEvent(ev("bid", { quantity: 3, face: 4 }, "p1"), dice)?.tail).toBe("叫数 3×4");
    expect(
      describeEvent(
        ev("challenge", { challenger: "p1", bidder: "p0", bid_quantity: 4, bid_face: 5, actual_count: 2, bid_met: false, loser: "p0" }, "p1"),
        dice,
      )?.tail,
    ).toBe("质疑——虚报被抓(实际 2 个 5 点);我 输一个骰子");
    const coup = ctxFor("coup");
    expect(describeEvent(ev("action", { action: "steal", target: "p2", claimed_role: "Captain" }, "p1"), coup)?.tail).toBe(
      "偷取 → Kimi K3 (Captain)",
    );
  });
});
