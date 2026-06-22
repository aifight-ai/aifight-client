// Coup state-formatter — emits human-readable stateBlock +
// recentEventsBlock for prompt-builder (M1-12 拍板点 #3:每游戏单一函数 +
// {stateBlock, recentEventsBlock} 双 block 输出).
//
// Internal-only — not re-exported from runtime/src/index.ts.
//
// Same shape contract as Texas Hold'em / Liar's Dice formatters:
// - publicState typed as CoupState (caller M1-14 narrows from
//   DecisionRequest.publicState: unknown);runtime fields may be missing,
//   each access is defensive.
// - players are anonymized by server;formatter strictly reads
//   id / name / status — never agent_id / real agent_name.
// - player.data is opaque object — `coins` / `hidden_cards` /
//   `revealed` read via shape-guard helpers from `_shared/player-info`
//   (TED Risks #16).
//
// Coup has 17 logical event types (action / challenge_pass / challenge /
// challenge_result / block_pass / block / block_challenge_pass /
// block_accepted / challenge_block / challenge_block_result /
// influence_lost / player_eliminated / exchange_draw / exchange_complete /
// action_resolved / game_over / player_disconnected) — 13 distinct data
// shapes per protocol/types.ts (some types share `{ player: string }`).

import type {
  CoupRules,
  CoupState,
  Event,
  PlayerInfo,
} from "../../protocol/types";
import { readNumberField, readStringArrayField } from "../_shared/player-info";

export interface CoupFormatterInput {
  readonly publicState: CoupState;
  readonly privateState?: unknown;
  readonly rules: CoupRules;
  readonly players: readonly PlayerInfo[];
  readonly recentEvents: readonly Event[];
  readonly yourPlayerId: string;
}

export interface StateFormatterOutput {
  readonly stateBlock: string;
  readonly recentEventsBlock: string;
}

const NO_EVENTS_PLACEHOLDER = "(no events since your last turn)";

export function formatCoupState(input: CoupFormatterInput): StateFormatterOutput {
  return {
    stateBlock: buildStateBlock(input),
    recentEventsBlock: buildEventsBlock(input),
  };
}

// ─── stateBlock ─────────────────────────────────────────────────────

function buildStateBlock(input: CoupFormatterInput): string {
  const { publicState: s, players, yourPlayerId } = input;
  const lines: string[] = [];

  const phase = typeof s.phase === "string" ? s.phase : "(unknown)";
  lines.push(`Phase: ${phase}`);

  if (typeof s.current_turn === "string" && s.current_turn.length > 0) {
    lines.push(
      `Current turn (actor): ${formatPlayerLabel(s.current_turn, players, yourPlayerId)}`,
    );
  }

  if (typeof s.pending_action === "string" && s.pending_action.length > 0) {
    let line = `Pending action: ${s.pending_action}`;
    if (typeof s.pending_target === "string" && s.pending_target.length > 0) {
      line += ` | target: ${formatPlayerLabel(s.pending_target, players, yourPlayerId)}`;
    }
    if (typeof s.claimed_role === "string" && s.claimed_role.length > 0) {
      line += ` | claimed_role: ${s.claimed_role}`;
    }
    lines.push(line);
  }

  if (typeof s.blocker === "string" && s.blocker.length > 0) {
    let line = `Blocker: ${formatPlayerLabel(s.blocker, players, yourPlayerId)}`;
    if (typeof s.block_role === "string" && s.block_role.length > 0) {
      line += ` claiming role ${s.block_role}`;
    }
    lines.push(line);
  }

  if (typeof s.influence_loser === "string" && s.influence_loser.length > 0) {
    lines.push(
      `Influence loser: ${formatPlayerLabel(s.influence_loser, players, yourPlayerId)}`,
    );
  }

  if (Array.isArray(s.your_cards)) {
    // Tuple/array of role literal-union; elements already strings by type
    lines.push(`Your unrevealed cards: [${s.your_cards.join(", ")}]`);
  }

  if (Array.isArray(s.your_revealed)) {
    lines.push(`Your revealed cards: [${s.your_revealed.join(", ")}]`);
  }

  if (typeof s.coins === "number") {
    lines.push(`Your coins: ${s.coins}`);
  }

  if (s.phase === "exchange_return" && Array.isArray(s.all_exchange_options)) {
    const opts = s.all_exchange_options
      .map((c, i) => `${i}=${c}`)
      .join(", ");
    if (opts.length > 0) {
      lines.push(`Exchange options (indexed): ${opts}`);
    }
  }

  const turnLog = s.turn_log;
  if (turnLog && typeof turnLog === "object" && !Array.isArray(turnLog)) {
    const entries: string[] = [];
    const tl = turnLog as Record<string, unknown>;
    if (typeof tl.action === "string") entries.push(`action=${tl.action}`);
    if (typeof tl.actor === "string") {
      entries.push(`actor=${formatPlayerLabel(tl.actor, players, yourPlayerId)}`);
    }
    if (typeof tl.target === "string") {
      entries.push(`target=${formatPlayerLabel(tl.target, players, yourPlayerId)}`);
    }
    if (typeof tl.claimed_role === "string") entries.push(`claimed_role=${tl.claimed_role}`);
    if (typeof tl.challenger === "string") {
      entries.push(`challenger=${formatPlayerLabel(tl.challenger, players, yourPlayerId)}`);
    }
    if (typeof tl.challenge_result === "string") {
      entries.push(`challenge_result=${tl.challenge_result}`);
    }
    if (typeof tl.blocker === "string") {
      entries.push(`blocker=${formatPlayerLabel(tl.blocker, players, yourPlayerId)}`);
    }
    if (typeof tl.block_role === "string") entries.push(`block_role=${tl.block_role}`);
    if (typeof tl.block_challenger === "string") {
      entries.push(
        `block_challenger=${formatPlayerLabel(tl.block_challenger, players, yourPlayerId)}`,
      );
    }
    if (typeof tl.block_challenge_result === "string") {
      entries.push(`block_challenge_result=${tl.block_challenge_result}`);
    }
    if (entries.length > 0) lines.push(`Turn log: ${entries.join(" | ")}`);
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
  const coins = readNumberField(p.data, "coins");
  if (coins !== undefined) line += ` | coins=${coins}`;
  const hidden = readNumberField(p.data, "hidden_cards");
  if (hidden !== undefined) line += ` | hidden_cards=${hidden}`;
  const revealed = readStringArrayField(p.data, "revealed");
  if (revealed !== undefined) line += ` | revealed=[${revealed.join(", ")}]`;
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

function buildEventsBlock(input: CoupFormatterInput): string {
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
  const label = (id: string) => formatPlayerLabel(id, players, yourPlayerId);

  switch (event.type) {
    case "action": {
      const action = typeof data.action === "string" ? data.action : "(unknown)";
      const target = typeof data.target === "string" ? data.target : undefined;
      const role = typeof data.claimed_role === "string" ? data.claimed_role : undefined;
      let line = `${actorLabel} attempts: ${action}`;
      if (target) line += ` (target: ${label(target)})`;
      if (role) line += ` (claims ${role})`;
      return line;
    }
    case "challenge_pass": {
      const player = typeof data.player === "string" ? data.player : actor;
      const passLabel = player ? label(player) : actorLabel;
      return `${passLabel} passed (no challenge)`;
    }
    case "challenge": {
      const challenger = typeof data.challenger === "string" ? data.challenger : actor;
      const challengedActor = typeof data.actor === "string" ? data.actor : undefined;
      const role = typeof data.claimed_role === "string" ? data.claimed_role : undefined;
      const challengerLabel = challenger ? label(challenger) : actorLabel;
      const targetLabel = challengedActor ? label(challengedActor) : "(unknown)";
      let line = `${challengerLabel} challenged ${targetLabel}'s claim`;
      if (role) line += ` of ${role}`;
      return line;
    }
    case "challenge_result": {
      const result = typeof data.result === "string" ? data.result : "(unknown)";
      const challengedActor = typeof data.actor === "string" ? data.actor : undefined;
      const challenger = typeof data.challenger === "string" ? data.challenger : undefined;
      const revealed = typeof data.revealed_card === "string" ? data.revealed_card : undefined;
      const interpretation =
        result === "success"
          ? `${challengedActor ? label(challengedActor) : "actor"} was lying, loses influence`
          : result === "fail"
            ? `${challenger ? label(challenger) : "challenger"} was wrong, loses influence`
            : "(unknown outcome)";
      let line = `Challenge result: ${result} — ${interpretation}`;
      if (revealed) line += ` (revealed card: ${revealed})`;
      return line;
    }
    case "block_pass": {
      const player = typeof data.player === "string" ? data.player : actor;
      const passLabel = player ? label(player) : actorLabel;
      return `${passLabel} passed (no block)`;
    }
    case "block": {
      const blocker = typeof data.blocker === "string" ? data.blocker : actor;
      const role = typeof data.claimed_role === "string" ? data.claimed_role : undefined;
      const action = typeof data.action === "string" ? data.action : undefined;
      const blockerLabel = blocker ? label(blocker) : actorLabel;
      let line = `${blockerLabel} blocks`;
      if (action) line += ` ${action}`;
      if (role) line += ` claiming ${role}`;
      return line;
    }
    case "block_challenge_pass": {
      const player = typeof data.player === "string" ? data.player : actor;
      const passLabel = player ? label(player) : actorLabel;
      return `${passLabel} passed (no challenge to block)`;
    }
    case "block_accepted": {
      const blocker = typeof data.blocker === "string" ? data.blocker : undefined;
      if (blocker) return `Block accepted (blocker: ${label(blocker)})`;
      return `Block accepted`;
    }
    case "challenge_block": {
      const challenger = typeof data.challenger === "string" ? data.challenger : actor;
      const blocker = typeof data.blocker === "string" ? data.blocker : undefined;
      const role = typeof data.claimed_role === "string" ? data.claimed_role : undefined;
      const challengerLabel = challenger ? label(challenger) : actorLabel;
      const blockerLabel = blocker ? label(blocker) : "(unknown)";
      let line = `${challengerLabel} challenged ${blockerLabel}'s block`;
      if (role) line += ` (claimed ${role})`;
      return line;
    }
    case "challenge_block_result": {
      const result = typeof data.result === "string" ? data.result : "(unknown)";
      const blocker = typeof data.blocker === "string" ? data.blocker : undefined;
      const challenger = typeof data.challenger === "string" ? data.challenger : undefined;
      const revealed = typeof data.revealed_card === "string" ? data.revealed_card : undefined;
      const interpretation =
        result === "success"
          ? `${blocker ? label(blocker) : "blocker"} was lying, loses influence`
          : result === "fail"
            ? `${challenger ? label(challenger) : "challenger"} was wrong, loses influence`
            : "(unknown outcome)";
      let line = `Block challenge result: ${result} — ${interpretation}`;
      if (revealed) line += ` (revealed card: ${revealed})`;
      return line;
    }
    case "influence_lost": {
      const player = typeof data.player === "string" ? data.player : actor;
      const card = typeof data.card === "string" ? data.card : undefined;
      const playerLabel = player ? label(player) : actorLabel;
      let line = `${playerLabel} revealed`;
      if (card) line += ` ${card}`;
      line += ` (lost influence)`;
      return line;
    }
    case "player_eliminated": {
      const player = typeof data.player === "string" ? data.player : actor;
      const elimLabel = player ? label(player) : actorLabel;
      return `${elimLabel} eliminated`;
    }
    case "exchange_draw": {
      const drawn = typeof data.drawn_count === "number" ? data.drawn_count : undefined;
      let line = `${actorLabel} drew exchange cards`;
      if (drawn !== undefined) line += ` (count: ${drawn})`;
      return line;
    }
    case "exchange_complete": {
      const player = typeof data.player === "string" ? data.player : actor;
      const returned = typeof data.returned_count === "number" ? data.returned_count : undefined;
      const playerLabel = player ? label(player) : actorLabel;
      let line = `${playerLabel} completed exchange`;
      if (returned !== undefined) line += ` (returned: ${returned})`;
      return line;
    }
    case "action_resolved": {
      const action = typeof data.action === "string" ? data.action : "(unknown)";
      const coinsNow = typeof data.coins_now === "number" ? data.coins_now : undefined;
      const target = typeof data.target === "string" ? data.target : undefined;
      const stolen = typeof data.stolen === "number" ? data.stolen : undefined;
      let line = `${actorLabel} resolved: ${action}`;
      if (target) line += ` (target: ${label(target)})`;
      if (stolen !== undefined) line += ` | stolen=${stolen}`;
      if (coinsNow !== undefined) line += ` | coins_now=${coinsNow}`;
      return line;
    }
    case "game_over": {
      const winner = typeof data.winner === "string" ? data.winner : "";
      const winnerLabel = winner.length > 0 ? label(winner) : "(no surviving player)";
      return `Game over. Winner: ${winnerLabel}`;
    }
    case "player_disconnected": {
      const player = typeof data.player === "string" ? data.player : actor;
      const discLabel = player ? label(player) : actorLabel;
      return `${discLabel} disconnected`;
    }
    default:
      return `(unhandled event: ${event.type})`;
  }
}
