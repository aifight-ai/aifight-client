// The CLI's in-match narrator: a terminal user used to see NOTHING between
// "queue joined" and the final "Match complete" block — decisions, model
// failures and truncations were invisible in the terminal (owner report,
// 2026-07-28). These tests pin the narration contract: what gets a line, what
// stays silent, and that per-match state (decision numbering, rosters, the
// once-per-match truncation warning) never bleeds across matches.

import { describe, expect, it } from "vitest";

import { MatchNarrator, displayGameName } from "../src/bridge/match-narrator";
import type { ServerMessageEnvelope } from "../src/wsclient/frame-handler";
import type { BridgeDecisionTrace } from "../src/bridge/provider";

const gameStart = (matchId: string, game = "coup"): ServerMessageEnvelope =>
  ({
    type: "game_start",
    data: {
      match_id: matchId,
      game,
      your_position: 0,
      your_player_id: "p0",
      players: [
        { position: 0, name: "Player 1", player_id: "p0" },
        { position: 1, name: "Player 2", player_id: "p1" },
        { position: 2, name: "Player 3", player_id: "p2" },
      ],
    },
  }) as unknown as ServerMessageEnvelope;

const gameOver = (matchId: string): ServerMessageEnvelope =>
  ({ type: "game_over", data: { match_id: "real", session_id: matchId, result: {} } }) as unknown as ServerMessageEnvelope;

const decisionRequest = (matchId: string): BridgeDecisionTrace =>
  ({ type: "decision_request", matchId, game: "coup", legalActionCount: 3, timeoutMs: 300_000, strategy: [] }) as BridgeDecisionTrace;

const finalAction = (
  matchId: string,
  action: { type: string; data?: Record<string, unknown> },
  extra?: Partial<Extract<BridgeDecisionTrace, { type: "final_action" }>>,
): BridgeDecisionTrace =>
  ({ type: "final_action", matchId, source: "runtime", action, ...extra }) as BridgeDecisionTrace;

function narratorAt(times: number[]): MatchNarrator {
  let i = 0;
  return new MatchNarrator({ now: () => times[Math.min(i++, times.length - 1)]! });
}

describe("MatchNarrator", () => {
  it("announces a match start as a new block with game, size and seat", () => {
    const n = new MatchNarrator();
    const line = n.observeServerMessage(gameStart("s1", "texas_holdem"));
    expect(line).toEqual({
      level: "info",
      blockStart: true,
      message: "Match started: Texas Hold'em · 3 players · your seat: Player 1",
    });
  });

  it("narrates each decision with number, action, author and elapsed time", () => {
    const n = narratorAt([1_000, 3_400, 10_000, 40_000]);
    n.observeServerMessage(gameStart("s1"));
    n.observeTrace(decisionRequest("s1"));
    const first = n.observeTrace(finalAction("s1", { type: "income" }));
    expect(first).toEqual({ level: "info", message: "Decision #1: income · model · 2.4s" });

    n.observeTrace(decisionRequest("s1"));
    const second = n.observeTrace(
      finalAction("s1", { type: "pass" }, { source: "fallback", reason: "decision timeout" }),
    );
    expect(second).toEqual({
      level: "info",
      message: "Decision #2: pass · fallback (decision timeout) · 30.0s",
    });
  });

  it("names an action's target from the anonymized roster and formats dice bids", () => {
    const n = new MatchNarrator();
    n.observeServerMessage(gameStart("s1"));
    n.observeTrace(decisionRequest("s1"));
    const coup = n.observeTrace(finalAction("s1", { type: "steal", data: { target: "p2" } }));
    expect(coup!.message).toContain("steal → Player 3");

    const dice = n.observeTrace(finalAction("s1", { type: "bid", data: { quantity: 4, face: 6 } }));
    expect(dice!.message).toContain("bid 4×6");

    const block = n.observeTrace(finalAction("s1", { type: "block", data: { role: "Duke" } }));
    expect(block!.message).toContain("block (Duke)");
  });

  it("labels a corrected decision as model (after retry)", () => {
    const n = new MatchNarrator();
    const line = n.observeTrace(finalAction("s1", { type: "fold" }, { decisionSource: "model_retry" }));
    expect(line!.message).toContain("model (after retry)");
  });

  it("surfaces model failures and illegal retries as warnings, flattened to one line", () => {
    const n = new MatchNarrator();
    const fail = n.observeTrace({
      type: "runtime_failure",
      matchId: "s1",
      attempt: 1,
      error: "Request timed\nout after   270s" + "x".repeat(300),
      errorClass: "timeout",
    } as BridgeDecisionTrace);
    expect(fail!.level).toBe("warning");
    expect(fail!.message).toContain("model call failed (attempt 1, timeout): Request timed out after 270s");
    expect(fail!.message.length).toBeLessThan(200); // long provider errors are clipped

    const retry = n.observeTrace({
      type: "illegal_retry",
      matchId: "s1",
      attempt: 2,
      reason: "illegal_runtime_action",
      priorPreview: "…",
    } as BridgeDecisionTrace);
    expect(retry).toEqual({
      level: "warning",
      message: "model output was not a legal action — asking the model to correct (attempt 2)",
    });
  });

  it("warns about truncation once per match, and resets for the next match", () => {
    const n = new MatchNarrator();
    n.observeServerMessage(gameStart("s1"));
    const success = (id: string) =>
      n.observeTrace({
        type: "runtime_success",
        matchId: id,
        attempt: 1,
        raw: { kind: "text", sha256: "x", bytes: 1, preview: "p" },
        truncated: true,
      } as BridgeDecisionTrace);
    expect(success("s1")!.level).toBe("warning");
    expect(success("s1")).toBeNull(); // second truncation in the same match stays quiet
    n.observeServerMessage(gameOver("s1"));
    n.observeServerMessage(gameStart("s2"));
    expect(success("s2")!.level).toBe("warning"); // fresh match warns again
  });

  it("notes a self-healed (auto-raised max tokens) decision", () => {
    const n = new MatchNarrator();
    const line = n.observeTrace({
      type: "runtime_success",
      matchId: "s1",
      attempt: 1,
      raw: { kind: "text", sha256: "x", bytes: 1, preview: "p" },
      selfHealed: { from: 4096, to: 8192 },
    } as BridgeDecisionTrace);
    expect(line).toEqual({ level: "info", message: "auto-raised max tokens 4096→8192 to finish this decision" });
  });

  it("stays silent on a clean success, a decision_request, and game_over", () => {
    const n = new MatchNarrator();
    n.observeServerMessage(gameStart("s1"));
    expect(n.observeTrace(decisionRequest("s1"))).toBeNull();
    expect(
      n.observeTrace({
        type: "runtime_success",
        matchId: "s1",
        attempt: 1,
        raw: { kind: "text", sha256: "x", bytes: 1, preview: "p" },
      } as BridgeDecisionTrace),
    ).toBeNull();
    expect(n.observeServerMessage(gameOver("s1"))).toBeNull();
  });

  it("numbers decisions per match, restarting on a new game_start", () => {
    const n = new MatchNarrator();
    n.observeServerMessage(gameStart("s1"));
    n.observeTrace(decisionRequest("s1"));
    expect(n.observeTrace(finalAction("s1", { type: "income" }))!.message).toContain("Decision #1");
    n.observeServerMessage(gameOver("s1"));
    n.observeServerMessage(gameStart("s2"));
    n.observeTrace(decisionRequest("s2"));
    expect(n.observeTrace(finalAction("s2", { type: "tax" }))!.message).toContain("Decision #1");
  });

  it("keeps at most a handful of matches tracked (service-mode memory bound)", () => {
    const n = new MatchNarrator();
    for (let i = 0; i < 30; i++) n.observeServerMessage(gameStart(`s${i}`));
    // No assertion on internals — the contract is simply that this never threw
    // and the newest match still narrates correctly.
    n.observeTrace(decisionRequest("s29"));
    expect(n.observeTrace(finalAction("s29", { type: "income" }))!.message).toContain("Decision #1");
  });
});

describe("displayGameName", () => {
  it("maps the three live games and falls back generically", () => {
    expect(displayGameName("texas_holdem")).toBe("Texas Hold'em");
    expect(displayGameName("liars_dice")).toBe("Liar's Dice");
    expect(displayGameName("coup")).toBe("Coup");
    expect(displayGameName("something_else")).toBe("AIFight match");
    expect(displayGameName(undefined)).toBe("AIFight match");
  });
});
