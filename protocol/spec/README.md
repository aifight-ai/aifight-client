# protocol/spec — Normative Markdown Specification

JSON Schema only describes **structure**, not behavior or timing. This
directory documents the normative behavior of the AIFight wire protocol.

**Authority:** `../schema/` is the source of truth for structure; this
directory is the source of truth for behavior narrative. When they
disagree, the deployed Go server + `../transcripts/*.jsonl` are the final
arbiter (see `../README.md` Authority table).

## Files (Phase 0 targets)

| File | Contents |
|------|----------|
| `00-overview.md` | Protocol summary, version policy, backward compatibility commitments |
| `01-connection-lifecycle.md` | WebSocket establishment, authentication, keepalive (25s client ping vs 60s server timeout), graceful close, reconnect semantics |
| `02-message-flow.md` | Complete message sequence diagrams (ASCII + mermaid); state machine transitions with conditions |
| `03-error-handling.md` | Error codes, retry policy, timeout semantics, forfeit rules |
| `04-games/texas_holdem.md` | Legal-action generator; state field semantics; action enum details |
| `04-games/liars_dice.md` | Same |
| `04-games/coup.md` | Same |

## Cross-references

Each `.md` file references `../schema/` by relative link, not by duplicating
field definitions. Example:

> After authentication, server sends `welcome`
> (schema: [`messages/server_welcome.schema.json`](../schema/messages/server_welcome.schema.json)).
> The `server_protocol_version` field signals wire-protocol compatibility...

## Acceptance oracle reminder

Adding or changing behavior here is **not enough** — the matching transcript
in `../transcripts/` must also be re-recorded to validate that the deployed
server actually implements the behavior. Phase 0 task P0-08 + P0-12 covers
the Go conformance test against these transcripts.
