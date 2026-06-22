# protocol/schema/games/liars_dice

Game-specific schemas for Liar's Dice. Source of truth:
[`games/liarsdice/liarsdice.go`](../../../../games/liarsdice/liarsdice.go).

## Files

| Schema | Mirrors | Used at |
|--------|---------|---------|
| [`rules.schema.json`](./rules.schema.json) | `Game.Rules()` L56 | `server_game_start.data.rules` |
| [`state.schema.json`](./state.schema.json) | `GetPlayerView()` L372 → `PlayerView.GameData` | `server_action_request.data.state`, `server_game_state.data.state` |
| [`action.schema.json`](./action.schema.json) | `GetLegalActions()` L121 + `ValidateAction()` L175 | `client_action.data`, `server_action_request.data.legal_actions[*]` |
| [`event.schema.json`](./event.schema.json) | All `events = append(..., Event{Type: ...})` emission sites | `server_action_request.data.new_events[*]`, `common/event.schema.json` `data` field when outer type is a Liar's Dice event |

No `config.schema.json`: `NewState()` ignores the `GameConfig` — dice count
(5 per player) and face range (1-6) are fixed by the Go implementation.
`server_game_start.data.config` for liars_dice is effectively an empty
object.

## Action enum

2 actions: `bid`, `challenge`. Legality:

- `challenge` — only legal when `current_bid` is set
- `bid` — always legal; must strictly beat `current_bid` (same quantity +
  higher face, or higher quantity); quantity capped at `total_dice`

## Event types

6 event types:

- `bid` — a player places a bid
- `challenge` — a player calls 'Liar!'; reveals all alive players' dice
- `player_eliminated` — a player loses their last die
- `round_start` — new round starts after challenge (dice re-rolled) or
  after a drop-induced reset; emitted only for round >= 2
- `game_over` — exactly one (or zero) alive players remain
- `player_disconnected` — timeout/disconnect removal

## Anonymization reminder

- `your_dice` and `your_dice_count` are **private**: only sent to the
  owning recipient.
- The `all_dice` field in a `challenge` event **publicly reveals** all
  alive players' dice — this is core to the game mechanic.
- Public state includes: phase, round, current_bid (quantity/face/bidder),
  current_turn, total_dice.

## Scope notes

- `common/action.schema.json` is the generic envelope; `action.schema.json`
  here uses `oneOf` to narrow.
- `common/event.schema.json` provides the outer envelope (`type`, `player?`,
  `seq`, `ts`); the `data` field's narrowing per Liar's Dice event type is
  what `event.schema.json` here describes.
- Ones-are-wild rule is a server-side resolution concern; the `face == 1`
  exception (no wilds on bids-of-ones) is noted in schema descriptions but
  not encoded as a validation rule (bid validity is purely quantity/face
  monotonicity at the protocol layer).
