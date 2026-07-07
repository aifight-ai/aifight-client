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
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { Entry } from "@napi-rs/keyring";

import {
  getDeviceId,
  getDeviceIdBackend,
  getOrCreateDeviceSecret,
  resetDeviceIdCacheForTests,
} from "../src/account/device-id";
import { resetCredentialsBackendCacheForTests } from "../src/account/credentials";

/** Is the OS keychain usable here? Gates the migration cases below. */
const keychainAvailable: boolean = (() => {
  const svc = "aifight-envprobe-" + randomUUID();
  try {
    const e = new Entry(svc, "check-" + randomUUID());
    e.setPassword("probe");
    try {
      e.deletePassword();
    } catch {
      // best effort
    }
    return true;
  } catch {
    return false;
  }
})();

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

describe("device-id (keychain → file migration, D1)", () => {
  let home: string;
  let prevHome: string | undefined;
  let prevForce: string | undefined;
  let prevService: string | undefined;
  let service: string;
  const ACCOUNT = "device-secret"; // DEVICE_KEYCHAIN_ACCOUNT in device-id.ts

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "aifight-deviceid-mig-"));
    service = "aifight-test-" + randomUUID();
    prevHome = process.env.AIFIGHT_HOME;
    prevForce = process.env.AIFIGHT_FORCE_FALLBACK;
    prevService = process.env.AIFIGHT_KEYCHAIN_SERVICE;
    process.env.AIFIGHT_HOME = home;
    delete process.env.AIFIGHT_FORCE_FALLBACK; // allow keychain adoption
    process.env.AIFIGHT_KEYCHAIN_SERVICE = service; // isolate from production
    resetCredentialsBackendCacheForTests();
    resetDeviceIdCacheForTests();
  });

  afterEach(() => {
    try {
      new Entry(service, ACCOUNT).deletePassword();
    } catch {
      // best effort
    }
    if (prevHome === undefined) delete process.env.AIFIGHT_HOME;
    else process.env.AIFIGHT_HOME = prevHome;
    if (prevForce === undefined) delete process.env.AIFIGHT_FORCE_FALLBACK;
    else process.env.AIFIGHT_FORCE_FALLBACK = prevForce;
    if (prevService === undefined) delete process.env.AIFIGHT_KEYCHAIN_SERVICE;
    else process.env.AIFIGHT_KEYCHAIN_SERVICE = prevService;
    resetCredentialsBackendCacheForTests();
    resetDeviceIdCacheForTests();
    rmSync(home, { recursive: true, force: true });
  });

  it.skipIf(!keychainAvailable)(
    "adopts a legacy keychain secret into device.key (id preserved) and drops the entry",
    () => {
      // Seed a legacy keychain-stored device secret; no device.key yet.
      const legacy = randomBytes(32).toString("hex");
      new Entry(service, ACCOUNT).setPassword(legacy);
      const keyPath = join(home, "device.key");
      expect(existsSync(keyPath)).toBe(false);

      const secret = getOrCreateDeviceSecret();
      expect(secret).toBe(legacy); // adopted → the deviceId stays stable
      expect(getDeviceId()).toBe(createHash("sha256").update(legacy).digest("hex"));

      // Now on the file backend, with the legacy keychain entry cleaned up.
      expect(getDeviceIdBackend().backend).toBe("file");
      expect(readFileSync(keyPath, "utf8").trim()).toBe(legacy);
      expect(new Entry(service, ACCOUNT).getPassword()).toBeNull();
    },
  );

  it.skipIf(!keychainAvailable)(
    "a fresh machine mints a file secret and never writes the keychain",
    () => {
      // No file, no keychain entry → mint fresh into the file, keychain stays empty.
      const secret = getOrCreateDeviceSecret();
      expect(secret).toMatch(/^[0-9a-f]{64}$/);
      expect(getDeviceIdBackend().backend).toBe("file");
      expect(existsSync(join(home, "device.key"))).toBe(true);
      expect(new Entry(service, ACCOUNT).getPassword()).toBeNull();
    },
  );

  it.skipIf(!keychainAvailable)(
    "an existing device.key wins over a legacy keychain secret (no adoption, entry untouched)",
    () => {
      // Models a concurrent winner: device.key already holds secretF while a
      // stale keychain entry holds a DIFFERENT secretK. The file must win — the
      // deviceId can never flip to the keychain value (that would 403 the agent).
      const secretF = randomBytes(32).toString("hex");
      const secretK = randomBytes(32).toString("hex");
      new Entry(service, ACCOUNT).setPassword(secretK);
      writeFileSync(join(home, "device.key"), secretF, { mode: 0o600 });

      expect(getOrCreateDeviceSecret()).toBe(secretF);
      expect(getDeviceIdBackend().backend).toBe("file");
      // The keychain was never consulted, so its (unrelated) entry is untouched.
      expect(new Entry(service, ACCOUNT).getPassword()).toBe(secretK);
    },
  );
});
