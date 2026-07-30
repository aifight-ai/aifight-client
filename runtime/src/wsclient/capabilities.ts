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

/**
 * Capability token for the X-AIFight-Capabilities handshake header: the client
 * understands `match_feed` frames (design: docs/design/LIVE_MATCH_FEED_DESIGN_2026-07-30.md
 * v2). The server sends match_feed ONLY to connections that declare it, so an
 * undeclaring client (older runtime, third-party bot, house LLM bot) never
 * receives the feed and its behavior is unchanged.
 *
 * Kept separate from BRIDGE_CAPABILITIES on purpose: that header negotiates how
 * the server should HANG UP (close codes); this one negotiates which extra
 * message TYPES it may push. Consuming the feed is render/log only — it must
 * never reach the decision path (see state-machine.ts's match_feed arm).
 */
export const CLIENT_CAPABILITY_MATCH_FEED = "match_feed";
