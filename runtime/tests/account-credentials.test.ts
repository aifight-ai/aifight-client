// runtime/tests/account-credentials.test.ts
//
// M1-05 C3b: 15 vitest cases covering the credentials.ts encryption
// core. Tests must never touch the user's real runtime home:
// AIFIGHT_RUNTIME_HOME redirects the master-key path to a
// mkdtempSync dir, and AIFIGHT_KEYCHAIN_SERVICE overrides the OS
// keychain service name so the production default stays isolated.
//
// build.sh Step 1.6 enforces two hard red lines against this file:
//   - no reference to the user's real runtime home path (literal)
//   - no hard-coded production keychain service name
// A grep violation fails the build before any test runs.
//
// Per Roy C3b execution constraints:
//   - Every case sets env BEFORE it calls any credentials API, and
//     calls resetCredentialsBackendCacheForTests() after the env
//     change so module-level caches cannot leak across cases.
//   - Under the D1 unified file backend, encrypt always emits the
//     AIFIGHT_CRYPTO_V1 file BLOB; the keychain is only READ + DELETED for
//     one-time migration of legacy AIFIGHT_KEYCHAIN_V1 BLOBs. Cases 10/11
//     construct such a legacy BLOB by hand (new Entry(...).setPassword) to
//     exercise those still-live read/delete paths.
//   - afterEach cleans up real keychain entries via the exact shape
//     { account, password } probed on 2026-04-24 (commit ce2388e):
//     `new Entry(testService, account).deletePassword()`.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";

import { Entry, findCredentials } from "@napi-rs/keyring";

import {
  AIFIGHT_CRYPTO_V1_PREFIX,
  AIFIGHT_KEYCHAIN_V1_PREFIX,
  decryptFromStorage,
  deleteFromStorage,
  encryptForStorage,
  getCredentialsBackend,
  isKeychainAvailable,
  resetCredentialsBackendCacheForTests,
} from "../src/account/credentials";
import { CredentialsCorruptError, CredentialsCryptoError } from "../src/account/errors";

// ─── Test fixture plumbing ──────────────────────────────────────────

let testService = "";
let testHome = "";

/** Build a fresh env + temp runtime home; reset module cache so
 *  getCredentialsBackend()'s next call observes the new env. */
function setupEnv(opts: { forceFallback?: boolean } = {}): void {
  testService = "aifight-test-" + randomUUID();
  testHome = mkdtempSync(join(tmpdir(), "aifight-cred-test-"));
  process.env.AIFIGHT_KEYCHAIN_SERVICE = testService;
  process.env.AIFIGHT_RUNTIME_HOME = testHome;
  if (opts.forceFallback) {
    process.env.AIFIGHT_FORCE_FALLBACK = "1";
  } else {
    delete process.env.AIFIGHT_FORCE_FALLBACK;
  }
  resetCredentialsBackendCacheForTests();
}

/** Remove keychain entries under the current test service, delete
 *  the temp runtime home, and clear env + module cache. Safe to call
 *  multiple times per test body (used when a case reconfigures). */
function teardownEnv(): void {
  if (testService) {
    try {
      const entries = findCredentials(testService);
      for (const { account } of entries) {
        try {
          new Entry(testService, account).deletePassword();
        } catch {
          // Best effort — another process may have beaten us.
        }
      }
    } catch {
      // Keychain unreachable in CI — nothing to clean.
    }
  }
  if (testHome && existsSync(testHome)) {
    rmSync(testHome, { recursive: true, force: true });
  }
  testService = "";
  testHome = "";
  delete process.env.AIFIGHT_KEYCHAIN_SERVICE;
  delete process.env.AIFIGHT_RUNTIME_HOME;
  delete process.env.AIFIGHT_FORCE_FALLBACK;
  resetCredentialsBackendCacheForTests();
}

const POSIX = process.platform !== "win32";

/** Module-level one-shot probe: is the OS keychain usable in this
 *  test environment? Uses a throwaway service so the real test
 *  service namespace stays clean. Gates `it.skipIf(!keychainAvailable)`
 *  for cases that require a live keychain. */
const keychainAvailable: boolean = (() => {
  const probeService = "aifight-envprobe-" + randomUUID();
  const probeAccount = "check-" + randomUUID();
  try {
    const entry = new Entry(probeService, probeAccount);
    entry.setPassword("probe");
    try {
      entry.deletePassword();
    } catch {
      // ignore — best effort cleanup
    }
    return true;
  } catch {
    return false;
  }
})();

// ─── Cases ──────────────────────────────────────────────────────────

describe("credentials.ts — M1-05", () => {
  beforeEach(() => {
    setupEnv();
  });
  afterEach(() => {
    teardownEnv();
  });

  it("Case 1 — isKeychainAvailable() returns boolean and never throws", () => {
    expect(() => isKeychainAvailable()).not.toThrow();
    expect(typeof isKeychainAvailable()).toBe("boolean");
  });

  it("Case 2 — encrypt always emits the file BLOB, never a keychain ref (D1)", () => {
    // Even on a machine with a usable keychain, encrypt no longer WRITES it —
    // the unified local-file backend (AIFIGHT_CRYPTO_V1) is the only output.
    const plaintext = "sk-secret-" + randomUUID();
    const blob = encryptForStorage(plaintext);

    expect(blob.subarray(0, 18).toString("ascii")).toBe(AIFIGHT_CRYPTO_V1_PREFIX);
    expect(blob.subarray(0, 20).toString("ascii")).not.toBe(
      AIFIGHT_KEYCHAIN_V1_PREFIX,
    );
    expect(decryptFromStorage(blob)).toBe(plaintext);
  });

  it("Case 3 — fallback path round-trip (AIFIGHT_FORCE_FALLBACK=1)", () => {
    teardownEnv();
    setupEnv({ forceFallback: true });

    expect(isKeychainAvailable()).toBe(false);
    expect(getCredentialsBackend().backend).toBe("fallback-crypto");

    const plaintext = "sk-fallback-" + randomUUID();
    const blob = encryptForStorage(plaintext);

    expect(blob.subarray(0, 18).toString("ascii")).toBe(
      AIFIGHT_CRYPTO_V1_PREFIX,
    );
    expect(decryptFromStorage(blob)).toBe(plaintext);
  });

  it("Case 4 — fallback 10 KB plaintext round-trip", () => {
    teardownEnv();
    setupEnv({ forceFallback: true });

    const plaintext = "x".repeat(10 * 1024);
    const blob = encryptForStorage(plaintext);
    const recovered = decryptFromStorage(blob);

    expect(recovered).toBe(plaintext);
    expect(recovered.length).toBe(10 * 1024);
  });

  it("Case 5 — fallback empty-string round-trip", () => {
    teardownEnv();
    setupEnv({ forceFallback: true });

    const blob = encryptForStorage("");
    // Format B = 18 prefix + 16 salt + 12 iv + 16 tag + 0 ct = 62 bytes.
    expect(blob.length).toBe(62);
    expect(decryptFromStorage(blob)).toBe("");
  });

  it("Case 6 — fallback tampered ciphertext throws CredentialsCorruptError", () => {
    teardownEnv();
    setupEnv({ forceFallback: true });

    const blob = encryptForStorage("sk-integrity-check");
    // Layout: 18 prefix + 16 salt + 12 iv + 16 tag = offset 62
    // marks byte 0 of the ciphertext region.
    expect(blob.length).toBeGreaterThan(62);
    const tampered = Buffer.from(blob);
    tampered[62] = tampered[62] ^ 0xff;

    expect(() => decryptFromStorage(tampered)).toThrow(CredentialsCorruptError);
    expect(() => decryptFromStorage(tampered)).toThrow(
      /AES-GCM auth tag mismatch/,
    );
  });

  it("Case 7 — unknown blob prefix throws CredentialsCorruptError", () => {
    const future = Buffer.from("AIFIGHT_FUTURE_V99:whatever-extra-bytes");
    expect(() => decryptFromStorage(future)).toThrow(CredentialsCorruptError);
    expect(() => decryptFromStorage(future)).toThrow(/unknown format version/);
  });

  it.skipIf(!POSIX)(
    "Case 8 — new master.key is created mode 0600 (POSIX)",
    () => {
      teardownEnv();
      setupEnv({ forceFallback: true });

      encryptForStorage("trigger-master-key-creation");

      const keyPath = join(testHome, "master.key");
      expect(existsSync(keyPath)).toBe(true);
      expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    },
  );

  it("Case 9 — fallback: two encrypt calls produce independent salt + IV", () => {
    teardownEnv();
    setupEnv({ forceFallback: true });

    const plaintext = "identical-plaintext";
    const blobA = encryptForStorage(plaintext);
    const blobB = encryptForStorage(plaintext);

    expect(blobA.equals(blobB)).toBe(false);
    expect(blobA.subarray(18, 34).equals(blobB.subarray(18, 34))).toBe(false);
    expect(blobA.subarray(34, 46).equals(blobB.subarray(34, 46))).toBe(false);

    expect(decryptFromStorage(blobA)).toBe(plaintext);
    expect(decryptFromStorage(blobB)).toBe(plaintext);
  });

  it.skipIf(!keychainAvailable)(
    "Case 10 — legacy keychain BLOBs still decrypt + delete (migration read path)",
    () => {
      // encrypt no longer writes the keychain, so construct a legacy
      // AIFIGHT_KEYCHAIN_V1 BLOB the pre-D1 way to exercise the still-live
      // keychain READ + DELETE that credential migration depends on.
      const plaintext = "legacy-" + randomUUID();
      const uuid = randomUUID();
      new Entry(testService, uuid).setPassword(plaintext);
      const blob = Buffer.concat([
        Buffer.from(AIFIGHT_KEYCHAIN_V1_PREFIX, "ascii"),
        Buffer.from(uuid, "ascii"),
      ]);
      expect(blob.length).toBe(56);

      // decrypt reads the value back out of the keychain entry
      expect(decryptFromStorage(blob)).toBe(plaintext);

      // once deleted, the entry is gone → decrypt reports corruption
      deleteFromStorage(blob);
      expect(() => decryptFromStorage(blob)).toThrow(CredentialsCorruptError);
    },
  );

  it.skipIf(!keychainAvailable)(
    "Case 11 — deleteFromStorage is idempotent on a legacy keychain BLOB",
    () => {
      // Construct a legacy keychain BLOB (encrypt no longer produces one).
      const uuid = randomUUID();
      new Entry(testService, uuid).setPassword("delete-me");
      const blob = Buffer.concat([
        Buffer.from(AIFIGHT_KEYCHAIN_V1_PREFIX, "ascii"),
        Buffer.from(uuid, "ascii"),
      ]);

      expect(() => deleteFromStorage(blob)).not.toThrow();
      // Second delete on the now-absent entry: still no-throw.
      expect(() => deleteFromStorage(blob)).not.toThrow();
    },
  );

  it("Case 12 — domain separation: chimeric BLOB fails integrity", () => {
    teardownEnv();
    setupEnv({ forceFallback: true });

    const blobA = encryptForStorage("secret-A");
    const blobB = encryptForStorage("secret-B");

    expect(decryptFromStorage(blobA)).toBe("secret-A");
    expect(decryptFromStorage(blobB)).toBe("secret-B");

    // A's (prefix + salt + iv) + B's (tag + ct).
    // scrypt(masterKey, saltA) != scrypt(masterKey, saltB), so
    // even though B's tag+ct are valid under B's AES key, they
    // won't validate under the A-derived key.
    const chimera = Buffer.concat([
      blobA.subarray(0, 18 + 16 + 12),
      blobB.subarray(18 + 16 + 12),
    ]);
    expect(chimera.length).toBe(blobB.length);

    expect(() => decryptFromStorage(chimera)).toThrow(CredentialsCorruptError);
  });

  it.skipIf(!keychainAvailable)(
    "Case 13 — AIFIGHT_FORCE_FALLBACK=1 bypasses cached keychain verdict (Roy constraint #1)",
    () => {
      // beforeEach gave us keychain-path env. Populate the cache
      // with the "keychain" verdict.
      expect(isKeychainAvailable()).toBe(true);
      expect(getCredentialsBackend().backend).toBe("keychain");

      // Now flip env WITHOUT clearing the cache.
      process.env.AIFIGHT_FORCE_FALLBACK = "1";

      // Backend query must short-circuit on env BEFORE reading
      // the (still "keychain") cache.
      expect(isKeychainAvailable()).toBe(false);
      const info = getCredentialsBackend();
      expect(info.backend).toBe("fallback-crypto");
      expect(info.keychainProbeMessage).toBe("AIFIGHT_FORCE_FALLBACK=1");

      // And subsequent encrypt actually goes the fallback path.
      const blob = encryptForStorage("post-force");
      expect(blob.subarray(0, 18).toString("ascii")).toBe(
        AIFIGHT_CRYPTO_V1_PREFIX,
      );
    },
  );

  it.skipIf(!keychainAvailable)(
    "Case 14 — probeKeychain() cleans up its probe entry (Roy hardening guard #1)",
    () => {
      // Fresh env from beforeEach; no force-fallback.
      // Drive multiple probes by clearing the cache each time.
      for (let i = 0; i < 3; i++) {
        resetCredentialsBackendCacheForTests();
        isKeychainAvailable();
      }

      const entries = findCredentials(testService);
      const stale = entries.filter((e) => e.account.startsWith("probe-"));
      expect(stale).toHaveLength(0);
    },
  );

  it.skipIf(!POSIX)(
    "Case 15 — existing master.key is re-chmod'd to 0600 on load (Roy hardening guard #2)",
    () => {
      teardownEnv();
      setupEnv({ forceFallback: true });

      // Pre-write a 32-byte master.key with widened perms 0644.
      // writeFileSync's mode option is masked by umask on some
      // platforms, so chmod explicitly to guarantee the 0644 pre-state.
      const keyPath = join(testHome, "master.key");
      writeFileSync(keyPath, randomBytes(32), { mode: 0o644 });
      chmodSync(keyPath, 0o644);
      expect(statSync(keyPath).mode & 0o777).toBe(0o644);

      // Trigger a fallback encrypt: loadOrCreateMasterKey reads
      // the existing file and re-asserts 0600.
      encryptForStorage("trigger-load");

      expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(!POSIX)(
    "Case 16 — an existing master.key is adopted, never overwritten (first-writer-wins)",
    () => {
      teardownEnv();
      setupEnv({ forceFallback: true });

      // Pre-seed a valid 32-byte master.key, as a concurrent first-writer would
      // have left it. This process must ADOPT it (O_EXCL create loses cleanly),
      // never clobber it — overwriting would strand every ciphertext already
      // sealed under it.
      const keyPath = join(testHome, "master.key");
      const winner = randomBytes(32);
      writeFileSync(keyPath, winner, { mode: 0o600 });

      const blob = encryptForStorage("sealed-under-the-winner-key");
      expect(decryptFromStorage(blob)).toBe("sealed-under-the-winner-key");

      // The pre-existing key bytes are byte-identical afterwards — the create
      // race was lost and we read the winner instead of minting a new key.
      expect(readFileSync(keyPath).equals(winner)).toBe(true);
      expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(!POSIX)(
    "Case 17 — a corrupt (wrong-length) master.key fails closed and is not overwritten",
    () => {
      teardownEnv();
      setupEnv({ forceFallback: true });

      // A short/torn master.key must NOT be re-minted: if the real 32-byte key
      // is merely unreadable right now, overwriting it would destroy the ability
      // to decrypt everything sealed under it. Fail closed instead.
      const keyPath = join(testHome, "master.key");
      writeFileSync(keyPath, Buffer.alloc(10, 7), { mode: 0o600 });

      expect(() => encryptForStorage("must-not-mint-over-corrupt")).toThrow(
        CredentialsCryptoError,
      );
      // The corrupt bytes are left exactly as-is — never clobbered.
      expect(readFileSync(keyPath).length).toBe(10);
    },
  );

  it.skipIf(!POSIX)(
    "Case 18 — a persistent 0-byte master.key fails closed and is not overwritten",
    () => {
      teardownEnv();
      setupEnv({ forceFallback: true });

      // A 0-byte read is the transient a create-race loser can briefly see while
      // a winner is mid-write; the settle loop rides that out. But a PERSISTENT
      // 0-byte file (nothing is writing it) must still fail closed after the
      // retries rather than being minted over — overwriting could destroy the
      // real key if it were merely unreadable.
      const keyPath = join(testHome, "master.key");
      writeFileSync(keyPath, Buffer.alloc(0), { mode: 0o600 });

      expect(() => encryptForStorage("must-not-mint-over-empty")).toThrow(
        CredentialsCryptoError,
      );
      expect(statSync(keyPath).size).toBe(0); // never overwritten
    },
  );
});
