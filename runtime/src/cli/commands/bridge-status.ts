import { checkPlatformAgentStatus, type PlatformAgentStatus } from "../../account/platform-agent-status";
import { formatPublicNo } from "../../account/public-no";
import { dropClaimCredentialsAfterClaim, readBridgeConfig, redactBridgeConfig } from "../../bridge/config";
import { declaredModelOriginLabel, resolveEffectiveDeclaredModel } from "../../bridge/declared-model";
import { checkBridgeUpdate } from "../../bridge/update-check";
import { RUNTIME_VERSION } from "../../index";
import { ControlClientError } from "../control-client";
import { resolveLocale, t, type Locale } from "../i18n";
import { createOutput } from "../output";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { expectArity, makeClient } from "../shared";
import type { BridgeConfig } from "../../bridge/config";
import { agentSeatHolderPid } from "./bridge-start";

const USAGE = "usage: aifight status [--live]";

export async function runBridgeStatus(
  args: HandlerArgs,
  env: HandlerEnv,
): Promise<number> {
  expectArity(args, 0, 0, USAGE);
  const loc = env.locale?.() ?? resolveLocale();
  // 连接审计 #14: `--live` asks the RUNNING bridge (aifight run / the service)
  // over its control API — realtime transport + queue, not config-file guesses.
  if (args.flags.live === true) return runLiveStatus(args, env);
  const out = createOutput({ labelWidth: 26 });
  const config = readOptionalBridgeConfig();
  if (config === undefined) {
    if (args.jsonMode) {
      env.stdout(JSON.stringify({ status: "not_configured", bridgeVersion: RUNTIME_VERSION }) + "\n");
    } else {
      env.stdout(`${out.section(t(loc, "status.title"))}\n\n`);
      env.stdout(`${out.kv(t(loc, "status.label.bridge"), t(loc, "status.value.not_configured"), { tone: "yellow" })}\n`);
      env.stdout(`${out.kv(t(loc, "status.label.cli"), RUNTIME_VERSION)}\n`);
      env.stdout(`${out.note(t(loc, "status.next"))}\n`);
    }
    return 0;
  }
  const redacted = redactBridgeConfig(config);
  const declaredModel = resolveEffectiveDeclaredModel(config);
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
      declaredModel: { value: declaredModel.value, origin: declaredModel.origin },
      matchingPaused: config.matchingPaused === true,
      claimUrl: unclaimedClaimUrl(platformAgentStatus, config) ?? null,
    }) + "\n");
    return 0;
  }

  env.stdout(`${out.section(t(loc, "status.title"))}\n\n`);
  // Prefer the server-authoritative name (reflects a rename from any device);
  // fall back to the locally cached name when the status check is unavailable.
  const serverName = platformAgentStatus.kind === "ok" ? platformAgentStatus.name : undefined;
  const publicNo = platformAgentStatus.kind === "ok" ? platformAgentStatus.publicNo : undefined;
  const idSuffix = publicNo !== undefined ? out.ansi.dim(`  (ID ${formatPublicNo(publicNo)})`) : "";
  const profile = profileLabel(loc, platformAgentStatus, config);
  env.stdout(`${out.kv(t(loc, "status.label.agent"), (serverName ?? redacted.agentName) + idSuffix)}\n`);
  env.stdout(`${out.kv(t(loc, "status.label.profile"), profile.text, { tone: profile.tone })}\n`);
  if (platformAgentStatus.kind === "unavailable") {
    env.stdout(`${out.kv(t(loc, "status.label.profile_check"), platformAgentStatus.message, { tone: "yellow" })}\n`);
  }
  // An unclaimed agent cannot play at all — the claim link IS the way past the
  // gate, so print it here instead of leaving the user at "Profile: unclaimed".
  const claimUrl = unclaimedClaimUrl(platformAgentStatus, config);
  if (claimUrl !== undefined) {
    env.stdout(`${out.ansi.yellow(t(loc, "status.claim"))}\n`);
    env.stdout(`  ${claimUrl}\n`);
  }
  if (platformAgentStatus.kind === "ok" && platformAgentStatus.termsPending) {
    const dashUrl = `${config.baseUrl.replace(/\/+$/, "")}/dashboard`;
    env.stdout(`${out.ansi.yellow(t(loc, "status.terms"))}\n`);
    env.stdout(`${t(loc, "status.terms.tail", { url: dashUrl })}\n`);
  }
  env.stdout(`${out.kv(t(loc, "status.label.bridge"), t(loc, "status.value.configured"), { tone: "green" })}\n`);
  env.stdout(`${out.kv(t(loc, "status.label.cli"), RUNTIME_VERSION)}\n`);
  const updateKnownNewer = update.status === "update_recommended" || update.status === "unsupported";
  env.stdout(`${out.kv(t(loc, "status.label.update"), update.message, updateKnownNewer ? { tone: "yellow" } : {})}\n`);
  if (updateKnownNewer) {
    env.stdout(`${out.kv(t(loc, "status.label.update_cmd"), t(loc, "status.value.update_cmd"))}\n`);
    env.stdout(`${out.kv(t(loc, "status.label.update_manual"), update.policy?.updateCommand ?? "npm install -g @aifight/aifight")}\n`);
    env.stdout(`${out.note(t(loc, "status.update.note"))}\n`);
  }
  env.stdout(`${out.kv(t(loc, "status.label.runtime"), `${runtimeLabel(redacted.runtimeType)} · ${redacted.runtimeLocalUrl}`)}\n`);
  // What the leaderboard/profile shows as this agent's model, and why.
  env.stdout(`${out.kv(t(loc, "status.label.declared"), `${declaredModel.value} (${declaredModelOriginLabel(declaredModel.origin)})`, { tone: "cyan" })}\n`);
  env.stdout(`${out.kv(t(loc, "status.label.daily"), formatDaily(loc, redacted.autoDailyLimit))}\n`);
  // The pause flag survives restarts, so say it out loud when set — a paused
  // agent looks "configured and online" everywhere else, which is exactly the
  // confusion that made the desktop show this state prominently too.
  if (config.matchingPaused === true) {
    env.stdout(`${out.ansi.yellow(t(loc, "status.paused"))}\n`);
  }
  env.stdout(`${out.kv(t(loc, "status.label.games"), redacted.autoGames?.join(", ") ?? "texas_holdem, liars_dice, coup")}\n`);
  env.stdout(`${out.kv(t(loc, "status.label.ws"), redacted.wsUrl)}\n`);
  env.stdout(`${out.note(t(loc, "status.secrets"))}\n`);
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
  const loc = env.locale?.() ?? resolveLocale();
  const out = createOutput({ labelWidth: 18 });
  const client = makeClient(env);
  let agents: readonly LiveAgentRow[];
  try {
    const body = await client.get<{ agents?: readonly LiveAgentRow[] }>("/v1/agents");
    agents = Array.isArray(body.agents) ? body.agents : [];
  } catch (e) {
    if (e instanceof ControlClientError && e.kind === "daemon_unreachable") {
      // A live seat holder with no control API is the desktop app's
      // in-process bridge — say so instead of "not running" (see bridge-start).
      const pid = agentSeatHolderPid();
      if (args.jsonMode) {
        env.stdout(JSON.stringify(
          pid !== undefined
            ? { status: "bridge_running_without_control_api", pid }
            : { status: "bridge_not_running" },
        ) + "\n");
      } else if (pid !== undefined) {
        env.stdout(`${t(loc, "status.live.desktop1", { pid })}\n`);
        env.stdout(`${t(loc, "status.live.desktop2")}\n`);
      } else {
        env.stdout(`${t(loc, "status.live.down1")}\n`);
        env.stdout(`${t(loc, "status.live.down2")}\n`);
      }
      return 1;
    }
    throw e;
  }
  if (args.jsonMode) {
    env.stdout(JSON.stringify({ status: "ok", agents }) + "\n");
    return 0;
  }
  env.stdout(`${out.section(t(loc, "status.live.title"))}\n\n`);
  if (agents.length === 0) {
    env.stdout(`${out.note(t(loc, "status.live.empty"))}\n`);
    return 0;
  }
  for (const a of agents) {
    const s = a.state ?? null;
    env.stdout(`${out.kv(t(loc, "status.label.agent"), a.name ?? "-")}\n`);
    env.stdout(`${out.kv(t(loc, "status.live.label.connection"), a.transport ?? "-")}\n`);
    env.stdout(`${out.kv(t(loc, "status.live.label.phase"), s?.phase ?? "-")}\n`);
    env.stdout(`${out.kv(t(loc, "status.live.label.queue"),
      s?.queue?.game !== undefined ? `${s.queue.game} (${s.queue.mode ?? "ranked"})` : t(loc, "status.live.queue.none"))}\n`);
    const matches = s?.activeMatches !== undefined ? Object.values(s.activeMatches) : [];
    env.stdout(`${out.kv(t(loc, "status.live.label.matches"),
      matches.length === 0 ? t(loc, "status.live.matches.none") : matches.map((m) => m.game ?? "?").join(", "))}\n`);
  }
  return 0;
}

/**
 * The locally saved claim URL while the agent is not confirmed claimed. The
 * platform's "claimed" answer is authoritative (and has already scrubbed the
 * local URL via dropClaimCredentialsAfterClaim above); an unreachable platform
 * falls back to the local file, which can lag but never over-reports "claimed".
 */
function unclaimedClaimUrl(status: PlatformAgentStatus, config: BridgeConfig): string | undefined {
  if (status.kind === "ok" && status.isClaimed) return undefined;
  return config.claimUrl;
}

function profileLabel(
  loc: Locale,
  status: PlatformAgentStatus,
  config: BridgeConfig,
): { readonly text: string; readonly tone: "green" | "yellow" | "default" } {
  if (status.kind === "unavailable") {
    return {
      text: config.claimToken !== undefined
        ? t(loc, "status.profile.unknown_saved")
        : t(loc, "status.profile.unknown"),
      tone: "default",
    };
  }
  switch (status.status) {
    case "ready":
    // "needs_official_name" is retired — claim is the only gate, so a claimed
    // agent is simply ready (handle the value for older-server back-compat).
    case "needs_official_name":
      return { text: t(loc, "status.profile.ready"), tone: "green" };
    case "pending_claim":
      return { text: t(loc, "status.profile.unclaimed"), tone: "yellow" };
  }
}

function formatDaily(loc: Locale, limit: number | undefined): string {
  if (limit === undefined) return t(loc, "status.daily.unset");
  if (limit === 0) return t(loc, "status.daily.off");
  return t(loc, "status.daily.cap", { limit });
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
