// `aifight pause` / `aifight resume` — the CLI's pause-matching switch.
//
// The desktop app has had this (persisted) for a while; the CLI only had the
// "set daily 0" workaround, which also wipes the configured cap. Pause is the
// lighter switch: it leaves the current queue and stops every automatic
// re-join while keeping the daily cap and game preferences intact.
//
// Two halves, both needed:
//   - Server side: leaving the queue clears every queued entry AND disables
//     auto_requeue (policy.go), so the agent does not silently re-join after
//     its current match ends.
//   - Local side: matchingPaused in bridge.json persists the choice, and the
//     runner reads that flag fresh at every connect edge — so a RUNNING CLI
//     bridge honors the pause without a restart (its config snapshot alone is
//     frozen at startup; only the flag is re-read).
//
// Because the running bridge picks the flag up by itself and the control API
// syncs the live queue immediately, neither command needs a bridge restart —
// that is why they never print a restart hint. The daily cap and game list
// learned the same connect-edge re-read in V3 (runner #autoJoinDecision), so
// `aifight set daily` / `aifight set game` no longer need one either.

import { pickAutomaticGame } from "../../bridge/auto-join";
import { readBridgeConfig, writeBridgeConfig, type BridgeConfig } from "../../bridge/config";
import { fetchNoFollow } from "../../net/guarded-fetch";
import { createStatusIcons } from "../ansi";
import { ControlClientError } from "../control-client";
import { resolveLocale, t, type Locale } from "../i18n";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { CommandError, expectArity, makeClient } from "../shared";
import { agentSeatHolderPid } from "./bridge-start";

const PAUSE_USAGE = "usage: aifight pause [--json]";
const RESUME_USAGE = "usage: aifight resume [--json]";

export async function runBridgePause(
  args: HandlerArgs,
  env: HandlerEnv,
): Promise<number> {
  expectArity(args, 0, 0, PAUSE_USAGE);
  const loc = env.locale?.() ?? resolveLocale();
  const config = readPauseBridgeConfig();

  if (config.matchingPaused === true) {
    if (args.jsonMode) {
      env.stdout(JSON.stringify({ status: "already_paused", matchingPaused: true }) + "\n");
    } else {
      env.stdout(`${t(loc, "pause.already")}\n`);
    }
    return 0;
  }

  // Leave BEFORE saving the flag: a failed leave changes nothing (the agent
  // keeps matching as before), while the reverse order could strand it in a
  // queue it was told to exit. A running CLI bridge gets the control-plane
  // leave (the live runner drops the queue locally and the WS leave_queue
  // frame runs the same server-side cleanup); otherwise the platform HTTP
  // endpoint does that cleanup with the agent key — it works with no bridge
  // running at all.
  const viaControl = await leaveViaControlApi(config, env);
  if (!viaControl) {
    await leaveViaPlatform(config, env);
  }

  // preserveMtime (V3 重启精确化): a running bridge reads this flag fresh at
  // every connect edge and the control-plane leave above already synced the
  // live queue, so the change is live RIGHT NOW — it must not read as
  // "restart pending" to the menu's once-at-the-end offer.
  writeBridgeConfig(
    { ...config, matchingPaused: true, updatedAt: new Date().toISOString() },
    { preserveMtime: true },
  );

  if (args.jsonMode) {
    env.stdout(JSON.stringify({
      status: "paused",
      matchingPaused: true,
      bridge: viaControl ? "control_synced" : "platform_synced",
    }) + "\n");
    return 0;
  }
  // Human feedback leads with the V2 status icons (✓ / ⚠, ASCII fallback
  // "OK" / "!" when colors are off) — --json above stays byte-stable.
  const icons = env.statusIcons ?? createStatusIcons();
  env.stdout(`${icons.ok} ${t(loc, "pause.ok")}\n`);
  if (!viaControl) {
    env.stdout(`${icons.warn} ${notRunningNote(loc)}\n`);
  }
  env.stdout(`${t(loc, "pause.resume_hint")}\n`);
  return 0;
}

export async function runBridgeResume(
  args: HandlerArgs,
  env: HandlerEnv,
): Promise<number> {
  expectArity(args, 0, 0, RESUME_USAGE);
  const loc = env.locale?.() ?? resolveLocale();
  const config = readPauseBridgeConfig();

  if (config.matchingPaused !== true) {
    if (args.jsonMode) {
      env.stdout(JSON.stringify({ status: "not_paused", matchingPaused: false }) + "\n");
    } else {
      env.stdout(`${t(loc, "resume.not_paused")}\n`);
    }
    return 0;
  }

  // Clear the flag first so the pause is lifted even when the re-join below
  // cannot be delivered (bridge down, control hiccup) — the flag is the
  // persistent state; the join is best-effort on top of it.
  // preserveMtime (V3 重启精确化): the running bridge re-reads the flag at
  // every connect edge, so this is live already — no restart pending.
  const { matchingPaused: _dropped, ...rest } = config;
  const cleared: BridgeConfig = { ...rest, updatedAt: new Date().toISOString() };
  writeBridgeConfig(cleared, { preserveMtime: true });

  // Mirror the startup auto-join (automaticJoinOptions): a random pick from
  // the configured games, ranked, NOT one-shot. A daily cap of 0 means
  // "manual only", so there is nothing automatic to re-join.
  let outcome: "joined" | "not_running" | "join_failed" | "cap_off" = "cap_off";
  let game: ReturnType<typeof pickAutomaticGame> | undefined;
  if ((cleared.autoDailyLimit ?? 0) > 0) {
    game = pickAutomaticGame(cleared.autoGames);
    outcome = await joinViaControlApi(cleared, env, game);
  }

  if (args.jsonMode) {
    env.stdout(JSON.stringify({
      status: "resumed",
      matchingPaused: false,
      rejoined: outcome === "joined",
      ...(game !== undefined ? { game } : {}),
    }) + "\n");
    return 0;
  }
  const icons = env.statusIcons ?? createStatusIcons();
  switch (outcome) {
    case "joined":
      env.stdout(`${icons.ok} ${t(loc, "resume.ok.joined", { game: game ?? "" })}\n`);
      break;
    case "not_running":
      env.stdout(`${icons.ok} ${t(loc, "resume.ok")}\n`);
      env.stdout(`${icons.warn} ${notRunningNote(loc)}\n`);
      break;
    case "join_failed":
      env.stdout(`${icons.warn} ${t(loc, "resume.warn.join_failed")}\n`);
      break;
    case "cap_off":
      env.stdout(`${icons.ok} ${t(loc, "resume.ok")}\n`);
      env.stdout(`${icons.warn} ${t(loc, "resume.warn.cap_off")}\n`);
      break;
  }
  return 0;
}

/** What "no CLI bridge answered the control API" means for the user. When the
 *  desktop app holds the agent seat it IS running but speaks no control API —
 *  and it keeps its own pause switch, so say so instead of "not running". */
function notRunningNote(loc: Locale): string {
  return agentSeatHolderPid() !== undefined
    ? t(loc, "note.desktop_seat")
    : t(loc, "note.not_running");
}

/** readBridgeConfig, with the expected local-config failures mapped to a
 *  CommandError (exit 1 + hint) instead of the exit-99 catchall. */
function readPauseBridgeConfig(): BridgeConfig {
  try {
    return readBridgeConfig();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.includes("bridge is not configured")) {
      throw new CommandError("bridge_not_configured", "AIFight Bridge is not configured.", {
        hint: "Run `aifight setup` for a new agent, or `aifight connect <PAIRING_CODE>` for an existing agent.",
      });
    }
    if (message.includes("bridge config is invalid")) {
      throw new CommandError("bridge_config_invalid", "The local bridge config is damaged and cannot be read.", {
        hint: "Re-link this machine with `aifight connect <PAIRING_CODE>`, or re-run `aifight setup`.",
      });
    }
    throw cause;
  }
}

/** Ask the running bridge to drop the queue. False on ANY control-plane
 *  failure — the platform endpoint fallback then does the server-side cleanup,
 *  and the live runner's stale queue belief heals via the server frames plus
 *  the persisted pause flag (read fresh at every connect edge). */
async function leaveViaControlApi(config: BridgeConfig, env: HandlerEnv): Promise<boolean> {
  try {
    await makeClient(env).post(`/v1/agents/${encodeURIComponent(config.agentName)}/leave`);
    return true;
  } catch {
    return false;
  }
}

/** POST /api/queue/leave with the agent key: clears every queued entry and
 *  disables server-side auto_requeue, exactly like the WS leave path. */
async function leaveViaPlatform(config: BridgeConfig, env: HandlerEnv): Promise<void> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/api/queue/leave`;
  let res: Response;
  try {
    res = await fetchNoFollow(
      url,
      {
        method: "POST",
        headers: { "X-API-Key": config.apiKey },
        signal: AbortSignal.timeout(10_000),
      },
      { fetchImpl: env.fetchImpl ?? globalThis.fetch },
    );
  } catch (cause) {
    throw new CommandError(
      "queue_leave_failed",
      `Could not reach AIFight to leave the matchmaking queue: ${cause instanceof Error ? cause.message : String(cause)}`,
      { hint: "Check the internet connection and retry — nothing was paused yet." },
    );
  }
  if (!res.ok) {
    throw new CommandError(
      "queue_leave_failed",
      `AIFight did not accept the queue leave (HTTP ${res.status}).`,
      { hint: "Retry in a moment — nothing was paused yet. If this persists, run `aifight doctor`." },
    );
  }
}

/** Re-join through the running bridge, the same way startup auto-join does
 *  (non-one-shot ranked). "not_running" covers an absent CLI bridge AND the
 *  desktop seat (no control API) — the caller's note tells those apart. Any
 *  other failure leaves the cleared flag in place, so it is not fatal. */
async function joinViaControlApi(
  config: BridgeConfig,
  env: HandlerEnv,
  game: "texas_holdem" | "liars_dice" | "coup",
): Promise<"joined" | "not_running" | "join_failed"> {
  try {
    await makeClient(env).post(`/v1/agents/${encodeURIComponent(config.agentName)}/join`, {
      game,
      mode: "ranked",
      one_shot: false,
    });
    return "joined";
  } catch (cause) {
    if (cause instanceof ControlClientError && cause.kind === "daemon_unreachable") {
      return "not_running";
    }
    return "join_failed";
  }
}
