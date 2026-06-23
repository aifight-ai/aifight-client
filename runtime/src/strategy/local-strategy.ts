import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import type { GameType } from "../decision/types";
import { getRuntimeHome } from "../store/paths";
import type { BridgeDecisionStrategy, BridgeDecisionStrategySection } from "../bridge/provider";

const MAX_STRATEGY_FILE_BYTES = 64 * 1024;

/**
 * Starter template written to a fresh `strategy/global.md` on first setup.
 *
 * This is the single source of truth for an agent's *strategy* — there is no
 * separate "soul/persona" file or schema. The whole document is free-form text
 * that the runtime injects into the system prompt before each decision; a user
 * may describe how their agent reasons or the tone it uses, but the product
 * treats all of it as strategy. Per-game tactics layer on top in
 * `strategy/games/<game>.md`.
 */
export const DEFAULT_GLOBAL_STRATEGY = `# Strategy

This is your agent's global strategy. It applies to every game you play on
AIFight and is added to the system prompt before each decision. Write plain
guidance here, in your own words — there is no required format or schema.

You can describe how your agent should reason, weigh risk, and read opponents,
and even the voice it uses when it explains a move. Per-game tactics go in
strategy/games/<game>.md and layer on top of this file. Leave anything blank
and the runtime simply skips it.

## How to decide
- Reason from the information in the current game state; don't over-anchor on past rounds.
- Take calculated risks only when the expected value is clearly positive.
- Prefer a safe legal action when uncertain or short on time.

## Reading opponents
- Track betting, bidding, and claim patterns and adapt as the match goes on.
- Stay unpredictable enough that opponents can't model you cheaply.
`;

export interface LocalStrategyPaths {
  readonly root: string;
  readonly global: string;
  readonly gamesDir: string;
  readonly game?: string;
}

export interface LocalStrategyBundle extends BridgeDecisionStrategy {
  readonly paths: LocalStrategyPaths;
}

export interface LoadLocalStrategyOptions {
  readonly runtimeHome?: string;
}

export function resolveLocalStrategyPaths(
  agentId: string,
  game?: GameType,
  opts: LoadLocalStrategyOptions = {},
): LocalStrategyPaths {
  const root = path.join(opts.runtimeHome ?? getRuntimeHome(), "agents", safePathSegment(agentId), "strategy");
  const gamesDir = path.join(root, "games");
  return {
    root,
    global: path.join(root, "global.md"),
    gamesDir,
    ...(game !== undefined ? { game: path.join(gamesDir, `${game}.md`) } : {}),
  };
}

export function loadLocalStrategy(
  agentId: string,
  game: GameType,
  opts: LoadLocalStrategyOptions = {},
): LocalStrategyBundle {
  const paths = resolveLocalStrategyPaths(agentId, game, opts);
  const sections = [
    readStrategySection("global", paths.global),
    paths.game !== undefined ? readStrategySection("game", paths.game, game) : null,
  ].filter((section): section is BridgeDecisionStrategySection => section !== null);
  return {
    sections,
    paths,
  };
}

function readStrategySection(
  scope: BridgeDecisionStrategySection["scope"],
  filePath: string,
  game?: GameType,
): BridgeDecisionStrategySection | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size <= 0) return null;

  const raw = fs.readFileSync(filePath);
  const truncated = raw.length > MAX_STRATEGY_FILE_BYTES;
  const bytes = truncated ? raw.subarray(0, MAX_STRATEGY_FILE_BYTES) : raw;
  const content = bytes.toString("utf8").trim();
  if (content === "") return null;

  return {
    scope,
    ...(game !== undefined ? { game } : {}),
    path: filePath,
    content,
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
    bytes: Buffer.byteLength(content, "utf8"),
    mtimeMs: Math.trunc(stat.mtimeMs),
    truncated,
  };
}

function safePathSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  return safe.length > 0 ? safe : "unknown";
}

/**
 * Write a starter `strategy/global.md` (DEFAULT_GLOBAL_STRATEGY) if one does not
 * already exist, so a freshly set-up agent has an editable strategy to play
 * with. Idempotent: an existing file (even empty) is never clobbered. The file
 * lands at exactly the path the runtime reads at decision time
 * (resolveLocalStrategyPaths), so the scaffold is immediately in effect.
 *
 * The directory is created 0700 and the file 0600 (best-effort chmod, no-op on
 * Windows), matching the rest of the local runtime home. Never throws on chmod;
 * fs write errors propagate to the caller, which treats scaffolding as
 * best-effort.
 */
export async function scaffoldGlobalStrategy(
  agentId: string,
  opts: LoadLocalStrategyOptions = {},
): Promise<"created" | "exists"> {
  const paths = resolveLocalStrategyPaths(agentId, undefined, opts);
  await fsp.mkdir(paths.root, { recursive: true, mode: 0o700 });
  await chmodBestEffort(paths.root, 0o700);
  try {
    await fsp.access(paths.global);
    return "exists";
  } catch {
    // Absent — create it below.
  }
  await fsp.writeFile(paths.global, DEFAULT_GLOBAL_STRATEGY, { mode: 0o600 });
  await chmodBestEffort(paths.global, 0o600);
  return "created";
}

async function chmodBestEffort(target: string, mode: number): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await fsp.chmod(target, mode);
  } catch {
    // Best effort only; the runtime home is already user-scoped.
  }
}
