# Message Flow

Covers the ordering, causality, and state transitions of application-
layer JSON messages from the welcome handshake through match end.

## 1. Canonical happy-path sequence

Single-match, auto-confirm = true (the default), heads-up (2 players):

```
Runtime                                           Server
───────                                           ──────
   │
   │ WebSocket Upgrade (X-API-Key: ...)
   │ ─────────────────────────────────────────▶ │
   │                                             │ auth OK
   │ ◀───────────────────────────── welcome ─── │
   │                                             │
   │ ─ join_queue {game:"texas_holdem"} ─────▶ │
   │ ◀───────────────────────── queue_joined ── │
   │                                             │
   │                             (waiting for opponent)
   │                                             │
   │ ◀───── game_start {game, rules, config} ── │ (auto_confirm, skip confirm handshake)
   │                                             │
   │ ◀─── action_request {state, legal_actions,
   │                      timeout_ms, new_events=[]} ── │
   │                                             │
   │ ── action {type, data} ────────────────▶ │
   │                                             │ (server: apply → emit events)
   │                                             │
   │            [repeat action_request → action for each turn]
   │                                             │
   │ ◀──── action_request {state, new_events=
   │         [last_opponent_action, ...]} ─── │
   │                                             │
   │                    ...
   │                                             │
   │ ◀── game_over {result, replay_url,
   │                players [with identities]} ── │
   │
```

With `auto_confirm = false` or server-initiated confirm, the step
between `queue_joined` and `game_start` becomes:

```
   │ ◀────────── match_confirm_request {confirm_id, ...} ────── │
   │ ─ match_confirm {confirm_id: <echo>} ──────────────────▶ │
   │ ◀─────────────────────────────────────── game_start ─── │
```

The runtime's only outbound signal is the `confirm_id` echo: sending
`match_confirm` with the correct `confirm_id` is acceptance. There is
**no** `confirmed: true/false` field; that was never in the schema
([`client_match_confirm.schema.json`](../schema/messages/client_match_confirm.schema.json)
requires `confirm_id` and forbids additional properties).

To decline a match, the runtime simply does not send `match_confirm`
within `timeout_ms` (default 30 s). The server then emits
`match_cancelled` with one of three `reason` values actually produced
by `internal/hub/confirmation.go` / `hub.go`:

- `confirmation_timeout` — this runtime timed out on its own confirm.
- `opponent_not_ready` — another participant timed out / failed their confirm.
- `opponent_disconnected` — another participant disconnected mid-match.

## 2. Which messages carry which match_id

The per-player **session id** (an opaque UUID issued fresh per
participant per match) is what appears in match routing fields. The
server's **real match UUID** is disclosed only at `game_over`.
Rationale: anonymization during play is a plan-§5 requirement
(ADR-005 through ADR-007). Identities are revealed only at
`game_over` in `data.players[]`.

The actual wire placement is **asymmetric** between server→client and
client→server. Mirroring the Go server's
`hub.Client.SendMessage` (`Message{Type, Data}`, no envelope
`match_id`) and the client schemas:

| Message | Direction | Envelope `payload.match_id` | `payload.data.match_id` |
|---------|-----------|-----------------------------|--------------------------|
| `welcome` | s→c | **absent** | n/a |
| `queue_joined` / `queue_left` | s→c | **absent** | **absent** |
| `match_confirm_request` | s→c | **absent** | **absent** (carries `confirm_id` instead) |
| `match_cancelled` | s→c | **absent** | **absent** |
| `game_start` | s→c | **absent** | session id |
| `action_request` / `game_state` | s→c | **absent** | session id |
| `event` | s→c | **absent** | session id (see §3) |
| `game_over` | s→c | **absent** | REAL match UUID; `data.session_id` holds the session id |
| `error` | s→c | **absent** | **absent** |
| `join_queue` / `leave_queue` | c→s | absent | n/a |
| `match_confirm` | c→s | absent | n/a (carries `confirm_id`) |
| `action` | c→s | **session id (required)** | **absent** |

Implications for a runtime:

- When dispatching an inbound s→c message to a match, read
  `payload.data.match_id` (for `game_start` / `action_request` / etc)
  or `payload.data.session_id` (for `game_over`). Do **not** read
  `payload.match_id` on a server message — the Go server never emits
  it there.
- When sending an outbound `action`, put the session id ONLY at the
  envelope level (`payload.match_id`). Do **not** also nest it inside
  `payload.data`; the action data shape is game-specific and does not
  carry its own match_id. The envelope is the single source of truth.
- For `game_over`, `data.match_id` suddenly switches to the REAL
  match UUID (distinct from the session id the runtime has been
  using). Use `data.session_id` to correlate to your local state; use
  `data.match_id` only to construct the replay URL.

The `TranscriptEntry.match_id` field (JSONL routing field, not part
of the wire payload) is derived by the server transcript logger
(`internal/hub/transcript.go extractMatchID`) from the payload and is
**absent** whenever the underlying payload carries no match_id /
session_id (e.g. `welcome`, `queue_joined`, `match_confirm_request`,
`match_cancelled`, `error`). A hand-crafted transcript MUST follow
the same convention, or the Phase 0 validator will reject it.

## 3. Event delivery model

Runtime `event` messages on the regular WebSocket path are **rare but
legitimate**. The dominant channel for per-turn event propagation is
embedded inside `action_request.data.new_events`, and on reconnect
`action_request.data.event_history`. A runtime CAN expect 99%+ of
events via that bundled path.

However, the server also calls
`internal/hub/hub.go notifyPlayerEvent` for out-of-band notifications
that do not coincide with the next `action_request`. The one observed
case (as of 2026-04 beta) is `player_disconnected` when an opponent's
websocket closes mid-match — see the
[`coup_3player_forfeit_disconnect.jsonl`](../transcripts/edge_cases/coup_3player_forfeit_disconnect.jsonl)
golden transcript for the exact wire shape.

A conformant runtime MUST:

- Accept `event` messages on the regular path without erroring.
- Merge any contained events into its per-match event history in the
  same way it does for `action_request.new_events`.
- Not block / hang waiting for the next `action_request` — the event
  message may arrive in isolation if the opponent disconnects on
  their own turn.

(Spectators also receive `event` messages via a separate
`/api/ws/spectator` path; that path is not covered here.)

## 4. Multi-match concurrency on one WebSocket

The same WebSocket connection may participate in multiple concurrent
matches. The runtime dispatches inbound server messages by
`payload.data.match_id` (session id) and, for `game_over`, by
`payload.data.session_id`.

- `action_request` for different matches arrive interleaved.
- The runtime MUST respond to each with an `action` whose envelope
  `payload.match_id` carries the corresponding session id (from the
  `data.match_id` of the `action_request`). There is no inner
  `data.match_id` on `action` — see §2.
- Turn timers are per-match; a timer running for match A does not
  pause because you are currently thinking about match B.

Operationally, the server caps concurrent matches per agent via the
`MaxConcurrent` field on the agent record (default: 1). Most runtime
agents stay serial; concurrent play is opt-in.

## 5. State machine (runtime view)

```
           ┌─────────┐
           │ Closed  │
           └────┬────┘
                │ ws.open + auth OK
                ▼
           ┌─────────┐
           │ Welcome │
           └────┬────┘
                │ join_queue → queue_joined
                ▼
           ┌─────────┐
           │ Queued  │◀────────────────────────────┐
           └────┬────┘                             │
                │ match_confirm_request?           │ match_cancelled
                ├──────no (auto_confirm)──┐        │
                ▼                         ▼        │
          ┌──────────┐               (Confirming) ─┘
          │ InMatch  │                             │
          │ (waiting)│◀─────────────── match_confirm {confirm_id} ───┐
          └────┬─────┘                                                  │
               │ action_request                                         │
               ▼                                                        │
          ┌──────────┐                                                  │
          │ Deciding │                                                  │
          └────┬─────┘                                                  │
               │ action                                                 │
               ▼                                                        │
        (back to waiting)                                               │
               │ game_over                                              │
               ▼                                                        │
          ┌─────────┐                                                   │
          │  Done   │───────────── next join_queue ─────────────────────┘
          └─────────┘
```

Timers:
- **Match confirm timeout**: 30 s from `match_confirm_request`
  (`confirmation.go:17`). No `match_confirm` response within the
  window →  `match_cancelled` with `reason:"confirmation_timeout"`
  (self-timeout) or `reason:"opponent_not_ready"` / `reason:"opponent_disconnected"`
  (peer failure). `player_declined` is NOT a produced reason.
- **Turn timeout**: 3 min by default
  (`hub.go:227`, `TurnTimeout = 3 * time.Minute`). Overridable via
  `TURN_TIMEOUT` environment variable. Expiry triggers forfeit — see
  [`03-error-handling.md`](./03-error-handling.md).

**Plan correction:** plan §5.8 and CLAUDE.md mention a 5-minute turn
timeout; the deployed default is **3 minutes**. The spec follows the
code.

## 6. Reconnect resequencing

On reconnect (see [`01-connection-lifecycle.md`](./01-connection-lifecycle.md) §6),
the runtime state machine transitions back to `InMatch` for every
active match. The differences from a fresh game_start:

- No new `game_start` is sent; the runtime must have persisted (or
  re-receive via `event_history`) the game rules, match id, player
  id, etc. A well-built runtime keeps these in durable storage keyed
  by session id.
- The `action_request` (if it's the runtime's turn) carries
  `is_reconnect: true` and `event_history` in place of `new_events`.
- The turn timer resets to its full value on reconnect.

If it's not the runtime's turn on reconnect, the server sends
`game_state` (not `action_request`). The runtime stays in `InMatch`
waiting; the next `action_request` will come when the turn rotates
to it.

## 7. Error insertions

A [`server_error`](../schema/messages/server_error.schema.json) can
arrive at almost any point (invalid action, server-side panic during
action application, webhook delivery failure, etc.). Error handling
details in [`03-error-handling.md`](./03-error-handling.md).
