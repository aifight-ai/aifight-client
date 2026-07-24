// Texas Hold'em state-formatter — emits human-readable stateBlock +
// recentEventsBlock for prompt-builder (M1-12 拍板点 #3:每游戏单一函数 +
// {stateBlock, recentEventsBlock} 双 block 输出).
//
// Internal-only — not re-exported from runtime/src/index.ts.
//
// Shape contract:
// - `input.publicState` is typed as TexasHoldemState (caller M1-14
//   narrows from DecisionRequest.publicState: unknown);runtime fields
//   may still be missing, so each access is defensive (TED Risks
//   "缺关键字段不抛").
// - `input.players` is anonymized by server (player.name = "Player N");
//   formatter NEVER emits agent_id / real agent_name — it strictly reads
//   id / name / status (拍板点 #10).
// - `player.data` is opaque object — game-specific fields read via
//   `readNumberField` / `readStringArrayField` from `_shared/player-info`
//   (TED rev3 Risks #16).

import type {
  Event,
  PlayerInfo,
  TexasHoldemRules,
  TexasHoldemState,
} from "../../protocol/types";
import { readNumberField } from "../_shared/player-info";

export interface TexasHoldemFormatterInput {
  readonly publicState: TexasHoldemState;
  readonly privateState?: unknown;
  readonly rules: TexasHoldemRules;
  readonly players: readonly PlayerInfo[];
  readonly recentEvents: readonly Event[];
  readonly yourPlayerId: string;
}

export interface StateFormatterOutput {
  readonly stateBlock: string;
  readonly recentEventsBlock: string;
}

const NO_EVENTS_PLACEHOLDER = "(no events since your last turn)";

export function formatTexasHoldemState(
  input: TexasHoldemFormatterInput,
): StateFormatterOutput {
  return {
    stateBlock: buildStateBlock(input),
    recentEventsBlock: buildEventsBlock(input),
  };
}

// ─── stateBlock ─────────────────────────────────────────────────────

function buildStateBlock(input: TexasHoldemFormatterInput): string {
  const { publicState: s, players, yourPlayerId } = input;
  const lines: string[] = [];

  const phase = typeof s.phase === "string" ? s.phase : "(unknown)";
  if (typeof s.hand_num === "number" && typeof s.max_hands === "number") {
    lines.push(`Hand ${s.hand_num} of ${s.max_hands} | Phase: ${phase}`);
  } else {
    lines.push(`Phase: ${phase}`);
  }

  if (typeof s.small_blind === "number" && typeof s.big_blind === "number") {
    lines.push(`Blinds: ${s.small_blind}/${s.big_blind}`);
  }

  if (Array.isArray(s.your_hand) && s.your_hand.length === 2) {
    const [c1, c2] = s.your_hand;
    if (typeof c1 === "string" && typeof c2 === "string") {
      lines.push(`Your hand: ${c1} ${c2}`);
    }
  }

  if (Array.isArray(s.community_cards) && s.community_cards.length > 0) {
    const cards = s.community_cards.filter((c): c is string => typeof c === "string");
    lines.push(`Board: ${cards.join(" ")}`);
  } else {
    lines.push(`Board: (no community cards yet)`);
  }

  if (typeof s.your_position === "string" && s.your_position.length > 0) {
    lines.push(`Your position: ${s.your_position}`);
  }

  if (typeof s.your_chips === "number" && typeof s.your_bet === "number") {
    lines.push(`Your chips: ${s.your_chips} | Your current bet: ${s.your_bet}`);
  } else if (typeof s.your_chips === "number") {
    lines.push(`Your chips: ${s.your_chips}`);
  }

  const pot = typeof s.pot === "number" ? s.pot : undefined;
  const currentBet = typeof s.current_bet === "number" ? s.current_bet : undefined;
  if (pot !== undefined && currentBet !== undefined) {
    let line = `Pot: ${pot} | Current bet to match: ${currentBet}`;
    if (typeof s.your_bet === "number" && currentBet > s.your_bet) {
      line += ` | Need to call: ${currentBet - s.your_bet}`;
    }
    lines.push(line);
  }

  if (Array.isArray(s.action_order) && s.action_order.length > 0) {
    const order = s.action_order
      .filter((id): id is string => typeof id === "string")
      .map((id) => formatPlayerLabel(id, players, yourPlayerId))
      .join(" → ");
    if (order.length > 0) lines.push(`Action order: ${order}`);
  }

  const opponents = players.filter((p) => p.id !== yourPlayerId);
  if (opponents.length > 0) {
    lines.push(`Opponents:`);
    for (const p of opponents) {
      lines.push(`  ${formatOpponentLine(p)}`);
    }
  }

  // Cash-format running results across completed hands — the aggregate the match
  // is scored on (cumulative net + bb/100). Stacks reset each hand, so this
  // cross-hand net matters more than the current-hand chip count.
  if (s.format === "cash" && Array.isArray(s.players)) {
    const handsDone = typeof s.hands_completed === "number" ? s.hands_completed : 0;
    const maxHands = typeof s.max_hands === "number" ? s.max_hands : 0;
    const bb = typeof s.big_blind === "number" && s.big_blind > 0 ? s.big_blind : 1;
    const sign = (n: number, dp = 0): string => `${n >= 0 ? "+" : ""}${n.toFixed(dp)}`;
    lines.push(
      `Running results (through ${handsDone} of ${maxHands} hands) — cumulative net, scored as bb/100:`,
    );
    for (const p of s.players) {
      const id = typeof p?.id === "string" ? p.id : "?";
      const net = typeof p?.net === "number" ? p.net : 0;
      const label = id === yourPlayerId ? `${id} (you)` : id;
      const netBB = net / bb;
      const bb100 = handsDone > 0 ? (netBB / handsDone) * 100 : 0;
      lines.push(`  ${label}: net ${sign(net)} (${sign(netBB, 1)} BB, ${sign(bb100, 0)} bb/100)`);
    }
  } else if (s.format !== "cash") {
    // Tournament format (production default; the state carries no format key):
    // restate the match clock, the blind schedule, and the win condition next
    // to the live stacks — pure rules + state, no strategy. Mirrors the
    // server-side house-bot formatter (internal/llmbot/pool.go) line for line,
    // so personal agents and house bots receive the same information.
    // Remaining hands derive from hand_num — the same field the "Hand N of M"
    // header uses — so the two lines can never disagree.
    const handNum = typeof s.hand_num === "number" ? s.hand_num : 0;
    const maxHands = typeof s.max_hands === "number" ? s.max_hands : 0;
    const sb = typeof s.small_blind === "number" ? s.small_blind : 0;
    const bb = typeof s.big_blind === "number" ? s.big_blind : 0;
    if (handNum > 0 && maxHands > 0) {
      const remaining = Math.max(0, maxHands - handNum + 1);
      lines.push(
        `Hands left including this one: ${remaining} (the match also ends early if only one player still has chips).`,
      );
      if (maxHands >= 6 && sb > 0 && bb > 0) {
        if (handNum < 6) {
          lines.push(`Blinds double to ${sb * 2}/${bb * 2} at hand 6.`);
        } else {
          lines.push(`Blinds doubled at hand 6; the current level is ${sb}/${bb}.`);
        }
      }
      lines.push(
        `The match winner is the single player holding the most chips when the match ends; a tie for the most chips is a draw.`,
      );
    }
  }

  return lines.join("\n");
}

function formatOpponentLine(p: PlayerInfo): string {
  const display = p.name ?? `Player ${p.id}`;
  let line = `${display} (${p.id}): status=${p.status}`;
  const chips = readNumberField(p.data, "chips");
  if (chips !== undefined) line += ` | chips=${chips}`;
  const bet = readNumberField(p.data, "bet");
  if (bet !== undefined) line += ` | bet=${bet}`;
  return line;
}

function formatPlayerLabel(
  id: string,
  players: readonly PlayerInfo[],
  yourPlayerId: string,
): string {
  if (id === yourPlayerId) return `you (${id})`;
  const player = players.find((p) => p.id === id);
  const display = player?.name ?? `Player ${id}`;
  return `${display} (${id})`;
}

// ─── recentEventsBlock ──────────────────────────────────────────────

function buildEventsBlock(input: TexasHoldemFormatterInput): string {
  const { recentEvents, players, yourPlayerId } = input;
  if (recentEvents.length === 0) return NO_EVENTS_PLACEHOLDER;
  return recentEvents
    .map((event) => formatEvent(event, players, yourPlayerId))
    .join("\n");
}

function formatEvent(
  event: Event,
  players: readonly PlayerInfo[],
  yourPlayerId: string,
): string {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const actor = typeof event.player === "string" ? event.player : undefined;
  const actorLabel = actor ? formatPlayerLabel(actor, players, yourPlayerId) : "(unknown)";

  switch (event.type) {
    case "new_hand": {
      const handNum = typeof data.hand_num === "number" ? data.hand_num : undefined;
      const dealer = typeof data.dealer === "string" ? data.dealer : undefined;
      const dealerLabel = dealer
        ? formatPlayerLabel(dealer, players, yourPlayerId)
        : "(unknown)";
      const sb = typeof data.small_blind === "number" ? data.small_blind : undefined;
      const bb = typeof data.big_blind === "number" ? data.big_blind : undefined;
      const handPart = handNum !== undefined ? `Hand ${handNum} began` : `New hand began`;
      const blindsPart =
        sb !== undefined && bb !== undefined ? ` | blinds: ${sb}/${bb}` : "";
      return `${handPart} | dealer: ${dealerLabel}${blindsPart}`;
    }
    case "player_action": {
      const action = typeof data.action === "string" ? data.action : "(unknown action)";
      const amount = typeof data.amount === "number" ? data.amount : undefined;
      const totalBet = typeof data.total_bet === "number" ? data.total_bet : undefined;
      let line = `${actorLabel} ${action}`;
      if (amount !== undefined) line += ` ${amount}`;
      if (totalBet !== undefined) line += ` (total bet ${totalBet})`;
      return line;
    }
    case "community_cards": {
      const cards = Array.isArray(data.cards)
        ? data.cards.filter((c): c is string => typeof c === "string")
        : [];
      const subPhase = typeof data.phase === "string" ? data.phase : undefined;
      const phaseLabel = subPhase
        ? subPhase.charAt(0).toUpperCase() + subPhase.slice(1)
        : "Community cards";
      return `${phaseLabel}: ${cards.join(" ")}`;
    }
    case "cards_dealt": {
      // server filters: this event only reaches the player whose cards
      // were dealt; defensively check actor === yourPlayerId
      if (actor !== yourPlayerId) return `${actorLabel} was dealt cards`;
      const cards = Array.isArray(data.cards)
        ? data.cards.filter((c): c is string => typeof c === "string")
        : [];
      return `You were dealt: ${cards.join(" ")}`;
    }
    case "hand_result": {
      const winnersArr = Array.isArray(data.winners)
        ? data.winners.filter((w): w is string => typeof w === "string")
        : [];
      const winners =
        winnersArr.length > 0
          ? winnersArr.map((w) => formatPlayerLabel(w, players, yourPlayerId)).join(", ")
          : "(unknown)";
      const pot = typeof data.pot === "number" ? data.pot : undefined;
      const reason = typeof data.reason === "string" ? data.reason : undefined;
      let line = `Hand winners: ${winners}`;
      if (pot !== undefined) line += ` | pot ${pot}`;
      if (reason) line += ` (${reason})`;
      return line;
    }
    case "match_result": {
      const winner = typeof data.winner === "string" ? data.winner : "";
      const winnerLabel =
        winner.length > 0
          ? formatPlayerLabel(winner, players, yourPlayerId)
          : "(no single winner)";
      return `Match over. Winner: ${winnerLabel}`;
    }
    case "player_disconnected": {
      const reason = typeof data.reason === "string" ? data.reason : "(no reason)";
      return `${actorLabel} disconnected — reason: ${reason}`;
    }
    default:
      return `(unhandled event: ${event.type})`;
  }
}

/**
 * Package-internal export of the single-event narrator, so the shipped
 * direct-LLM bridge path can render texas match history as sentences (owner
 * 拍板 2026-07-22: 个人 Agent 与平台自营 bot 的信息呈现拉平). Not re-exported
 * from runtime/src/index.ts.
 */
export function formatTexasHoldemEventLine(
  event: Event,
  players: readonly PlayerInfo[],
  yourPlayerId: string,
): string {
  return formatEvent(event, players, yourPlayerId);
}
