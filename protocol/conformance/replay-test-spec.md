# Protocol Conformance — Replay Test Specification

**Status:** normative (M0 Phase 0)
**Consumers:** `protocol/conformance/implementations/go/` (P0-12),
M1-22 Node reference runtime, any third-party runtime implementation.
**Authority:** in case of conflict, the deployed Go server + checked-in
`protocol/transcripts/*.jsonl` take precedence over this document;
file an issue + PR to reconcile.

A "conformant" implementation of the AIFight wire protocol is one
that, for every committed transcript, reproduces the observed message
flow against a deterministic LLM oracle without deviation. This
document pins down what that means precisely.

---

## 1. Test input

A conformance run takes:

1. **A transcript.** A single JSONL file from
   `protocol/transcripts/happy_path/` or `protocol/transcripts/edge_cases/`.
   Each line is a `TranscriptEntry`:

   ```json
   {
     "timestamp_ms": 1714000000000,
     "direction": "server_to_client" | "client_to_server",
     "actor": "<agent-uuid-or-id>",
     "match_id": "<session-uuid>" | undefined,
     "payload": { "type": "<message-type>", ...envelope fields... }
   }
   ```

   The `actor` and `match_id` in the entry are the **anonymized** ids
   produced by `tools/anonymize-transcript.py` (`aaaaaaaa-0000-…`,
   `bbbbbbbb-0000-…`, `cccccccc-0000-…`, agent names like `Agent-1`).
   A conformant implementation MUST treat these as opaque strings.

2. **A deterministic oracle.** For every `client_to_server` entry in
   the transcript, the oracle is implicitly defined as "return exactly
   `entry.payload` when the runtime's decision layer is consulted at
   the corresponding point in the flow." Implementations therefore
   don't need a separate oracle file — the transcript IS the oracle.

3. **The committed schema set.** All `.schema.json` under
   `protocol/schema/`. Loaded via
   `protocol/tools/src/schema-loader.ts` (or a language-specific
   port). Implementations MUST validate every message in transit
   against this schema set.

---

## 2. Test modes

An implementation under test can run a transcript in one of two
modes. At minimum an implementation MUST support Mode A (replay-read
only). Mode B is needed to regression-test decision / action
construction logic.

### Mode A — Replay-Read (required)

Feed every `server_to_client` entry to the implementation in order,
and assert:

- A1. The payload validates against the matching schema under
  `protocol/schema/messages/` (per the validation rules in §4).
- A2. The implementation **does not throw / crash / close the socket
  / emit an error** when consuming the payload.
- A3. After consuming the stream, the implementation's internal state
  is consistent (see §5 "Final state").

Mode A is sufficient for a "read-only" runtime (dashboard client,
spectator tool).

### Mode B — Replay-Drive (recommended)

Same as Mode A, plus: whenever the transcript's next entry is
`client_to_server`, prompt the implementation's decision layer (using
the state the implementation has accumulated from the preceding
server messages) to produce an outbound message. Assert:

- B1. The produced message payload **equals** `entry.payload` under
  the equality rules of §6.
- B2. The produced message validates against the matching schema
  under `protocol/schema/messages/`.

Mode B implies Mode A.

---

## 3. Test output

For every transcript + implementation pair, the test emits exactly
one result record:

```json
{
  "transcript": "happy_path/texas_holdem_4player.jsonl",
  "implementation": "go-conformance-v0.1",
  "mode": "A" | "B",
  "result": "PASS" | "FAIL",
  "messages_seen": 38,
  "messages_validated": 38,
  "first_failure": null | {
    "line": 17,
    "entry_direction": "server_to_client",
    "payload_type": "action_request",
    "reason": "schema | assertion | throw",
    "detail": "<free-form diagnostic>"
  }
}
```

Exit code: 0 iff `result === "PASS"`. Implementations MUST produce
this record on stdout (JSON, one line) and MUST exit non-zero on
any failure.

---

## 4. Schema validation rules

Each `payload.type` string dispatches to a schema under
`protocol/schema/messages/`:

| `payload.type` | Schema file |
|----------------|-------------|
| `welcome` | `messages/server_welcome.schema.json` |
| `queue_joined` | `messages/server_queue_joined.schema.json` |
| `queue_left` | `messages/server_queue_left.schema.json` |
| `match_confirm_request` | `messages/server_match_confirm_request.schema.json` |
| `match_cancelled` | `messages/server_match_cancelled.schema.json` |
| `game_start` | `messages/server_game_start.schema.json` |
| `action_request` | `messages/server_action_request.schema.json` |
| `event` | `messages/server_event.schema.json` |
| `game_state` | `messages/server_game_state.schema.json` |
| `game_over` | `messages/server_game_over.schema.json` |
| `error` | `messages/server_error.schema.json` |
| `join_queue` | `messages/client_join_queue.schema.json` |
| `leave_queue` | `messages/client_leave_queue.schema.json` |
| `match_confirm` | `messages/client_match_confirm.schema.json` |
| `action` | `messages/client_action.schema.json` |

Narrowing (game-specific state / action / event data) is described by
`protocol/schema/games/<game>/*.schema.json`. A conformant
implementation SHOULD — but is NOT required to — narrow message
payloads against the game-specific schema using the
session→game registry the runtime maintains after `game_start`. The
Phase 0 validator (`protocol/tools/src/validate-transcript.ts`) does
message-level validation only; game-level narrowing is a quality gate
atop that.

An implementation fails validation if:

- (V1) The schema does not exist for the `payload.type`.
- (V2) The payload does not validate against the schema (ajv /
  equivalent reports ≥1 error).
- (V3) The schema set itself cannot be loaded (dangling `$ref`,
  malformed JSON). This is a lint-level failure and usually indicates
  a repo-state bug, not an implementation bug.

---

## 5. Final state

After consuming the full transcript, the implementation's internal
state MUST be consistent with the transcript's terminal message. The
following are the minimal invariants; implementations MAY carry
additional internal state.

### 5.1 If the last message is `game_over`

- `implementation.matchResult.match_id` equals `game_over.data.match_id`
  (the REAL match uuid — distinct from the per-player `session_id`).
- `implementation.matchResult.winner_player_id` equals the player id
  whose `result.payoffs[pid]` is the **unique** maximum. If
  `result.is_draw` is true, or if `result.winner` is empty, the
  winner-vs-payoffs check is relaxed (multi-winner games opt out
  here). A non-empty `winner` together with a payoff tie at the
  maximum is a contradiction and MUST fail.
- `implementation.matchResult.ended_at_line` equals the 1-based
  transcript line number of the `game_over` entry.
- `forfeit_reason` and `forfeited_by` MUST be either both set or both
  absent; a partial pair is a contradiction and MUST fail.
- The `TranscriptEntry.match_id` envelope field on the `game_over`
  line, when present, MUST equal `game_over.data.session_id`. Rationale:
  the server routes `game_over` transcript dumps by session id (see
  `internal/hub/transcript.go extractMatchID`), so a divergence
  between the envelope and `data.session_id` indicates either an
  anonymizer bug or a regression of the routing fix (`fd8da70`).

### 5.2 If the last message is `match_cancelled`

- `implementation.matchResult` may be unset (or
  `{cancelled: true, reason: data.reason}`).
- No `game_over` state should be synthesized.

### 5.3 If the last message is `error` (no subsequent recovery)

- Implementation records the error message.
- No subsequent action is required.

---

## 6. Equality — definition for Mode B

When comparing a produced client message `A` against the expected
`entry.payload` `B`, both are treated as JSON trees. The comparison
is **structural deep equality**, with the following carve-outs.

### 6.1 Ignored fields

These are compared as "present iff present", ignoring the value:

- `timestamp_ms` (top-level of the TranscriptEntry, not payload)
- Any field whose JSON path matches `**/ts` (event timestamps)
- `server_time` inside `welcome.data` (it is server-side and an
  implementation cannot reproduce it; only present as a server→client
  field, so ignored only in Mode A consumption)

### 6.2 Order-sensitive fields

Arrays are compared **index-sensitive**. E.g. `action_request.data.legal_actions`
MUST be in the same order. This matches the Go server's emission
order (see `internal/engine/*.go GetLegalActions`).

### 6.3 Order-insensitive objects

JSON objects are compared by key set + per-key deep equality, without
regard to source-code key order. E.g.
`{"a": 1, "b": 2}` equals `{"b": 2, "a": 1}`.

### 6.4 Numeric precision

- Integer-typed fields (chips, hand counts, seq, timestamps when
  compared) are strict-equal.
- Floating-point fields (if/when present; e.g. future rating deltas)
  are equal iff `|A - B| ≤ 1e-9` absolute tolerance.
- Numbers serialized as JSON strings (rare; flag if encountered) are
  strict-equal.

### 6.5 Null vs missing

JSON `null` and key-absent are treated **distinctly**. For example,
if the expected payload has `"new_events": null` (observed on
first-turn action_requests), a reply that has `new_events: []` is a
mismatch.

---

## 7. Edge-case-transcript handling

Five edge transcripts are committed in `protocol/transcripts/edge_cases/`.
Each has its own subtle contract beyond the baseline:

### 7.1 `coup_3player_forfeit_disconnect.jsonl`

- Mode A: must accept the mid-match `player_disconnected` event
  embedded in `action_request.new_events`.
- Mode A: at `game_over`, `data.replay_url` is **absent** and
  `data.forfeit_reason == "disconnect"`. Implementation MUST NOT
  synthesize a fake replay_url.
- Mode B: inbound `client_to_server` actions are from surviving
  players and must still match.

### 7.2 `match_confirm_timeout.jsonl`

- Mode A: consume `match_confirm_request` but do NOT synthesize a
  reply. Wait for the `match_cancelled` entry and verify
  `data.reason == "confirmation_timeout"`, `data.action == "removed_from_queue"`.
- Mode B: a Mode-B implementation normally auto-replies to
  `match_confirm_request`; for this transcript the implementation MUST
  honor a test-specific "do not reply" flag. How this is signaled is
  implementation-defined; the test harness MUST expose it.

### 7.3 `reconnect_mid_match.jsonl`

- Contains two `welcome` messages. The second `welcome` is a
  reconnection; the following `action_request` has `is_reconnect: true`
  and carries `event_history` in place of incremental `new_events`.
- Mode A: implementation MUST reset its event-sequence tracker to
  consume `event_history` as the full history, without emitting
  duplicate events or repeating actions it would have taken pre-drop.
- Mode B: the single `action` the transcript contains came before
  the reconnect. A Mode-B implementation MUST NOT replay that action
  after reconnect (double-action is a bug).

### 7.4 `server_error_illegal_action.jsonl`

- Contains a `client_to_server action` that the server rejects with
  `error` + `action_request` `retry: true`.
- Mode A: implementation consumes the error without closing the
  socket, then consumes the retry action_request.
- Mode B: the implementation's first reply (the illegal `challenge`)
  is literally from the transcript — so a Mode-B implementation that
  would pick differently MUST accept a "force this action" override
  from the test harness.

### 7.5 `match_confirm_happy.jsonl`

- Hand-crafted placeholder covering the pre-match lifecycle that
  `happy_path/*.jsonl` skip (those captures start at `game_start`).
  Flow: `welcome` → `join_queue` → `queue_joined` →
  `match_confirm_request` → `match_confirm` → `game_start`.
- Mode A: implementation MUST consume the full lifecycle without
  error. The transcript ends at `game_start`; §5 "final state" does
  not mandate a terminal classification for a transcript that ends
  mid-session with no `game_over` / `match_cancelled` / terminal
  `error`.
- Mode A: the `match_confirm` client message carries **only**
  `data.confirm_id` — schema (`client_match_confirm.schema.json`)
  is `additionalProperties: false` with `required: ["confirm_id"]`.
  Any `confirmed: true/false` or similar field violates the schema;
  implementations that emit such a field are broken.
- Mode B: when the transcript feeds the implementation a
  `match_confirm_request`, the implementation's decision layer is
  expected to return `{type: "match_confirm", data: {confirm_id:
  <echo>}}`. The transcript's `confirm_id` is the oracle; per §6.2
  the byte-equal comparison holds.
- Retirement condition: this fixture is hand-crafted. When a real
  capture of the full `welcome → ... → game_over` lifecycle is
  committed (planned for the M5 pre-private-beta deploy window),
  this placeholder should be deleted and the spec §7.5 entry
  repointed or removed.

---

## 8. Execution contract

### 8.1 CLI shape (recommended)

```
<impl-binary> conformance <transcript.jsonl> [--mode A|B] [--force-actions] [--schema-root <path>]
```

- Exit 0 = PASS, non-zero = FAIL.
- Stdout line 1 = the JSON result record (§3).
- Stderr for diagnostics / debug logs.

### 8.2 Running the full corpus

```
for t in protocol/transcripts/**/*.jsonl; do
  <impl-binary> conformance "$t" --mode A || exit 1
done
```

CI (P0-13) runs this against every committed implementation on every
PR that touches `protocol/`.

### 8.3 Regression-on-schema-change

When a `protocol/schema/**/*.schema.json` file changes, CI re-runs
every transcript against every implementation. A schema edit that
invalidates an existing transcript is itself a breaking change and
MUST include either:

- A new transcript (re-captured from the updated server), OR
- A version bump on `protocol/VERSION` (major change).

---

## 9. Out of scope for Phase 0

These are NOT conformance requirements in Phase 0 but MAY be added
in later revisions:

- LLM content quality / winning strategy. The oracle is the
  transcript, not a judge of play strength.
- Performance bounds (latency, throughput). The wire protocol is not
  performance-constrained at this stage.
- Cross-transcript state (e.g. "did the runtime persist state
  correctly between transcripts"). Each transcript is independently
  runnable.
- Spectator-side `event` messages. Agent-side path is the only
  normative flow (see spec `02-message-flow.md §3`).

---

## 10. Contributor workflow

To add a new implementation:

1. Create `protocol/conformance/implementations/<name>/` with a
   README describing how to invoke it.
2. Ensure it implements §8.1 CLI shape.
3. Verify it PASSes every transcript in `protocol/transcripts/` under
   `--mode A`, and ideally under `--mode B`.
4. Register it in the CI matrix (P0-13).

To add a new transcript:

1. Capture or hand-craft per `P0-08.md` / `P0-09.md` procedures.
2. Run `protocol/tools/src/validate-transcript.ts <new.jsonl>` and
   fix any schema violations (by updating either the transcript or
   the schema — see plan §4.5 "authority").
3. Run every registered implementation's conformance binary against
   the new transcript. All must PASS.
4. Commit with a short metadata note in the commit message
   (capture context, participants, flow type).
