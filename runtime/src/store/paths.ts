// Runtime home directory resolution.
//
// Default: $HOME/.aifight/runtime (POSIX) or %USERPROFILE%\.aifight\runtime
// (Windows — os.homedir() handles both). Tests and CI MUST override via
// AIFIGHT_RUNTIME_HOME to avoid touching real user data; M1-04 build.sh
// asserts no test file references `~/.aifight`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const AIFIGHT_HOME_SUBPATH = ".aifight";

/**
 * Canonical AIFight home root. Default `~/.aifight`, overridable via
 * `AIFIGHT_HOME`. Both the CLI and the desktop app resolve EVERY config
 * path from here, so they always share one config folder. Tests set
 * `AIFIGHT_HOME` to a temp dir to isolate from real user data.
 */
export function getAifightHome(): string {
  const override = process.env.AIFIGHT_HOME;
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), AIFIGHT_HOME_SUBPATH);
}

export function getRuntimeHome(): string {
  // Back-compat: AIFIGHT_RUNTIME_HOME, when set, is honored verbatim
  // (existing tests and installed services point it directly at a runtime
  // dir). Otherwise derive from the unified AIFight home.
  const override = process.env.AIFIGHT_RUNTIME_HOME;
  if (override && override.length > 0) return override;
  return path.join(getAifightHome(), "runtime");
}

/** Root of all agent profiles: `<aifight-home>/agents`. */
export function getAgentsRoot(): string {
  return path.join(getAifightHome(), "agents");
}

export function getDefaultDbPath(): string {
  return path.join(getRuntimeHome(), "state.db");
}

// Idempotent. On POSIX, narrows perms to 0700 so sibling users cannot
// read the credential store (this matters for M1-05). On Windows,
// chmod is a no-op; directory ACLs are inherited from the parent and
// default to user-only.
export function ensureRuntimeHome(): void {
  const home = getRuntimeHome();
  fs.mkdirSync(home, { recursive: true });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(home, 0o700);
    } catch {
      // Best effort — if chmod fails (e.g. exotic FS like /tmp on some
      // CI), don't block. Perms are advisory; the real secret store
      // is M1-05's keychain.
    }
  }
}
