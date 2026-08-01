// 连接审计 #3/#12 (2026-07-28): the ONLY honest source of "am I queued, and for
// which game" is the server's own protocol echoes. This pure helper reads a raw
// server frame and answers how the host's queued belief should change:
//   - {game, mode}  → queue_joined: we ARE in this queue now
//   - null          → queue_left / game_start: whatever we believed, it's over
//                     (game_start consumes the queue entry server-side)
//   - undefined     → frame says nothing about queue membership
// Disconnects also clear the belief, but that lives at the host's snapshot edge
// (the server kicks every queue entry on socket death — hub.OnQueueLeave).

export interface QueuedInfo {
  readonly game: string;
  readonly mode: string;
  /** True when the server echoed one_shot — an explicit manual match request.
   *  Server-side enrollment (orchestrator sweep, auto-requeue) echoes false,
   *  so this is the only queue entry the UI may name a game for (owner ruling
   *  2026-08-01: standby is game-agnostic; the platform picks the game). */
  readonly oneShot: boolean;
}

export function queueTransitionOf(message: unknown): QueuedInfo | null | undefined {
  if (message === null || typeof message !== "object") return undefined;
  const m = message as { type?: unknown; data?: unknown };
  if (m.type === "queue_left" || m.type === "game_start") return null;
  if (m.type !== "queue_joined") return undefined;
  const d = (m.data ?? {}) as { game?: unknown; mode?: unknown; one_shot?: unknown };
  if (typeof d.game !== "string" || d.game === "") return undefined;
  return {
    game: d.game,
    mode: typeof d.mode === "string" ? d.mode : "ranked",
    oneShot: d.one_shot === true,
  };
}
