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
//   - lock:  getRuntimeHome()/lock,  mode 0600. Existence IS the advisory
//            lock. Since 2026-07-24 it also carries a one-line JSON owner
//            stamp {"pid":N,"boot":M}; the pid file stays the fallback for
//            locks written by older bridges, which left this file empty.
//
// Internal-only — not re-exported to the package root (mirrors M1-17
// read-side which is also internal-only; CLI / lifecycle consume both).

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
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

/**
 * Owner stamp written INSIDE the lock file when we create it.
 *
 * The lock used to be an empty file whose owner could only be learned from the
 * separate `pid` file — and anything that deleted that file (a bridge older than
 * 2026-07-24 does exactly this when it loses the race for the lock) left a lock
 * nobody could prove was dead. Every later acquire then read "ambiguous" and
 * refused, forever, for BOTH the app and the service: an unrecoverable state that
 * needed a terminal to escape. Keeping the owner inside the lock itself means the
 * two can never disagree.
 *
 * `boot` is only ever used as positive corroboration ("same boot, live pid ⇒
 * definitely held"). It is deliberately NOT used to declare a live pid stale:
 * `os.uptime()` can jump across a laptop suspend, and mistaking a live owner for
 * a dead one would put two bridges on one agent — the exact failure this whole
 * mechanism exists to prevent.
 */
interface LockOwnerStamp {
  readonly pid: number;
  readonly boot: number;
}

/** Approximate boot time in epoch ms. Coarse by construction — see LockOwnerStamp. */
function bootTimeMs(): number {
  return Date.now() - Math.round(os.uptime() * 1000);
}

/** Same boot if the two stamps agree to within this much. Generous: os.uptime()
 *  has second granularity and the wall clock can be stepped by NTP. */
const SAME_BOOT_TOLERANCE_MS = 120_000;

function readLockOwner(lockPath: string): LockOwnerStamp | null {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  // Empty: a lock written before this stamp existed. Callers fall back to the
  // pid file, which is exactly how those older bridges expect to be treated.
  if (trimmed.length === 0) return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<LockOwnerStamp>;
    const pid = parsed?.pid;
    const boot = parsed?.boot;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1) return null;
    if (typeof boot !== "number" || !Number.isFinite(boot)) return null;
    return { pid, boot };
  } catch {
    return null;
  }
}

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
      createStampedLock(lockPath);
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

      // Lock file exists. Prefer the owner stamp INSIDE it: it is written
      // under the same O_EXCL create, so it cannot disagree with the lock, and
      // it survives anything that removes the separate pid file — including a
      // pre-2026-07-24 bridge, which unlinks token/port/pid on the very path it
      // takes when it loses this race. Without this, that one unlink left every
      // later acquire reading "ambiguous" and refusing forever.
      const owner = readLockOwner(lockPath);
      if (owner !== null) {
        if (probe(owner.pid)) {
          // Live pid, but stamped in a DIFFERENT boot: almost certainly a lock
          // that outlived a crash whose pid has since been handed to an
          // unrelated process. We still refuse — os.uptime() can jump across a
          // suspend, and stealing from a live owner would put two bridges on one
          // agent — but we say so, because "delete the lock" is then the answer.
          const sameBoot = Math.abs(owner.boot - bootTimeMs()) <= SAME_BOOT_TOLERANCE_MS;
          throw new RuntimeFilesWriteError(
            "lock_held_by_other",
            lockPath,
            sameBoot
              ? `lock at ${lockPath} held by live PID ${owner.pid}`
              : `lock at ${lockPath} claims PID ${owner.pid}, which was recorded before the last restart — if no other AIFight bridge is running, delete ${lockPath} and try again`,
            { heldByPid: owner.pid },
          );
        }
        // Owner is gone: a true stale lock. Same cleanup as the pid-file path.
        cleanStaleLockFiles(lockPath, pidPath);
        continue;
      }

      // No stamp — a lock written by an older bridge. Inspect the pid file to
      // decide stale vs held vs ambiguous. Only `valid` + dead may auto-clean
      // (TED rev8 review-fix); every other state must fail safe so we never
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
      cleanStaleLockFiles(lockPath, pidPath);
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

/**
 * Create the lock, already carrying its owner stamp, in one atomic step.
 *
 * Writing the stamp into an O_EXCL fd after the fact is NOT atomic: the lock is
 * observably empty in between, and a process killed in that window leaves an
 * unstamped lock — which, if its pid file is also gone, is the unrecoverable
 * "ambiguous" state the stamp exists to eliminate. So the stamp is written to a
 * private temp file first and hard-linked into place: link() fails with EEXIST if
 * the lock already exists, giving the same mutual exclusion as O_EXCL, and the
 * lock is fully formed the instant it becomes visible.
 *
 * Throws the same EEXIST-shaped error as the O_EXCL path so the caller's
 * contention handling is unchanged. Falls back to O_EXCL where link() is not
 * supported (some network filesystems), accepting the narrow window there.
 */
function createStampedLock(lockPath: string): void {
  const stamp: LockOwnerStamp = { pid: process.pid, boot: bootTimeMs() };
  const tmpPath = `${lockPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(stamp), { mode: 0o600 });
  } catch {
    // Cannot stage the stamp — fall back to an unstamped lock rather than
    // failing to lock at all.
    fs.closeSync(openLockExclusive(lockPath));
    return;
  }
  try {
    fs.linkSync(tmpPath, lockPath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw e; // contention — caller inspects the holder
    // link() unsupported/refused: keep the lock semantics, lose the atomicity.
    const fd = openLockExclusive(lockPath);
    try {
      fs.writeSync(fd, JSON.stringify(stamp));
    } catch {
      // best effort — existence is what makes this a lock
    }
    fs.closeSync(fd);
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // best effort — the link (or the fallback) already owns the content
    }
  }
}

function openLockExclusive(lockPath: string): number {
  return fs.openSync(
    lockPath,
    // eslint-disable-next-line no-bitwise -- standard POSIX flag combo
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600,
  );
}

/** Remove a lock whose owner is provably gone, plus its pid file, so the retry
 *  below can create a fresh one. Both unlinks are best effort: a racing startup
 *  may have cleaned them already. */
function cleanStaleLockFiles(lockPath: string, pidPath: string): void {
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
