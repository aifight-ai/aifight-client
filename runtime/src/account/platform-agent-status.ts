// "What does the platform think of this agent?" — one short, offline-safe GET.
//
// GET /api/agents/me/status is the authoritative answer to questions the local
// bridge.json can only guess at: is this agent claimed, does it have an official
// name, are the terms still pending. It is deliberately cheap and deliberately
// forgiving: any failure (offline, slow, old server, unparsable body) comes back
// as `unavailable` rather than throwing, so a caller can always fall back to
// whatever local signal it has.
//
// Lives here rather than inside the `status` command because the interactive
// panel needs the same answer to decide whether to warn "not claimed".

import { fetchNoFollow } from "../net/guarded-fetch.js";

export const PLATFORM_STATUS_TIMEOUT_MS = 1500;

export type PlatformAgentStatus =
  | {
    readonly kind: "ok";
    readonly agentId: string;
    readonly isClaimed: boolean;
    readonly identityStatus: "bootstrap" | "official";
    // "needs_official_name" is retired (claim is the only gate now) but kept in
    // the union so a status from an older server still parses.
    readonly status: "ready" | "needs_official_name" | "pending_claim";
    readonly name?: string;
    readonly publicNo?: number;
    readonly termsPending: boolean;
  }
  | {
    readonly kind: "unavailable";
    readonly message: string;
  };

export async function checkPlatformAgentStatus(
  config: { readonly baseUrl: string; readonly apiKey: string },
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs: number = PLATFORM_STATUS_TIMEOUT_MS,
): Promise<PlatformAgentStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchNoFollow(`${config.baseUrl.replace(/\/+$/, "")}/api/agents/me/status`, {
      method: "GET",
      headers: { "X-API-Key": config.apiKey },
      signal: controller.signal,
    }, { fetchImpl });
    if (!response.ok) {
      return { kind: "unavailable", message: `server returned HTTP ${response.status}` };
    }
    const raw = await response.json().catch(() => undefined) as unknown;
    const parsed = parsePlatformAgentStatus(raw);
    if (parsed === null) {
      return { kind: "unavailable", message: "server returned an unexpected status response" };
    }
    return parsed;
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    return { kind: "unavailable", message: name === "AbortError" ? "server check timed out" : "server check unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

export function parsePlatformAgentStatus(raw: unknown): PlatformAgentStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (
    typeof v.agent_id !== "string" ||
    typeof v.is_claimed !== "boolean" ||
    (v.identity_status !== "bootstrap" && v.identity_status !== "official") ||
    (v.status !== "ready" && v.status !== "needs_official_name" && v.status !== "pending_claim")
  ) {
    return null;
  }
  return {
    kind: "ok",
    agentId: v.agent_id,
    isClaimed: v.is_claimed,
    identityStatus: v.identity_status,
    status: v.status,
    name: typeof v.name === "string" ? v.name : undefined,
    publicNo: typeof v.public_no === "number" ? v.public_no : undefined,
    termsPending: v.terms_pending === true,
  };
}
