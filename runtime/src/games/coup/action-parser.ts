// Coup LLM action parser (M1-14).
//
// Internal-only. Consumed by `runtime/src/decision/provider.ts` after
// `client.generate()` returns. Coup never reconstructs `data` — every
// targeted variant (coup / assassinate / steal target, block role,
// lose_card index, return_cards index combo) is enumerated by the
// server in `legalActions`, so the parser looks up the matching entry
// and returns the original `LegalAction` reference (reference equality
// holds for every successful parse).
//
// Phase / data contract per action type:
//   - income / foreign_aid / tax / exchange / challenge / pass:
//       data optional, ignored, server reference returned.
//   - coup / assassinate / steal: data.target must equal one of the
//       enumerated `target` values; matching server entry returned.
//   - block: data.role must equal one of the enumerated `role` values.
//   - lose_card: data.card_index must equal one of the enumerated
//       `card_index` values.
//   - return_cards: data.return_indices must be an integer array and
//       must equal one of the enumerated `return_indices` arrays
//       (order-sensitive — server enumeration defines canonical order).

import type { LegalAction } from "../../decision/types";
import type { ParseInvalidReason, ParseResult } from "../../decision/parser-types";

const DEFAULT_RAW_SNIPPET_CAP = 500;
const FENCED_JSON_PATTERN = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/;

const COUP_ACTION_TYPES = new Set([
  "income",
  "foreign_aid",
  "coup",
  "tax",
  "assassinate",
  "steal",
  "exchange",
  "challenge",
  "pass",
  "block",
  "lose_card",
  "return_cards",
]);

export function parseCoupAction(
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

  if (!COUP_ACTION_TYPES.has(actionType)) {
    return invalid("unknown_action_type", trimmed, rawSnippetCap);
  }

  const matchesByType = legalActions.filter((entry) => entry.type === actionType);
  if (matchesByType.length === 0) {
    return invalid("action_not_legal", trimmed, rawSnippetCap);
  }

  const matched = matchByDataShape(actionType, matchesByType, parsedData);
  if (!matched) {
    return invalid("data_validation", trimmed, rawSnippetCap);
  }

  return summary !== undefined
    ? { kind: "ok", action: matched, summary }
    : { kind: "ok", action: matched };
}

function matchByDataShape(
  actionType: string,
  candidates: readonly LegalAction[],
  parsedData: Record<string, unknown> | undefined,
): LegalAction | undefined {
  switch (actionType) {
    case "coup":
    case "assassinate":
    case "steal": {
      const target = parsedData?.target;
      if (typeof target !== "string") return undefined;
      return candidates.find(
        (entry) => readString(entry.data, "target") === target,
      );
    }
    case "block": {
      const role = parsedData?.role;
      if (typeof role !== "string") return undefined;
      return candidates.find(
        (entry) => readString(entry.data, "role") === role,
      );
    }
    case "lose_card": {
      const cardIndex = parsedData?.card_index;
      if (
        typeof cardIndex !== "number" ||
        !Number.isFinite(cardIndex) ||
        !Number.isInteger(cardIndex)
      ) {
        return undefined;
      }
      return candidates.find(
        (entry) => readNumber(entry.data, "card_index") === cardIndex,
      );
    }
    case "return_cards": {
      const returnIndices = parsedData?.return_indices;
      if (!Array.isArray(returnIndices)) return undefined;
      if (
        !returnIndices.every(
          (value) =>
            typeof value === "number" &&
            Number.isFinite(value) &&
            Number.isInteger(value),
        )
      ) {
        return undefined;
      }
      return candidates.find((entry) => {
        const serverIndices = readNumberArray(entry.data, "return_indices");
        return serverIndices !== undefined && arraysEqual(serverIndices, returnIndices);
      });
    }
    default:
      // income / foreign_aid / tax / exchange / challenge / pass —
      // data is irrelevant, single server entry is canonical.
      return candidates[0];
  }
}

function stripMarkdownFence(text: string): string {
  const match = text.match(FENCED_JSON_PATTERN);
  return match ? match[1].trim() : text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(data: unknown, key: string): string | undefined {
  if (!isPlainObject(data)) return undefined;
  const value = data[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(data: unknown, key: string): number | undefined {
  if (!isPlainObject(data)) return undefined;
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNumberArray(data: unknown, key: string): number[] | undefined {
  if (!isPlainObject(data)) return undefined;
  const value = data[key];
  if (!Array.isArray(value)) return undefined;
  if (
    !value.every(
      (entry) => typeof entry === "number" && Number.isFinite(entry),
    )
  ) {
    return undefined;
  }
  return value;
}

function arraysEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
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
