# protocol/schema/common — Shared Type Schemas

Reusable structural types referenced by multiple message schemas in
`../messages/` (and by game-specific schemas in `../games/` once P0-03
lands). Each is a complete JSON Schema describing a Go type from
`internal/engine/types.go` or `internal/match/`.

## Files

| Schema | Mirrors (Go) | Used by |
|--------|--------------|---------|
| [`action.schema.json`](./action.schema.json) | `engine.Action` (`internal/engine/types.go:12`) | `client_action.data`, `server_action_request.data.legal_actions[*]` |
| [`event.schema.json`](./event.schema.json) | `engine.Event` (`internal/engine/types.go:18`) | `server_action_request.data.new_events[*]` + `event_history[*]`, `server_event.data.events[*]` |
| [`player_info.schema.json`](./player_info.schema.json) | `engine.PlayerInfo` (`internal/engine/types.go:40`) | `server_action_request.data.players[*]`, `server_game_state.data.players[*]` |
| [`rules.schema.json`](./rules.schema.json) | `engine.Rules` (`internal/engine/types.go:66`) | `server_game_start.data.rules` |
| [`game_result.schema.json`](./game_result.schema.json) | `engine.GameResult` (`internal/engine/types.go:48`) | `server_game_over.data.result` |
| [`player_identity.schema.json`](./player_identity.schema.json) | Anonymous struct in `internal/hub/hub.go:865` (handleGameOver) | `server_game_over.data.players[*]` |
| [`error.schema.json`](./error.schema.json) | `map[string]string{"message": ...}` (`internal/hub/hub.go:1228`) | `server_error.data` |

## Game-specific narrowing

Several types contain `data` / `state` / `details` fields that are
game-specific (`map[string]interface{}` in Go). Current schemas leave
these as open `{"type": "object"}`. After P0-03 writes game schemas,
these will be narrowed by `$ref` + `oneOf`:

- `action.schema.json` → `data` — game-specific action params
- `event.schema.json` → `data` — game-specific event payload
- `player_info.schema.json` → `data` — game-specific public player data
- `game_result.schema.json` → `details[*]` — per-player game-specific summary

## Anonymization reminder

- **During match:** opponents' names are anonymized (`"Player 1"`,
  `"Player 2"`, ...) via `PlayerInfo.name` to prevent identity-based
  strategy adaptation
- **At game_over:** real identities are revealed via `PlayerIdentity`
  (different type, different schema — `player_identity.schema.json`)
- Runtime must handle both without assuming `name` matches across
  `PlayerInfo` and `PlayerIdentity`
