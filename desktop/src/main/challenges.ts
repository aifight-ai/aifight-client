// Normalize GET /api/agents/me/challenges (agent-key) into renderer rows.
// Pure (no Electron / no network) so it is unit-tested — same pattern as
// agentProfile.ts. The server returns pending_duels rows where the agent is
// host OR guest; `agentId` resolves the local side's role + opponent name.

import type { ChallengeInfo } from "../shared/ipc";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Map a raw duels payload to ChallengeInfo rows. Never throws; bad rows drop out. */
export function normalizeChallenges(json: unknown, agentId: string): readonly ChallengeInfo[] {
  const duels = (json as { duels?: unknown } | null)?.duels;
  if (!Array.isArray(duels)) return [];
  const out: ChallengeInfo[] = [];
  for (const row of duels) {
    const d = row as Record<string, unknown> | null;
    const id = str(d?.id);
    const status = str(d?.status);
    if (id === "" || status === "") continue;
    const isHost = str(d?.host_agent_id) === agentId;
    const maxPlayers = typeof d?.max_players === "number" && d.max_players >= 2 ? d.max_players : 2;
    out.push({
      id,
      game: str(d?.game),
      status,
      isHost,
      // The side opposite mine; "" while a hosted challenge has no taker yet.
      opponentName: isHost ? str(d?.guest_agent_name) : str(d?.host_agent_name),
      createdAt: str(d?.created_at),
      expiresAt: str(d?.expires_at),
      maxPlayers,
      seatedCount: typeof d?.seated_count === "number" ? d.seated_count : 0,
    });
  }
  return out;
}
