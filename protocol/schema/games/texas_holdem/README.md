# protocol/schema/games/texas_holdem

Game-specific schemas for No-Limit Texas Hold'em. Source of truth:
[`games/texasholdem/texasholdem.go`](../../../../games/texasholdem/texasholdem.go).

## Files

| Schema | Mirrors | Used at |
|--------|---------|---------|
| [`rules.schema.json`](./rules.schema.json) | `Game.Rules()` L91 | `server_game_start.data.rules` |
| [`config.schema.json`](./config.schema.json) | `NewState()` config params L128 | `server_game_start.data.config` |
| [`state.schema.json`](./state.schema.json) | `GetPlayerView()` L1157 → `PlayerView.GameData` | `server_action_request.data.state`, `server_game_state.data.state` |
| [`action.schema.json`](./action.schema.json) | `GetLegalActions()` L299 + `ValidateAction()` L356 | `client_action.data`, `server_action_request.data.legal_actions[*]` |
| [`event.schema.json`](./event.schema.json) | All `events = append(..., Event{Type: ...})` emission sites | `server_action_request.data.new_events[*]`, `common/event.schema.json` `data` field when outer type is Texas event |

## Action enum

5 actions: `fold`, `check`, `call`, `raise`, `allin`. Legality depends on
the betting state; `GetLegalActions()` is authoritative. Summary:

- `fold`: only when `toCall > 0`
- `check`: only when `toCall == 0`
- `call`: when `toCall > 0` and you have chips
- `raise`: when you have chips > toCall AND no short-all-in bet this round
- `allin`: always legal when you have chips

## Event types

7 event types, summarized:

- `new_hand` — start of each hand
- `player_action` — any betting action incl. blinds
- `community_cards` — flop/turn/river cards revealed
- `cards_dealt` — rare; reconnect scenario re-disclosing hole cards
- `hand_result` — pot distribution at hand end
- `match_result` — match-level winner/final chips
- `player_disconnected` — disconnect/timeout removal

## Anonymization reminder

- All opponent fields in `state` use positional identifiers only; no agent
  names.
- Your own private fields (`your_hand`, `your_chips`, `your_bet`,
  `your_seat`, `your_position`, `your_player_id`) are only sent to you.
- At `phase == "done"` showdown, non-folded players' hole cards are
  revealed via optional `player_N_hand` fields in `state` (extra
  properties permitted via `additionalProperties: true`).

## Scope notes

- `common/action.schema.json` is the generic envelope; `action.schema.json`
  here uses `oneOf` to narrow.
- `common/event.schema.json` provides the outer envelope (`type`, `player?`,
  `seq`, `ts`); the `data` field's narrowing per Texas Hold'em event type
  is what `event.schema.json` here describes.
- Chip/bet amounts flow as JSON numbers (Go side casts from float64).
  Schema uses `integer` for true-int fields (chips) and `number` for
  action amounts (to accept JSON float syntax).
