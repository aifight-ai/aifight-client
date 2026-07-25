// The lock file's owner stamp (2026-07-24).
//
// Adjacent to daemon-runtime-files-write.test.ts, which covers the ORIGINAL
// contract: every lock it writes is an empty file, so none of its cases reach
// the stamped branch. These do.
//
// Why the stamp exists: the lock used to be empty, and the only record of who
// held it was a SEPARATE pid file. A bridge older than this change deletes that
// pid file on the path it takes when it loses the race for the lock — leaving a
// lock nobody could prove was dead, which every later acquire refused, forever,
// for both the app and the service. A terminal was the only way out.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  acquireDaemonLock,
  RuntimeFilesWriteError,
  type LockHandle,
} from "../src/daemon/runtime-files-write";

const ORIGINAL_HOME = process.env.AIFIGHT_RUNTIME_HOME;
let tmpDir: string;
let held: LockHandle | null = null;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-lock-stamp-"));
  process.env.AIFIGHT_RUNTIME_HOME = tmpDir;
  held = null;
});

afterEach(() => {
  held?.release();
  held = null;
  if (ORIGINAL_HOME === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
  else process.env.AIFIGHT_RUNTIME_HOME = ORIGINAL_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const lockPath = (): string => path.join(tmpDir, "lock");
const pidPath = (): string => path.join(tmpDir, "pid");

function readStamp(): { pid?: unknown; boot?: unknown } {
  return JSON.parse(fs.readFileSync(lockPath(), "utf8")) as { pid?: unknown; boot?: unknown };
}

function expectHeldByOther(fn: () => unknown): RuntimeFilesWriteError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RuntimeFilesWriteError);
    return e as RuntimeFilesWriteError;
  }
  throw new Error("expected acquireDaemonLock to refuse, but it acquired the lock");
}

describe("lock owner stamp", () => {
  it("is present the instant the lock exists, and names this process", () => {
    held = acquireDaemonLock();

    const stamp = readStamp();
    expect(stamp.pid).toBe(process.pid);
    expect(typeof stamp.boot).toBe("number");
    if (process.platform !== "win32") {
      expect(fs.statSync(lockPath()).mode & 0o777).toBe(0o600);
    }
    // No temp file left behind by the atomic create.
    expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("identifies a live holder even when the pid file has been deleted", () => {
    // Precisely what an older bridge does to us when it loses the race: it
    // unlinks token/port/pid on its way out, including OUR pid file.
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: 4242, boot: Date.now() }), { mode: 0o600 });
    expect(fs.existsSync(pidPath())).toBe(false);

    const err = expectHeldByOther(() => acquireDaemonLock({ processIsAlive: (p) => p === 4242 }));

    expect(err.kind).toBe("lock_held_by_other");
    expect(err.heldByPid).toBe(4242);
  });

  it("reclaims a lock whose stamped owner is gone, with no pid file in sight", () => {
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: 4242, boot: Date.now() }), { mode: 0o600 });

    held = acquireDaemonLock({ processIsAlive: () => false });

    // We now own it, and the stamp is ours.
    expect(readStamp().pid).toBe(process.pid);
  });

  it("says how to recover when the stamp predates the last restart", () => {
    // A crash leaves the lock behind; after a reboot the OS can hand that pid to
    // an unrelated process, which probes as alive. Refusing is right — stealing
    // from a live owner is how two bridges end up on one agent — but the message
    // has to name the thing that actually helps.
    fs.writeFileSync(
      lockPath(),
      JSON.stringify({ pid: 4242, boot: Date.now() - 7 * 24 * 60 * 60 * 1000 }),
      { mode: 0o600 },
    );

    const err = expectHeldByOther(() => acquireDaemonLock({ processIsAlive: () => true }));

    expect(err.kind).toBe("lock_held_by_other");
    expect(err.message).toContain("before the last restart");
    expect(err.message).toContain(lockPath());
  });

  it("falls back to the pid file for a lock written by an older bridge", () => {
    // Unstamped lock + live pid file: the pre-2026-07-24 shape. Must behave
    // exactly as it always did.
    fs.writeFileSync(lockPath(), "", { mode: 0o600 });
    fs.writeFileSync(pidPath(), "12345", "utf8");

    const err = expectHeldByOther(() => acquireDaemonLock({ processIsAlive: (p) => p === 12345 }));

    expect(err.kind).toBe("lock_held_by_other");
    expect(err.heldByPid).toBe(12345);
  });

  it("still refuses an unstamped lock with no pid — that is the racing-daemon window", () => {
    // The one state we must NOT auto-clean: another daemon may be between
    // creating the lock and writing its pid. Stealing here would put two bridges
    // on one agent.
    fs.writeFileSync(lockPath(), "", { mode: 0o600 });

    let caught: unknown;
    try {
      acquireDaemonLock({ processIsAlive: () => false });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RuntimeFilesWriteError);
    expect((caught as RuntimeFilesWriteError).kind).toBe("lock_acquire_failed");
    expect(fs.existsSync(lockPath())).toBe(true);
  });

  it("ignores a corrupt stamp instead of trusting it", () => {
    for (const body of ['{"pid":0,"boot":1}', '{"pid":"x","boot":1}', '{"pid":7}', "not json", "7"]) {
      fs.writeFileSync(lockPath(), body, { mode: 0o600 });
      fs.writeFileSync(pidPath(), "12345", "utf8");

      const err = expectHeldByOther(() => acquireDaemonLock({ processIsAlive: (p) => p === 12345 }));
      // Fell through to the pid file rather than believing the stamp.
      expect(err.heldByPid, `body ${body}`).toBe(12345);
    }
  });
});
