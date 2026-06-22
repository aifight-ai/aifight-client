import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { GameType } from "../decision/types";
import { getRuntimeHome } from "../store/paths";
import type { BridgeDecisionStrategy, BridgeDecisionStrategySection } from "../bridge/provider";

const MAX_STRATEGY_FILE_BYTES = 64 * 1024;

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
