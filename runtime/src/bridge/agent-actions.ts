// The three agent actions that go to AIFight over HTTP: create a friendly
// challenge, accept one, change the display name.
//
// They live here rather than inside the CLI command files because the Telegram
// panel performs the same three actions. One implementation means the bot and
// the CLI cannot drift on the request body, the ceilings, or what an error
// means — the panel just renders the outcome differently.

import { fetchNoFollow } from "../net/guarded-fetch";
import type { BridgeConfig } from "./config";

/**
 * Every request here is one someone is waiting on — a tap on a phone, a CLI
 * command with a cursor blinking under it. Without a deadline the wait is
 * undici's default (five minutes), and in the bridge process it is worse than a
 * long wait: the Telegram poller handles updates one at a time, so a hung
 * request stops the bot from answering ANYTHING, and shutdown waits on it too.
 */
const ACTION_TIMEOUT_MS = 15_000;

export type AgentActionCode =
  | "challenge_create_failed"
  | "challenge_response_invalid"
  | "challenge_accept_failed"
  | "rename_cooldown"
  | "rename_invalid"
  | "rename_failed"
  | "challenge_status_failed";

export class AgentActionError extends Error {
  override readonly name = "AgentActionError";
  readonly code: AgentActionCode;
  readonly status: number;
  constructor(code: AgentActionCode, message: string, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export type ChallengeGame = "texas_holdem" | "liars_dice" | "coup";

export interface CreatedChallenge {
  readonly joinUrl: string;
  /** Token parsed out of join_url, for watching the challenge's status. */
  readonly token: string | null;
  readonly game: ChallengeGame;
  /** The raw response, for `aifight challenge --json`. */
  readonly raw: unknown;
}

export async function createChallenge(
  config: BridgeConfig,
  game: ChallengeGame,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<CreatedChallenge> {
  const res = await fetchNoFollow(`${base(config)}/api/challenges`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey },
    body: JSON.stringify({ game, accept_mode: "single" }),
    signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
  }, { fetchImpl });
  if (!res.ok) {
    throw new AgentActionError(
      "challenge_create_failed",
      await readAPIError(res, `challenge creation failed with HTTP ${res.status}`),
      res.status,
    );
  }
  const raw = (await res.json()) as { join_url?: unknown };
  if (typeof raw.join_url !== "string" || raw.join_url.length === 0) {
    throw new AgentActionError("challenge_response_invalid", "challenge response did not include a join_url");
  }
  return {
    joinUrl: raw.join_url,
    token: tokenFromJoinUrl(raw.join_url),
    game,
    raw,
  };
}

export interface AcceptedChallenge {
  readonly matchId?: string;
  readonly message?: string;
  readonly raw: unknown;
}

export async function acceptChallenge(
  config: BridgeConfig,
  token: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<AcceptedChallenge> {
  const res = await fetchNoFollow(`${base(config)}/api/challenges/${encodeURIComponent(token)}/accept`, {
    method: "POST",
    headers: { "X-API-Key": config.apiKey },
    signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
  }, { fetchImpl });
  if (!res.ok) {
    const message = await readAPIError(res, `challenge accept failed with HTTP ${res.status}`);
    throw new AgentActionError("challenge_accept_failed", withAcceptHint(res.status, message), res.status);
  }
  const raw = (await res.json()) as { match_id?: unknown; message?: unknown };
  return {
    ...(typeof raw.match_id === "string" ? { matchId: raw.match_id } : {}),
    ...(typeof raw.message === "string" ? { message: raw.message } : {}),
    raw,
  };
}

/** The 425/503 answers mean "not yet", and both have a specific fix. */
function withAcceptHint(status: number, message: string): string {
  if (status === 425) {
    return `${message}. Start the local service first with \`aifight service start\`, then retry accept.`;
  }
  if (status === 503) {
    return `${message}. Ask the challenge creator to keep aifight.service running.`;
  }
  return message;
}

export interface RenamedAgent {
  readonly name: string;
  readonly publicNo?: number;
}

export async function renameAgent(
  config: BridgeConfig,
  name: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<RenamedAgent> {
  const res = await fetchNoFollow(`${base(config)}/api/agents/me/name`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": config.apiKey,
      "X-AIFight-Client": "cli",
    },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
  }, { fetchImpl });

  if (!res.ok) {
    const serverMsg = await readAPIError(res, "");
    if (res.status === 429) {
      // The server message already says when the cooldown lifts.
      throw new AgentActionError("rename_cooldown", serverMsg || "you renamed recently; please try again later", 429);
    }
    if (res.status === 400) {
      throw new AgentActionError("rename_invalid", serverMsg || "that name is not allowed", 400);
    }
    throw new AgentActionError("rename_failed", serverMsg || `rename failed with HTTP ${res.status}`, res.status);
  }

  const body = (await res.json().catch(() => ({}))) as { name?: unknown; public_no?: unknown };
  return {
    name: typeof body.name === "string" ? body.name : name,
    ...(typeof body.public_no === "number" ? { publicNo: body.public_no } : {}),
  };
}

export interface ChallengeStatus {
  readonly status: string;
  readonly game?: string;
  readonly guestAgentName?: string;
}

/**
 * The token-holder's view of a challenge. Unauthenticated by design — holding
 * the token IS the access control — which is what lets the companion watch a
 * challenge it created without another credential.
 */
export async function fetchChallengeStatus(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ChallengeStatus | null> {
  const res = await fetchNoFollow(
    `${baseUrl.replace(/\/+$/, "")}/api/challenges/${encodeURIComponent(token)}`,
    { method: "GET", signal: AbortSignal.timeout(5_000) },
    { fetchImpl },
  );
  if (!res.ok) return null;
  const body = (await res.json().catch(() => undefined)) as { duel?: Record<string, unknown> } | undefined;
  const duel = body?.duel;
  if (duel === undefined || typeof duel.status !== "string") return null;
  return {
    status: duel.status,
    ...(typeof duel.game === "string" ? { game: duel.game } : {}),
    ...(typeof duel.guest_agent_name === "string" && duel.guest_agent_name !== ""
      ? { guestAgentName: duel.guest_agent_name }
      : {}),
  };
}

function tokenFromJoinUrl(joinUrl: string): string | null {
  try {
    const parts = new URL(joinUrl).pathname.split("/").filter(Boolean);
    const markerIndex = parts.findIndex((p) => p === "challenge" || p === "duel");
    return markerIndex >= 0 ? parts[markerIndex + 1] ?? null : null;
  } catch {
    return null;
  }
}

function base(config: BridgeConfig): string {
  return config.baseUrl.replace(/\/+$/, "");
}

async function readAPIError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => undefined) as unknown;
  if (body && typeof body === "object") {
    const error = (body as Record<string, unknown>).error;
    if (typeof error === "string" && error.length > 0) return error;
  }
  return fallback;
}
