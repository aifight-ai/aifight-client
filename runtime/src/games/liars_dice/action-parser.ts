// Liar's Dice LLM action parser (M1-14).
//
// Internal-only. Consumed by `runtime/src/decision/provider.ts` after
// `client.generate()` returns. Returns a `ParseResult`: on `kind: "ok"`,
// `action` is either the original server-provided `LegalAction`
// reference (challenge) or a fresh `{type:"bid", data:{quantity, face}}`
// object (bid — LLM picks within server-provided hint window).
//
// Bid validation rules (M1-14 拍板点 #14):
//   - quantity / face must be finite numbers.
//   - face must be in [1, 6].
//   - When bid LegalAction.data carries server hints
//     (min_quantity / min_face / max_quantity), enforce:
//       quantity >= min_quantity, quantity <= max_quantity,
//       and if quantity === min_quantity then face >= min_face
//       (same-quantity bids must raise the face value);
//       if quantity > min_quantity, face is unconstrained 1..6.
//   - When hints are absent (server bug), fall back to weak validation
//     (numbers + face range only); fallback policy in `decision/provider`
//     handles the residual gap.

import type { LegalAction } from "../../decision/types";
import type { ParseInvalidReason, ParseResult } from "../../decision/parser-types";

const DEFAULT_RAW_SNIPPET_CAP = 500;
const FENCED_JSON_PATTERN = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/;

export function parseLiarsDiceAction(
  rawText: string,
  legalActions: readonly LegalAction[],
  rawSnippetCap: number = DEFAULT_RAW_SNIPPET_CAP,
): ParseResult {
  const trimmed = rawText.trim();
  const stripped = stripMarkdownFence(trimmed);

  let envelope: unknown;
  try {
    envelope = JSON.parse(stripped);
  } catch {
    return invalid("json_parse", trimmed, rawSnippetCap);
  }

  if (!isPlainObject(envelope)) {
    return invalid("missing_fields", trimmed, rawSnippetCap);
  }

  const actionType = envelope.action;
  if (typeof actionType !== "string") {
    return invalid("missing_fields", trimmed, rawSnippetCap);
  }

  const summary = typeof envelope.summary === "string" ? envelope.summary : undefined;
  const dataField = envelope.data;
  if (dataField !== undefined && dataField !== null && !isPlainObject(dataField)) {
    return invalid("missing_fields", trimmed, rawSnippetCap);
  }
  const parsedData = isPlainObject(dataField) ? dataField : undefined;

  if (!LIARS_DICE_ACTION_TYPES.has(actionType)) {
    return invalid("unknown_action_type", trimmed, rawSnippetCap);
  }

  const candidate = legalActions.find((entry) => entry.type === actionType);
  if (!candidate) {
    return invalid("action_not_legal", trimmed, rawSnippetCap);
  }

  if (actionType === "bid") {
    const reconstructed = buildBidAction(candidate, parsedData);
    if (!reconstructed) {
      return invalid("data_validation", trimmed, rawSnippetCap);
    }
    return summary !== undefined
      ? { kind: "ok", action: reconstructed, summary }
      : { kind: "ok", action: reconstructed };
  }

  return summary !== undefined
    ? { kind: "ok", action: candidate, summary }
    : { kind: "ok", action: candidate };
}

const LIARS_DICE_ACTION_TYPES = new Set(["bid", "challenge"]);

function buildBidAction(
  legalBid: LegalAction,
  parsedData: Record<string, unknown> | undefined,
): LegalAction | undefined {
  if (!parsedData) return undefined;

  const quantity = parsedData.quantity;
  const face = parsedData.face;
  if (
    typeof quantity !== "number" ||
    !Number.isFinite(quantity) ||
    !Number.isInteger(quantity) ||
    typeof face !== "number" ||
    !Number.isFinite(face) ||
    !Number.isInteger(face)
  ) {
    return undefined;
  }
  if (face < 1 || face > 6) return undefined;
  if (quantity < 1) return undefined;

  const hints = isPlainObject(legalBid.data) ? legalBid.data : undefined;
  const minQuantity = readNumber(hints, "min_quantity");
  const minFace = readNumber(hints, "min_face");
  const maxQuantity = readNumber(hints, "max_quantity");

  if (minQuantity !== undefined && quantity < minQuantity) return undefined;
  if (maxQuantity !== undefined && quantity > maxQuantity) return undefined;
  if (
    minQuantity !== undefined &&
    minFace !== undefined &&
    quantity === minQuantity &&
    face < minFace
  ) {
    return undefined;
  }

  return { type: "bid", data: { quantity, face } };
}

function stripMarkdownFence(text: string): string {
  const match = text.match(FENCED_JSON_PATTERN);
  return match ? match[1].trim() : text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readNumber(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  if (!record) return undefined;
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function invalid(
  reason: ParseInvalidReason,
  rawText: string,
  cap: number,
): ParseResult {
  return {
    kind: "invalid",
    reason,
    rawSnippet: rawText.length > cap ? rawText.slice(0, cap) : rawText,
  };
}
