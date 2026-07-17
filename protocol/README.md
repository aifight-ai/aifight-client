# AIFight Protocol (v1.2.0)

This directory is the **structural source of truth** for the AIFight wire protocol
between the `aifight` TypeScript runtime/Desktop client and the AIFight Go server.

**Current status:** protocol `v1.2.0`; schema/spec/transcript tooling remains active.
The 2026-04 Phase-0 plans and sign-off logs are historical and archived, not
current implementation instructions. Cross-domain status lives in
[`docs/CURRENT_STATE.md`](../docs/CURRENT_STATE.md).

## Authority (v1.1.1 refinement)

| Aspect | Source of truth |
|--------|------------------|
| Structure (field names, types, required, enums) | `schema/*.json` (JSON Schema draft-07) |
| Behavior & timing (state machine, timeouts, ordering) | Deployed Go server + `transcripts/*.jsonl` (golden transcripts as acceptance oracle) |
| Narrative / rationale | `spec/*.md` |

When the three sources disagree: **server behavior is truth.** Schema must
reflect reality (fix the Schema if it drifts); Markdown spec is corrected
to match; transcripts are re-recorded and committed.

## Directory layout

```
protocol/
  VERSION                  v1.2.0 (semver)
  schema/                  JSON Schema for every message + game payload
    messages/              WebSocket messages (server_*.json, client_*.json)
    games/{texas_holdem,liars_dice,coup}/   game-specific state/action/event
    rest/                  runtime-facing REST endpoints only
    common/                shared types (error, rating, player)
  spec/                    normative Markdown (behavior, timing, rationale)
    00-overview.md
    01-connection-lifecycle.md
    02-message-flow.md
    03-error-handling.md
    04-games/{texas_holdem,liars_dice,coup}.md
  transcripts/             golden message transcripts (JSONL)
    happy_path/
    edge_cases/
  conformance/             cross-language conformance tests
    replay-test-spec.md
    implementations/go/
    implementations/node/   (M1)
  tools/                   codegen + validation
    validate-transcript.ts
    codegen.ts
    dump-server-transcript.ts
    lint.ts
```

## Contribution rules

- All PRs touching this directory must pass `tools/validate-transcript` and
  `conformance/implementations/go` CI gates.
- TypeScript types in `runtime/src/protocol/types.ts` are **auto-generated** by
  `tools/codegen.ts` from the schemas in this directory. Do not edit by hand.
- Go backend does not codegen yet (Phase 0 reverse-dumps existing Go types
  into Schema as the starting snapshot; subsequent drift fixed manually with
  CI gate).

## Version policy

- `VERSION` uses semver. Breaking wire-protocol changes require major bump.
  (One documented, owner-approved exception: the 2026-07-16 in-place revision
  of v1.2.0 — the `action.request_id` echo became REQUIRED and the server now
  refuses < v1.2.0 handshakes. Pre-launch, zero affected users, and a major
  bump would have hard-refused every shipped conformant client; full
  rationale in `spec/00-overview.md` Version history.)
- Backend and runtime both declare their supported protocol version on
  connect (`welcome.server_protocol_version`); mismatch triggers clear
  error, not silent failure.
- Protocol changes must record actual server behavior, update schema, re-record
  affected transcripts, regenerate types, and pass conformance checks in the
  same change.
