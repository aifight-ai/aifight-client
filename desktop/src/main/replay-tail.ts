// Fetch the complete PUBLIC frame list of a finished match's replay.
//
// Why this exists: the local bridge is a PLAYER — its event stream arrives as
// action_request.new_events, which stops at this player's LAST decision. The
// closing stretch of a match (opponents' final actions, the showdown, the
// result) never reaches the bridge, so without this the cockpit board freezes
// mid-hand on "opponent thinking…" forever. game_over hands us the public
// replay path; we page the public frames API and hand the renderer the full
// sequence. 🔒 Public data only — the replay endpoint is the same one the
// website serves to any anonymous visitor, and it exists only once the match
// is over.

import type { ReplayTailFrame } from "../shared/ipc";

/** The server caps a frames page at 25 (publicFrameMaxLimit). */
const PAGE_LIMIT = 25;
/** Hard stop: 80 pages ≈ 2000 frames, far past any real match. */
const MAX_PAGES = 80;
/** The public replay budget refills ~1 req/s (burst 20): pace politely on 429. */
const THROTTLE_DELAY_MS = 1200;
const PAGE_TIMEOUT_MS = 8000;

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** "/replay/replay_XXX?step=3" → "replay_XXX"; null when no id is present. */
export function replayIDFromPath(replayPath: string): string | null {
  const clean = replayPath.split(/[?#]/, 1)[0] ?? "";
  const seg = clean.split("/").filter((s) => s !== "");
  const id = seg[seg.length - 1];
  return id !== undefined && id !== "" ? id : null;
}

/**
 * Page through GET {origin}/api/replays/{id}/frames until has_more=false.
 * Returns null on any unrecoverable failure (replay missing, malformed pages)
 * so the caller keeps the board it already has. One 429 pauses and retries the
 * SAME page; a second consecutive 429 on that page gives up rather than hammer.
 */
export async function fetchReplayTail(
  origin: string,
  replayPath: string,
  fetchImpl: FetchLike = fetch,
  throttleDelayMs: number = THROTTLE_DELAY_MS,
): Promise<readonly ReplayTailFrame[] | null> {
  const id = replayIDFromPath(replayPath);
  if (id === null) return null;
  const base = origin.replace(/\/+$/, "");

  const out: ReplayTailFrame[] = [];
  let from = 0;
  let throttledThisPage = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${base}/api/replays/${encodeURIComponent(id)}/frames?from=${from}&limit=${PAGE_LIMIT}`;
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
    } catch {
      return null;
    }
    if (res.status === 429) {
      if (throttledThisPage) return null;
      throttledThisPage = true;
      page--; // retry the same page once after the limiter refills
      await sleep(throttleDelayMs);
      continue;
    }
    throttledThisPage = false;
    if (!res.ok) return null;

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return null;
    }
    const b = (body ?? {}) as { frames?: unknown; has_more?: unknown };
    if (!Array.isArray(b.frames)) return null;
    for (const f of b.frames) {
      if (f !== null && typeof f === "object") out.push(f as ReplayTailFrame);
    }
    if (b.has_more !== true) return out;
    // `from` is a ROW offset (pre-sanitize): a page can return fewer frames
    // than rows it consumed when sanitize drops some. Advancing by the frame
    // count re-reads the dropped rows' neighbours (the seq-merge dedupes), and
    // a fully-dropped page advances by the whole window — has_more says rows
    // remain, so skipping that window is correct, never early-terminating.
    from += b.frames.length > 0 ? b.frames.length : PAGE_LIMIT;
  }
  // Page cap hit: return what we have — a partial tail still beats a frozen board.
  return out;
}
