# protocol/schema/games/coup

Game-specific schemas for Coup. Source of truth:
[`games/coup/coup.go`](../../../../games/coup/coup.go).

## Files

| Schema | Mirrors | Used at |
|--------|---------|---------|
| [`rules.schema.json`](./rules.schema.json) | `Game.Rules()` L205 | `server_game_start.data.rules` |
| [`state.schema.json`](./state.schema.json) | `GetPlayerView()` L1592 → `PlayerView.GameData` | `server_action_request.data.state`, `server_game_state.data.state` |
| [`action.schema.json`](./action.schema.json) | `GetLegalActions()` L385 + `ValidateAction()` L613 + `applyXxx()` dispatch | `client_action.data`, `server_action_request.data.legal_actions[*]` |
| [`event.schema.json`](./event.schema.json) | All `events = append(..., Event{Type: ...})` emission sites | `server_action_request.data.new_events[*]`, `common/event.schema.json` `data` field when outer type is a Coup event |

No `config.schema.json`: `NewState()` ignores `GameConfig` — deck composition
(3 of each role = 15 cards), starting coins (2), starting hand (2 cards),
and the mandatory-coup threshold (10 coins) are all fixed by the Go
implementation. `server_game_start.data.config` for coup is effectively an
empty object.

## Phase state machine

```
action → (challenge_action?) → (block? → (challenge_block?)) → execute
action → lose_influence (for coup / caught-lie / post-block-challenge)
action → exchange_return (for completed Exchange)
```

Multiple lose_influence transitions can chain (e.g. failed block-challenge
causes blocker to lose influence, then action executes which may cause a
second loss).

## Action enum

12 action types:

| Type | Phase | Subtype data |
|------|-------|--------------|
| `income` | action | (none) |
| `foreign_aid` | action | (none) |
| `coup` | action | `target` (player id) |
| `tax` | action | (none; claims Duke) |
| `assassinate` | action | `target`; claims Assassin |
| `steal` | action | `target`; claims Captain |
| `exchange` | action | (none; claims Ambassador) |
| `challenge` | challenge_action / challenge_block | (none) |
| `pass` | challenge_action / challenge_block / block | (none) |
| `block` | block | `role` (Duke/Contessa/Captain/Ambassador) |
| `lose_card` | lose_influence | `card_index` (0-based) |
| `return_cards` | exchange_return | `return_indices` (array of indices into `all_exchange_options`) |

## Event types

17 event types, grouped:

- Action flow: `action`, `action_resolved`
- Challenge flow: `challenge_pass`, `challenge`, `challenge_result`
- Block flow: `block_pass`, `block`, `block_challenge_pass`,
  `block_accepted`, `challenge_block`, `challenge_block_result`
- Influence: `influence_lost`, `player_eliminated`
- Exchange: `exchange_draw`, `exchange_complete`
- Match end: `game_over`
- Disconnect: `player_disconnected`

## Anonymization reminder

**PRIVATE** (only sent to the recipient):

- `your_cards` (roles of your face-down cards)
- `coins` (your coins — also public in players array; duplicated here for
  convenience)
- `exchange_cards` and `all_exchange_options` (sent only to the Ambassador
  actor during `exchange_return`)

**PUBLIC** (in `players[*].data` for everyone):

- `coins` (per-player)
- `hidden_cards` (count, not roles)
- `revealed` (list of revealed role names)

**Becomes public when revealed:**

- `influence_lost` event includes the card role, which is visible to all
  players and will also appear in `players[*].data.revealed` on subsequent
  views.
- `challenge_result` / `challenge_block_result` with `result == 'fail'`
  broadcasts `revealed_card` publicly before the server re-shuffles the
  actor's hand and draws a replacement.

## Scope notes

- `common/action.schema.json` is the generic envelope; `action.schema.json`
  here uses `oneOf` to narrow.
- `common/event.schema.json` provides the outer envelope (`type`, `player?`,
  `seq`, `ts`); the `data` field's narrowing per Coup event type is what
  `event.schema.json` here describes.
- `return_cards.data.cards` and `return_cards.data.all_cards` are server-
  provided display hints (present in legal_actions so an LLM can read role
  names, not just indices). Client-side echoes on outbound `client_action`
  are not required; server only reads `return_indices`.
- `card_index` in `lose_card` is an index into the actor's full `Cards`
  array (hidden + revealed), NOT just the face-down subset. Usually 0 or 1
  but can be higher after mid-game shuffle-and-redraws from failed
  challenges.
