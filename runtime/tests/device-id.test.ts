// Device id (single-device binding / anti-theft) — file-fallback backend.
//
// Forces the file backend (AIFIGHT_FORCE_FALLBACK=1) so the test never touches
// the real OS keychain, and isolates the home to a temp dir. Verifies the device
// secret lives in the AIFight home's device.key (0600) — NOT in bridge.json — and
// that the id sent to the server is sha256(secret), stable across "restarts".

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  getDeviceId,
  getDeviceIdBackend,
  getOrCreateDeviceSecret,
  resetDeviceIdCacheForTests,
} from "../src/account/device-id";
import { resetCredentialsBackendCacheForTests } from "../src/account/credentials";

describe("device-id (file fallback)", () => {
  let home: string;
  let prevHome: string | undefined;
  let prevForce: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "aifight-deviceid-"));
    prevHome = process.env.AIFIGHT_HOME;
    prevForce = process.env.AIFIGHT_FORCE_FALLBACK;
    process.env.AIFIGHT_HOME = home;
    process.env.AIFIGHT_FORCE_FALLBACK = "1"; // force file backend (no keychain)
    resetCredentialsBackendCacheForTests();
    resetDeviceIdCacheForTests();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.AIFIGHT_HOME;
    else process.env.AIFIGHT_HOME = prevHome;
    if (prevForce === undefined) delete process.env.AIFIGHT_FORCE_FALLBACK;
    else process.env.AIFIGHT_FORCE_FALLBACK = prevForce;
    resetCredentialsBackendCacheForTests();
    resetDeviceIdCacheForTests();
    rmSync(home, { recursive: true, force: true });
  });

  it("uses the file backend and writes <home>/device.key (0600)", () => {
    const backend = getDeviceIdBackend();
    expect(backend.backend).toBe("file");
    const keyPath = join(home, "device.key");
    expect(existsSync(keyPath)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    }
  });

  it("device id is sha256(secret), 64-char hex, and != the secret", () => {
    const secret = getOrCreateDeviceSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const id = getDeviceId();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).toBe(createHash("sha256").update(secret).digest("hex"));
    // The id is sent to the server; the secret stays local — they must differ.
    expect(id).not.toBe(secret);
  });

  it("is stable across a simulated process restart (same key file)", () => {
    const first = getDeviceId();
    resetDeviceIdCacheForTests(); // fresh process re-reads the same device.key
    expect(getDeviceId()).toBe(first);
  });

  it("regenerates when device.key is malformed", () => {
    getDeviceId();
    const keyPath = join(home, "device.key");
    writeFileSync(keyPath, "not-hex");
    resetDeviceIdCacheForTests();
    const id = getDeviceId();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(keyPath, "utf8")).toMatch(/^[0-9a-f]{64}$/);
  });
});
