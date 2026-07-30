// Formatting helpers for CLI human-mode output.
//
// All functions return a single string ready to write to stdout (caller
// adds trailing newline if needed). JSON-mode emission is the caller's
// responsibility (handlers JSON.stringify the server response themselves).
//
// Internal-only — not re-exported.

/** Compose a JSON-mode error envelope. Used by main.ts error funnel and
 *  by handlers that surface a usage error in JSON mode. */
export function jsonErrorEnvelope(
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): string {
  const body: { error: { code: string; message: string; details?: Readonly<Record<string, unknown>> } } =
    details === undefined
      ? { error: { code, message } }
      : { error: { code, message, details } };
  return JSON.stringify(body) + "\n";
}
