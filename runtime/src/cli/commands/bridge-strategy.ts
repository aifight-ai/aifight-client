import fs from "node:fs";
import path from "node:path";

import { readBridgeConfig } from "../../bridge/config";
import type { GameType } from "../../decision/types";
import { resolveLocalStrategyPaths } from "../../strategy/local-strategy";
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

  env.stdout(`Strategy root: ${paths.root}\n`);
  env.stdout(`Global strategy: ${paths.global}\n`);
  env.stdout(`Game strategy directory: ${paths.gamesDir}\n`);
  for (const item of gamePaths) {
    env.stdout(`${item.game}: ${item.path}\n`);
  }
  env.stdout("Strategy files are Markdown/free-text .md files, not JSON config files.\n");
  env.stdout("Missing or empty strategy files are skipped during matches.\n");
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
  env.stdout(`Strategy files ready (${created} created, ${kept} kept).\n`);
  for (const file of files) {
    env.stdout(`${labelFor(file)}: ${file.path}\n`);
  }
  env.stdout("Edit these Markdown/free-text files with strategy guidance. Empty files are skipped during matches.\n");
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

  for (const file of files) {
    const label = labelFor(file);
    if (!file.exists) {
      env.stdout(`${label}: missing (${file.path})\n`);
      continue;
    }
    if (file.empty) {
      env.stdout(`${label}: empty (${file.path})\n`);
      continue;
    }
    env.stdout(`${label}: ok, ${file.bytes} bytes${file.truncatedByBridge ? " (Bridge will read the first 65536 bytes)" : ""}\n`);
    for (const warning of file.warnings) {
      env.stdout(`  warning: ${warning}\n`);
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

function chmodBestEffort(filePath: string, mode: number): void {
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    // Best effort only; runtime home remains user-scoped.
  }
}
