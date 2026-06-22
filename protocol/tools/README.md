# protocol/tools — Schema Utilities

TypeScript / Node scripts for validating, generating, and maintaining the
protocol artifacts. Run under Node 22.14+ (24.x recommended; see plan
ADR-020).

## Planned scripts (Phase 0)

| Script | Purpose | Phase 0 task |
|--------|---------|--------------|
| `validate-transcript.ts` | Parse a JSONL transcript, validate every message against the matching schema from `../schema/messages/`. Fails loudly on violations. | P0-09 |
| `codegen.ts` | Generate TypeScript types from `../schema/`, write to `runtime/src/protocol/types.ts`. Uses `json-schema-to-typescript`. Diff against checked-in generated files in CI. | P0-10 |
| `dump-server-transcript.ts` | Server-side helper (Go port or wrapper) used by `LOG_PROTOCOL_TRANSCRIPTS=<dir>` mode to write JSONL as matches play out. Or a pure Node triage tool that reads Go's raw dumps and rewrites into the canonical transcript format. | P0-07 supporting |
| `lint.ts` | Static checks on `../schema/`: every schema has `$id`, `title`, `description`, `additionalProperties: false`; filenames match `$id` pattern; no orphaned `$ref`. | P0-09 supporting |

## Package layout

```
protocol/tools/
  package.json           private, name: @aifight/protocol-tools
  tsconfig.json
  src/
    validate-transcript.ts
    codegen.ts
    lint.ts
  tests/
```

`package.json` is `"private": true` — this is internal build tooling,
not published.

## Node baseline

`"engines": { "node": ">=22.14" }` per ADR-020. Test matrix: 22.14+, 24.x.
22.0–22.13 excluded.
