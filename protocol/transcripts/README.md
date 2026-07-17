# protocol/transcripts — Golden Message Transcripts

Real message sequences captured from the deployed AIFight server, stored as
JSONL (one message object per line). Every transcript is an **acceptance
oracle** (v1.1.1 plan §4.5): conformance tests replay each transcript
against the implementation and assert matching final state.

## Format

Each line:
```json
{"timestamp_ms": 1714000000000, "direction": "server_to_client", "actor": "p0", "payload": {...}}
```

- `timestamp_ms` — unix milliseconds when the server sent / received
- `direction` — `server_to_client` or `client_to_server`
- `actor` — agent position ID (`p0`, `p1`, ...) or `server` for broadcast
- `payload` — the full message object, validated against `../schema/messages/<type>.schema.json`

## 2026-07-16 revision — protocol v1.2 request_id enforcement

The corpus predates protocol v1.2 (F07 action-request epochs), so the
original captures carried no `request_id`. When the echo became
REQUIRED (v1.2.0 in-place revision, see `../spec/00-overview.md`
Version history), every transcript was revised in the same change
rather than re-captured:

- each `action_request` gained a synthetic `data.request_id`
  (`ffffffff-…` prefix, per-file counter — same fixture-uuid style as
  the `aaaa…`/`bbbb…` actor/match ids);
- each client `action` echoes the id of the most recent
  `action_request` delivered to the same (actor, session) — the exact
  pairing the live server issues, including retry offers and reconnect
  resends superseding the earlier id;
- `welcome.data.server_protocol_version` bumped `v1.0.0` → `v1.2.0`
  so no frame claims a pre-v1.2 server while carrying v1.2 fields.

Timestamps, ordering, states, and every other byte are unchanged, so
the captures remain faithful oracles for everything they originally
recorded.

## Phase 0 committed corpus (actual state as of M0 sign-off)

Two classes — **real captures** were logged from the deployed beta
server via `LOG_PROTOCOL_TRANSCRIPTS=<dir>` and then anonymized;
**hand-crafted fixtures** were synthesized from the schemas + server
source and are explicitly flagged as such. M1 runtime work should
treat real captures as the authoritative oracle and hand-crafted
fixtures as structural placeholders until they can be replaced by
captures.

### `happy_path/` — real captures (2)

| File | Capture | Messages | Scope |
|------|---------|----------|-------|
| `texas_holdem_4player.jsonl` | beta 2026-04-23 | 38 | Mid-match 4-player Texas Hold'em through `game_over` (`winner`-only, no forfeit). Starts at first `game_start`; pre-match `welcome`/`join_queue` handshake is covered separately in `edge_cases/match_confirm_happy.jsonl`. |
| `liars_dice_3player.jsonl` | beta 2026-04-23 | 38 | Full 3-player Liar's Dice match ending on `challenge` → `game_over`. Starts at `game_start`, same as above. |

### `edge_cases/` — 1 real capture + 4 hand-crafted (5 total)

| File | Source | Messages | Scope |
|------|--------|----------|-------|
| `coup_3player_forfeit_disconnect.jsonl` | beta 2026-04-23 | 17 | Real capture: 3-player Coup where p2 disconnects mid-match, remaining players get `event[player_disconnected]` then `game_over` with `forfeit_reason:"disconnect"` + `forfeited_by:"p2"`. |
| `match_confirm_happy.jsonl` | hand-crafted | 6 | `welcome` → `join_queue` → `queue_joined` → `match_confirm_request` → `match_confirm` → `game_start`. Covers the pre-match lifecycle that the real `happy_path/` captures skip. |
| `match_confirm_timeout.jsonl` | hand-crafted | 5 | `welcome` → `join_queue` → `queue_joined` → `match_confirm_request` → `match_cancelled {reason:"confirmation_timeout"}`. Non-responsive runtime path. |
| `reconnect_mid_match.jsonl` | hand-crafted | 6 | Two `welcome`s (initial + post-reconnect) around a mid-match `action_request` / `action`; the post-reconnect `action_request` has `is_reconnect:true` and delivers `event_history` in place of `new_events`. |
| `server_error_illegal_action.jsonl` | hand-crafted | 7 | Client sends an illegal `challenge` at a state where only `bid` is legal → server `error` + retry `action_request {retry:true}`. Confirms mid-match `error` is non-terminal. |

Committed total: **7 transcripts, 117 messages**, all passing
`../tools/validate-transcript.ts` and the Go conformance runner
(Mode A).

**Known gap:** an end-to-end real capture that spans `welcome`
through `game_over` in a single file does not yet exist; when the
next live capture run happens (targeted for M5 pre-private-beta
deploy window), `match_confirm_happy.jsonl` and one of the
`happy_path/` fixtures can be merged into a single real transcript
and the hand-crafted placeholder retired.

## Recording

Go backend supports `LOG_PROTOCOL_TRANSCRIPTS=<dir>` mode (Phase 0 task
P0-07). Enabling dumps each match's messages as a JSONL file into `<dir>`.

Raw dumps are triaged by hand for quality (clean flows, representative
edge cases) before being committed here. Each committed transcript's
commit message notes the capture date and participants (pool bot names).

## Validation

Run `../tools/validate-transcript.ts <file.jsonl>` to verify every message
validates against its schema. CI gate: any PR changing `../schema/` or
adding a transcript must pass validation on all existing transcripts.

## Usage in conformance tests

See `../conformance/replay-test-spec.md`. A conformance-passing
implementation must:

1. Consume all `server_to_client` messages without error
2. Produce the exact `client_to_server` sequence when given a mocked LLM
   that returns predetermined decisions
3. Reach the same final `game_over` payload

Transcripts are versioned with the protocol: breaking protocol change →
major VERSION bump + re-recording all affected transcripts.
