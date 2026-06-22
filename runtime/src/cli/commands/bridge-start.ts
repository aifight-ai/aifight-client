import { readBridgeConfig, type BridgeConfig } from "../../bridge/config";
import { checkBridgeUpdate } from "../../bridge/update-check";
import { BridgeServiceError, statusBridgeService } from "../../bridge/service";
import { RUNTIME_VERSION } from "../../index";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { CommandError, UsageError, isSupportedGame, makeClient, SUPPORTED_GAMES } from "../shared";
import { ControlClientError } from "../control-client";

type SupportedGame = "texas_holdem" | "liars_dice" | "coup";

const MAX_MANUAL_MATCHES = 20;
const USAGE = [
  "usage: aifight start [game] [N]",
  "       aifight start [N]",
  "  Request manual ranked match(es) through the running AIFight Bridge.",
  `  N must be 1-${MAX_MANUAL_MATCHES}. Manual starts do not consume the daily automatic match limit.`,
  `  supported games: ${SUPPORTED_GAMES.join(", ")}`,
].join("\n");

export async function runBridgeStart(
  args: HandlerArgs,
  env: HandlerEnv,
): Promise<number> {
  if (args.positional.length > 2) {
    const extras = args.positional.slice(2).join(" ");
    throw new UsageError(`unexpected extra positional arguments: ${extras}`, USAGE);
  }

  const config = readStartBridgeConfig();
  const request = parseStartRequest(args.positional, config);
  const update = await checkBridgeUpdate({
    baseUrl: config.baseUrl,
    currentVersion: RUNTIME_VERSION,
    fetchImpl: env.fetchImpl,
  });
  if (update.status === "unsupported") {
    env.stderr(`${update.message}\n`);
    env.stderr("Run: aifight update --yes\n");
    env.stderr(`Manual npm command: ${update.policy?.updateCommand ?? "npm install -g @aifight/aifight@alpha"}\n`);
    return 1;
  }
  if (update.status === "update_recommended") {
    env.stdout(`[warn] bridge.update: ${update.message}\n`);
    env.stdout("[warn] update when ready: aifight update --yes\n");
  }

  try {
    const client = makeClient(env);
    await client.post<unknown>(
      `/v1/agents/${encodeURIComponent(config.agentName)}/join`,
      {
        game: request.game,
        mode: "ranked",
        one_shot: true,
        count: request.count,
      },
    );
  } catch (cause) {
    if (cause instanceof ControlClientError) {
      throw new CommandError(
        controlErrorCode(cause),
        controlErrorMessage(cause),
        { hint: await bridgeStartHint(env) },
      );
    }
    throw cause;
  }

  if (args.jsonMode) {
    env.stdout(JSON.stringify({
      status: "queued",
      agent: config.agentName,
      game: request.game,
      count: request.count,
      mode: "ranked",
      manual: true,
    }) + "\n");
  } else {
    const noun = request.count === 1 ? "match" : "matches";
    env.stdout(`Requested ${request.count} manual ranked ${displayGameName(request.game)} ${noun} for ${config.agentName}.\n`);
    env.stdout("The running Bridge will keep your Agent online and handle the match when AIFight pairs it.\n");
  }
  return 0;
}

function readStartBridgeConfig(): BridgeConfig {
  try {
    return readBridgeConfig();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.includes("bridge is not configured")) {
      throw new CommandError(
        "bridge_not_configured",
        "AIFight Bridge is not configured.",
        {
          hint: "Run `aifight setup` for a new agent, or `aifight connect <PAIRING_CODE>` for an existing agent. Then install `aifight.service` before requesting manual matches.",
        },
      );
    }
    throw cause;
  }
}

function parseStartRequest(
  positional: readonly string[],
  config: BridgeConfig,
): { readonly game: SupportedGame; readonly count: number } {
  if (positional.length === 0) {
    return { game: pickManualGame(config.autoGames), count: 1 };
  }

  const first = positional[0]!;
  if (positional.length === 1) {
    const maybeCount = parsePositiveCount(first);
    if (maybeCount !== null) {
      return { game: pickManualGame(config.autoGames), count: maybeCount };
    }
    if (isSupportedGame(first)) {
      return { game: first as SupportedGame, count: 1 };
    }
    throw new UsageError(
      `unsupported game or count '${first}'`,
      USAGE,
    );
  }

  const second = positional[1]!;
  if (!isSupportedGame(first)) {
    throw new UsageError(`unsupported game '${first}'`, USAGE);
  }
  const count = parsePositiveCount(second);
  if (count === null) {
    throw new UsageError(`N must be an integer between 1 and ${MAX_MANUAL_MATCHES}`, USAGE);
  }
  return { game: first as SupportedGame, count };
}

function parsePositiveCount(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > MAX_MANUAL_MATCHES) return null;
  return n;
}

function pickManualGame(configured: readonly string[] | undefined): SupportedGame {
  const games = (configured ?? SUPPORTED_GAMES).filter(isSupportedGame);
  const pool = games.length > 0 ? games : SUPPORTED_GAMES;
  return pool[Math.floor(Math.random() * pool.length)]! as SupportedGame;
}

function controlErrorCode(cause: ControlClientError): string {
  if (cause.kind === "daemon_unreachable") return "bridge_not_running";
  if (cause.kind === "runtime_files_corrupt") return "bridge_runtime_files_invalid";
  if (cause.kind === "auth_failed") return "bridge_control_auth_failed";
  if (cause.kind === "request_timeout") return "bridge_control_timeout";
  return "bridge_control_failed";
}

function controlErrorMessage(cause: ControlClientError): string {
  if (cause.kind === "daemon_unreachable") return "AIFight Bridge is not running.";
  if (cause.kind === "runtime_files_corrupt") return "AIFight Bridge runtime files are invalid.";
  if (cause.kind === "auth_failed") return "AIFight Bridge rejected the local control token.";
  if (cause.kind === "request_timeout") return "AIFight Bridge did not answer the local control request in time.";
  return cause.message;
}

async function bridgeStartHint(env: HandlerEnv): Promise<string> {
  try {
    const status = await statusBridgeService(env.bridgeService);
    if (status.installed && status.running === false) {
      return "Start it with `aifight service start`, then run this command again.";
    }
    if (status.installed && status.running === true) {
      return "The service appears to be running, but its local control API did not answer. Try `aifight service restart` when no match is in progress.";
    }
  } catch (cause) {
    if (!(cause instanceof BridgeServiceError)) throw cause;
  }
  return "Install the background service with `aifight service install`, or self-manage `aifight run` as an advanced path.";
}

function displayGameName(game: SupportedGame): string {
  switch (game) {
    case "texas_holdem":
      return "Texas Hold'em";
    case "liars_dice":
      return "Liar's Dice";
    case "coup":
      return "Coup";
  }
}
