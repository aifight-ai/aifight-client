// Liar's Dice fallback policy (M1-13).
//
// Internal-only. Liar's Dice is the one M1-13 exception to the
// "return original LegalAction reference" rule for bid: the server's
// bid LegalAction.data carries hint fields, so fallback constructs the
// actual { quantity, face } payload from those hints.

import type { LegalAction } from "../../decision/types";
import type { LiarsDiceState } from "../../protocol/types";

export interface LiarsDiceFallbackInput {
  readonly publicState: LiarsDiceState;
  readonly legalActions: readonly LegalAction[];
  readonly yourPlayerId: string;
}

interface BidHints {
  readonly minQuantity?: number;
  readonly minFace?: number;
  readonly maxQuantity?: number;
}

export function fallbackLiarsDice(input: LiarsDiceFallbackInput): LegalAction {
  const { publicState, legalActions } = input;
  if (legalActions.length === 0) {
    throw new Error("Liar's Dice fallback requires at least one legal action");
  }

  const bidAction = legalActions.find((action) => action.type === "bid");
  const challengeAction = legalActions.find((action) => action.type === "challenge");

  if (bidAction) {
    const bidFromHints = buildBidFromHints(bidAction.data);
    if (bidFromHints) {
      if (
        bidFromHints.maxQuantity !== undefined &&
        bidFromHints.minQuantity > bidFromHints.maxQuantity
      ) {
        return challengeAction ?? legalActions[0];
      }
      return {
        type: "bid",
        data: {
          quantity: bidFromHints.minQuantity,
          face: bidFromHints.minFace,
        },
      };
    }

    const backupBid = buildBidFromPublicState(publicState);
    if (backupBid) {
      if (
        typeof publicState.total_dice === "number" &&
        backupBid.quantity > publicState.total_dice
      ) {
        return challengeAction ?? legalActions[0];
      }
      return { type: "bid", data: backupBid };
    }
  }

  if (challengeAction) return challengeAction;
  return legalActions[0];
}

function buildBidFromHints(data: unknown): Required<Pick<BidHints, "minQuantity" | "minFace">> &
  Pick<BidHints, "maxQuantity"> | undefined {
  const d = asRecord(data);
  if (!d) return undefined;

  const minQuantity = readNumber(d, "min_quantity");
  const minFace = readNumber(d, "min_face");
  if (minQuantity === undefined || minFace === undefined) return undefined;

  return {
    minQuantity,
    minFace,
    maxQuantity: readNumber(d, "max_quantity"),
  };
}

function buildBidFromPublicState(
  state: LiarsDiceState,
): { readonly quantity: number; readonly face: number } | undefined {
  const currentBid = state.current_bid;
  if (!currentBid) {
    if (typeof state.total_dice !== "number") return undefined;
    return { quantity: 1, face: 1 };
  }

  if (
    typeof currentBid.quantity !== "number" ||
    typeof currentBid.face !== "number"
  ) {
    return undefined;
  }

  if (currentBid.face < 6) {
    return { quantity: currentBid.quantity, face: currentBid.face + 1 };
  }
  return { quantity: currentBid.quantity + 1, face: 1 };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}
