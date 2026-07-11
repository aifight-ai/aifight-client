// Shared admission/concurrency bound for one agent (R13-F02).
//
// ONE source of truth read by three places so the readiness handshake and the
// local admission gate can never drift apart:
//   • agents/state-machine.ts gameStart — refuses NEW match admissions past this.
//   • agents/agent.ts               — the in-flight decision "busy" count.
//   • bridge/runner.ts readiness     — the value the server probe is answered with.
//
// A generous ceiling: it catches a stuck pile-up (duplicate/superseding
// action_requests, a wedged provider) rather than throttling normal concurrent
// play — a single user on their own key is nowhere near 8 simultaneous matches.
export const MAX_CONCURRENT_MATCHES = 8;
