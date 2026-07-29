import { checkPlatformAgentStatus, type PlatformAgentStatus } from "../../account/platform-agent-status";
import { formatPublicNo } from "../../account/public-no";
import { dropClaimCredentialsAfterClaim, readBridgeConfig, redactBridgeConfig } from "../../bridge/config";
import { checkBridgeUpdate } from "../../bridge/update-check";
import { RUNTIME_VERSION } from "../../index";
import { ControlClientError } from "../control-client";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { expectArity, makeClient } from "../shared";
import type { BridgeConfig } from "../../bridge/config";

const USAGE = "usage: aifight status [--live]";

export async function runBridgeStatus(
  args: HandlerArgs,
  env: HandlerEnv,
): Promise<number> {
  expectArity(args, 0, 0, USAGE);
  // 连接审计 #14: `--live` asks the RUNNING bridge (aifight run / the service)
  // over its control API — realtime transport + queue, not config-file guesses.
  if (args.flags.live === true) return runLiveStatus(args, env);
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

// ── `aifight status --live` (连接审计 #14) ───────────────────────────────────
// Reads GET /v1/agents from the local control API that `aifight run` starts.
// Shape mirrors the server's SanitizedAgentSnapshot — parsed defensively so a
// version-skewed bridge degrades to "-" fields, never a crash.
interface LiveAgentRow {
  readonly name?: string;
  readonly transport?: string;
  readonly state?: {
    readonly phase?: string;
    readonly queue?: { readonly game?: string; readonly mode?: string };
    readonly activeMatches?: Readonly<Record<string, { readonly game?: string }>>;
    readonly activeMatchCount?: number;
  } | null;
}

async function runLiveStatus(args: HandlerArgs, env: HandlerEnv): Promise<number> {
  const client = makeClient(env);
  let agents: readonly LiveAgentRow[];
  try {
    const body = await client.get<{ agents?: readonly LiveAgentRow[] }>("/v1/agents");
    agents = Array.isArray(body.agents) ? body.agents : [];
  } catch (e) {
    if (e instanceof ControlClientError && e.kind === "daemon_unreachable") {
      if (args.jsonMode) {
        env.stdout(JSON.stringify({ status: "bridge_not_running" }) + "\n");
      } else {
        env.stdout("Bridge not running on this machine — live status needs `aifight run` (or the background service).\n");
        env.stdout("Plain `aifight status` shows the stored configuration instead.\n");
      }
      return 1;
    }
    throw e;
  }
  if (args.jsonMode) {
    env.stdout(JSON.stringify({ status: "ok", agents }) + "\n");
    return 0;
  }
  env.stdout("AIFight live status\n\n");
  if (agents.length === 0) {
    env.stdout("No agents running in the bridge.\n");
    return 0;
  }
  for (const a of agents) {
    const s = a.state ?? null;
    env.stdout(`Agent: ${a.name ?? "-"}\n`);
    env.stdout(`Connection: ${a.transport ?? "-"}\n`);
    env.stdout(`Phase: ${s?.phase ?? "-"}\n`);
    env.stdout(`Queue: ${s?.queue?.game !== undefined ? `${s.queue.game} (${s.queue.mode ?? "ranked"})` : "not queued"}\n`);
    const matches = s?.activeMatches !== undefined ? Object.values(s.activeMatches) : [];
    env.stdout(`Active matches: ${matches.length === 0 ? "none" : matches.map((m) => m.game ?? "?").join(", ")}\n`);
  }
  return 0;
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
