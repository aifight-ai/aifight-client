// One renderer-wide view of the platform's live-game list. The BACKEND is the
// single source (shared/games.ts; bridge-host caches the welcome frame /
// GET /api/games); this hook gives every view a synchronous render value — the
// last-known list, seeded with the local fallback until the first answer — and
// re-asks main on each mount (cheap: main answers from its cache), so a game
// launched mid-session shows up on the next tab visit.

import { useEffect, useState } from "react";

import { FALLBACK_LIVE_GAMES } from "../shared/games";
import { getLiveGames } from "./useBridge";

let cached: readonly string[] | null = null;

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** The platform's live games, in canonical order. Never empty. */
export function useLiveGames(): readonly string[] {
  const [games, setGames] = useState<readonly string[]>(() => cached ?? FALLBACK_LIVE_GAMES);
  useEffect(() => {
    let alive = true;
    void getLiveGames().then((list) => {
      if (!alive || list.length === 0) return;
      cached = list;
      setGames((prev) => (sameList(prev, list) ? prev : list));
    });
    return () => {
      alive = false;
    };
  }, []);
  return games;
}
