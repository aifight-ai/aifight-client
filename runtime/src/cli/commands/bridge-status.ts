import { formatPublicNo } from "../../account/public-no";
import { dropClaimCredentialsAfterClaim, readBridgeConfig, redactBridgeConfig } from "../../bridge/config";
import { checkBridgeUpdate } from "../../bridge/update-check";
import { RUNTIME_VERSION } from "../../index";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { expectArity } from "../shared";
import type { BridgeConfig } from "../../bridge/config";

const USAGE = "usage: aifight status";
const STATUS_TIMEOUT_MS = 1500;

type PlatformAgentStatus =
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

export async function runBridgeStatus(
  args: HandlerArgs,
  env: HandlerEnv,
): Promise<number> {
  expectArity(args, 0, 0, USAGE);
  const config = readOptionalBridgeConfig();
  if (config === undefined) {
    if (args.jsonMode) {
      env.stdout(JSON.stringify({ status: "not_configured", bridgeVersion: RUNTIME_VERSION }) + "\n");
    } else {
      env.stdout("AIFight status\n\n");
      env.stdout("Bridge: not configured\n");
      env.stdout(`CLI version: ${RUNTIME_VERSION}\n`);
      env.stdout("Next: run `aifight setup` for a new agent, or `aifight connect <PAIRING_CODE>` for an existing agent.\n");
    }
    return 0;
  }
  const redacted = redactBridgeConfig(config);
  const update = await checkBridgeUpdate({
    baseUrl: config.baseUrl,
    currentVersion: RUNTIME_VERSION,
    fetchImpl: env.fetchImpl,
  });
  const platformAgentStatus = await checkPlatformAgentStatus(config, env.fetchImpl);
  // F10: the claim token/URL are single-use — once the platform reports the
  // agent claimed, scrub them from local storage.
  if (platformAgentStatus.kind === "ok" && platformAgentStatus.isClaimed) {
    dropClaimCredentialsAfterClaim();
  }

  if (args.jsonMode) {
    env.stdout(JSON.stringify({
      status: "configured",
      bridgeVersion: RUNTIME_VERSION,
      update,
      platformAgentStatus,
      config: redacted,
    }) + "\n");
    return 0;
  }

  env.stdout("AIFight status\n\n");
  // Prefer the server-authoritative name (reflects a rename from any device);
  // fall back to the locally cached name when the status check is unavailable.
  const serverName = platformAgentStatus.kind === "ok" ? platformAgentStatus.name : undefined;
  const publicNo = platformAgentStatus.kind === "ok" ? platformAgentStatus.publicNo : undefined;
  const idSuffix = publicNo !== undefined ? `  (ID ${formatPublicNo(publicNo)})` : "";
  env.stdout(`Agent: ${serverName ?? redacted.agentName}${idSuffix}\n`);
  env.stdout(`Profile: ${profileLabel(platformAgentStatus, config)}\n`);
  if (platformAgentStatus.kind === "unavailable") {
    env.stdout(`Profile check: ${platformAgentStatus.message}\n`);
  }
  if (platformAgentStatus.kind === "ok" && platformAgentStatus.termsPending) {
    const dashUrl = `${config.baseUrl.replace(/\/+$/, "")}/dashboard`;
    env.stdout("Action needed: updated Terms/Privacy must be accepted to keep your agent active.\n");
    env.stdout(`  Accept in the CLI: aifight accept-terms   (or in the browser: ${dashUrl})\n`);
  }
  env.stdout("Bridge: configured\n");
  env.stdout(`CLI version: ${RUNTIME_VERSION}\n`);
  env.stdout(`Update: ${update.message}\n`);
  if (update.status === "update_recommended" || update.status === "unsupported") {
    env.stdout("Update command: aifight update --yes\n");
    env.stdout(`Manual npm command: ${update.policy?.updateCommand ?? "npm install -g @aifight/aifight"}\n`);
    env.stdout("The update command keeps local credentials and restarts `aifight.service` when it is installed.\n");
  }
  env.stdout(`Runtime: ${runtimeLabel(redacted.runtimeType)} at ${redacted.runtimeLocalUrl}\n`);
  env.stdout(`Automatic ranked matches: ${formatDaily(redacted.autoDailyLimit)}\n`);
  env.stdout(`Games: ${redacted.autoGames?.join(", ") ?? "texas_holdem, liars_dice, coup"}\n`);
  env.stdout(`AIFight WebSocket: ${redacted.wsUrl}\n`);
  env.stdout("No secrets are shown here.\n");
  return 0;
}

async function checkPlatformAgentStatus(
  config: BridgeConfig,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<PlatformAgentStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${config.baseUrl.replace(/\/+$/, "")}/api/agents/me/status`, {
      method: "GET",
      headers: { "X-API-Key": config.apiKey },
      signal: controller.signal,
    });
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

function parsePlatformAgentStatus(raw: unknown): PlatformAgentStatus | null {
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

function profileLabel(status: PlatformAgentStatus, config: BridgeConfig): string {
  if (status.kind === "unavailable") {
    return config.claimToken !== undefined
      ? "unknown (claim URL saved locally)"
      : "unknown";
  }
  switch (status.status) {
    case "ready":
    // "needs_official_name" is retired — claim is the only gate, so a claimed
    // agent is simply ready (handle the value for older-server back-compat).
    case "needs_official_name":
      return "claimed, ready";
    case "pending_claim":
      return "unclaimed";
  }
}

function formatDaily(limit: number | undefined): string {
  if (limit === undefined) return "not set";
  if (limit === 0) return "disabled";
  return `${limit} per day`;
}

function runtimeLabel(runtimeType: ReturnType<typeof redactBridgeConfig>["runtimeType"]): string {
  switch (runtimeType) {
    case "mock":
      return "mock";
    case "direct":
      return "Direct (LLM)";
  }
}

function readOptionalBridgeConfig(): ReturnType<typeof readBridgeConfig> | undefined {
  try {
    return readBridgeConfig();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.includes("bridge is not configured")) return undefined;
    throw cause;
  }
}
