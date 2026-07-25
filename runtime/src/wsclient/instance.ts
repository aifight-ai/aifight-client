// Process connection-instance identity (reconnect redesign 2026-07-25, P3).
//
// One id per PROCESS lifetime, sent on every WS handshake as
// X-AIFight-Instance. The server compares the ids of the old and new
// connection when a newer one evicts an older one, and tells the EVICTED side
// only a boolean ("same_instance") in the 4409 close reason. That boolean is
// what lets a client distinguish "my own process reconnected over a stale
// socket of mine" (normal — stand down silently is fine, the successor is us)
// from "another machine/client took the seat" (park and probe politely).
//
// Deliberately a boolean on the wire, never the raw id: echoing the WINNER's
// id to the LOSER would teach an attacker (any api-key holder who gets
// evicted) the victim's current instance id, which they could then replay to
// make the victim classify a hostile takeover as "myself" — a forgeable
// silent kill. The server owns the comparison instead (审查裁定 F9/F10).
//
// 24 lowercase hex chars: comfortably under the server's 64-byte clamp and
// within its charset whitelist.
import { randomBytes } from "node:crypto";

export const PROCESS_INSTANCE_ID: string = randomBytes(12).toString("hex");
