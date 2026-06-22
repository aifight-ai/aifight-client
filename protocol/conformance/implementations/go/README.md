# conformance-go — Phase 0 Go reference conformance runner

A standalone Go module that executes the Mode A (replay-read)
conformance contract from
[`../../replay-test-spec.md`](../../replay-test-spec.md) against every
committed transcript under `protocol/transcripts/`.

**Scope (Phase 0):** Mode A only. Per spec §2 a read-only
implementation satisfies conformance with Mode A; Mode B
(replay-drive) is deferred to M1 when the reference Node runtime
lands.

## Build

```bash
cd protocol/conformance/implementations/go
go build .
```

Produces the `conformance-go` binary. Requires Go 1.25+.

## Run

```bash
# Single transcript
./conformance-go ../../../transcripts/happy_path/texas_holdem_4player.jsonl

# All committed transcripts
for f in ../../../transcripts/**/*.jsonl; do
  ./conformance-go "$f" || echo FAIL: $f
done
```

Exit code: 0 = PASS, 1 = FAIL (schema / assertion / throw), 2 = CLI /
IO error.

Stdout line 1 is a single-line JSON `Result` record per
replay-test-spec.md §3. Stderr carries diagnostic messages.

### Example success

```json
{"transcript":"../../../transcripts/happy_path/texas_holdem_4player.jsonl","implementation":"go-conformance-v0.1","mode":"A","result":"PASS","messages_seen":38,"messages_validated":38,"first_failure":null}
```

### Example failure

```json
{"transcript":"/tmp/bad.jsonl","result":"FAIL","messages_seen":1,"messages_validated":0,"first_failure":{"line":1,"entry_direction":"server_to_client","payload_type":"game_start","reason":"schema","detail":"jsonschema: '/data' ... missing properties: 'game'"}}
```

## Tests

```bash
go test ./... -count=1
```

Covers:
- every committed transcript PASSes (table-driven over 7 transcripts)
- schema-level fail-injection (synthetic game_start missing `game`)
- malformed JSONL / missing file → `reason=throw`
- terminal-state §5.1 fail-injection:
  - envelope `match_id` ≠ `data.session_id` on game_over
  - winner inconsistent with payoffs max
  - payoff tie with a non-empty winner (contradiction)
  - draw accepts any winner string (relaxed)
  - forfeit_reason without forfeited_by (and vice versa)
  - valid forfeit pair accepted
  - ended_at_line recorded on game_over terminals
- terminal-last §5 fail-injection:
  - messages after game_over → FAIL
  - messages after match_cancelled → FAIL
  - mid-match error followed by retry action_request → PASS

## What this impl does and doesn't

| Spec check | Phase 0 status |
|-----------|----------------|
| Schema validation per message (§4) | implemented via santhosh-tekuri/jsonschema/v5 |
| Terminal-state assertions (§5.1 game_over) | `session_id` / `match_id` / `winner` ↔ `payoffs` uniqueness / forfeit pair co-occurrence / envelope match_id == data.session_id / `ended_at_line` reported |
| Terminal-must-be-last (§5) | enforced — any message after a recorded `game_over` or `match_cancelled` FAILs with `reason=assertion` (mid-match `error` with subsequent recovery is not treated as terminal) |
| Equality rules (§6) | not needed for Mode A |
| Edge-case handling (§7) | all 5 edge transcripts PASS — schema narrowness already captures the shape; Mode B will need the "force-actions" harness described in §7.2 and §7.4 |

## Dependencies

- `github.com/santhosh-tekuri/jsonschema/v5` — pure Go Draft-07 JSON
  Schema validator. Chosen over `xeipuuv/gojsonschema` because it
  resolves cross-file `$ref`s by schema `$id` out of the box, which
  this repo's schemas rely on.

## Note on isolation

This is a **standalone Go module** (`aifight.ai/conformance-go`); it
does NOT import `internal/engine` or `games/*` from the parent repo.
That isolation is deliberate:

1. Avoids circular coupling — the runtime protocol is authoritative,
   not the specific engine impl.
2. Avoids the "engine non-determinism" risk the P0-12 TED flagged —
   Mode A never needs to replay through `engine.ApplyAction`.
3. Makes the conformance binary portable: anyone can vendor this
   directory into a different repo and still run it.
