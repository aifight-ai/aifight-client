import { readBridgeConfig } from "../../bridge/config";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { CommandError, UsageError, expectArity } from "../shared";

const USAGE = "usage: aifight challenge <texas_holdem|liars_dice|coup>";

interface ChallengeResponse {
  readonly duel?: {
    readonly id?: string;
    readonly game?: string;
    readonly status?: string;
    readonly expires_at?: string;
  };
  readonly join_url?: string;
}

export async function runBridgeChallenge(
  args: HandlerArgs,
  env: HandlerEnv,
): Promise<number> {
  expectArity(args, 1, 1, USAGE);
  const game = args.positional[0]!;
  if (game !== "texas_holdem" && game !== "liars_dice" && game !== "coup") {
    throw new UsageError(
      `challenge game must be texas_holdem, liars_dice, or coup (got '${game}')`,
      USAGE,
    );
  }

  const config = readBridgeConfig();
  const res = await (env.fetchImpl ?? globalThis.fetch)(`${config.baseUrl}/api/challenges`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": config.apiKey,
    },
    body: JSON.stringify({ game, accept_mode: "single" }),
  });
  if (!res.ok) {
    throw new CommandError("challenge_create_failed", await readAPIError(res, `challenge creation failed with HTTP ${res.status}`));
  }
  const body = (await res.json()) as ChallengeResponse;
  if (typeof body.join_url !== "string" || body.join_url.length === 0) {
    throw new CommandError("challenge_response_invalid", "challenge response did not include a join_url");
  }

  if (args.jsonMode) {
    env.stdout(JSON.stringify(body) + "\n");
    return 0;
  }
  env.stdout("Friendly challenge created.\n\n");
  env.stdout(`Game: ${game}\n`);
  env.stdout("Rating impact: none\n");
  env.stdout("Accepts: 1 (accepted once)\n\n");
  env.stdout("Share this URL:\n");
  env.stdout(`${body.join_url}\n\n`);
  env.stdout("This does not affect ratings or daily auto-play.\n");
  if (game === "texas_holdem") {
    env.stdout("Texas Hold'em challenges start as a direct two-player friendly table; normal matchmaking still starts at four players.\n");
  }
  env.stdout("Keep aifight.service running before the other side accepts. For temporary testing, run `aifight run` in another terminal.\n");
  return 0;
}

async function readAPIError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => undefined) as unknown;
  if (body && typeof body === "object") {
    const error = (body as Record<string, unknown>).error;
    if (typeof error === "string" && error.length > 0) return error;
  }
  return fallback;
}
