// Liar's Dice state-formatter — emits human-readable stateBlock +
// recentEventsBlock for prompt-builder (M1-12 拍板点 #3:每游戏单一函数 +
// {stateBlock, recentEventsBlock} 双 block 输出).
//
// Internal-only — not re-exported from runtime/src/index.ts.
//
// Same shape contract as Texas Hold'em formatter:
// - publicState typed as LiarsDiceState (caller M1-14 narrows from
//   DecisionRequest.publicState: unknown);runtime fields may be missing,
//   each access is defensive.
// - players are anonymized by server;formatter strictly reads
//   id / name / status — never agent_id / real agent_name.
// - player.data is opaque object — `dice_count` read via
//   `readNumberField` shape guard (TED Risks #16).

import type {
  Event,
  LiarsDiceRules,
  LiarsDiceState,
  PlayerInfo,
} from "../../protocol/types";
import { readNumberField } from "../_shared/player-info";

export interface LiarsDiceFormatterInput {
  readonly publicState: LiarsDiceState;
  readonly privateState?: unknown;
  readonly rules: LiarsDiceRules;
  readonly players: readonly PlayerInfo[];
  readonly recentEvents: readonly Event[];
  readonly yourPlayerId: string;
}

export interface StateFormatterOutput {
  readonly stateBlock: string;
  readonly recentEventsBlock: string;
}

const NO_EVENTS_PLACEHOLDER = "(no events since your last turn)";

export function formatLiarsDiceState(
  input: LiarsDiceFormatterInput,
): StateFormatterOutput {
  return {
    stateBlock: buildStateBlock(input),
    recentEventsBlock: buildEventsBlock(input),
  };
}

// ─── stateBlock ─────────────────────────────────────────────────────

function buildStateBlock(input: LiarsDiceFormatterInput): string {
  const { publicState: s, players, yourPlayerId } = input;
  const lines: string[] = [];

  const phase = typeof s.phase === "string" ? s.phase : "(unknown)";
  if (typeof s.round === "number") {
    lines.push(`Round ${s.round} | Phase: ${phase}`);
  } else {
    lines.push(`Phase: ${phase}`);
  }

  if (typeof s.total_dice === "number") {
    lines.push(`Total dice in play: ${s.total_dice}`);
  }

  if (Array.isArray(s.your_dice)) {
    const faces = s.your_dice.filter((f): f is number => typeof f === "number");
    const count =
      typeof s.your_dice_count === "number" ? s.your_dice_count : faces.length;
    lines.push(`Your dice: [${faces.join(" ")}] (count: ${count})`);
  } else if (typeof s.your_dice_count === "number") {
    lines.push(`Your dice: (eliminated or not visible) (count: ${s.your_dice_count})`);
  }

  const bid = s.current_bid;
  if (bid && typeof bid === "object") {
    const q = typeof bid.quantity === "number" ? bid.quantity : undefined;
    const f = typeof bid.face === "number" ? bid.face : undefined;
    const bidder = typeof bid.bidder === "string" ? bid.bidder : undefined;
    if (q !== undefined && f !== undefined && bidder !== undefined) {
      const bidderLabel = formatPlayerLabel(bidder, players, yourPlayerId);
      lines.push(`Current bid: quantity=${q} face=${f} by ${bidderLabel}`);
    } else {
      lines.push(`Current bid: (incomplete bid data)`);
    }
  } else {
    lines.push(`Current bid: (none — you may bid any opening bid)`);
  }

  if (typeof s.current_turn === "string" && s.current_turn.length > 0) {
    lines.push(`Current turn: ${formatPlayerLabel(s.current_turn, players, yourPlayerId)}`);
  }

  const opponents = players.filter((p) => p.id !== yourPlayerId);
  if (opponents.length > 0) {
    lines.push(`Opponents:`);
    for (const p of opponents) {
      lines.push(`  ${formatOpponentLine(p)}`);
    }
  }

  return lines.join("\n");
}

function formatOpponentLine(p: PlayerInfo): string {
  const display = p.name ?? `Player ${p.id}`;
  let line = `${display} (${p.id}): status=${p.status}`;
  const diceCount = readNumberField(p.data, "dice_count");
  if (diceCount !== undefined) line += ` | dice_count=${diceCount}`;
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

function buildEventsBlock(input: LiarsDiceFormatterInput): string {
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
    case "bid": {
      const quantity = typeof data.quantity === "number" ? data.quantity : undefined;
      const face = typeof data.face === "number" ? data.face : undefined;
      if (quantity !== undefined && face !== undefined) {
        return `${actorLabel} bid: quantity ${quantity} face ${face}`;
      }
      return `${actorLabel} bid: (incomplete data)`;
    }
    case "challenge": {
      const challenger = typeof data.challenger === "string" ? data.challenger : undefined;
      const bidder = typeof data.bidder === "string" ? data.bidder : undefined;
      const bidQ = typeof data.bid_quantity === "number" ? data.bid_quantity : undefined;
      const bidF = typeof data.bid_face === "number" ? data.bid_face : undefined;
      const actual = typeof data.actual_count === "number" ? data.actual_count : undefined;
      const met = typeof data.bid_met === "boolean" ? data.bid_met : undefined;
      const loser = typeof data.loser === "string" ? data.loser : undefined;
      const allDice = data.all_dice;
      const challengerLabel = challenger
        ? formatPlayerLabel(challenger, players, yourPlayerId)
        : actorLabel;
      const bidderLabel = bidder ? formatPlayerLabel(bidder, players, yourPlayerId) : "(unknown)";
      const loserLabel = loser ? formatPlayerLabel(loser, players, yourPlayerId) : "(unknown)";
      const bidStr =
        bidQ !== undefined && bidF !== undefined ? `${bidQ} ${bidF}s` : "the bid";
      const actualStr = actual !== undefined ? `Actual count: ${actual}` : "";
      const metStr = met !== undefined ? `bid_met=${met}` : "";
      const lossStr = `${loserLabel} loses 1 die`;
      let line = `${challengerLabel} challenged ${bidderLabel}'s bid (${bidStr}).`;
      const tail = [actualStr, metStr, lossStr].filter((s) => s.length > 0).join(" → ");
      if (tail.length > 0) line += ` ${tail}.`;
      if (allDice && typeof allDice === "object" && !Array.isArray(allDice)) {
        const reveal = Object.entries(allDice as Record<string, unknown>)
          .map(([pid, faces]) => {
            if (!Array.isArray(faces)) return null;
            const numbers = faces.filter((n): n is number => typeof n === "number");
            return `${pid}=[${numbers.join(",")}]`;
          })
          .filter((s): s is string => s !== null)
          .join(", ");
        if (reveal.length > 0) line += ` Revealed dice: ${reveal}`;
      }
      return line;
    }
    case "player_eliminated": {
      return `${actorLabel} eliminated`;
    }
    case "round_start": {
      const round = typeof data.round === "number" ? data.round : undefined;
      const counts = data.dice_counts;
      const roundPart = round !== undefined ? `Round ${round} began` : `New round began`;
      let line = `${roundPart}.`;
      if (counts && typeof counts === "object" && !Array.isArray(counts)) {
        const parts = Object.entries(counts as Record<string, unknown>)
          .map(([pid, n]) => (typeof n === "number" ? `${pid}=${n}` : null))
          .filter((s): s is string => s !== null)
          .join(", ");
        if (parts.length > 0) line += ` Dice counts: ${parts}`;
      }
      return line;
    }
    case "game_over": {
      const winner = typeof data.winner === "string" ? data.winner : "";
      const winnerLabel =
        winner.length > 0
          ? formatPlayerLabel(winner, players, yourPlayerId)
          : "(no single winner)";
      return `Game over. Winner: ${winnerLabel}`;
    }
    case "player_disconnected": {
      return `${actorLabel} disconnected`;
    }
    default:
      return `(unhandled event: ${event.type})`;
  }
}
