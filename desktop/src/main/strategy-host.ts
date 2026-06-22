// D8.5 — read/write the agent's own strategy docs from the desktop.
//
// The runtime injects these Markdown files into the LLM prompt during real
// matches (see strategy/local-strategy.ts → BridgeDecisionStrategy), so editing
// them here changes how YOUR agent plays. We resolve their location through the
// runtime's resolveLocalStrategyPaths — NEVER a hardcoded `~/.aifight` — so the
// desktop and CLI always agree on where strategy lives. local-strategy.ts pulls
// only node builtins + the clean store/paths helper (no native modules), so it's
// safe to import statically here (unlike the bridge engine).
//
// Safety: `scope` is validated as "global" or a safe engine name in the live
// list (no path traversal); content is capped at the runtime's
// MAX_STRATEGY_FILE_BYTES; files are written 0600 in a 0700 dir. This is a
// LOCAL file edit — it never touches the platform/API.
//
// Per-game scopes follow the platform's live-game list (the caller passes
// bridge-host's backend-fed cache — never a hardcoded copy here), so launching
// a game adds its strategy tab without a desktop edit.

import fs from "node:fs";
import path from "node:path";

import { readBridgeConfig } from "@aifight/aifight/bridge/config";
import { resolveLocalStrategyPaths } from "@aifight/aifight/strategy/local-strategy";
import { isSafeGameName } from "../shared/games";
import type { StrategyDoc, StrategyReadResult, StrategyScope, StrategyWriteResult } from "../shared/ipc";

const MAX_STRATEGY_FILE_BYTES = 64 * 1024;

/** "global" + the current live games. isSafeGameName re-checks each name because
 *  these become file-path segments below — the gate must hold regardless of source. */
function scopesFor(liveGames: readonly string[]): readonly StrategyScope[] {
  return ["global", ...liveGames.filter((g) => isSafeGameName(g))];
}

function isScope(liveGames: readonly string[], value: unknown): value is StrategyScope {
  return value === "global" || (isSafeGameName(value) && liveGames.includes(value));
}

/** Resolve the on-disk path for a scope's strategy file (global.md or games/<game>.md). */
function fileForScope(agentId: string, scope: StrategyScope): string {
  if (scope === "global") return resolveLocalStrategyPaths(agentId).global;
  // The runtime's signature pins its game union, but the implementation is
  // name-agnostic (games/<name>.md) — the cast marks that boundary; path safety
  // is already enforced by isSafeGameName above.
  const paths = resolveLocalStrategyPaths(agentId, scope as Parameters<typeof resolveLocalStrategyPaths>[1]);
  // `game` is always present when a game is passed; fall back defensively.
  return paths.game ?? path.join(paths.gamesDir, `${scope}.md`);
}

/** Read all strategy docs (global + per-live-game) for the configured agent. Never throws. */
export function readStrategy(liveGames: readonly string[]): StrategyReadResult {
  let agentId: string;
  try {
    agentId = readBridgeConfig().agentId;
  } catch (cause) {
    return { docs: [], maxBytes: MAX_STRATEGY_FILE_BYTES, error: describeError(cause) };
  }
  const docs: StrategyDoc[] = scopesFor(liveGames).map((scope) => {
    const file = fileForScope(agentId, scope);
    let content = "";
    let exists = false;
    try {
      content = fs.readFileSync(file, "utf8");
      exists = true;
    } catch {
      // missing file = empty doc (the runtime skips empty/missing strategy).
    }
    return { scope, path: file, content, bytes: Buffer.byteLength(content, "utf8"), exists };
  });
  return { agentId, docs, maxBytes: MAX_STRATEGY_FILE_BYTES };
}

/** Write one strategy doc. Validates scope + size; writes 0600. Returns a result, never throws. */
export function writeStrategy(liveGames: readonly string[], scope: unknown, content: unknown): StrategyWriteResult {
  if (!isScope(liveGames, scope)) return { ok: false, error: `unknown strategy scope: ${String(scope)}` };
  if (typeof content !== "string") return { ok: false, error: "strategy content must be a string" };
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_STRATEGY_FILE_BYTES) {
    return { ok: false, error: `strategy too large: ${bytes} bytes (max ${MAX_STRATEGY_FILE_BYTES})` };
  }

  let agentId: string;
  try {
    agentId = readBridgeConfig().agentId;
  } catch (cause) {
    return { ok: false, error: describeError(cause) };
  }

  const file = fileForScope(agentId, scope);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    chmodBestEffort(path.dirname(file), 0o700);
    fs.writeFileSync(file, content, { mode: 0o600 });
    chmodBestEffort(file, 0o600);
  } catch (cause) {
    return { ok: false, error: describeError(cause) };
  }
  return { ok: true, bytes };
}

function chmodBestEffort(target: string, mode: number): void {
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(target, mode);
  } catch {
    // Best effort only.
  }
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
