// The daily automatic-match cap: the one place that knows what the number
// means, what it costs, and how to tell the platform about it.
//
// Three surfaces change this setting — `aifight set daily`, the setup wizard,
// and the Telegram settings panel — and all three must agree on the ceiling,
// the confirmation threshold, and the PATCH body. It lives here rather than in
// a CLI command module so the bridge process can reach it without dragging in
// terminal I/O.
//
// It also owns the two calls that turn the SERVER half of automatic matching
// on and off — declareStandbyGames (on) and withdrawFromMatchmaking (off) —
// for the same reason: the bridge runner, the CLI and the chat panel all need
// them, and they must not drift apart.

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
/**
 * Declare which games this agent stands by for (R2 platform orchestration).
 * Fire-and-forget from the bridge's connect edge: a failure (old server that
 * rejects the unknown field, transient network) only means the platform cannot
 * assign a game — the local fallback join covers exactly that case, so errors
 * are the caller's to log, never to retry hot.
 *
 * The body ALSO re-opens `auto_requeue` (2026-08-06). Declaring standby is the
 * server's only signal that the agent is available, but the platform's
 * candidate query additionally requires `auto_requeue = TRUE` — and pausing
 * matching turns that flag OFF server-side (ApplyLeaveQueueSideEffects). Resume
 * used to restore only the LOCAL half, so every user who had ever paused stayed
 * invisible to the supply sweep forever while their UI said "standing by".
 * Declaring is only ever reached when matching is NOT paused and the daily cap
 * is above zero, i.e. exactly when "the platform may assign me a match" is what
 * the user asked for — so the two belong in one write, and every stuck install
 * heals at its next connect edge or standby refresh without touching anything.
 */
export async function declareStandbyGames(
  config: BridgeConfig,
  games: readonly string[],
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> {
  const res = await patchPolicy(config, { standby_games: games, auto_requeue: true }, fetchImpl);
  if (res.ok) return;
  // The server refuses `auto_requeue: true` when the STORED daily cap is 0
  // ("auto_requeue=true requires max_games_per_day > 0"). A regular agent in
  // that state is excluded from the candidate query anyway, but an org-scope
  // agent reads a stored 0 as "unlimited" and is still selectable — dropping
  // its standby set over a field it never needed would be a regression. So a
  // 400 falls back to the pre-2026-08-06 body, and only that body's failure is
  // reported.
  if (res.status === 400) {
    const retry = await patchPolicy(config, { standby_games: games }, fetchImpl);
    if (retry.ok) return;
    throw new DailyPolicySyncError(
      await readAPIError(retry, `standby declaration failed with HTTP ${retry.status}`),
      retry.status,
    );
  }
  throw new DailyPolicySyncError(await readAPIError(res, `standby declaration failed with HTTP ${res.status}`), res.status);
}

function patchPolicy(
  config: BridgeConfig,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<Response> {
  return fetchNoFollow(`${config.baseUrl.replace(/\/+$/, "")}/api/agents/me/policy`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": config.apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(POLICY_TIMEOUT_MS),
  }, { fetchImpl });
}

/**
 * The SERVER half of "pause matching": POST /api/queue/leave with the agent
 * key drops every queued entry AND clears `auto_requeue`
 * (internal/hub/policy.go ApplyLeaveQueueSideEffects), so the platform's supply
 * sweep stops treating this agent as available. Idempotent — leaving with
 * nothing queued is a no-op, and it never touches a match already in progress.
 *
 * Two callers, one implementation on purpose: `aifight pause` when no bridge is
 * running to do it over the control plane, and the runner's connect edge when
 * it comes online already paused. The second exists because the local flag and
 * the server flag can drift — a desktop pause taken while the bridge was down,
 * or a leave that failed at the time, used to leave the agent fully selectable
 * while its owner believed matching was off.
 *
 * Throws a DailyPolicySyncError (carrying the status) when the server refuses,
 * and the raw transport error otherwise; callers decide what that is worth (the
 * CLI turns both into a CommandError, the runner only logs).
 */
export async function withdrawFromMatchmaking(
  config: BridgeConfig,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> {
  const res = await fetchNoFollow(`${config.baseUrl.replace(/\/+$/, "")}/api/queue/leave`, {
    method: "POST",
    headers: { "X-API-Key": config.apiKey },
    signal: AbortSignal.timeout(POLICY_TIMEOUT_MS),
  }, { fetchImpl });
  if (!res.ok) {
    throw new DailyPolicySyncError(`queue leave failed with HTTP ${res.status}`, res.status);
  }
}

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
