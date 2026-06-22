// M1-17 Step 1 — runtime-files test matrix (Group 2, 7 cases).
//
// Maps directly to docs/plans/m1/M1-17.md Test Matrix Group 2 (case 15-21).
// Uses AIFIGHT_RUNTIME_HOME (M1-04 sealed env override) to point at a
// per-test tmpdir; no test writes to the production runtime home
// directory (M1-04 hard red line — see build.sh step 1.6 grep).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  readToken,
  readPort,
  tokenFilePath,
  portFilePath,
  RuntimeFilesError,
} from "../src/cli/runtime-files";

let tmpDir: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-m1-17-rf-"));
  prevHome = process.env.AIFIGHT_RUNTIME_HOME;
  process.env.AIFIGHT_RUNTIME_HOME = tmpDir;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
  else process.env.AIFIGHT_RUNTIME_HOME = prevHome;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe("runtime-files (M1-17 Group 2)", () => {
  it("case 15: readToken happy path — trims trailing newline", () => {
    fs.writeFileSync(tokenFilePath(), "abc123\n", "utf8");
    expect(readToken()).toBe("abc123");
  });

  it("case 16: readToken ENOENT → token_missing", () => {
    let caught: unknown;
    try {
      readToken();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RuntimeFilesError);
    expect((caught as RuntimeFilesError).kind).toBe("token_missing");
    expect((caught as RuntimeFilesError).filePath).toBe(tokenFilePath());
  });

  it("case 17: readToken empty file → token_corrupt", () => {
    fs.writeFileSync(tokenFilePath(), "   \n", "utf8");
    let caught: unknown;
    try {
      readToken();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RuntimeFilesError);
    expect((caught as RuntimeFilesError).kind).toBe("token_corrupt");
    expect((caught as RuntimeFilesError).filePath).toBe(tokenFilePath());
  });

  it("case 18: readPort happy path — strips trailing newline + parseInt", () => {
    fs.writeFileSync(portFilePath(), "12345\n", "utf8");
    expect(readPort()).toBe(12345);
  });

  it("case 19: readPort ENOENT → port_missing", () => {
    let caught: unknown;
    try {
      readPort();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RuntimeFilesError);
    expect((caught as RuntimeFilesError).kind).toBe("port_missing");
    expect((caught as RuntimeFilesError).filePath).toBe(portFilePath());
  });

  it("case 20: readPort non-numeric → port_corrupt", () => {
    fs.writeFileSync(portFilePath(), "abc", "utf8");
    let caught: unknown;
    try {
      readPort();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RuntimeFilesError);
    expect((caught as RuntimeFilesError).kind).toBe("port_corrupt");
  });

  it("case 21: readPort out of range (0, 65536, -1) → port_corrupt", () => {
    for (const bad of ["0", "65536", "-1"]) {
      fs.writeFileSync(portFilePath(), bad, "utf8");
      let caught: unknown;
      try {
        readPort();
      } catch (e) {
        caught = e;
      }
      expect(caught, `port "${bad}" should throw`).toBeInstanceOf(RuntimeFilesError);
      expect((caught as RuntimeFilesError).kind).toBe("port_corrupt");
    }
  });
});
