// The daily automatic-match cap: the one place that knows what the number
// means, what it costs, and how to tell the platform about it.
//
// Three surfaces change this setting — `aifight set daily`, the setup wizard,
// and the Telegram settings panel — and all three must agree on the ceiling,
// the confirmation threshold, and the PATCH body. It lives here rather than in
// a CLI command module so the bridge process can reach it without dragging in
// terminal I/O.

import { fetchNoFollow } from "../net/guarded-fetch";
import type { BridgeConfig } from "./config";

/** Above this many automatic matches per day, every surface asks for an
 *  explicit second confirmation — the cap is a token-burn safety valve, and
 *  >10/day means a lot of model calls on the user's own key. Mirrors the
 *  desktop dashboard's CAP_CONFIRM_THRESHOLD; change both together. */
export const DAILY_CAP_CONFIRM_THRESHOLD = 10;

/** Client-side ceiling for a hand-entered cap. Mirrors the desktop dashboard's
 *  CAP_MAX (PlayView.tsx); change both together. The server ceiling
 *  (agent_daily_ranked_cap, admin-tunable) is the real hard limit and clamps
 *  anything higher on the PATCH. */
export const SETUP_WIZARD_CAP_MAX = 100;

/** Someone is always waiting on this PATCH — a wizard step, a CLI command, or a
 *  tap in the chat panel, where a hung request also blocks the bot's whole
 *  update loop. Five minutes of undici default is not a wait, it is a hang. */
const POLICY_TIMEOUT_MS = 15_000;

export function dailyCapNeedsConfirm(limit: number): boolean {
  return limit > DAILY_CAP_CONFIRM_THRESHOLD;
}

export class DailyPolicySyncError extends Error {
  override readonly name = "DailyPolicySyncError";
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface DailyPolicyResult {
  /**
   * The cap as this client models it, AFTER the server had its say: the server
   * clamps to the account ceiling and answers with what it stored, so asking
   * for 500 and reporting "set to 500" would be repeating the question back as
   * if it were the answer. 0 when auto-requeue came back off.
   */
  readonly effectiveLimit: number;
  readonly maxGamesPerDay?: number;
  readonly autoRequeue?: boolean;
}

/**
 * Push the cap to the platform. 0 is not "zero matches per day" to the server —
 * it is auto_requeue:false, i.e. the agent stops queueing itself at all.
 */
export async function syncDailyPolicy(
  config: BridgeConfig,
  limit: number,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<DailyPolicyResult> {
  const body = limit === 0
    ? { auto_requeue: false }
    : { max_games_per_day: limit, auto_requeue: true };
  const res = await fetchNoFollow(`${config.baseUrl.replace(/\/+$/, "")}/api/agents/me/policy`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": config.apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(POLICY_TIMEOUT_MS),
  }, { fetchImpl });
  if (!res.ok) {
    throw new DailyPolicySyncError(await readAPIError(res, `daily policy sync failed with HTTP ${res.status}`), res.status);
  }
  const answer = (await res.json().catch(() => undefined)) as
    | { policy?: { max_games_per_day?: unknown; auto_requeue?: unknown } }
    | undefined;
  const stored = answer?.policy?.max_games_per_day;
  const autoRequeue = answer?.policy?.auto_requeue;
  // A server that answers with something unreadable is not a reason to doubt
  // the write it just accepted: fall back to what was asked for.
  const effectiveLimit = autoRequeue === false
    ? 0
    : typeof stored === "number" && Number.isFinite(stored) && stored >= 0
      ? stored
      : limit;
  return {
    effectiveLimit,
    ...(typeof stored === "number" ? { maxGamesPerDay: stored } : {}),
    ...(typeof autoRequeue === "boolean" ? { autoRequeue } : {}),
  };
}

async function readAPIError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => undefined) as unknown;
  if (body && typeof body === "object") {
    const error = (body as Record<string, unknown>).error;
    if (typeof error === "string" && error.length > 0) return error;
  }
  return fallback;
}
