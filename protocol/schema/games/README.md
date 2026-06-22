# protocol/schema/games — Game-Specific Schemas

Per-game payloads referenced by message-level `$ref` in `../messages/`.
Each subdirectory corresponds to a registered game. Schemas mirror the
Go structs returned by `engine.Game` interface methods in
`games/<game>/<game>.go`.

## Subdirectories

| Game | Status | Source (Go) |
|------|--------|-------------|
| `texas_holdem/` | ✅ P0-03 partial (landed) | `games/texasholdem/texasholdem.go` |
| `liars_dice/` | ⏸ Pending | `games/liarsdice/liarsdice.go` |
| `coup/` | ⏸ Pending | `games/coup/coup.go` |

## Files per game

Each game directory should contain 4-5 schemas:

- `rules.schema.json` — matches `Game.Rules()` output (engine.Rules)
- `config.schema.json` — match config, sent in `server_game_start.data.config`
- `state.schema.json` — per-player state, sent in `server_action_request.data.state`;
  mix of public + private fields per `Game.GetPlayerView()`
- `action.schema.json` — action payload, sent in `client_action.data`;
  typically `oneOf` discriminated by `action.type`
- `event.schema.json` — event `data` payload, per event type;
  typically `oneOf` discriminated by outer `event.type`

## Scope note (v1.1.1 P0-03 TED)

- The base `common/action.schema.json` / `common/event.schema.json` leave
  the `data` field as an open object. The per-game schemas here narrow
  it when the game is known.
- `server_action_request.data.state` likewise starts as open `{"type":
  "object"}` in `../messages/server_action_request.schema.json`; once all
  3 games land, we narrow it via `oneOf` + `game` discriminator. See
  P0-03 TED Step 4.

## Validation

Once P0-09 lands, the `validate-transcript.ts` tool will auto-resolve
these `$ref` paths and apply appropriate narrowing based on the match's
`game` field.
