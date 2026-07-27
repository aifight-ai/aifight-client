// Reading a friendly-challenge token out of whatever the user pasted.
//
// Shared by `aifight accept` and by the Telegram bot, which watches ordinary
// chat messages for a challenge link — so both agree on exactly what counts as
// a token, and neither invents a looser rule.

/** Tokens are minted server-side as dl_ + 32 hex characters. */
export const CHALLENGE_TOKEN_PATTERN = /^dl_[0-9a-f]{32}$/i;

/** A bare token, or a challenge/duel URL carrying one. Null when neither. */
export function extractChallengeToken(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (CHALLENGE_TOKEN_PATTERN.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const parts = url.pathname.split("/").filter(Boolean);
    const markerIndex = parts.findIndex((p) => p === "challenge" || p === "duel");
    if (markerIndex >= 0) {
      const token = parts[markerIndex + 1];
      if (token !== undefined && CHALLENGE_TOKEN_PATTERN.test(token)) return token;
    }
  } catch {
    // Not a URL — fall through.
  }
  return null;
}

/** Find a challenge in free text (a forwarded message, a link with a sentence
 *  around it). Returns the first token found, or null. */
export function findChallengeTokenInText(text: string): string | null {
  for (const word of text.split(/\s+/)) {
    // Trim punctuation people type around a pasted link.
    const cleaned = word.replace(/[),.;!?"'\]]+$/, "").replace(/^[("'[]+/, "");
    const token = extractChallengeToken(cleaned);
    if (token !== null) return token;
  }
  return null;
}
