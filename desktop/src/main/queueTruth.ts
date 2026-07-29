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
}

export function queueTransitionOf(message: unknown): QueuedInfo | null | undefined {
  if (message === null || typeof message !== "object") return undefined;
  const m = message as { type?: unknown; data?: unknown };
  if (m.type === "queue_left" || m.type === "game_start") return null;
  if (m.type !== "queue_joined") return undefined;
  const d = (m.data ?? {}) as { game?: unknown; mode?: unknown };
  if (typeof d.game !== "string" || d.game === "") return undefined;
  return { game: d.game, mode: typeof d.mode === "string" ? d.mode : "ranked" };
}
