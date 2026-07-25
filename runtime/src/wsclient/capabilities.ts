// What this bridge promises the server about how it will read the wire.
//
// Its own module so the handshake (client.ts) and the code that implements the
// promise (reconnect.ts) can share one definition without importing each other —
// and so the wsclient test suites, which mock client.ts wholesale, still see it.

/**
 * Close code the server uses to say "a NEWER connection claimed this agent".
 *
 * Only one connection per agent stays live; the older one is evicted. Without a
 * distinct code that eviction is indistinguishable from a network blip, so the
 * loser reconnects within a second, evicts the winner, and the two trade the
 * seat indefinitely (2026-07-24: 161 evictions in one hour on a single agent).
 */
export const CLOSE_CODE_REPLACED = 4409;

/**
 * Capabilities declared at handshake via X-AIFight-Bridge-Capabilities.
 *
 * The server must not use a newer wire behaviour on a client that would misread
 * it. Every bridge up to 0.1.0-beta.23 treats the whole 4000-4999 close range as
 * terminal, so being sent 4409 would stop it reconnecting for good — worse than
 * the storm. Declaring the token is how a client opts in; the server keeps the
 * old hard close for anyone who says nothing.
 */
export const BRIDGE_CAPABILITIES: readonly string[] = ["replaced-close-code"];
