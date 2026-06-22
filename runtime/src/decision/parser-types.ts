// Shared types for per-game LLM action parsers (M1-14).
//
// `parseTexasHoldemAction` / `parseLiarsDiceAction` / `parseCoupAction`
// each take rawText (LLM completion) + legalActions (server-enumerated)
// and return a discriminated `ParseResult`. M1-14 `decision/provider.ts`
// dispatches on `req.game` and threads the result into either the
// happy path (return as `DecisionResponse`) or the corrective re-prompt
// path (insert `reason` + truncated `rawSnippet` into the next user
// prompt for one more retry).
//
// This module is types-only: no runtime symbols, no fetch, no IO.
// Importers should use `import type { ... } from "./parser-types"`.

import type { LegalAction } from "./types";

export type ParseInvalidReason =
  | "json_parse"
  | "missing_fields"
  | "unknown_action_type"
  | "action_not_legal"
  | "data_validation";

export type ParseResult =
  | {
      readonly kind: "ok";
      /**
       * For simple / server-enumerated actions, this is the original
       * server-provided `LegalAction` reference (reference equality
       * holds against the matching entry in `legalActions`). For
       * Texas Hold'em `raise` and Liar's Dice `bid`, the LLM picks
       * the concrete amount / quantity-face within the server hints,
       * so the parser constructs a fresh `{ type, data }` object —
       * reference equality with `legalActions[i]` does NOT hold for
       * those two cases (M1-14 拍板点 #5 + Risks #10).
       */
      readonly action: LegalAction;
      /**
       * Optional one-line reasoning extracted from the LLM JSON
       * (`{"summary": ...}`). M1-14 provider passes this through to
       * `DecisionResponse.summary` without re-parsing.
       */
      readonly summary?: string;
    }
  | {
      readonly kind: "invalid";
      readonly reason: ParseInvalidReason;
      /**
       * Up to `parseRetryHintCharCap` chars (default 500) of the raw
       * LLM output, used to populate the corrective re-prompt. Parser
       * is responsible for truncation; provider does not re-truncate.
       */
      readonly rawSnippet?: string;
    };
