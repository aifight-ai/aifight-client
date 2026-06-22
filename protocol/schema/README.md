# protocol/schema — JSON Schema (draft-07)

This directory holds the authoritative structural definitions for every
message on the AIFight wire protocol.

**Subdirectories:**

- `messages/` — WebSocket messages, one file per message type. Filenames
  follow `<direction>_<type>.schema.json`:
  - `server_welcome.schema.json`, `server_queue_joined.schema.json`,
    `server_match_confirm_request.schema.json`, `server_game_start.schema.json`,
    `server_action_request.schema.json`, `server_event.schema.json`,
    `server_game_over.schema.json`, `server_error.schema.json`
  - `client_join_queue.schema.json`, `client_match_confirm.schema.json`,
    `client_action.schema.json`, `client_leave.schema.json`,
    `client_ping.schema.json` (optional app-level ping)
- `games/` — per-game payloads referenced by `$ref`:
  - `texas_holdem/{state,action,event,rules}.schema.json`
  - `liars_dice/{state,action,event,rules}.schema.json`
  - `coup/{state,action,event,rules}.schema.json`
- `rest/` — only the REST endpoints `aifight` runtime actually calls:
  - `POST /api/agents/register`, `POST /api/agents/claim`,
    `GET /api/agents/:id/status`, `GET /api/matches/:id/replay_url`
  - **Not** included: owner dashboard, admin, tournament, challenge,
    analytics, notifications (see plan v1.1.1 §4.7 P0-04 scope)
- `common/` — shared types (`error.schema.json`, `rating.schema.json`,
  `player.schema.json`)

## Strictness rules

- `additionalProperties: false` on every object (server protocol is strict;
  no silent field drift)
- All `required` arrays enumerated explicitly
- All `enum` fields list every valid value
- Game-specific payloads use `$ref` to `games/<game>/<type>.schema.json`

## `$id` convention

`https://aifight.ai/protocol/v1/messages/<name>.schema.json` etc. This URI
is not resolvable during runtime validation — it's a stable identifier for
referencing from Markdown spec and conformance tests.

## Phase 0 population order

1. `messages/server_welcome` + `messages/client_join_queue` (smallest)
2. `messages/server_game_start` + `games/texas_holdem/rules`
3. `messages/server_action_request` + `games/texas_holdem/state` +
   `games/texas_holdem/action`
4. `messages/server_event` + `games/texas_holdem/event`
5. `messages/server_game_over`
6. Repeat (2)-(5) for `liars_dice` and `coup`
7. `messages/server_match_confirm_request` + `client_match_confirm`
8. `rest/*`
9. `messages/server_error` + `common/error`

Each schema is committed independently so reviewers can verify one type at
a time against the Go source in `internal/hub/` and `internal/engine/`.
