// M1-18 Step 1 — daemon-runtime-files-write test matrix Group 1+2.
//
// Maps directly to docs/plans/m1/M1-18.md Test Matrix
// `daemon-runtime-files-write.test.ts` cases 1-20.
//
// Uses AIFIGHT_RUNTIME_HOME env override (M1-04 sealed) to scope all
// file-system writes to a per-test tmpdir; no test ever touches the
// production runtime home (M1-04 hard red line — see runtime/build.sh
// stage [1.6]).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  generateToken,
  writeToken,
  writePort,
  writePid,
  cleanupStaleTmpFiles,
  acquireDaemonLock,
  RuntimeFilesWriteError,
  type LockHandle,
} from "../src/daemon/runtime-files-write";

const isPosix = process.platform !== "win32";

let tmpDir: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-m1-18-rfw-"));
  prevHome = process.env.AIFIGHT_RUNTIME_HOME;
  process.env.AIFIGHT_RUNTIME_HOME = tmpDir;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (prevHome === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
  else process.env.AIFIGHT_RUNTIME_HOME = prevHome;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe("daemon-runtime-files-write Group 1 — token / port / pid atomic write", () => {
  it("case 1: generateToken returns a 64-char hex string (256-bit)", () => {
    const t = generateToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    // Smoke check: two calls produce different tokens (random source).
    expect(generateToken()).not.toBe(t);
  });

  it("case 2: writeToken happy → mode 0o600 + content === token + no trailing newline", () => {
    const token = "a".repeat(64);
    writeToken(token);
    const p = path.join(tmpDir, "token");
    expect(fs.readFileSync(p, "utf8")).toBe(token);
    if (isPosix) {
      expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    }
  });

  it("case 3: writeToken invalid token → RuntimeFilesWriteError(write_failed)", () => {
    const upper = "A".repeat(64);
    let caughtUpper: unknown;
    try {
      writeToken(upper);
    } catch (e) {
      caughtUpper = e;
    }
    expect(caughtUpper).toBeInstanceOf(RuntimeFilesWriteError);
    expect((caughtUpper as RuntimeFilesWriteError).kind).toBe("write_failed");
    expect((caughtUpper as RuntimeFilesWriteError).filePath).toBe(
      path.join(tmpDir, "token"),
    );

    let caughtShort: unknown;
    try {
      writeToken("abc");
    } catch (e) {
      caughtShort = e;
    }
    expect(caughtShort).toBeInstanceOf(RuntimeFilesWriteError);
    expect((caughtShort as RuntimeFilesWriteError).kind).toBe("write_failed");

    // Token file must not exist after rejected writes.
    expect(fs.existsSync(path.join(tmpDir, "token"))).toBe(false);
  });

  it("case 4: writeToken rename-into-place — tmp file exists in intermediate state with name <path>.<pid>.<counter>.tmp", () => {
    const realRename = fs.renameSync;
    let observedTmp: string | undefined;
    let tmpExistedBeforeRename = false;
    const spy = vi
      .spyOn(fs, "renameSync")
      .mockImplementation((src, dst) => {
        observedTmp = src as string;
        tmpExistedBeforeRename = fs.existsSync(src as string);
        realRename(src as string, dst as string);
      });

    writeToken("b".repeat(64));

    expect(observedTmp).toBeDefined();
    expect(observedTmp!).toMatch(
      new RegExp(`token\\.${process.pid}\\.\\d+\\.tmp$`),
    );
    expect(tmpExistedBeforeRename).toBe(true);

    spy.mockRestore();
  });

  it("case 5: multiple consecutive writeToken — counter increments + no tmp residue after success", () => {
    const observedTmps: string[] = [];
    const realRename = fs.renameSync;
    const spy = vi
      .spyOn(fs, "renameSync")
      .mockImplementation((src, dst) => {
        observedTmps.push(src as string);
        realRename(src as string, dst as string);
      });

    writeToken("c".repeat(64));
    writeToken("d".repeat(64));
    writeToken("e".repeat(64));

    spy.mockRestore();

    expect(observedTmps).toHaveLength(3);
    const counters = observedTmps.map((p) => {
      const m = p.match(/\.(\d+)\.tmp$/);
      return m ? Number.parseInt(m[1]!, 10) : NaN;
    });
    expect(counters[1]!).toBeGreaterThan(counters[0]!);
    expect(counters[2]!).toBeGreaterThan(counters[1]!);

    const remainingTmps = fs
      .readdirSync(tmpDir)
      .filter((n) => n.endsWith(".tmp"));
    expect(remainingTmps).toEqual([]);
  });

  it("case 6: writePort(54321) happy → mode 0o644 + content === '54321' + no trailing newline", () => {
    writePort(54321);
    const p = path.join(tmpDir, "port");
    expect(fs.readFileSync(p, "utf8")).toBe("54321");
    if (isPosix) {
      expect(fs.statSync(p).mode & 0o777).toBe(0o644);
    }
  });

  it("case 7: writePort(0) → throws (out of range, [1, 65535])", () => {
    let caught: unknown;
    try {
      writePort(0);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RuntimeFilesWriteError);
    expect((caught as RuntimeFilesWriteError).kind).toBe("write_failed");
    expect(fs.existsSync(path.join(tmpDir, "port"))).toBe(false);
  });

  it("case 8: writePort(65536) → throws (out of range)", () => {
    let caught: unknown;
    try {
      writePort(65536);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RuntimeFilesWriteError);
    expect((caught as RuntimeFilesWriteError).kind).toBe("write_failed");
  });

  it("case 9: write failure (fs.writeSync throws EPERM) → RuntimeFilesWriteError(write_failed, filePath) + tmp cleaned", () => {
    const epermError: NodeJS.ErrnoException = Object.assign(
      new Error("EPERM: operation not permitted, write"),
      { code: "EPERM" },
    );
    const spy = vi.spyOn(fs, "writeSync").mockImplementation(() => {
      throw epermError;
    });

    let caught: unknown;
    try {
      writeToken("f".repeat(64));
    } catch (e) {
      caught = e;
    }
    spy.mockRestore();

    expect(caught).toBeInstanceOf(RuntimeFilesWriteError);
    expect((caught as RuntimeFilesWriteError).kind).toBe("write_failed");
    expect((caught as RuntimeFilesWriteError).filePath).toBe(
      path.join(tmpDir, "token"),
    );
    expect((caught as RuntimeFilesWriteError).cause).toBe(epermError);

    // tmp file cleaned on failure
    const remainingTmps = fs
      .readdirSync(tmpDir)
      .filter((n) => n.endsWith(".tmp"));
    expect(remainingTmps).toEqual([]);
    // final token file never created
    expect(fs.existsSync(path.join(tmpDir, "token"))).toBe(false);
  });

  it("case 10: writePid(process.pid) happy → mode 0o644 + content === String(pid) + no trailing newline", () => {
    writePid(process.pid);
    const p = path.join(tmpDir, "pid");
    expect(fs.readFileSync(p, "utf8")).toBe(String(process.pid));
    if (isPosix) {
      expect(fs.statSync(p).mode & 0o777).toBe(0o644);
    }
  });
});

describe("daemon-runtime-files-write Group 2 — cleanup tmp + lock acquire", () => {
  let acquiredHandle: LockHandle | undefined;

  afterEach(() => {
    try {
      acquiredHandle?.release();
    } catch {
      // best effort
    }
    acquiredHandle = undefined;
  });

  it("case 11: cleanupStaleTmpFiles deletes *.tmp but preserves other files", () => {
    fs.writeFileSync(path.join(tmpDir, "token.123.1.tmp"), "stale1", "utf8");
    fs.writeFileSync(path.join(tmpDir, "port.456.2.tmp"), "stale2", "utf8");
    fs.writeFileSync(path.join(tmpDir, "keep-me.txt"), "data", "utf8");
    fs.writeFileSync(path.join(tmpDir, "token"), "real-token", "utf8");

    cleanupStaleTmpFiles();

    const remaining = fs.readdirSync(tmpDir).sort();
    expect(remaining).toEqual(["keep-me.txt", "token"]);
  });

  it("case 12: cleanupStaleTmpFiles silent on unlink failure", () => {
    fs.writeFileSync(path.join(tmpDir, "stale.tmp"), "x", "utf8");
    const spy = vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    });

    expect(() => cleanupStaleTmpFiles()).not.toThrow();
    spy.mockRestore();
  });

  it("case 13: acquireDaemonLock happy on clean home → LockHandle + lock file mode 0o600 exists", () => {
    acquiredHandle = acquireDaemonLock();
    const p = path.join(tmpDir, "lock");
    expect(fs.existsSync(p)).toBe(true);
    if (isPosix) {
      expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    }
  });

  it("case 14: acquireDaemonLock when lock + alive PID → throws lock_held_by_other with heldByPid", () => {
    fs.writeFileSync(path.join(tmpDir, "lock"), "", { mode: 0o600 });
    fs.writeFileSync(path.join(tmpDir, "pid"), "12345", "utf8");
    const fakeAlive = (pid: number): boolean => pid === 12345;

    let caught: unknown;
    try {
      acquireDaemonLock({ processIsAlive: fakeAlive });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RuntimeFilesWriteError);
    const err = caught as RuntimeFilesWriteError;
    expect(err.kind).toBe("lock_held_by_other");
    expect(err.heldByPid).toBe(12345);
    expect(err.filePath).toBe(path.join(tmpDir, "lock"));
    // Lock + pid files preserved (we did not steal them).
    expect(fs.existsSync(path.join(tmpDir, "lock"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "pid"))).toBe(true);
  });

  it("case 15: acquireDaemonLock when lock + dead PID (ESRCH) → silently cleans + acquires", () => {
    fs.writeFileSync(path.join(tmpDir, "lock"), "", { mode: 0o600 });
    fs.writeFileSync(path.join(tmpDir, "pid"), "99999", "utf8");
    const fakeDead = (_pid: number): boolean => false;

    acquiredHandle = acquireDaemonLock({ processIsAlive: fakeDead });

    // New lock acquired (overwrote the stale one); pid file removed by
    // stale-cleanup path.
    expect(fs.existsSync(path.join(tmpDir, "lock"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "pid"))).toBe(false);
  });

  it("case 16: acquireDaemonLock when lock exists but pid file MISSING → fails safe (lock_acquire_failed, lock preserved, probe NOT called)", () => {
    // **TED rev8 review-fix (Codex/Roy P1):** lock + missing pid is the
    // exact race window between Step 2's `acquireDaemonLock()` and
    // `writePid(process.pid)`. Treating it as stale would let daemon B
    // steal a freshly-started daemon A's live lock. Fail safe instead.
    fs.writeFileSync(path.join(tmpDir, "lock"), "", { mode: 0o600 });
    // pid file intentionally absent
    const probe = vi.fn(() => true);

    let caught: unknown;
    try {
      acquireDaemonLock({ processIsAlive: probe });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RuntimeFilesWriteError);
    const err = caught as RuntimeFilesWriteError;
    expect(err.kind).toBe("lock_acquire_failed");
    expect(err.filePath).toBe(path.join(tmpDir, "lock"));
    expect(err.message).toMatch(/pid file .* is missing/);
    // Lock file preserved — we did NOT steal it.
    expect(fs.existsSync(path.join(tmpDir, "lock"))).toBe(true);
    // Probe never called — no pid to probe.
    expect(probe).not.toHaveBeenCalled();
  });

  it("case 16b: acquireDaemonLock when lock exists but pid CORRUPT/INVALID (e.g. 'abc') → fails safe (lock_acquire_failed, both files preserved, probe NOT called)", () => {
    // **TED rev8 review-fix (Codex/Roy P1):** corrupt pid content is
    // ambiguous (could be a foreign tool's leftover, could be torn
    // write of a live daemon's pid). Refuse to steal the lock.
    fs.writeFileSync(path.join(tmpDir, "lock"), "", { mode: 0o600 });
    fs.writeFileSync(path.join(tmpDir, "pid"), "abc", "utf8");
    const probe = vi.fn(() => false);

    let caught: unknown;
    try {
      acquireDaemonLock({ processIsAlive: probe });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RuntimeFilesWriteError);
    const err = caught as RuntimeFilesWriteError;
    expect(err.kind).toBe("lock_acquire_failed");
    expect(err.filePath).toBe(path.join(tmpDir, "lock"));
    expect(err.message).toMatch(/pid file .* content is invalid/);
    // Both files preserved — neither stolen.
    expect(fs.existsSync(path.join(tmpDir, "lock"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "pid"))).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, "pid"), "utf8")).toBe("abc");
    // Probe never called — pid is unparseable.
    expect(probe).not.toHaveBeenCalled();
  });

  it("case 17: default acquireDaemonLock when real process.kill throws EPERM (cross-user) → lock_held_by_other + files preserved", () => {
    // **TED rev8 review-fix:** previously this test injected a fake
    // probe returning `true`, which only verified the routing logic.
    // Now we spy the actual `process.kill` so that the default
    // `processIsAlive` semantics are exercised end-to-end —
    // EPERM (cross-user) MUST be treated as alive (safe default,
    // TED 拍板点 #6 + Group 2 case 17).
    fs.writeFileSync(path.join(tmpDir, "lock"), "", { mode: 0o600 });
    fs.writeFileSync(path.join(tmpDir, "pid"), "777", "utf8");

    const epermError: NodeJS.ErrnoException = Object.assign(
      new Error("EPERM: operation not permitted, kill"),
      { code: "EPERM" },
    );
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((pid: number, signal?: string | number) => {
        // Only intercept the liveness probe (signal 0). Anything else
        // (real signal sends) should not happen in this test, but we
        // forward defensively so other test infrastructure isn't broken.
        if (signal === 0 && pid === 777) throw epermError;
        return true;
      });

    let caught: unknown;
    try {
      acquireDaemonLock(); // default probe — exercises real defaultProcessIsAlive
    } catch (e) {
      caught = e;
    }
    killSpy.mockRestore();

    expect(caught).toBeInstanceOf(RuntimeFilesWriteError);
    const err = caught as RuntimeFilesWriteError;
    expect(err.kind).toBe("lock_held_by_other");
    expect(err.heldByPid).toBe(777);
    expect(err.filePath).toBe(path.join(tmpDir, "lock"));
    // Foreign lock + pid preserved — never stolen.
    expect(fs.existsSync(path.join(tmpDir, "lock"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "pid"))).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, "pid"), "utf8")).toBe("777");
  });

  it("case 18: LockHandle.release unlinks lock file + idempotent on second call", () => {
    acquiredHandle = acquireDaemonLock();
    const p = path.join(tmpDir, "lock");
    expect(fs.existsSync(p)).toBe(true);

    acquiredHandle.release();
    expect(fs.existsSync(p)).toBe(false);

    // Second release is no-op
    expect(() => acquiredHandle!.release()).not.toThrow();
    expect(fs.existsSync(p)).toBe(false);
    acquiredHandle = undefined;
  });

  it("case 19: acquireDaemonLock second call from same process throws (reentrancy guard)", () => {
    acquiredHandle = acquireDaemonLock();
    let caught: unknown;
    try {
      acquireDaemonLock();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RuntimeFilesWriteError);
    expect((caught as RuntimeFilesWriteError).kind).toBe("lock_acquire_failed");
    expect((caught as RuntimeFilesWriteError).filePath).toBe(
      path.join(tmpDir, "lock"),
    );
  });

  it("case 20: AIFIGHT_RUNTIME_HOME override lets two locks coexist in same process", () => {
    // First home — already pointed to tmpDir by beforeEach.
    const handle1 = acquireDaemonLock();

    // Second home — fresh tmpdir.
    const tmpDir2 = fs.mkdtempSync(
      path.join(os.tmpdir(), "aifight-m1-18-rfw-2-"),
    );
    process.env.AIFIGHT_RUNTIME_HOME = tmpDir2;
    let handle2: LockHandle | undefined;
    try {
      handle2 = acquireDaemonLock();
      expect(fs.existsSync(path.join(tmpDir2, "lock"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "lock"))).toBe(true);
    } finally {
      handle2?.release();
      handle1.release();
      process.env.AIFIGHT_RUNTIME_HOME = tmpDir;
      try {
        fs.rmSync(tmpDir2, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    // Already released — skip the outer afterEach release.
    acquiredHandle = undefined;
  });
});
