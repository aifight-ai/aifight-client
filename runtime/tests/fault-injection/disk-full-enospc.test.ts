// M5-01 fault class 4: 磁盘满 / 写失败 (ENOSPC) (plan §13).
//
// Adjacent to daemon-runtime-files-write.test.ts (sealed M1-18 Group 1+2):
// that suite proves the unit contract for token/port/pid writers. Adjacent
// to daemon-lifecycle.test.ts cases 9-10 (sealed M1-18 Group 6): those test
// the full daemon startup unwind under EPERM injection at openSync.
//
// This file injects ENOSPC specifically (vs EPERM) at fs.openSync for each
// of token/port/pid write paths and asserts:
//   - all three writers wrap the errno into RuntimeFilesWriteError(write_failed)
//   - the original errno survives as cause.code so caller exit-code mapping
//     can distinguish disk-full from permission-denied
//   - tmp file is cleaned up after failure (no leaked .tmp file)
//
// EPERM and ENOSPC flow through the same atomicWrite catch path, but the
// fault class is "disk full" (different operational meaning, different fix
// for the user — free space vs check perms). Locking ENOSPC explicitly here
// guards against future split-out where disk-full might get its own branch.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  writeToken,
  writePort,
  writePid,
  generateToken,
  RuntimeFilesWriteError,
} from "../../src/daemon/runtime-files-write";
import { injectFsOpenSyncError } from "./_helpers";

let tmpDir: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-m5-01-enospc-"));
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

function expectNoLeakedTmpFiles(): void {
  // After failure, atomicWrite's catch block must unlink the tmp file.
  // Anything left behind is a regression.
  const entries = fs.readdirSync(tmpDir);
  const leakedTmp = entries.filter((e) => e.endsWith(".tmp"));
  expect(leakedTmp).toEqual([]);
}

describe("M5-01 disk full — ENOSPC injected at openSync", () => {
  it("writeToken under ENOSPC → RuntimeFilesWriteError(write_failed), errno preserved, no tmp leak", () => {
    const handle = injectFsOpenSyncError(
      (p) => p.includes("/token."),
      "ENOSPC",
    );

    let caught: unknown = null;
    try {
      writeToken(generateToken());
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(RuntimeFilesWriteError);
    expect((caught as RuntimeFilesWriteError).kind).toBe("write_failed");
    expect((caught as RuntimeFilesWriteError).filePath).toContain("token");
    // Original errno survives in cause for caller-side branching (e.g. exit
    // code 28 for ENOSPC vs 13 for EACCES).
    const cause = (caught as RuntimeFilesWriteError).cause as
      | NodeJS.ErrnoException
      | undefined;
    expect(cause?.code).toBe("ENOSPC");

    expectNoLeakedTmpFiles();
    handle.restore();
  });

  it("writePort under ENOSPC → wraps consistently (not raw throw)", () => {
    const handle = injectFsOpenSyncError(
      (p) => p.includes("/port."),
      "ENOSPC",
    );

    let caught: unknown = null;
    try {
      writePort(8123);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(RuntimeFilesWriteError);
    expect((caught as RuntimeFilesWriteError).kind).toBe("write_failed");
    expect(
      ((caught as RuntimeFilesWriteError).cause as NodeJS.ErrnoException)?.code,
    ).toBe("ENOSPC");
    expectNoLeakedTmpFiles();
    handle.restore();
  });

  it("writePid under ENOSPC → same wrap; pid path appears in error.filePath", () => {
    const handle = injectFsOpenSyncError(
      (p) => p.includes("/pid."),
      "ENOSPC",
    );

    let caught: unknown = null;
    try {
      writePid(99999);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(RuntimeFilesWriteError);
    expect((caught as RuntimeFilesWriteError).kind).toBe("write_failed");
    expect((caught as RuntimeFilesWriteError).filePath).toContain("pid");
    expect(
      ((caught as RuntimeFilesWriteError).cause as NodeJS.ErrnoException)?.code,
    ).toBe("ENOSPC");
    expectNoLeakedTmpFiles();
    handle.restore();
  });
});
