// Device-id keychain→file migration: the three-state probe (G1) + the atomic,
// read-back-verified publish (F1). The OS keychain is MOCKED here so we can
// drive the paths a real keychain can't reproduce deterministically — a Deny
// (getPassword throws), an unreachable keychain on macOS vs Linux, and legacy
// adoption — and assert we NEVER mint a secret that would flip the deviceId and
// 403 the user's own agent.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

// Hoisted control surface for the mocked keychain (vi.mock is hoisted above the
// imports, so its factory can only close over hoisted state).
const kc = vi.hoisted(() => ({
  probeSucceeds: true, // setPassword("probe") in credentials.probeKeychain
  deviceSecret: null as string | null, // getPassword() for the device-secret account
  deviceSecretThrows: false, // getPassword() throws (Deny / locked ACL)
  deleted: [] as string[], // accounts deletePassword() was called on
}));

vi.mock("@napi-rs/keyring", () => {
  class FakeEntry {
    constructor(
      readonly service: string,
      readonly account: string,
    ) {}
    setPassword(_value: string): void {
      // Probe writes (probe-<uuid>) gate keychain availability; when the probe
      // "fails" every write throws → credentials reports it unavailable.
      if (!kc.probeSucceeds) throw new Error("keychain locked (mock)");
    }
    getPassword(): string | null {
      if (this.account === "device-secret") {
        if (kc.deviceSecretThrows) throw new Error("user denied keychain access (mock)");
        return kc.deviceSecret;
      }
      return null;
    }
    deletePassword(): boolean {
      kc.deleted.push(this.account);
      return true;
    }
  }
  return { Entry: FakeEntry };
});

import {
  getDeviceId,
  getOrCreateDeviceSecret,
  resetDeviceIdCacheForTests,
} from "../src/account/device-id";
import { resetCredentialsBackendCacheForTests } from "../src/account/credentials";

const DEVICE_KEY = "device.key";
const ACCOUNT = "device-secret";

let home: string;
let prevHome: string | undefined;
let prevForce: string | undefined;
let prevService: string | undefined;
let stderrLines: string[];
let stderrSpy: { mockRestore: () => void };
const realPlatform = process.platform;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

/** Seed <home>/runtime/bridge.json — the "this is an existing install" signal. */
function seedBridgeJson(): void {
  const runtime = join(home, "runtime");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, "bridge.json"), "{}", { mode: 0o600 });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aifight-deviceid-states-"));
  prevHome = process.env.AIFIGHT_HOME;
  prevForce = process.env.AIFIGHT_FORCE_FALLBACK;
  prevService = process.env.AIFIGHT_KEYCHAIN_SERVICE;
  process.env.AIFIGHT_HOME = home;
  // The suite forces the file backend globally; drop it so the keychain probe
  // paths (mocked) actually run.
  delete process.env.AIFIGHT_FORCE_FALLBACK;
  process.env.AIFIGHT_KEYCHAIN_SERVICE = "aifight-test-states";
  kc.probeSucceeds = true;
  kc.deviceSecret = null;
  kc.deviceSecretThrows = false;
  kc.deleted = [];
  stderrLines = [];
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderrLines.push(String(chunk));
    return true;
  }) as never);
  resetCredentialsBackendCacheForTests();
  resetDeviceIdCacheForTests();
});

afterEach(() => {
  stderrSpy.mockRestore();
  setPlatform(realPlatform);
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

describe("device-id migration — three-state keychain probe (G1/F1)", () => {
  it("mints a fresh file secret when the keychain has no legacy entry", () => {
    setPlatform("darwin");
    kc.probeSucceeds = true;
    kc.deviceSecret = null;

    const id = getDeviceId();

    expect(id).toMatch(/^[0-9a-f]{64}$/);
    const keyPath = join(home, DEVICE_KEY);
    expect(existsSync(keyPath)).toBe(true);
    expect(readFileSync(keyPath, "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(kc.deleted).not.toContain(ACCOUNT); // nothing to adopt → nothing to delete
  });

  it("adopts a legacy keychain secret and drops the entry after a durable write", () => {
    setPlatform("darwin");
    const legacy = randomBytes(32).toString("hex");
    kc.probeSucceeds = true;
    kc.deviceSecret = legacy;

    expect(getOrCreateDeviceSecret()).toBe(legacy);
    expect(getDeviceId()).toBe(createHash("sha256").update(legacy).digest("hex"));
    expect(readFileSync(join(home, DEVICE_KEY), "utf8").trim()).toBe(legacy);
    // The old entry is released ONLY after the adopted secret is read back.
    expect(kc.deleted).toContain(ACCOUNT);
  });

  it("defers migration (no mint, no file, no delete) when the keychain refuses, then retries next run", () => {
    setPlatform("darwin");
    seedBridgeJson(); // existing install
    kc.probeSucceeds = true;
    kc.deviceSecretThrows = true; // user clicked "Deny"

    // No X-Device-Id → server Missing path (non-strict allow, no poison binding).
    expect(getDeviceId()).toBe("");
    const keyPath = join(home, DEVICE_KEY);
    expect(existsSync(keyPath)).toBe(false); // nothing minted, nothing written
    expect(kc.deleted).not.toContain(ACCOUNT); // never delete a secret we could not read
    expect(stderrLines.join("")).toMatch(/keychain is locked\/unavailable/);

    // Warns at most once per process run.
    getDeviceId();
    expect(stderrLines.filter((l) => l.includes("device-id migration"))).toHaveLength(1);

    // Next run: the user allows access (or unlocks) → the one-time migration completes.
    resetDeviceIdCacheForTests();
    kc.deviceSecretThrows = false;
    const legacy = randomBytes(32).toString("hex");
    kc.deviceSecret = legacy;
    expect(getOrCreateDeviceSecret()).toBe(legacy); // adopted on retry
    expect(readFileSync(keyPath, "utf8").trim()).toBe(legacy);
  });

  it("defers migration on an existing macOS install when the keychain is unreachable", () => {
    setPlatform("darwin");
    seedBridgeJson();
    kc.probeSucceeds = false; // e.g. locked login keychain over SSH

    expect(getDeviceId()).toBe("");
    expect(existsSync(join(home, DEVICE_KEY))).toBe(false);
    expect(kc.deleted).not.toContain(ACCOUNT);
  });

  it("mints on a fresh macOS box even when the keychain is unreachable (no prior install)", () => {
    setPlatform("darwin");
    kc.probeSucceeds = false; // no keychain, but no bridge.json → nothing to lose

    const id = getDeviceId();

    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(home, DEVICE_KEY))).toBe(true);
  });

  it("mints on keyring-less Linux so single-device binding still engages", () => {
    setPlatform("linux");
    kc.probeSucceeds = false;
    seedBridgeJson(); // even with an existing install, non-macOS always mints

    const id = getDeviceId();

    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(home, DEVICE_KEY))).toBe(true);
    expect(id).not.toBe("");
  });
});
