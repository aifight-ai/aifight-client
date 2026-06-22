// Client-side formatter for the immutable 10-digit numeric public ID
// (internal/publicno on the server). Mirrors publicno.Format: groups a 10-digit
// value as 3-3-4 for legibility, e.g. 1024384756 -> "102-438-4756". Anything
// outside the 10-digit range (legacy 0 / unassigned) is returned undecorated so
// callers never render a malformed string.

const MIN = 1_000_000_000;
const MAX = 9_999_999_999;

export function formatPublicNo(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n) || n < MIN || n > MAX) {
    return n === undefined || n === null ? "" : String(n);
  }
  const s = String(n);
  return `${s.slice(0, 3)}-${s.slice(3, 6)}-${s.slice(6, 10)}`;
}
