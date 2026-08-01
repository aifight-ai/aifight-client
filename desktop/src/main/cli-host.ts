// D7 — run `aifight` CLI commands in-process. The desktop is a GUI over the SAME
// engine, so instead of reimplementing each command we call the CLI's exported
// run() with --json and capture its output. This gives full parity for free:
// register / connect / config / set / challenge / accept / status / strategy /
// doctor all work exactly as the CLI does (and write the SAME shared config).
//
// Excluded by design: `run` / `service` (the desktop runs the bridge in-process
// via BridgeHost instead of a systemd/launchd service), and `update` / `uninstall`
// (package/teardown actions that don't belong behind a renderer button). The
// desktop always registers and plays via direct-LLM.
//
// The engine (and its lazily-required native modules) loads only when run() is
// first called, via dynamic import — never at app startup.

import type { CliOp, CliRunResult } from "../shared/ipc";

// Final defensive gate: even though every argv is now built from a fixed template
// (argvForCliOp), assert the leading command is one the desktop actually maps to.
// This is the set of commands the templates below can produce — nothing else can
// reach the CLI's run(). Note `sessions` reads the SQLite store and needs the
// native module rebuilt for Electron (D9) to work. `review` is included (the old
// allowlist omitted it, which silently broke self-review — now fixed).
const KNOWN_CLI_COMMANDS = new Set(["setup", "connect", "status", "challenge", "accept", "config", "review", "sessions"]);

// Conservative validators for every renderer-supplied string that gets
// interpolated into argv. Anything failing these makes argvForCliOp return null,
// which the caller turns into an "invalid cli operation" result — the CLI never
// runs. Kept intentionally strict (allow only what real values look like).
// A leading "-" is forbidden in every value below so an interpolated positional
// can never be parsed by the CLI as an option/flag (e.g. a connect code of
// "--replace-local-identity"). Combined with the fixed argv[0] and the no-space
// charsets, the renderer can only ever supply values, never compose flags.
const SLUG_RE = /^[a-z0-9_]{1,32}$/; // game / config-test slug
const PROFILE_ID_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/; // llm profile id
const SESSION_ID_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,127}$/; // local session id
const PAIRING_CODE_RE = /^[A-Za-z0-9._:][A-Za-z0-9._:-]*$/; // pairing/connect code (alnum + separators)

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Build the fixed argv for an enumerated CLI operation, validating every
 * interpolated value. Returns null for an unknown kind or any value that fails
 * validation — the renderer can never compose arbitrary argv/flags, only pick a
 * kind and supply values that pass these gates. Exported for unit tests.
 */
export function argvForCliOp(op: CliOp): string[] | null {
  // `op` crosses the IPC (structured-clone) boundary as untrusted data — switch on
  // kind and treat every field defensively regardless of the static type.
  switch (op?.kind) {
    case "setup":
      return ["setup", "--json", ...(op.replaceLocalIdentity ? ["--replace-local-identity"] : [])];
    case "connect": {
      const code = isString(op.code) ? op.code.trim() : "";
      if (code === "" || code.length > 128 || !PAIRING_CODE_RE.test(code)) return null;
      // --client-kind desktop is NOT optional here. Redeeming a pairing code is
      // what decides which program owns the agent from then on, and the CLI's
      // connect defaults to "cli" because that is who normally types it. Leaving
      // it off would make the app award the agent to the background service —
      // locking itself out of the very pairing the user started from the app,
      // with no error to explain it.
      return [
        "connect",
        code,
        "--client-kind",
        "desktop",
        ...(op.replaceLocalIdentity ? ["--replace-local-identity"] : []),
        "--json",
      ];
    }
    case "status":
      return ["status", "--json"];
    case "challenge": {
      if (!isString(op.game) || !SLUG_RE.test(op.game)) return null;
      // Optional table size (W5 multi-seat friendlies). Bounds mirror the CLI's
      // own 2-6 format check; the server stays the authority on per-game sizes.
      if (op.players === undefined) return ["challenge", op.game, "--json"];
      if (!Number.isInteger(op.players) || op.players < 2 || op.players > 6) return null;
      return ["challenge", op.game, String(op.players), "--json"];
    }
    case "accept":
      return isString(op.url) && op.url.length <= 2048 && isHttpUrl(op.url) ? ["accept", op.url, "--json"] : null;
    case "configReviewGet":
      return ["config", "review", "--json"];
    case "configReviewSet":
      // The CLI's `config review auto <mode>` honours --json on its write path
      // too (printReviewConfig), so the renderer gets the same structured
      // result as every other config op.
      return op.mode === "off" || op.mode === "all" || op.mode === "losses_only"
        ? ["config", "review", "auto", op.mode, "--json"]
        : null;
    case "configReasoningGet":
      return ["config", "reasoning", "--json"];
    case "configReasoningSet":
      return typeof op.enabled === "boolean"
        ? ["config", "reasoning", op.enabled ? "on" : "off", "--json"]
        : null;
    case "configTest":
      return isString(op.slug) && SLUG_RE.test(op.slug) && isString(op.profileId) && PROFILE_ID_RE.test(op.profileId)
        ? ["config", "test", op.slug, "--profile", op.profileId, "--json"]
        : null;
    case "review": {
      if (!isString(op.sessionId) || !SESSION_ID_RE.test(op.sessionId)) return null;
      const modeFlag = op.mode === "regen" ? ["--regen"] : op.mode === "no-generate" ? ["--no-generate"] : [];
      return ["review", op.sessionId, "--json", ...modeFlag];
    }
    case "sessionsList":
      return ["sessions", "list", "--json"];
    case "sessionsExport":
      // NOTE: no --json here, matching the CLI's export behavior the renderer expects.
      return isString(op.sessionId) && SESSION_ID_RE.test(op.sessionId) ? ["sessions", "export", op.sessionId] : null;
    default:
      return null;
  }
}

// All desktop CLI ops run strictly one-at-a-time, in call order. The config
// subcommands are read-modify-write on the shared config.json, so two
// concurrent ops could interleave reads and let the OLDER click's write land
// last (UI says off, disk says on — Codex re-review finding). Serializing here
// fixes that ordering at the root, and makes the stdin.isTTY save/restore in
// runCliArgv actually safe (it always assumed sequential runs). Ops are quick
// local commands; a queued op just waits its turn.
let cliOpChain: Promise<unknown> = Promise.resolve();

/** Exported for tests: enqueue a task on the strict FIFO CLI chain. A failed
 *  task never breaks the chain for the next one. */
export function enqueueCliTask<T>(task: () => Promise<T>): Promise<T> {
  const run = cliOpChain.then(task, task);
  cliOpChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Run an enumerated CLI operation: build + validate the argv, then execute it.
 * Invalid operations (unknown kind / bad value) never touch the CLI.
 */
export async function runCliOp(op: CliOp): Promise<CliRunResult> {
  const argv = argvForCliOp(op);
  if (argv === null) {
    return { exitCode: 2, stdout: "", stderr: "", error: "invalid cli operation" };
  }
  return enqueueCliTask(() => runCliArgv(argv));
}

async function runCliArgv(argv: string[]): Promise<CliRunResult> {
  const cmd = argv[0];
  if (cmd === undefined || !KNOWN_CLI_COMMANDS.has(cmd)) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: "",
      error: `command not available from the desktop: ${cmd ?? "(none)"}`,
    };
  }

  // Desktop callers pass --json so commands take their structured, non-interactive
  // path. Each argv template in argvForCliOp carries it explicitly where the
  // subcommand supports it (sessionsExport is the one deliberate exception) —
  // nothing is appended here.
  let out = "";
  let err = "";

  // 🛡 Hang-class defense (the register-spinner bug, generalized): CLI commands
  // gate their interactive [Y/n] prompts on `process.stdin.isTTY`. When the app is
  // launched from a terminal, the Electron main process INHERITS that TTY, so a
  // prompt would block forever on stdin the user can't answer (the prompt text is
  // captured, not shown). The desktop must NEVER prompt — so we force stdin to look
  // non-interactive for the duration of the run, which makes every prompt guard take
  // its safe non-interactive branch. Restored in `finally` (desktop runs ARE
  // sequential — enforced by the enqueueCliTask FIFO chain above). This is
  // belt-and-suspenders on top of always passing --json.
  const stdinObj = process.stdin as unknown as { isTTY?: boolean };
  const prevIsTTY = stdinObj.isTTY;
  try {
    stdinObj.isTTY = false;
  } catch {
    // isTTY not writable on this platform — --json already covers the prompt paths.
  }

  let exitCode: number;
  try {
    // Lazy: pulls the CLI/runtime graph only on first command, not at app launch.
    // Importing the CLI eagerly loads the runtime's native modules (SQLite via the
    // sessions command / barrel), so this requires the Electron-ABI rebuild (D9).
    const { run } = await import("@aifight/aifight/cli/main");
    exitCode = await run(argv, {
      stdout: (s) => {
        out += s;
      },
      stderr: (s) => {
        err += s;
      },
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const hint = /better-sqlite3|@napi-rs\/keyring|Cannot find module/.test(message)
      ? " (native modules need the Electron rebuild — desktop D9)"
      : "";
    return { exitCode: 99, stdout: out, stderr: err, error: `command failed to run${hint}: ${message}` };
  } finally {
    try {
      stdinObj.isTTY = prevIsTTY;
    } catch {
      // best effort
    }
  }

  let json: unknown;
  const trimmed = out.trim();
  if (trimmed.length > 0) {
    try {
      json = JSON.parse(trimmed);
    } catch {
      json = undefined;
    }
  }

  return { exitCode, stdout: out, stderr: err, ...(json !== undefined ? { json } : {}) };
}
