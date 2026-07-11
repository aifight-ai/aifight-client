import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import type { GameType } from "../decision/types";
import { getRuntimeHome, safePathSegment } from "../store/paths";
import type { BridgeDecisionStrategy, BridgeDecisionStrategySection } from "../bridge/provider";

const MAX_STRATEGY_FILE_BYTES = 64 * 1024;

// An agent's strategy is free-form Markdown — there is no separate
// "soul/persona" file or schema. `strategy/global.md` applies to every game and
// per-game tactics layer on top in `strategy/games/<game>.md`. A fresh setup
// scaffolds an EMPTY global.md (see scaffoldGlobalStrategy): there is no default
// strategy, and an empty file is skipped at decision time, so nothing is
// injected until the user writes something.

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

/**
 * Scaffold an empty `strategy/global.md` if one does not already exist, so a
 * freshly set-up agent has an editable file ready at the path the runtime reads
 * each decision (resolveLocalStrategyPaths). There is no default strategy — the
 * file starts empty, and an empty file is skipped at decision time
 * (readStrategySection returns null), so nothing is injected until the user
 * writes something. Idempotent: an existing file (even empty) is never
 * clobbered.
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
  await fsp.writeFile(paths.global, "", { mode: 0o600 });
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
