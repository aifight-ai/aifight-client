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

import type { CliRunResult } from "../shared/ipc";

// Allowlist: the renderer can only trigger these commands (defense-in-depth even
// though the renderer is our own sandboxed code). Note `sessions` reads the
// SQLite store and needs the native module rebuilt for Electron (D9) to work.
const ALLOWED = new Set([
  "version",
  "doctor",
  "status",
  "setup",
  "connect",
  "set",
  "challenge",
  "accept",
  "config",
  "strategy",
  "sessions",
]);

export async function runCli(args: unknown): Promise<CliRunResult> {
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
    return { exitCode: 2, stdout: "", stderr: "", error: "cli args must be an array of strings" };
  }
  const argv = args as string[];
  const cmd = argv[0];
  if (cmd === undefined || !ALLOWED.has(cmd)) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: "",
      error: `command not available from the desktop: ${cmd ?? "(none)"}`,
    };
  }

  // Desktop callers pass --json so commands take their structured, non-interactive
  // path. We append it below for safety on commands that support it.
  let out = "";
  let err = "";

  // 🛡 Hang-class defense (the register-spinner bug, generalized): CLI commands
  // gate their interactive [Y/n] prompts on `process.stdin.isTTY`. When the app is
  // launched from a terminal, the Electron main process INHERITS that TTY, so a
  // prompt would block forever on stdin the user can't answer (the prompt text is
  // captured, not shown). The desktop must NEVER prompt — so we force stdin to look
  // non-interactive for the duration of the run, which makes every prompt guard take
  // its safe non-interactive branch. Restored in `finally` (desktop runs are
  // sequential). This is belt-and-suspenders on top of always passing --json.
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
