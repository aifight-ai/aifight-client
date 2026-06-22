// Shared types + helpers for CLI command handlers.
//
// Internal to runtime/src/cli — not re-exported from runtime/src/index.ts.

import type { ControlClient, CreateControlClientOptions } from "./control-client";
import { createControlClient } from "./control-client";
import { readToken, readPort } from "./runtime-files";
import type { HelloResult } from "../index";
import type { BridgeServiceDeps } from "../bridge/service";

/** Per-handler injectable environment. Defaults wired to process I/O +
 *  real fs + native fetch. Tests pass overrides for stdout/stderr capture
 *  + hello stub + fetchImpl pointing at a temporary M1-16 server. */
export interface HandlerEnv {
  readonly stdout: (s: string) => void;
  readonly stderr: (s: string) => void;
  /** Override for the M1-01 schemas/types self-test used by `doctor`.
   *  Default: real `hello` from runtime/src/index.ts (lazy-imported by
   *  the doctor handler so other commands do not pull in the
   *  schemas-loading cost). */
  readonly hello?: () => HelloResult;
  /** Override fetch implementation for tests. Default globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Optional rebootstrap log hook (forwarded to control-client). */
  readonly onLog?: (event: { code: string; message: string }) => void;
  /** Default 10000 ms per Step 2b directive (must not drop below ~3000
   *  for normal commands). doctor uses its own 3000 ms one-shot fetch. */
  readonly baseTimeoutMs?: number;
  /** Optional bridge service manager overrides for tests and controlled installs. */
  readonly bridgeService?: BridgeServiceDeps;
}

export interface HandlerArgs {
  /** Positional argv with the command (and subcommand for `agent`/`daily`)
   *  already stripped by the dispatcher in main.ts. */
  readonly positional: readonly string[];
  /** All globally-known flags merged from the single argv pass. */
  readonly flags: Readonly<Record<string, string | number | boolean>>;
  /** True when `--json` was set (any position — floating flag, rev2 fix #1). */
  readonly jsonMode: boolean;
}

/** Build a controlClient that lazily reads token+port from the daemon
 *  files. version / doctor / Tier B/C stubs do NOT call this. */
export function makeClient(env: HandlerEnv, extra: Partial<CreateControlClientOptions> = {}): ControlClient {
  return createControlClient({
    tokenSource: readToken,
    portSource: readPort,
    fetchImpl: env.fetchImpl,
    onLog: env.onLog,
    baseTimeoutMs: env.baseTimeoutMs,
    ...extra,
  });
}

/** Centralised game enum for client-side validation (Risks #11 — CLI
 *  hard-codes the supported list rather than fetching from server, so a
 *  contract drift surfaces as a usage error rather than a daemon round
 *  trip). */
export const SUPPORTED_GAMES: ReadonlyArray<string> = ["texas_holdem", "liars_dice", "coup"];

export function isSupportedGame(g: string): boolean {
  return SUPPORTED_GAMES.includes(g);
}

/** Class for argv-parser-style usage errors that should map to exit 2.
 *  Distinct from AgentResolverError (which uses its own kind discriminator). */
export class UsageError extends Error {
  override readonly name = "UsageError";
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    if (hint !== undefined) this.hint = hint;
  }
}

/** Expected runtime/API failures that should be shown as ordinary command
 * errors (exit 1), not catchall programmer failures (exit 99). */
export class CommandError extends Error {
  override readonly name = "CommandError";
  readonly code: string;
  readonly exitCode: number;
  readonly hint?: string;

  constructor(code: string, message: string, opts: { readonly exitCode?: number; readonly hint?: string } = {}) {
    super(message);
    this.code = code;
    this.exitCode = opts.exitCode ?? 1;
    if (opts.hint !== undefined) this.hint = opts.hint;
  }
}

/** Step 3b — assert positional arity at the top of every handler BEFORE
 *  any side-effect (controlClient / network / fs). Extra positionals
 *  must NOT silently fall through to a successful POST (e.g.
 *  `aifight shutdown anything` previously still POSTed /v1/shutdown).
 *
 *  Throws UsageError → main.ts funnel maps to exit 2 + usage hint.
 *  No-args handlers call `expectArity(args, 0, 0, "...")`;
 *  optional-arg handlers (e.g. agent status [<name>]) use min=0 max=1;
 *  fixed-arity handlers (e.g. daily set <game> <count>) use min=max=N. */
export function expectArity(
  args: HandlerArgs,
  min: number,
  max: number,
  usage: string,
): void {
  const n = args.positional.length;
  if (n < min) {
    throw new UsageError(
      `missing required positional argument${min === 1 ? "" : "s"}`,
      usage,
    );
  }
  if (n > max) {
    const extras = args.positional.slice(max).join(" ");
    throw new UsageError(
      `unexpected extra positional argument${n - max === 1 ? "" : "s"}: ${extras}`,
      usage,
    );
  }
}
