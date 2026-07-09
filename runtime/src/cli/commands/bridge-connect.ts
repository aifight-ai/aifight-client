import {
  readBridgeConfig,
  redactBridgeConfig,
  writeBridgeConfig,
  type BridgeConfig,
} from "../../bridge/config";
import { exchangePairingCode } from "../../bridge/pairing";
import { getDeviceId } from "../../account/device-id";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { CommandError, expectArity } from "../shared";

const USAGE = [
  "usage: aifight connect <PAIRING_CODE> [--replace-local-identity]",
  "  Authorize this machine for an existing claimed Agent using a Dashboard pairing code.",
  "  --replace-local-identity confirms that an existing local bridge identity may be replaced.",
].join("\n");

export async function runBridgeConnect(
  args: HandlerArgs,
  env: HandlerEnv,
): Promise<number> {
  expectArity(args, 1, 1, USAGE);
  const pairingCode = args.positional[0]!;
  const existing = readOptionalBridgeConfig();
  const replaceLocalIdentity = args.flags["replace-local-identity"] === true;
  if (existing !== undefined && !replaceLocalIdentity) {
    throw new CommandError(
      "local_identity_exists",
      [
        `This machine already has local AIFight bridge credentials for ${existing.agentName} (${existing.agentId}).`,
        "A pairing code rotates an Agent API key and replaces local bridge credentials.",
        "To avoid consuming a one-time pairing code by accident, this command is blocked until you approve local identity replacement.",
        "If you are intentionally reconnecting this machine from Dashboard, rerun:",
        `  aifight connect ${pairingCode} --replace-local-identity`,
      ].join("\n"),
    );
  }
  let config: BridgeConfig;
  try {
    config = await exchangePairingCode({
      pairingCode,
      fetchImpl: env.fetchImpl,
      deviceId: getDeviceId(),
    });
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const { code, message } = classifyPairingError(raw);
    throw new CommandError(code, message);
  }
  writeBridgeConfig(config);

  if (args.jsonMode) {
    env.stdout(JSON.stringify({ status: "configured", config: redactBridgeConfig(config) }) + "\n");
    return 0;
  }

  if (existing !== undefined) {
    env.stdout(`Replaced local bridge identity ${existing.agentName} (${existing.agentId}).\n`);
  }
  env.stdout(`Bridge configured for ${config.agentName}.\n`);
  env.stdout("This machine is now the only one that can control this Agent; any previously paired machine has been signed out.\n");
  env.stdout("Next: run `aifight config` to set your LLM key on this machine, then `aifight service install`.\n");
  return 0;
}

function readOptionalBridgeConfig(): BridgeConfig | undefined {
  try {
    return readBridgeConfig();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.includes("bridge is not configured")) return undefined;
    throw cause;
  }
}

/** Refined pairing-exchange error codes. */
export type PairingErrorCode =
  | "pairing_invalid"
  | "pairing_expired"
  | "pairing_used"
  | "pairing_revoked"
  | "pairing_network"
  | "pairing_failed";

// One self-contained, actionable sentence per code. We deliberately fold the
// next step INTO the message (rather than a separate CommandError hint) so the
// --json error envelope stays exactly {code, message} — only `code` gets more
// specific — while the human line still tells the user what to do next.
const PAIRING_INVALID_MSG =
  "Pairing failed: that pairing code wasn't recognized. Copy the entire code — including the aifp_ prefix — and try again.";
const PAIRING_EXPIRED_MSG =
  "Pairing failed: that pairing code has expired. Pairing codes last 10 minutes — generate a fresh one on your Dashboard and use it right away.";
const PAIRING_USED_MSG =
  "Pairing failed: that pairing code was already used. Each code works only once — generate a new one on your Dashboard.";
const PAIRING_REVOKED_MSG =
  "Pairing failed: that pairing code was replaced by a newer one. Generating a code retires any earlier code — use the most recent one from your Dashboard.";
const PAIRING_NETWORK_MSG =
  "Pairing failed: couldn't reach AIFight. Check your internet connection and try again.";

/** Split a pairing-exchange failure into an actionable cause.
 *
 * The server (internal/auth ExchangeBridgePairing) and the runtime wrapper
 * (bridge/pairing.ts) throw plain Error strings that all used to collapse into a
 * single opaque `pairing_failed`. This re-reads the message — the only seam we own
 * between the exchange call and the user — and classifies it. It NEVER touches the
 * exchange request itself; it is a pure string classifier over the message that
 * request already produced, so it also tolerates future/older server wording by
 * falling back to `pairing_failed` with the raw text preserved. */
export function classifyPairingError(rawMessage: string): { code: PairingErrorCode; message: string } {
  const s = rawMessage.toLowerCase();
  // Server verdicts first (auth.go: "pairing_code already used" / "pairing_code
  // expired" / "invalid pairing_code"). These are the actionable, common cases.
  if (/already used/.test(s)) return { code: "pairing_used", message: PAIRING_USED_MSG };
  // A newly generated code retires older ones (auth.go ErrBridgePairingRevoked).
  // This is a common outcome of the re-pair flow, so give it its own actionable
  // copy instead of letting it collapse into the opaque pairing_failed bucket.
  if (/revoked/.test(s)) return { code: "pairing_revoked", message: PAIRING_REVOKED_MSG };
  if (/expired/.test(s)) return { code: "pairing_expired", message: PAIRING_EXPIRED_MSG };
  if (/invalid pairing/.test(s)) return { code: "pairing_invalid", message: PAIRING_INVALID_MSG };
  // Transport: readErrorMessage's non-JSON HTTP fallback ("pairing failed with
  // HTTP <status>"), the server's 503 "pairing temporarily unavailable", OR a raw
  // fetch network exception. All mean "the request never completed — try again",
  // so the next step is identical: check the connection and retry.
  if (/pairing failed with http/.test(s) || /temporarily unavailable/.test(s) || isNetworkErrorMessage(s)) {
    return { code: "pairing_network", message: PAIRING_NETWORK_MSG };
  }
  // Everything else (the unsafe-ws guard, response-parse failures, an empty code,
  // an unrecognized server error string) keeps its raw message so we never hide an
  // unexpected cause behind friendly copy.
  return { code: "pairing_failed", message: rawMessage };
}

/** Heuristic for a thrown fetch/network exception (undici + common DNS/socket
 *  errors). Conservative on purpose: anything it misses simply stays the raw
 *  `pairing_failed` message, which is safe — never a wrong actionable claim. */
function isNetworkErrorMessage(s: string): boolean {
  return /fetch failed|failed to fetch|network(?:error| error| request failed)|econnrefused|econnreset|econnaborted|enotfound|etimedout|eai_again|getaddrinfo|socket hang up|und_err|request to .* failed|timed out/.test(
    s,
  );
}
