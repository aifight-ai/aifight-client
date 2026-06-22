// Texas Hold'em fallback policy (M1-13).
//
// Internal-only. This is intentionally a dumb selector over the
// server-provided legalActions list: it never estimates raise amounts
// and never reconstructs `data`.

import type { LegalAction } from "../../decision/types";
import type { TexasHoldemState } from "../../protocol/types";

export interface TexasHoldemFallbackInput {
  readonly publicState: TexasHoldemState;
  readonly legalActions: readonly LegalAction[];
  readonly yourPlayerId: string;
}

const TEXAS_HOLDEM_FALLBACK_PRIORITY = [
  "check",
  "call",
  "fold",
  "raise",
  "allin",
] as const;

export function fallbackTexasHoldem(
  input: TexasHoldemFallbackInput,
): LegalAction {
  const { legalActions } = input;
  if (legalActions.length === 0) {
    throw new Error("Texas Hold'em fallback requires at least one legal action");
  }

  for (const type of TEXAS_HOLDEM_FALLBACK_PRIORITY) {
    const action = legalActions.find((candidate) => candidate.type === type);
    if (action) return action;
  }

  return legalActions[0];
}
