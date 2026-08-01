// Local record of the friendly challenges THIS machine created.
//
// The server stores only a DIGEST of the join token (codex C07), so the share
// URL exists exactly once — in the create response. Losing it used to mean
// waiting out the 24h expiry (owner report 2026-08-01). This module keeps the
// URL on the creating machine, keyed by pending_duels.id, so `aifight
// challenge list` (and the Telegram panel) can show it again. Purely a local
// convenience: no secret leaves the machine it was already delivered to.

import path from "node:path";
import fs from "node:fs";

import { getRuntimeHome } from "../store/paths";

export interface CreatedChallengeRecord {
  readonly url: string;
  readonly game: string;
  /** Table size it was created with (2 = classic duel). */
  readonly players: number;
  /** ISO creation time — orders the cap-50 eviction. */
  readonly at: string;
}

const CAP = 50;

function recordPath(): string {
  return path.join(getRuntimeHome(), "challenges-created.json");
}

/** duelId → record. Any read/parse failure = empty map (convenience data). */
export function loadCreatedChallenges(): Record<string, CreatedChallengeRecord> {
  try {
    const parsed = JSON.parse(fs.readFileSync(recordPath(), "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, CreatedChallengeRecord> = {};
    for (const [id, rec] of Object.entries(parsed as Record<string, unknown>)) {
      if (rec === null || typeof rec !== "object") continue;
      const r = rec as Record<string, unknown>;
      if (typeof r.url !== "string" || r.url === "") continue;
      out[id] = {
        url: r.url,
        game: typeof r.game === "string" ? r.game : "",
        players: typeof r.players === "number" && r.players >= 2 ? r.players : 2,
        at: typeof r.at === "string" ? r.at : "",
      };
    }
    return out;
  } catch {
    return {};
  }
}

function save(map: Record<string, CreatedChallengeRecord>): void {
  try {
    const entries = Object.entries(map)
      .sort((a, b) => (a[1].at < b[1].at ? 1 : -1))
      .slice(0, CAP);
    fs.mkdirSync(getRuntimeHome(), { recursive: true });
    fs.writeFileSync(recordPath(), JSON.stringify(Object.fromEntries(entries), null, 2) + "\n", { mode: 0o600 });
  } catch {
    // A full disk only costs the copy convenience — never the command.
  }
}

export function rememberCreatedChallenge(duelId: string, rec: CreatedChallengeRecord): void {
  if (duelId === "") return;
  const map = loadCreatedChallenges();
  map[duelId] = rec;
  save(map);
}

/** Drop records whose duel the server-side list has shown as ENDED. Ids the
 *  list does not know (old rows beyond its limit) are left alone. */
export function forgetEndedChallenges(endedIds: readonly string[]): void {
  if (endedIds.length === 0) return;
  const map = loadCreatedChallenges();
  let changed = false;
  for (const id of endedIds) {
    if (map[id] !== undefined) {
      delete map[id];
      changed = true;
    }
  }
  if (changed) save(map);
}
