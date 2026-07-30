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
// that is why they never print a restart hint (unlike `aifight set daily`,
// whose value the bridge reads only at startup).

import { pickAutomaticGame } from "../../bridge/auto-join";
import { readBridgeConfig, writeBridgeConfig, type BridgeConfig } from "../../bridge/config";
import { fetchNoFollow } from "../../net/guarded-fetch";
import { ControlClientError } from "../control-client";
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
  const config = readPauseBridgeConfig();

  if (config.matchingPaused === true) {
    if (args.jsonMode) {
      env.stdout(JSON.stringify({ status: "already_paused", matchingPaused: true }) + "\n");
    } else {
      env.stdout("Automatic matching is already paused. Resume with `aifight resume`.\n");
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

  // NOT preserveMtime: this flag changes what a running bridge does, so the
  // write is not behavior-neutral — and when an OLDER bridge (without the
  // connect-edge pause check) is the one running, the mtime bump is exactly
  // what lets the menu offer the restart that version genuinely needs.
  writeBridgeConfig({ ...config, matchingPaused: true, updatedAt: new Date().toISOString() });

  if (args.jsonMode) {
    env.stdout(JSON.stringify({
      status: "paused",
      matchingPaused: true,
      bridge: viaControl ? "control_synced" : "platform_synced",
    }) + "\n");
    return 0;
  }
  env.stdout("Automatic matching paused — left the queue; the agent will not re-join automatically after a match ends.\n");
  if (!viaControl) {
    env.stdout(`${notRunningNote()}\n`);
  }
  env.stdout("Resume any time: aifight resume\n");
  return 0;
}

export async function runBridgeResume(
  args: HandlerArgs,
  env: HandlerEnv,
): Promise<number> {
  expectArity(args, 0, 0, RESUME_USAGE);
  const config = readPauseBridgeConfig();

  if (config.matchingPaused !== true) {
    if (args.jsonMode) {
      env.stdout(JSON.stringify({ status: "not_paused", matchingPaused: false }) + "\n");
    } else {
      env.stdout("Automatic matching is not paused.\n");
    }
    return 0;
  }

  // Clear the flag first so the pause is lifted even when the re-join below
  // cannot be delivered (bridge down, control hiccup) — the flag is the
  // persistent state; the join is best-effort on top of it.
  const { matchingPaused: _dropped, ...rest } = config;
  const cleared: BridgeConfig = { ...rest, updatedAt: new Date().toISOString() };
  writeBridgeConfig(cleared);

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
  switch (outcome) {
    case "joined":
      env.stdout(`Automatic matching resumed — re-joined the ${game} queue.\n`);
      break;
    case "not_running":
      env.stdout(`Automatic matching resumed. ${notRunningNote()}\n`);
      break;
    case "join_failed":
      env.stdout("Automatic matching resumed (saved), but the running bridge did not accept the re-join — it picks the setting up on its next reconnect.\n");
      break;
    case "cap_off":
      env.stdout("Automatic matching resumed. The daily cap is 0 (manual only), so the agent still will not queue by itself — set one with `aifight set daily <N>`.\n");
      break;
  }
  return 0;
}

/** What "no CLI bridge answered the control API" means for the user. When the
 *  desktop app holds the agent seat it IS running but speaks no control API —
 *  and it keeps its own pause switch, so say so instead of "not running". */
function notRunningNote(): string {
  return agentSeatHolderPid() !== undefined
    ? "The desktop app currently runs this agent on this machine and keeps its own pause switch — set it in the app (Play view) too."
    : "No bridge is running on this machine — the change is saved and applies the next time one starts.";
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
