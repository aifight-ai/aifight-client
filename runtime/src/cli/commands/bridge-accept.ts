import { readBridgeConfig } from "../../bridge/config";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { CommandError, UsageError, expectArity } from "../shared";

const USAGE = "usage: aifight accept <challenge_url_or_token>";

interface AcceptResponse {
  readonly duel?: unknown;
  readonly match_id?: string;
  readonly message?: string;
  readonly host_online?: boolean;
  readonly guest_online?: boolean;
  readonly retryable?: boolean;
}

export async function runBridgeAccept(
  args: HandlerArgs,
  env: HandlerEnv,
): Promise<number> {
  expectArity(args, 1, 1, USAGE);
  const token = extractChallengeToken(args.positional[0]!);
  const config = readBridgeConfig();
  const res = await (env.fetchImpl ?? globalThis.fetch)(`${config.baseUrl}/api/challenges/${encodeURIComponent(token)}/accept`, {
    method: "POST",
    headers: { "X-API-Key": config.apiKey },
  });
  if (!res.ok) {
    const message = await readAPIError(res, `challenge accept failed with HTTP ${res.status}`);
    throw new CommandError("challenge_accept_failed", withAcceptHint(res.status, message));
  }
  const body = (await res.json()) as AcceptResponse;
  if (args.jsonMode) {
    env.stdout(JSON.stringify(body) + "\n");
    return 0;
  }
  env.stdout("Friendly challenge accepted.\n\n");
  if (body.match_id) env.stdout(`Match: ${body.match_id}\n`);
  if (body.message) env.stdout(`${body.message}\n`);
  env.stdout("Keep aifight.service running so game_start can reach this Agent. For temporary testing, run `aifight run` in another terminal.\n");
  return 0;
}

function extractChallengeToken(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") throw new UsageError("challenge token is required", USAGE);
  if (/^dl_[0-9a-f]{32}$/i.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const parts = url.pathname.split("/").filter(Boolean);
    const markerIndex = parts.findIndex((p) => p === "challenge" || p === "duel");
    if (markerIndex >= 0 && parts[markerIndex + 1] !== undefined) {
      const token = parts[markerIndex + 1]!;
      if (/^dl_[0-9a-f]{32}$/i.test(token)) return token;
    }
  } catch {
    // Fall through to the usage error below.
  }
  throw new UsageError("invalid challenge URL or token", USAGE);
}

function withAcceptHint(status: number, message: string): string {
  if (status === 425) {
    return `${message}. Start the local service first with \`aifight service start\`, then retry accept.`;
  }
  if (status === 503) {
    return `${message}. Ask the challenge creator to keep aifight.service running.`;
  }
  return message;
}

async function readAPIError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => undefined) as unknown;
  if (body && typeof body === "object") {
    const error = (body as Record<string, unknown>).error;
    if (typeof error === "string" && error.length > 0) return error;
  }
  return fallback;
}
