# protocol/tools/generated

Auto-generated artifacts. Do not edit by hand.

## `types.ts`

TypeScript type definitions for every schema under `protocol/schema/`,
produced by `protocol/tools/src/codegen.ts`. Regenerate with:

```bash
cd protocol/tools
npm run codegen
```

The output is **deterministic** — same schemas produce a byte-identical
file. CI (P0-13) asserts `git diff generated/types.ts` is empty after
running codegen; schema edits must therefore ship with a regenerated
types.ts in the same PR.

### Consumer contract (P0-10 "方案 A")

M1 runtime will **copy** this file into its own package:

```
runtime/src/protocol/types.ts                       ← copied from here
```

A trivial copy step in those packages' build scripts is enough; no
symlink or import-from-here, because downstream packages get
individually published and should carry their own types.ts.

### Naming conventions

- `common/*.schema.json`  → `export interface <Title>` (e.g. `Action`,
  `Event`, `Rules`, `ErrorPayload`)
- `messages/*.schema.json`  → `export interface Msg<Title>` (e.g.
  `MsgWelcome`, `MsgGameStart`, `MsgAction`). The `Msg` prefix
  deliberately disambiguates against the common envelopes that share
  a bare-word title.
- `games/<game>/*.schema.json`  → `export interface <Title>` where
  `<Title>` is already game-prefixed (e.g. `TexasHoldemState`,
  `LiarsDiceAction`, `CoupEvent`)
- `rest/*.schema.json`  → `export interface <Title>` (e.g.
  `RegisterRequest`, `AgentStatusResponse`)
- Terminal union:  `export type WSMessage = MsgWelcome | … | MsgAction`

### Usage in runtime

```ts
import type { WSMessage, MsgWelcome, MsgActionRequest } from "./protocol/types";

function handle(msg: WSMessage) {
  switch (msg.type) {
    case "welcome": {
      const w: MsgWelcome = msg;
      // w.data.server_protocol_version is strongly typed
      return handshake(w);
    }
    case "action_request": {
      const r: MsgActionRequest = msg;
      return decide(r);
    }
    // …full discriminated-union narrowing via `msg.type` const strings
  }
}
```
