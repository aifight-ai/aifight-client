// Which PROGRAM is running an agent: the desktop app or the CLI.
//
// The server binds an agent to one machine AND one client kind, so this value
// travels on two requests — the WebSocket handshake (X-AIFight-Client-Kind) and
// the pairing exchange, where it decides who wins the seat.
//
// It is always DECLARED by the caller, never inferred from the running process,
// and the desktop app is the reason. Its "move this agent here" button redeems
// the code through this very CLI's connect path, so anything derived from the
// program actually executing would read the app as a CLI and lock the app out
// of the pairing it just started. `aifight connect` therefore defaults to "cli"
// and the desktop passes --client-kind desktop.
//
// Its own module (rather than an export on pairing.ts or runner.ts) so tests can
// replace those modules wholesale without dragging this constant along.

export type BridgeClientKind = "desktop" | "cli";

export const BRIDGE_CLIENT_KINDS: readonly BridgeClientKind[] = ["desktop", "cli"];

/** The kind assumed when nobody declares one: a direct `aifight connect`. */
export const DEFAULT_BRIDGE_CLIENT_KIND: BridgeClientKind = "cli";

/** Parse a declared client kind, tolerating case and padding (it arrives as a
 *  command-line value or an HTTP header). Returns undefined for anything the
 *  two real clients don't use, which callers surface as a usage error rather
 *  than quietly connecting as the wrong program. */
export function parseBridgeClientKind(raw: unknown): BridgeClientKind | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim().toLowerCase();
  return BRIDGE_CLIENT_KINDS.find((k) => k === v);
}
