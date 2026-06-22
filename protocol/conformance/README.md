# protocol/conformance — Cross-Language Conformance Tests

Given a golden transcript (`../transcripts/*.jsonl`) and a predetermined
mock-LLM decision script, different language implementations of the
AIFight runtime must produce **identical** client-to-server sequences
and reach the same final state.

**Purpose:** Catch protocol drift between implementations before it
reaches users. Phase 0 target: Go conformance test (verifies the
transcripts + schemas are self-consistent against the deployed server).
M1 adds Node implementation; future Go/Rust runtime ports add theirs.

## Layout

```
conformance/
  README.md                         — you are here
  replay-test-spec.md               — the test contract
  implementations/
    go/                             — Phase 0 (P0-12)
      main.go
      go.mod
      README.md
    node/                           — M1 (M1-22, fills in alongside runtime build)
      package.json
      src/
      README.md
```

## Test contract (summary — full in `replay-test-spec.md`)

Given:
- A transcript `T = [msg_0, msg_1, ...]`
- A mock-LLM decision function `f(request) → action` deterministic over the
  transcript

Expected:
1. For each `msg_i` with `direction = server_to_client`: the impl must
   consume without throwing / rejecting.
2. For each `msg_i` with `direction = client_to_server`: if the impl is
   driving the transcript from a replayed-server mode, it must **emit a
   message equal to `msg_i.payload`** (modulo timestamps and client
   request IDs).
3. The final state reachable from consuming the transcript (e.g., last
   `game_over` payload's `winner` / `rating_delta`) must match the
   transcript's final state.

## CI gate

PR touching `../schema/` or `../spec/` or `../transcripts/` must pass:
- `../tools/validate-transcript.ts` on all transcripts
- `implementations/go/` conformance test

When `implementations/node/` exists (M1+), the same PR must pass both
Go and Node conformance.
