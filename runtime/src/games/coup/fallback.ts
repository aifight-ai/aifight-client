// Coup fallback policy (M1-13).
//
// Internal-only. This is a phase-aware dumb selector over
// server-provided legalActions. It never chooses targets/roles/card
// indices by itself and never reconstructs `data`.

import type { LegalAction } from "../../decision/types";
import type { CoupState } from "../../protocol/types";

export interface CoupFallbackInput {
  readonly publicState: CoupState;
  readonly legalActions: readonly LegalAction[];
  readonly yourPlayerId: string;
}

const ACTION_PRIORITY = [
  "income",
  "foreign_aid",
  "coup",
  "tax",
  "steal",
  "assassinate",
  "exchange",
] as const;

const PASS_THEN_CHALLENGE_PRIORITY = ["pass", "challenge"] as const;
const PASS_THEN_BLOCK_PRIORITY = ["pass", "block"] as const;
const LOSE_INFLUENCE_PRIORITY = ["lose_card"] as const;
const EXCHANGE_RETURN_PRIORITY = ["return_cards"] as const;

export function fallbackCoup(input: CoupFallbackInput): LegalAction {
  const { publicState, legalActions } = input;
  if (legalActions.length === 0) {
    throw new Error("Coup fallback requires at least one legal action");
  }

  switch (publicState.phase) {
    case "action":
      return selectByPriority(legalActions, ACTION_PRIORITY);
    case "challenge_action":
    case "challenge_block":
      return selectByPriority(legalActions, PASS_THEN_CHALLENGE_PRIORITY);
    case "block":
      return selectByPriority(legalActions, PASS_THEN_BLOCK_PRIORITY);
    case "lose_influence":
      return selectByPriority(legalActions, LOSE_INFLUENCE_PRIORITY);
    case "exchange_return":
      return selectByPriority(legalActions, EXCHANGE_RETURN_PRIORITY);
    case "done":
      throw new Error("Coup fallback should not run when phase is done");
    default:
      return legalActions[0];
  }
}

function selectByPriority(
  legalActions: readonly LegalAction[],
  priority: readonly string[],
): LegalAction {
  for (const type of priority) {
    const action = legalActions.find((candidate) => candidate.type === type);
    if (action) return action;
  }
  return legalActions[0];
}
