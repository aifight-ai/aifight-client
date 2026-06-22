// Texas Hold'em LLM action parser (M1-14).
//
// Internal-only. Consumed by `runtime/src/decision/provider.ts` after
// `client.generate()` returns. Returns a `ParseResult`: on `kind: "ok"`,
// `action` is either the original server-provided `LegalAction`
// reference (check / call / fold / allin) or a fresh `{type:"raise",
// data:{amount}}` object (raise — LLM picks the concrete amount within
// the server-provided [min, max] window).
//
// Texas-specific data validation:
//   - call:  trust legalActions[i].data.amount as-is (server final).
//   - raise: parsed.data.amount must be a number within
//            [legalAction.data.min ?? legalAction.data.amount,
//             legalAction.data.max ?? legalAction.data.amount].
//            Returns reconstructed `{type:"raise", data:{amount}}`.
//   - fold / check / allin: data is ignored; server reference returned.

import type { LegalAction } from "../../decision/types";
import type { ParseInvalidReason, ParseResult } from "../../decision/parser-types";

const DEFAULT_RAW_SNIPPET_CAP = 500;
const FENCED_JSON_PATTERN = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/;

export function parseTexasHoldemAction(
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

  if (!TEXAS_ACTION_TYPES.has(actionType)) {
    return invalid("unknown_action_type", trimmed, rawSnippetCap);
  }

  const candidate = legalActions.find((entry) => entry.type === actionType);
  if (!candidate) {
    return invalid("action_not_legal", trimmed, rawSnippetCap);
  }

  if (actionType === "raise") {
    const reconstructed = buildRaiseAction(candidate, parsedData);
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

const TEXAS_ACTION_TYPES = new Set(["fold", "check", "call", "raise", "allin"]);

function buildRaiseAction(
  legalRaise: LegalAction,
  parsedData: Record<string, unknown> | undefined,
): LegalAction | undefined {
  if (!parsedData) return undefined;
  const amount = parsedData.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount)) return undefined;

  const serverData = isPlainObject(legalRaise.data) ? legalRaise.data : undefined;
  const serverAmount = readNumber(serverData, "amount");
  const min = readNumber(serverData, "min") ?? serverAmount;
  const max = readNumber(serverData, "max") ?? serverAmount;

  if (min !== undefined && amount < min) return undefined;
  if (max !== undefined && amount > max) return undefined;

  return { type: "raise", data: { amount } };
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
