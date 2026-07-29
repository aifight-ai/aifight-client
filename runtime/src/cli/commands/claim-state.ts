// "Is this agent claimed?" — for the interactive panel's warning banner.
//
// An unclaimed agent cannot play anything: it sits online, joins nothing, and
// the only thing standing between it and a real match is a link the user has to
// open once. The owner finished a whole VPS install and never saw a reminder
// (2026-07-29), so the panel now leads with one — which makes getting the answer
// RIGHT the thing that matters. A false "not claimed" is its own bug.
//
// Two signals, in order:
//   1. The platform (GET /api/agents/me/status) — authoritative. Also the moment
//      to scrub the single-use claim credentials, which is what keeps signal 2
//      honest for the next offline run.
//   2. bridge.json's claimUrl — a local fallback for when the platform can't be
//      reached. It is present until some client observes is_claimed=true, so on
//      its own it can lag; it never over-reports "claimed", only under-reports.

import { checkPlatformAgentStatus } from "../../account/platform-agent-status";
import { dropClaimCredentialsAfterClaim, readBridgeConfig } from "../../bridge/config";

export interface ClaimState {
  readonly pending: boolean;
  readonly url?: string;
  readonly agentName?: string;
}

/**
 * Resolve the claim banner's state. Never throws and never blocks for long: an
 * unreachable platform falls back to the local signal, and a missing/unreadable
 * bridge.json returns undefined ("nothing to say").
 */
export async function resolveClaimState(fetchImpl?: typeof fetch): Promise<ClaimState | undefined> {
  let config;
  try {
    config = readBridgeConfig();
  } catch {
    return undefined;
  }

  const local: ClaimState = {
    pending: config.claimUrl !== undefined,
    ...(config.claimUrl !== undefined ? { url: config.claimUrl } : {}),
    ...(config.agentName !== undefined ? { agentName: config.agentName } : {}),
  };

  // Already believed claimed locally: nothing to warn about and nothing the
  // platform could add, so skip the request entirely.
  if (!local.pending) return local;

  const status = await checkPlatformAgentStatus(config, fetchImpl);
  if (status.kind !== "ok") return local; // offline / old server → local signal
  if (!status.isClaimed) {
    return { ...local, ...(status.name !== undefined ? { agentName: status.name } : {}) };
  }

  // Claimed on the platform but the local artifacts are still on disk — this is
  // exactly the "claimed in the browser, never ran `aifight status`" case that
  // would otherwise show a wrong warning forever. Scrub and report the truth.
  dropClaimCredentialsAfterClaim();
  const name = status.name ?? config.agentName;
  return { pending: false, ...(name !== undefined ? { agentName: name } : {}) };
}
