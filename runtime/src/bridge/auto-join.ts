// Which game the bridge queues for on its own.
//
// Shared by the process that starts the bridge and by the Telegram panel's
// "resume automatic matching" button, so a resume picks games exactly the way
// startup does instead of inventing a second rule.

import { SUPPORTED_GAMES, isSupportedGame } from "../cli/shared";
import type { BridgeConfig } from "./config";

export type SupportedGame = "texas_holdem" | "liars_dice" | "coup";

/** The full standby declaration: every game the user enabled (or all of them
 *  when unset). This is what the bridge PATCHes to the platform so the supply
 *  sweep can assign a game (R2); pickAutomaticGame stays the FALLBACK's way of
 *  choosing one when the platform has not assigned anything in time. */
export function standbyGamePool(configured: readonly string[] | undefined): SupportedGame[] {
  const games = (configured ?? SUPPORTED_GAMES).filter(isSupportedGame);
  return (games.length > 0 ? games : [...SUPPORTED_GAMES]) as SupportedGame[];
}

/** One game out of the user's preference list (or all of them when unset).
 *  Random on purpose: a fixed order would starve the later games. */
export function pickAutomaticGame(configured: readonly string[] | undefined): SupportedGame {
  const games = (configured ?? SUPPORTED_GAMES).filter(isSupportedGame);
  const pool = games.length > 0 ? games : SUPPORTED_GAMES;
  return pool[Math.floor(Math.random() * pool.length)]! as SupportedGame;
}

/** The runner options that make a bridge queue by itself. A daily cap of 0
 *  means "manual only", so it yields no auto-join at all. */
export function automaticJoinOptions(config: BridgeConfig): {
  readonly autoJoinGame?: SupportedGame;
  readonly autoJoinMode?: string;
  readonly autoJoinOneShot?: boolean;
} {
  const automaticGame = (config.autoDailyLimit ?? 0) > 0
    ? pickAutomaticGame(config.autoGames)
    : undefined;
  return automaticGame === undefined
    ? {}
    : {
        autoJoinGame: automaticGame,
        autoJoinMode: "ranked",
        autoJoinOneShot: false,
      };
}
