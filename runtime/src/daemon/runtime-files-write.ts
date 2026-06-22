// Write-side helpers for the daemon's token + port + pid + lock files.
//
// M1-17 cli/runtime-files.ts owns the read side. This module is the
// SINGLE writer — daemon lifecycle (M1-18) calls these and never writes
// these files inline. Multi-instance lock + pid file live next to these
// because they share the same atomicity + cleanup story.
//
// File contracts (M1-18 TED `File / Process Contracts` section, locked
// against M1-17 read-side assumptions):
//   - token: getRuntimeHome()/token, mode 0600, content = 64-char hex,
//            no trailing newline, atomic rename-into-place.
//   - port:  getRuntimeHome()/port,  mode 0644, content = String(port),
//            no trailing newline, atomic rename-into-place.
//   - pid:   getRuntimeHome()/pid,   mode 0644, content = String(pid),
//            no trailing newline, atomic rename-into-place.
//   - lock:  getRuntimeHome()/lock,  mode 0600, empty file (existence is
//            the advisory lock; pid file is consulted to detect stale).
//
// Internal-only — not re-exported to the package root (mirrors M1-17
// read-side which is also internal-only; CLI / lifecycle consume both).

import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

import { getRuntimeHome } from "../store/paths";

// ─── Errors ─────────────────────────────────────────────────────────

export type RuntimeFilesWriteErrorKind =
  | "write_failed"
  | "lock_held_by_other"
  | "lock_acquire_failed";

export class RuntimeFilesWriteError extends Error {
  override readonly name = "RuntimeFilesWriteError";
  readonly kind: RuntimeFilesWriteErrorKind;
  readonly filePath: string;
  /** Set when kind === "lock_held_by_other"; the holding process's PID
   *  as recorded in the pid file. Caller maps to exit-6 + user message. */
  readonly heldByPid?: number;
  override readonly cause?: unknown;

  constructor(
    kind: RuntimeFilesWriteErrorKind,
    filePath: string,
    message: string,
    init?: { heldByPid?: number; cause?: unknown },
  ) {
    super(message);
    this.kind = kind;
    this.filePath = filePath;
    if (init?.heldByPid !== undefined) this.heldByPid = init.heldByPid;
    if (init?.cause !== undefined) this.cause = init.cause;
  }
}

// ─── File path helpers (lazy — re-resolves home each call so
//     AIFIGHT_RUNTIME_HOME overrides take effect mid-process for tests) ─

function tokenFilePath(): string {
  return path.join(getRuntimeHome(), "token");
}

function portFilePath(): string {
  return path.join(getRuntimeHome(), "port");
}

function pidFilePath(): string {
  return path.join(getRuntimeHome(), "pid");
}

function lockFilePath(): string {
  return path.join(getRuntimeHome(), "lock");
}

// ─── Atomic write ───────────────────────────────────────────────────

let tmpCounter = 0;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

function atomicWrite(filePath: string, content: string, mode: number): void {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  tmpCounter += 1;
  const tmpPath = path.join(
    dir,
    `${base}.${process.pid}.${tmpCounter}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmpPath, "w", mode);
    fs.writeSync(fd, content);
    fs.closeSync(fd);
    fd = undefined;
    // Re-chmod to defeat process umask interaction. openSync's mode is
    // masked by umask, but the final file MUST have exactly the spec
    // mode at the moment of rename so readers never observe a
    // too-permissive view. POSIX-only — Windows ACL is inherited from
    // the parent dir (mkdir-time chmod 0700 on home from M1-04).
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(tmpPath, mode);
      } catch {
        // best effort — chmod can fail on exotic FS; rename still
        // proceeds since umask normally leaves token/pid modes correct.
      }
    }
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort — fd may already be closed
      }
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // best effort — tmp may not exist if openSync itself failed
    }
    throw new RuntimeFilesWriteError(
      "write_failed",
      filePath,
      `failed to write ${filePath}: ${(e as Error).message}`,
      { cause: e },
    );
  }
}

// ─── Token ──────────────────────────────────────────────────────────

/** Generates a fresh 64-char hex token (32 random bytes encoded). */
export function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** Atomic write: token file at `getRuntimeHome()/token` mode 0600.
 *  Internal: writes to `<path>.<pid>.<counter>.tmp` then `fs.renameSync`.
 *  Asserts token matches /^[0-9a-f]{64}$/ before write (TED Q2 — hex
 *  literal assertion to defeat future regressions that swap the random
 *  source for one emitting non-printable bytes / mixed case). */
export function writeToken(token: string): void {
  const p = tokenFilePath();
  if (!TOKEN_PATTERN.test(token)) {
    throw new RuntimeFilesWriteError(
      "write_failed",
      p,
      `token must match /^[0-9a-f]{64}$/ but received "${token}" (length ${token.length})`,
    );
  }
  atomicWrite(p, token, 0o600);
}

// ─── Port ───────────────────────────────────────────────────────────

/** Atomic write: port file at `getRuntimeHome()/port` mode 0644.
 *  Content = `String(port)` no trailing newline. Range checked
 *  [1, 65535] (matches M1-17 read-side validator). */
export function writePort(port: number): void {
  const p = portFilePath();
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RuntimeFilesWriteError(
      "write_failed",
      p,
      `port must be an integer in [1, 65535] but received ${port}`,
    );
  }
  atomicWrite(p, String(port), 0o644);
}

// ─── PID ────────────────────────────────────────────────────────────

/** Atomic write: pid file at `getRuntimeHome()/pid` mode 0644.
 *  Content = `String(pid)` no trailing newline. */
export function writePid(pid: number): void {
  const p = pidFilePath();
  if (!Number.isInteger(pid) || pid < 1) {
    throw new RuntimeFilesWriteError(
      "write_failed",
      p,
      `pid must be a positive integer but received ${pid}`,
    );
  }
  atomicWrite(p, String(pid), 0o644);
}

// ─── Unlink (graceful shutdown best-effort) ─────────────────────────

/** Best-effort unlink of token + port + pid files on graceful shutdown.
 *  ENOENT is silent (file already gone). Other failures only log via
 *  onLog so shutdown sequence never throws on cleanup. */
export function unlinkRuntimeFiles(opts: {
  onLog?: (msg: string) => void;
}): void {
  for (const p of [tokenFilePath(), portFilePath(), pidFilePath()]) {
    try {
      fs.unlinkSync(p);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      opts.onLog?.(`failed to unlink ${p}: ${(e as Error).message}`);
    }
  }
}

// ─── Stale tmp cleanup ──────────────────────────────────────────────

/** Cleans up `*.tmp` files in `getRuntimeHome()` left over from a
 *  previous daemon crash. Called once at startup before any write.
 *  Failures silent — best-effort only. */
export function cleanupStaleTmpFiles(): void {
  const home = getRuntimeHome();
  let entries: string[];
  try {
    entries = fs.readdirSync(home);
  } catch {
    // home doesn't exist or can't read — silent best effort
    return;
  }
  for (const name of entries) {
    if (!name.endsWith(".tmp")) continue;
    try {
      fs.unlinkSync(path.join(home, name));
    } catch {
      // best effort — silent
    }
  }
}

// ─── Lock file (multi-instance enforcement, TED 拍板点 #6) ──────────

export interface LockHandle {
  /** Releases lock + unlinks lock file. Idempotent — second call no-op. */
  release(): void;
}

/** Per-process tracking of held locks so reentrant `acquireDaemonLock`
 *  calls within the same process throw immediately (TED Group 2 case 19).
 *  Keyed by absolute lock file path so two different runtime homes within
 *  the same process can coexist (TED Group 2 case 20). */
const heldLocks = new Set<string>();

export interface AcquireDaemonLockOptions {
  /** Override `process.kill(pid, 0)` liveness probe for tests. Default
   *  uses `process.kill(pid, 0)` and treats EPERM (cross-user, can't
   *  signal) as `true` (alive) so we never overwrite a foreign daemon's
   *  lock — TED 拍板点 #6 + Group 2 case 17 "EPERM 不能确认 → safe
   *  保留". Production callers omit this option. */
  readonly processIsAlive?: (pid: number) => boolean;
}

function defaultProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM (cross-user) or any other non-ESRCH error — safe default:
    // assume alive so we never overwrite a foreign daemon's lock.
    return true;
  }
}

/** Result of inspecting the pid file alongside the lock file. The four
 *  variants exist because **collapsing them all into "no valid pid"
 *  would let a freshly-started daemon B steal a freshly-started
 *  daemon A's lock during the small window between `acquireDaemonLock()`
 *  and `writePid()`**. Only the `valid` + dead-probe combination is
 *  safe to clean — every other ambiguous state must fail safe (TED
 *  rev8 review-fix). */
type PidProbeResult =
  | { kind: "valid"; pid: number }
  | { kind: "missing" }
  | { kind: "invalid"; raw: string }
  | { kind: "read_error"; cause: NodeJS.ErrnoException };

function inspectHeldPid(pidPath: string): PidProbeResult {
  let raw: string;
  try {
    raw = fs.readFileSync(pidPath, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "missing" };
    return { kind: "read_error", cause: e as NodeJS.ErrnoException };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: "invalid", raw: trimmed };
  if (!/^\d+$/.test(trimmed)) return { kind: "invalid", raw: trimmed };
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 1) return { kind: "invalid", raw: trimmed };
  return { kind: "valid", pid: n };
}

/** Acquire exclusive lock at `getRuntimeHome()/lock` (`O_EXCL` create).
 *
 *  Outcomes when the lock file already exists (EEXIST):
 *  - **valid pid + alive (per probe)** → throw `lock_held_by_other`
 *    with `heldByPid` set; lock + pid files preserved.
 *  - **valid pid + dead** → STALE; clean lock + pid + retry once.
 *  - **pid file missing / corrupt content / read error** → AMBIGUOUS;
 *    throw `lock_acquire_failed`, **preserve lock + pid files**, do
 *    not invoke the liveness probe. This window is exactly when a
 *    racing daemon has just acquired the lock but has not yet written
 *    its pid (Step 2 startup order: `acquireDaemonLock()` then
 *    `writePid(process.pid)`); collapsing it into stale-cleanup would
 *    let daemon B steal daemon A's live lock and acquire its own
 *    (TED rev8 review-fix — multi-instance guarantee P1).
 *  - **stale-cleanup retry STILL races (EEXIST again)** → throw
 *    `lock_acquire_failed` (rare; another daemon snuck in between
 *    our unlink and our second openSync).
 *  - **non-EEXIST FS error on openSync** (permission denied, ENOSPC,
 *    etc.) → throw `lock_acquire_failed`.
 *  - **same process already holds this exact lock** → throw
 *    `lock_acquire_failed` (reentrancy guard, TED Group 2 case 19).
 *
 *  Caller maps `lock_held_by_other` to exit 6 ("daemon already
 *  running"); `lock_acquire_failed` to exit 1 (TED 拍板点 #8). */
export function acquireDaemonLock(
  opts?: AcquireDaemonLockOptions,
): LockHandle {
  const lockPath = lockFilePath();
  const pidPath = pidFilePath();
  const probe = opts?.processIsAlive ?? defaultProcessIsAlive;

  if (heldLocks.has(lockPath)) {
    throw new RuntimeFilesWriteError(
      "lock_acquire_failed",
      lockPath,
      `lock at ${lockPath} already held by this process; release the existing handle first (reentrancy guard)`,
    );
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(
        lockPath,
        // eslint-disable-next-line no-bitwise -- standard POSIX flag combo
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600,
      );
      fs.closeSync(fd);
      // Belt-and-suspenders chmod: openSync's mode is umask-masked, and
      // the lock file MUST be 0600 so a different user can't read it
      // (mode is the only place we leak liveness signal).
      if (process.platform !== "win32") {
        try {
          fs.chmodSync(lockPath, 0o600);
        } catch {
          // best effort
        }
      }
      heldLocks.add(lockPath);
      return makeLockHandle(lockPath);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw new RuntimeFilesWriteError(
          "lock_acquire_failed",
          lockPath,
          `failed to acquire lock at ${lockPath}: ${(e as Error).message}`,
          { cause: e },
        );
      }

      // Lock file exists — inspect pid file to decide stale vs held vs
      // ambiguous. Only `valid` + dead may auto-clean (TED rev8
      // review-fix); every other state must fail safe so we never
      // steal a freshly-started daemon's lock while it is still in the
      // window between acquireDaemonLock() and writePid().
      const probed = inspectHeldPid(pidPath);

      if (probed.kind === "missing") {
        throw new RuntimeFilesWriteError(
          "lock_acquire_failed",
          lockPath,
          `lock at ${lockPath} exists but pid file ${pidPath} is missing — ambiguous (possibly a racing daemon between acquireDaemonLock and writePid); refusing to steal lock. If the previous daemon truly crashed, manually remove ${lockPath}.`,
        );
      }
      if (probed.kind === "invalid") {
        throw new RuntimeFilesWriteError(
          "lock_acquire_failed",
          lockPath,
          `lock at ${lockPath} exists but pid file ${pidPath} content is invalid (raw="${probed.raw}") — ambiguous; refusing to steal lock. Manually remove both files if you confirm no daemon is running.`,
        );
      }
      if (probed.kind === "read_error") {
        throw new RuntimeFilesWriteError(
          "lock_acquire_failed",
          lockPath,
          `lock at ${lockPath} exists but pid file ${pidPath} could not be read (${probed.cause.code ?? "unknown"}: ${probed.cause.message}) — ambiguous; refusing to steal lock.`,
          { cause: probed.cause },
        );
      }

      // probed.kind === "valid" — probe liveness.
      if (probe(probed.pid)) {
        throw new RuntimeFilesWriteError(
          "lock_held_by_other",
          lockPath,
          `lock at ${lockPath} held by live PID ${probed.pid}`,
          { heldByPid: probed.pid },
        );
      }

      // Valid pid + dead — true stale lock from a prior crash. Clean
      // lock + pid + retry once.
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // may have been cleaned by another startup raced with us
      }
      try {
        fs.unlinkSync(pidPath);
      } catch {
        // pid file may not exist
      }
    }
  }

  // Two attempts both raced — bail safely. Caller maps to exit code per
  // TED 拍板点 #8 (lock_acquire_failed → exit 1; held_by_other → exit 6).
  throw new RuntimeFilesWriteError(
    "lock_acquire_failed",
    lockPath,
    `failed to acquire lock at ${lockPath} after stale-cleanup retry; another daemon may be racing`,
  );
}

function makeLockHandle(lockPath: string): LockHandle {
  let released = false;
  return {
    release(): void {
      if (released) return; // idempotent
      released = true;
      heldLocks.delete(lockPath);
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // best effort — file may have been removed externally
      }
    },
  };
}
