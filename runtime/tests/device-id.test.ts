// Device id (single-device binding / anti-theft) — file-fallback backend.
//
// Forces the file backend (AIFIGHT_FORCE_FALLBACK=1) so the test never touches
// the real OS keychain, and isolates the home to a temp dir. Verifies the device
// secret lives in the AIFight home's device.key (0600) — NOT in bridge.json — and
// that the id sent to the server is sha256(secret + ":" + machine id), stable
// across "restarts". The machine id is pinned via AIFIGHT_MACHINE_ID_OVERRIDE so
// these cases do not depend on what the host will say about itself.

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
import { resetMachineIdCacheForTests } from "../src/account/machine-id";
import { resetCredentialsBackendCacheForTests } from "../src/account/credentials";

/** Two stand-in machines. Real values are OS-supplied UUIDs; only their being
 *  different matters here. */
const MACHINE_A = "11111111-2222-3333-4444-555555555555";
const MACHINE_B = "99999999-8888-7777-6666-555555555555";

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

/** Windows Credential Manager is not safe against concurrent writers, and vitest
 *  runs test files in parallel processes. Measured here on Windows 11 with eight
 *  writer processes, each on its own random service name: ~0.5% of setPassword()
 *  calls report success but never persist, ~4% of entries that were written AND
 *  read back vanish moments later, and ~1% of deletePassword() calls do not
 *  stick. The same loop run solo is 0/400 — it is contention on the shared
 *  vault, not our code: the entry disappears even in the case below where the
 *  product never touches the keychain at all.
 *
 *  So the cases that seed a real entry get a bounded retry ON WINDOWS ONLY. Each
 *  attempt re-runs beforeEach, hence a fresh home and a fresh service name, so a
 *  retry re-seeds from scratch rather than inheriting half-lost state. macOS and
 *  Linux — where this legacy migration path actually ships — keep zero retries,
 *  so a flake there still fails the suite. */
const KEYCHAIN_RACE_RETRY = { retry: process.platform === "win32" ? 3 : 0 };

describe("device-id (file fallback)", () => {
  let home: string;
  let prevHome: string | undefined;
  let prevForce: string | undefined;
  let prevMachine: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "aifight-deviceid-"));
    prevHome = process.env.AIFIGHT_HOME;
    prevForce = process.env.AIFIGHT_FORCE_FALLBACK;
    prevMachine = process.env.AIFIGHT_MACHINE_ID_OVERRIDE;
    process.env.AIFIGHT_HOME = home;
    process.env.AIFIGHT_FORCE_FALLBACK = "1"; // force file backend (no keychain)
    process.env.AIFIGHT_MACHINE_ID_OVERRIDE = MACHINE_A;
    resetCredentialsBackendCacheForTests();
    resetDeviceIdCacheForTests();
    resetMachineIdCacheForTests();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.AIFIGHT_HOME;
    else process.env.AIFIGHT_HOME = prevHome;
    if (prevForce === undefined) delete process.env.AIFIGHT_FORCE_FALLBACK;
    else process.env.AIFIGHT_FORCE_FALLBACK = prevForce;
    if (prevMachine === undefined) delete process.env.AIFIGHT_MACHINE_ID_OVERRIDE;
    else process.env.AIFIGHT_MACHINE_ID_OVERRIDE = prevMachine;
    resetCredentialsBackendCacheForTests();
    resetDeviceIdCacheForTests();
    resetMachineIdCacheForTests();
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

  it("device id is sha256(secret + machine id), 64-char hex, and != the secret", () => {
    const secret = getOrCreateDeviceSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const id = getDeviceId();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).toBe(createHash("sha256").update(`${secret}:${MACHINE_A}`).digest("hex"));
    // The id is sent to the server; the secret stays local — they must differ.
    expect(id).not.toBe(secret);
  });

  // The whole point of mixing the machine in: carrying this directory to another
  // computer must not carry its identity. Same secret file, different machine,
  // different id — which is what lets the server refuse the copy.
  it("the same secret on another machine yields a different device id", () => {
    const secret = getOrCreateDeviceSecret();
    const here = getDeviceId();

    process.env.AIFIGHT_MACHINE_ID_OVERRIDE = MACHINE_B;
    resetMachineIdCacheForTests();
    const elsewhere = getDeviceId();

    expect(getOrCreateDeviceSecret()).toBe(secret); // the copied file is identical
    expect(elsewhere).not.toBe(here);
  });

  // A machine that will not name itself (containers, a locked-down host) must
  // still be able to play — but it identifies itself as nothing, not as
  // something. Hashing the empty machine id would hand the server a confident
  // fingerprint built from the secret alone: precisely the copy-the-folder value
  // this input exists to retire, and one that silently "changes machine" the
  // moment the read starts working. "" omits the header, and an unidentified
  // client is a state the server already handles (admitted while lenient).
  it("sends no id at all when the machine has none", () => {
    process.env.AIFIGHT_MACHINE_ID_OVERRIDE = "";
    resetMachineIdCacheForTests();
    expect(getDeviceId()).toBe("");
    expect(getDeviceId()).not.toBe(
      createHash("sha256").update(`${getOrCreateDeviceSecret()}:`).digest("hex"),
    );
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
  let prevMachine: string | undefined;
  let service: string;
  const ACCOUNT = "device-secret"; // DEVICE_KEYCHAIN_ACCOUNT in device-id.ts

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "aifight-deviceid-mig-"));
    service = "aifight-test-" + randomUUID();
    prevHome = process.env.AIFIGHT_HOME;
    prevForce = process.env.AIFIGHT_FORCE_FALLBACK;
    prevService = process.env.AIFIGHT_KEYCHAIN_SERVICE;
    prevMachine = process.env.AIFIGHT_MACHINE_ID_OVERRIDE;
    process.env.AIFIGHT_HOME = home;
    delete process.env.AIFIGHT_FORCE_FALLBACK; // allow keychain adoption
    process.env.AIFIGHT_KEYCHAIN_SERVICE = service; // isolate from production
    process.env.AIFIGHT_MACHINE_ID_OVERRIDE = MACHINE_A;
    resetCredentialsBackendCacheForTests();
    resetDeviceIdCacheForTests();
    resetMachineIdCacheForTests();
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
    if (prevMachine === undefined) delete process.env.AIFIGHT_MACHINE_ID_OVERRIDE;
    else process.env.AIFIGHT_MACHINE_ID_OVERRIDE = prevMachine;
    resetCredentialsBackendCacheForTests();
    resetDeviceIdCacheForTests();
    resetMachineIdCacheForTests();
    rmSync(home, { recursive: true, force: true });
  });

  it.skipIf(!keychainAvailable)(
    "adopts a legacy keychain secret into device.key (id preserved) and drops the entry",
    KEYCHAIN_RACE_RETRY,
    () => {
      // Seed a legacy keychain-stored device secret; no device.key yet.
      const legacy = randomBytes(32).toString("hex");
      new Entry(service, ACCOUNT).setPassword(legacy);
      const keyPath = join(home, "device.key");
      expect(existsSync(keyPath)).toBe(false);

      const secret = getOrCreateDeviceSecret();
      expect(secret).toBe(legacy); // adopted → the deviceId stays stable
      expect(getDeviceId()).toBe(createHash("sha256").update(`${legacy}:${MACHINE_A}`).digest("hex"));

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
    KEYCHAIN_RACE_RETRY,
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
