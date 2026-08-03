import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readBridgeConfig } from "../../bridge/config";
import type { GameType } from "../../decision/types";
import { getRuntimeHome } from "../../store/paths";
import { resolveLocalStrategyPaths } from "../../strategy/local-strategy";
import { createStatusIcons } from "../ansi";
import { resolveLocale, t } from "../i18n";
import { createOutput } from "../output";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { SUPPORTED_GAMES, UsageError, expectArity, isSupportedGame } from "../shared";

const USAGE = [
  "usage: aifight strategy path [game]",
  "       aifight strategy init [game]",
  "       aifight strategy validate [game]",
  `supported games: ${SUPPORTED_GAMES.join(", ")}`,
].join("\n");

interface StrategyFile {
  readonly scope: "global" | "game";
  readonly game?: GameType;
  readonly path: string;
}

interface StrategyFileStatus extends StrategyFile {
  readonly exists: boolean;
  readonly bytes: number;
  readonly empty: boolean;
  readonly truncatedByBridge: boolean;
  readonly warnings: readonly string[];
}

export async function runBridgeStrategy(
  args: HandlerArgs,
  env: HandlerEnv,
): Promise<number> {
  expectArity(args, 1, 2, USAGE);
  const action = args.positional[0]!;
  const game = parseOptionalGame(args.positional[1]);
  if (action === "path") return printStrategyPaths(game, args, env);
  if (action === "init") return initStrategyFiles(game, args, env);
  if (action === "validate") return validateStrategyFiles(game, args, env);
  throw new UsageError(`unknown strategy command '${action}'`, "available: path | init | validate");
}

function printStrategyPaths(
  game: GameType | undefined,
  args: HandlerArgs,
  env: HandlerEnv,
): number {
  const loc = env.locale?.() ?? resolveLocale();
  const out = createOutput();
  const config = readBridgeConfig();
  const paths = resolveLocalStrategyPaths(config.agentId, game);
  const gamePaths = game === undefined
    ? SUPPORTED_GAMES.map((g) => ({
      game: g,
      path: resolveLocalStrategyPaths(config.agentId, g as GameType).game!,
    }))
    : [{ game, path: paths.game! }];

  if (args.jsonMode) {
    env.stdout(JSON.stringify({
      agentId: config.agentId,
      root: paths.root,
      global: paths.global,
      gamesDir: paths.gamesDir,
      games: gamePaths,
    }) + "\n");
    return 0;
  }

  // P7 (U8b): the paths used to arrive with no answer to "what IS this file?".
  // Two lines of plain explanation, then the official guide on its own
  // unstyled line, then the paths.
  const base = config.baseUrl.replace(/\/+$/, "") || "https://aifight.ai";
  env.stdout(`${out.section(t(loc, "strategy.section"))}\n`);
  env.stdout(`${out.note(t(loc, "strategy.intro"))}\n`);
  env.stdout(`${out.note(t(loc, "strategy.intro.guide"))}\n`);
  env.stdout(`  ${base}/how-to-win\n\n`);
  for (const line of out.kvRows([
    [t(loc, "strategy.root"), shortenHome(paths.root), "dim"],
    [t(loc, "strategy.global"), shortenHome(paths.global), "dim"],
    [t(loc, "strategy.gamesdir"), shortenHome(paths.gamesDir), "dim"],
    ...gamePaths.map((item) => [item.game, shortenHome(item.path), "dim"] as const),
  ])) {
    env.stdout(`${line}\n`);
  }
  env.stdout(`${out.note(t(loc, "strategy.note.format"))}\n`);
  env.stdout(`${out.note(t(loc, "strategy.note.skip"))}\n`);
  return 0;
}

function initStrategyFiles(
  game: GameType | undefined,
  args: HandlerArgs,
  env: HandlerEnv,
): number {
  const config = readBridgeConfig();
  const files = strategyFiles(config.agentId, game);
  let created = 0;
  let kept = 0;
  for (const file of files) {
    fs.mkdirSync(path.dirname(file.path), { recursive: true, mode: 0o700 });
    chmodBestEffort(path.dirname(file.path), 0o700);
    if (fs.existsSync(file.path)) {
      kept += 1;
      continue;
    }
    fs.writeFileSync(file.path, "", { mode: 0o600 });
    chmodBestEffort(file.path, 0o600);
    created += 1;
  }

  if (args.jsonMode) {
    env.stdout(JSON.stringify({ status: "ok", created, kept, files }) + "\n");
    return 0;
  }
  const loc = env.locale?.() ?? resolveLocale();
  const out = createOutput();
  env.stdout(`${t(loc, "strategy.init.ready", { created, kept })}\n`);
  for (const line of out.kvRows(
    files.map((file) => [labelFor(file), shortenHome(file.path), "dim"] as const),
  )) {
    env.stdout(`${line}\n`);
  }
  env.stdout(`${out.note(t(loc, "strategy.init.note"))}\n`);
  return 0;
}

function validateStrategyFiles(
  game: GameType | undefined,
  args: HandlerArgs,
  env: HandlerEnv,
): number {
  const config = readBridgeConfig();
  const files = strategyFiles(config.agentId, game).map((file) => inspectStrategyFile(file));
  const warnings = files.flatMap((file) => file.warnings.map((warning) => ({
    path: file.path,
    warning,
  })));

  if (args.jsonMode) {
    env.stdout(JSON.stringify({
      status: warnings.length === 0 ? "ok" : "warning",
      files,
      warnings,
    }) + "\n");
    return warnings.length === 0 ? 0 : 1;
  }

  const loc = env.locale?.() ?? resolveLocale();
  const icons = env.statusIcons ?? createStatusIcons();
  for (const file of files) {
    const label = labelFor(file);
    if (!file.exists) {
      env.stdout(`${icons.warn} ${label}: ${t(loc, "strategy.validate.missing")} (${shortenHome(file.path)})\n`);
      continue;
    }
    if (file.empty) {
      env.stdout(`${icons.warn} ${label}: ${t(loc, "strategy.validate.empty")} (${shortenHome(file.path)})\n`);
      continue;
    }
    env.stdout(`${icons.ok} ${label}: ${t(loc, "strategy.validate.ok", { bytes: file.bytes })}${file.truncatedByBridge ? ` ${t(loc, "strategy.validate.truncated")}` : ""}\n`);
    for (const warning of file.warnings) {
      env.stdout(`  ${icons.warn} ${t(loc, "strategy.validate.warning", { warning })}\n`);
    }
  }
  return warnings.length === 0 ? 0 : 1;
}

function parseOptionalGame(raw: string | undefined): GameType | undefined {
  if (raw === undefined) return undefined;
  if (!isSupportedGame(raw)) {
    throw new UsageError(`unsupported game '${raw}'`, `supported: ${SUPPORTED_GAMES.join(", ")}`);
  }
  return raw as GameType;
}

function strategyFiles(agentId: string, game: GameType | undefined): StrategyFile[] {
  if (game !== undefined) {
    const paths = resolveLocalStrategyPaths(agentId, game);
    return [
      { scope: "global", path: paths.global },
      { scope: "game", game, path: paths.game! },
    ];
  }
  const paths = resolveLocalStrategyPaths(agentId);
  return [
    { scope: "global", path: paths.global },
    ...SUPPORTED_GAMES.map((g) => {
      const gamePaths = resolveLocalStrategyPaths(agentId, g as GameType);
      return { scope: "game" as const, game: g as GameType, path: gamePaths.game! };
    }),
  ];
}

function inspectStrategyFile(file: StrategyFile): StrategyFileStatus {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file.path);
  } catch {
    return {
      ...file,
      exists: false,
      bytes: 0,
      empty: true,
      truncatedByBridge: false,
      warnings: [],
    };
  }
  if (!stat.isFile()) {
    return {
      ...file,
      exists: true,
      bytes: 0,
      empty: true,
      truncatedByBridge: false,
      warnings: ["path exists but is not a regular file"],
    };
  }
  const raw = fs.readFileSync(file.path, "utf8");
  const trimmed = raw.trim();
  const bytes = Buffer.byteLength(trimmed, "utf8");
  return {
    ...file,
    exists: true,
    bytes,
    empty: trimmed.length === 0,
    truncatedByBridge: bytes > 64 * 1024,
    warnings: detectSecretLikeText(trimmed),
  };
}

function detectSecretLikeText(text: string): string[] {
  if (text.length === 0) return [];
  const warnings: string[] = [];
  const patterns: Array<[RegExp, string]> = [
    [/\bsk-[A-Za-z0-9_-]{20,}\b/, "looks like an OpenAI-style API key"],
    [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/, "looks like an Anthropic-style API key"],
    [/\bAIza[0-9A-Za-z_-]{20,}\b/, "looks like a Google API key"],
    [/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/, "looks like a bot token"],
    [/\b(provider|api|secret|token|password)[_-]?(key|token|secret)?\s*[:=]\s*\S{12,}/i, "looks like a secret assignment"],
  ];
  for (const [pattern, warning] of patterns) {
    if (pattern.test(text) && !warnings.includes(warning)) warnings.push(warning);
  }
  return warnings;
}

function labelFor(file: StrategyFile): string {
  return file.scope === "global" ? "global" : `game:${file.game}`;
}

/** Display-only path shortening (V4 — the owner's screenshot was a wall of
 *  raw /root/.aifight/runtime/... absolute paths). U8: abbreviate against the
 *  OS home so the result is a REAL path (`~/.aifight/runtime/…`) — the old
 *  version swallowed the `.aifight/runtime` segment and printed `~/agents/…`,
 *  a directory that does not exist. Paths outside the OS home (a service
 *  install, a test temp dir) stay absolute. --json keeps the full paths.
 *  Exported for tests (osHome injectable). */
export function shortenHome(filePath: string, osHome: string = os.homedir()): string {
  if (osHome.length === 0) return filePath;
  if (filePath === osHome) return "~";
  const prefix = `${osHome}${path.sep}`;
  return filePath.startsWith(prefix) ? `~${path.sep}${filePath.slice(prefix.length)}` : filePath;
}

function chmodBestEffort(filePath: string, mode: number): void {
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    // Best effort only; runtime home remains user-scoped.
  }
}
