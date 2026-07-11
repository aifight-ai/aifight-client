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

/**
 * Sanitize one untrusted value (agent slug, agent id, session id, …) into a
 * filesystem-safe path SEGMENT: replace every character outside
 * [A-Za-z0-9._-] with "_", cap at 128 chars, and never return an empty string
 * (fall back to "unknown"). This neutralizes "/", "\\", ":" and absolute-path
 * prefixes, so a caller that joins the result under a known root cannot be
 * walked out of that root by a single segment. A pure-dots value like ".."
 * survives (dots are allowed), so callers that build a full path MUST still
 * assert containment against their root as defense-in-depth — see
 * resolveAgentDir in profile/profile-loader.ts.
 */
export function safePathSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  return safe.length > 0 ? safe : "unknown";
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
