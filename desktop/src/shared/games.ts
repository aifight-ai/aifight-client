// Live-game list plumbing — the desktop FOLLOWS the backend's live-game
// allow-list instead of keeping its own hardcoded copy (the same single-source
// rule the web frontend adopted in 561664a: engine.LiveNames() is the only
// authority; activating a game must not require a desktop edit).
//
// Two backend sources feed one main-process cache (bridge-host.ts):
//   - the bridge welcome frame: data.games = engine.LiveNames(), refreshed on
//     every (re)connect at zero cost;
//   - GET /api/games ({ games: [{ name, … }] }, live-only + ordered), for
//     before/without a bridge connection.
// FALLBACK_LIVE_GAMES is the ONE remaining local copy, used only while the
// platform has not answered yet (offline / unconfigured).
//
// Deliberately separate from the `Game` TYPE union (shared/ipc.ts): the union
// declares which games THIS BUILD can render (board/own-hand views) and only
// widens when rendering support lands; the runtime list here declares which
// games are publicly live, and may legitimately exceed the union — such games
// play fine and degrade to a generic cockpit (no board).
//
// Self-contained like shared/ipc.ts: no electron, no runtime, no node imports,
// so both main and the strict renderer can import it (and tests run in node).

/** Last-resort live list while the platform hasn't answered. Never authoritative. */
export const FALLBACK_LIVE_GAMES: readonly string[] = ["texas_holdem", "liars_dice", "coup"];

// Engine names are lowercase snake_case identifiers. This is also the
// path-safety gate for strategy-file scopes (strategy-host.ts joins these into
// file paths), so it must stay strict: no dots, slashes, or uppercase.
const SAFE_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export function isSafeGameName(value: unknown): value is string {
  return typeof value === "string" && SAFE_NAME.test(value);
}

/** Keep only well-formed, de-duplicated names; null when nothing usable remains. */
function sanitizeNames(values: unknown): readonly string[] | null {
  if (!Array.isArray(values)) return null;
  const out: string[] = [];
  for (const v of values) {
    if (isSafeGameName(v) && !out.includes(v)) out.push(v);
  }
  return out.length > 0 ? out : null;
}

/** Live games from a bridge welcome frame (`data.games`). Null if absent/malformed. */
export function parseWelcomeGames(data: unknown): readonly string[] | null {
  return sanitizeNames((data as { games?: unknown } | null | undefined)?.games);
}

/** Live games from a GET /api/games response (`{ games: [{ name, … }] }`). Null if malformed. */
export function parseGamesResponse(json: unknown): readonly string[] | null {
  const arr = (json as { games?: unknown } | null | undefined)?.games;
  if (!Array.isArray(arr)) return null;
  return sanitizeNames(arr.map((g) => (g as { name?: unknown } | null | undefined)?.name));
}

// Proper-noun display labels (identical in every language — these are titles,
// not translations). A live game without an entry renders its prettified
// engine name until a desktop release adds the official title.
const GAME_LABEL: Record<string, string> = {
  texas_holdem: "Texas Hold'em",
  liars_dice: "Liar's Dice",
  coup: "Coup",
};

/** Display label for an engine game name ("texas_holdem" → "Texas Hold'em", unknown "bocce_ball" → "Bocce Ball"). */
export function gameLabel(name: string): string {
  const known = GAME_LABEL[name];
  if (known !== undefined) return known;
  return name
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}
