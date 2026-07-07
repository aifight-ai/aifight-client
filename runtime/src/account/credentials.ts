// runtime/src/account/credentials.ts
//
// M1-05 Step 4: encryption core for agents.api_key / agents.claim_token.
// Library-only surface — no CLI wiring, no registerAgent() glue.
//
// Backend selection (per TED rev 2 §BLOB wire format):
//   - Primary: OS keychain via @napi-rs/keyring. Emits Format A BLOB
//     = "AIFIGHT_KEYCHAIN_V1:" + 36-byte ASCII UUID. The UUID is
//     generated inside encryptForStorage(); callers cannot influence
//     the account id and therefore cannot make two encrypt calls
//     collide on the same keychain entry.
//   - Fallback: node:crypto AES-256-GCM + scryptSync(masterKey, salt).
//     Emits Format B BLOB = "AIFIGHT_CRYPTO_V1:" + 16-byte salt +
//     12-byte IV + 16-byte GCM tag + ciphertext. Fresh salt per
//     encrypt gives domain separation without an accountName AAD.
//
// Cache + env precedence (Roy Step 2+3 constraint #1):
//   AIFIGHT_FORCE_FALLBACK=1 is checked at the TOP of every public
//   backend query — before the cache, before any keychain access.
//   A prior cached "keychain" never leaks into a forced-fallback
//   run. The test-only helper resetCredentialsBackendCacheForTests()
//   clears module state between cases; it is intentionally NOT
//   re-exported from src/index.ts.
//
// Service name (Roy Step 2+3 constraint #2):
//   AIFIGHT_KEYCHAIN_SERVICE env var overrides the production
//   default "aifight-runtime" for tests only. Production callers
//   never read from user-supplied input.
//
// Master key (Roy Step 2+3 constraint #3):
//   ~/.aifight/runtime/master.key (mode 0600) — via getRuntimeHome()
//   which honors AIFIGHT_RUNTIME_HOME. Tests set that env to a
//   mkdtempSync path so real $HOME is never touched.
//
// Error contract (per TED rev 2 §错误分支决策表):
//   - keychain probe throws                → cached as fallback, no throw
//   - first encrypt setPassword throws     → runtime demotion, fall through
//   - master key I/O / scrypt fail         → CredentialsCryptoError("kdf")
//   - AES-256-GCM encrypt fail             → CredentialsCryptoError("encrypt")
//   - unknown BLOB prefix                  → CredentialsCorruptError
//   - keychain getPassword returns null    → CredentialsCorruptError("keychain entry missing")
//   - keychain getPassword/delete throws   → CredentialsKeychainUnavailableError
//   - AES-GCM tag mismatch                 → CredentialsCorruptError("AES-GCM auth tag mismatch")
//
// Security note: callers MUST NOT log the Buffer returned by
// encryptForStorage() or the string returned by decryptFromStorage()
// in plaintext. Same redaction discipline as registration.ts.

import { Entry } from "@napi-rs/keyring";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  scryptSync,
} from "node:crypto";
import { chmodSync, closeSync, fsyncSync, linkSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

import { ensureRuntimeHome, getRuntimeHome } from "../store/paths";
import {
  CredentialsCorruptError,
  CredentialsCryptoError,
  CredentialsKeychainUnavailableError,
} from "./errors";

// ─── Constants (stable public surface) ───────────────────────────────

/** Version prefix for keychain-backed BLOBs. ASCII, 20 bytes.
 *  Format A per TED rev 2 §BLOB wire format. */
export const AIFIGHT_KEYCHAIN_V1_PREFIX = "AIFIGHT_KEYCHAIN_V1:";

/** Version prefix for fallback AES-256-GCM BLOBs. ASCII, 18 bytes.
 *  Format B per TED rev 2 §BLOB wire format. */
export const AIFIGHT_CRYPTO_V1_PREFIX = "AIFIGHT_CRYPTO_V1:";

/** Production default OS keychain service name. Tests MUST override
 *  via AIFIGHT_KEYCHAIN_SERVICE — a build.sh grep (Step 9) will
 *  forbid any test file from hard-coding this literal. */
export const AIFIGHT_RUNTIME_SERVICE = "aifight-runtime";

const MASTER_KEY_FILENAME = "master.key";
const MASTER_KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const UUID_ASCII_BYTES = 36;
const AES_KEY_BYTES = 32;

const KEYCHAIN_V1_PREFIX_BYTES = Buffer.byteLength(
  AIFIGHT_KEYCHAIN_V1_PREFIX,
  "ascii",
);
const CRYPTO_V1_PREFIX_BYTES = Buffer.byteLength(
  AIFIGHT_CRYPTO_V1_PREFIX,
  "ascii",
);

// ─── Types (stable public surface) ───────────────────────────────────

export interface CredentialsBackendInfo {
  readonly backend: "keychain" | "fallback-crypto";
  /** Populated only when backend = "fallback-crypto". Human-readable
   *  reason why the keychain probe failed — useful for diagnostics
   *  in the future `aifight doctor` CLI (M1-17). */
  readonly keychainProbeMessage?: string;
}

// ─── Module state (reset-able for tests) ─────────────────────────────

let backendCache: CredentialsBackendInfo | null = null;
let masterKeyCache: Buffer | null = null;

/** Internal test-only helper: clears cached backend selection and
 *  cached master key. Call in vitest `beforeEach`/`afterEach` to
 *  isolate cases. NOT re-exported from src/index.ts — test files
 *  import directly from `../src/account/credentials`. */
export function resetCredentialsBackendCacheForTests(): void {
  backendCache = null;
  masterKeyCache = null;
}

// ─── Service name (env override is tests-only) ───────────────────────

function getServiceName(): string {
  const override = process.env.AIFIGHT_KEYCHAIN_SERVICE;
  return override && override.length > 0 ? override : AIFIGHT_RUNTIME_SERVICE;
}

// ─── Keychain probe + backend selection ─────────────────────────────

function probeKeychain(): { ok: boolean; message?: string } {
  const entry = new Entry(getServiceName(), "probe-" + randomUUID());
  let writeOk = false;
  try {
    entry.setPassword("probe");
    writeOk = true;
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : String(e),
    };
  } finally {
    // Best-effort cleanup. If setPassword succeeded but delete
    // throws (a transient keychain hiccup between write and delete),
    // we still report ok — leaving a stale probe entry is preferable
    // to misreporting the backend as unavailable. Shape-probe on
    // 2026-04-24 (commit ce2388e) confirmed deletePassword on a
    // missing entry returns false and does NOT throw, so only a
    // genuine keychain fault can hit this branch.
    if (writeOk) {
      try {
        entry.deletePassword();
      } catch {
        // Stale probe entry — acceptable trade-off.
      }
    }
  }
}

/** Backend query. AIFIGHT_FORCE_FALLBACK=1 short-circuits BEFORE the
 *  cache and BEFORE any keychain call — see Roy Step 2+3 constraint #1. */
export function getCredentialsBackend(): CredentialsBackendInfo {
  if (process.env.AIFIGHT_FORCE_FALLBACK === "1") {
    return {
      backend: "fallback-crypto",
      keychainProbeMessage: "AIFIGHT_FORCE_FALLBACK=1",
    };
  }
  if (backendCache === null) {
    const probe = probeKeychain();
    backendCache = probe.ok
      ? { backend: "keychain" }
      : { backend: "fallback-crypto", keychainProbeMessage: probe.message };
  }
  return backendCache;
}

export function isKeychainAvailable(): boolean {
  return getCredentialsBackend().backend === "keychain";
}

// ─── Fallback master key ─────────────────────────────────────────────

function getMasterKeyPath(): string {
  return join(getRuntimeHome(), MASTER_KEY_FILENAME);
}

function loadOrCreateMasterKey(): Buffer {
  if (masterKeyCache !== null) return masterKeyCache;
  try {
    ensureRuntimeHome();
  } catch (e) {
    throw new CredentialsCryptoError(
      "kdf",
      `failed to create runtime home for master key: ${
        e instanceof Error ? e.message : String(e)
      }`,
      e,
    );
  }
  const path = getMasterKeyPath();

  // FIRST-WRITER-WINS — no check-then-act. Two independent processes can reach a
  // fresh machine at once (the desktop app auto-starts its bridge while a
  // headless `aifight` CLI or the launchd service runs) with NO cross-process
  // lock between them. A plain existsSync()+writeFileSync() lets both mint a
  // DIFFERENT master key and clobber each other; every ciphertext the loser
  // already sealed then fails its AES-GCM tag and the local apiKey is bricked
  // (recoverable only by re-pairing). O_CREAT|O_EXCL makes exactly one create
  // win; whoever loses the create reads the winner's key instead. And unlike
  // device.key, a master.key we cannot validate must FAIL CLOSED — overwriting
  // it destroys data (ciphertext already sealed under the real key), it does not
  // just re-mint a self-contained secret.
  const created = tryCreateMasterKey(path);
  const key = created ?? readExistingMasterKey(path);
  masterKeyCache = key;
  return key;
}

/** Create master.key first-writer-wins and return the freshly minted key, or
 *  null when the file already exists — a prior run, or a concurrent first-writer
 *  we lost the create race to (the caller then reads the winner). Any other I/O
 *  error is fatal.
 *
 *  POSIX publishes via link(): the key is written + fsync'd to a private tmp and
 *  then linked into place, so a create-race LOSER that reads master.key after the
 *  winner's link only ever observes a COMPLETE file. A bare openSync("wx") +
 *  writeSync leaves a 0-byte window between create and write; a loser spinning
 *  its settle read through that window would false-throw on a perfectly good key
 *  (~7% under a real desktop+CLI double launch — the review finding this closes).
 *  Windows keeps the direct O_EXCL create (hard-link semantics vary by FS) and
 *  relies on the 0-byte-aware settle read in readExistingMasterKey. */
function tryCreateMasterKey(path: string): Buffer | null {
  const key = randomBytes(MASTER_KEY_BYTES);
  if (process.platform === "win32") {
    try {
      writeKeyFileDurable(path, key);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw new CredentialsCryptoError(
        "kdf",
        `failed to create master key at ${path}: ${e instanceof Error ? e.message : String(e)}`,
        e,
      );
    }
    return key;
  }
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeKeyFileDurable(tmp, key);
    try {
      linkSync(tmp, path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw new CredentialsCryptoError(
        "kdf",
        `failed to create master key at ${path}: ${e instanceof Error ? e.message : String(e)}`,
        e,
      );
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // best effort — a stray tmp file is harmless
    }
  }
  // link() carries the tmp's perms; re-assert 0600 (umask may have masked it).
  try {
    chmodSync(path, 0o600);
  } catch (e) {
    throw new CredentialsCryptoError(
      "kdf",
      `failed to enforce 0600 permissions on new master key at ${path}: ${e instanceof Error ? e.message : String(e)}`,
      e,
    );
  }
  return key;
}

/** openSync("wx") + writeSync(full) + fsync + close. Create-or-fail; fsync so a
 *  crash cannot leave a zero-length/torn key that later reads as corrupt. */
function writeKeyFileDurable(file: string, key: Buffer): void {
  const fd = openSync(file, "wx", 0o600);
  try {
    writeSync(fd, key);
    fsyncSync(fd);
  } finally {
    try {
      closeSync(fd);
    } catch {
      // best effort — the bytes are already fsync'd.
    }
  }
}

/** Block ~ms without busy-spinning, to space out create-race settle reads so a
 *  concurrent winner's write can land. Degrades to an immediate return where
 *  SharedArrayBuffer/Atomics are unavailable. */
function sleepSyncMs(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Atomics.wait / SharedArrayBuffer unavailable — skip the wait.
  }
}

/** Read the on-disk master key — the common already-exists path, and the branch
 *  a create-race loser takes. Re-asserts 0600, validates the 32-byte length, and
 *  briefly retries a short/absent read to ride out a concurrent winner whose
 *  write+fsync has not yet landed. FAILS CLOSED — never overwrites — so a
 *  genuinely corrupt master.key surfaces as an error instead of silently
 *  destroying every ciphertext sealed under the real key. */
function readExistingMasterKey(path: string): Buffer {
  // Re-assert 0600: a backup restore, sibling process, or user error could have
  // widened perms after the original write. Refuse a key we cannot re-confine.
  if (process.platform !== "win32") {
    try {
      chmodSync(path, 0o600);
    } catch (e) {
      throw new CredentialsCryptoError(
        "kdf",
        `failed to enforce 0600 permissions on existing master key at ${path}: ${
          e instanceof Error ? e.message : String(e)
        }`,
        e,
      );
    }
  }
  let lastLen = -1;
  for (let i = 0; i < 8; i++) {
    let key: Buffer;
    try {
      key = readFileSync(path);
    } catch (e) {
      throw new CredentialsCryptoError(
        "kdf",
        `failed to read master key at ${path}: ${
          e instanceof Error ? e.message : String(e)
        }`,
        e,
      );
    }
    if (key.length === MASTER_KEY_BYTES) return key;
    lastLen = key.length;
    // On Windows (direct O_EXCL create) a create-race loser can read the file in
    // the instant after create but before the winner's single 32-byte write — an
    // empty (0-byte) read. Wait briefly and retry ONLY that transient; any other
    // wrong length is persistent corruption, so fail closed at once and never
    // overwrite (that would destroy ciphertext sealed under the real key).
    if (key.length !== 0) break;
    if (i < 7) sleepSyncMs(5);
  }
  throw new CredentialsCryptoError(
    "kdf",
    `master key at ${path} is ${lastLen} bytes, expected ${MASTER_KEY_BYTES}`,
  );
}

// ─── Encrypt ────────────────────────────────────────────────────────

function encryptWithFallback(plaintext: string): Buffer {
  const masterKey = loadOrCreateMasterKey();
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  let aesKey: Buffer;
  try {
    aesKey = scryptSync(masterKey, salt, AES_KEY_BYTES);
  } catch (e) {
    throw new CredentialsCryptoError(
      "kdf",
      `scrypt key derivation failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
      e,
    );
  }
  let ct: Buffer;
  let tag: Buffer;
  try {
    const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
    ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    tag = cipher.getAuthTag();
  } catch (e) {
    throw new CredentialsCryptoError(
      "encrypt",
      `AES-256-GCM encrypt failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
      e,
    );
  }
  return Buffer.concat([
    Buffer.from(AIFIGHT_CRYPTO_V1_PREFIX, "ascii"),
    salt,
    iv,
    tag,
    ct,
  ]);
}

export function encryptForStorage(plaintext: string): Buffer {
  // Unified local-file backend (D1): always emit the AES-256-GCM file BLOB
  // (AIFIGHT_CRYPTO_V1) — the OS keychain is no longer WRITTEN.
  //
  // Why: a keychain entry created by one code-signed program (the desktop app)
  // and read by another (the CLI's Node binary) makes macOS raise a "enter your
  // login keychain password" authorization dialog. On the app+CLI-on-one-machine
  // setup this is unavoidable and reads to users as spyware. The user's most
  // valuable secret (the LLM API key) is already a 0600 plaintext file, so
  // guarding the platform key behind a popup-prone keychain was protection
  // inversion. Every major peer tool (Cherry Studio, opencode, aws/gh) keeps
  // credentials in a local config file; this adds an AES-256-GCM layer on top.
  //
  // Existing AIFIGHT_KEYCHAIN_V1 BLOBs are still READ and one-time migrated to
  // this format (decryptFromStorage stays format-driven; bridge/config.ts
  // rewrites + releases the old keychain entry on next read).
  // AIFIGHT_FORCE_FALLBACK=1 is retained and now simply matches the default.
  return encryptWithFallback(plaintext);
}

// ─── Decrypt ────────────────────────────────────────────────────────

function startsWithAsciiPrefix(blob: Buffer, prefix: string): boolean {
  const len = Buffer.byteLength(prefix, "ascii");
  if (blob.length < len) return false;
  return blob.subarray(0, len).toString("ascii") === prefix;
}

function parseKeychainUuid(blob: Buffer): string {
  const expected = KEYCHAIN_V1_PREFIX_BYTES + UUID_ASCII_BYTES;
  if (blob.length !== expected) {
    throw new CredentialsCorruptError(
      `keychain BLOB wrong length: expected ${expected} bytes, got ${blob.length}`,
    );
  }
  return blob
    .subarray(KEYCHAIN_V1_PREFIX_BYTES, expected)
    .toString("ascii");
}

function decryptKeychainBlob(blob: Buffer): string {
  const uuid = parseKeychainUuid(blob);
  let stored: string | null;
  try {
    stored = new Entry(getServiceName(), uuid).getPassword();
  } catch (e) {
    throw new CredentialsKeychainUnavailableError(
      `keychain unavailable while reading entry for ${uuid}: ${
        e instanceof Error ? e.message : String(e)
      }`,
      e,
    );
  }
  if (stored === null || stored === undefined) {
    throw new CredentialsCorruptError(
      `keychain entry missing (uuid=${uuid}); BLOB row exists but keychain has no matching row`,
    );
  }
  return stored;
}

function decryptFallbackBlob(blob: Buffer): string {
  const minLen = CRYPTO_V1_PREFIX_BYTES + SALT_BYTES + IV_BYTES + TAG_BYTES;
  if (blob.length < minLen) {
    throw new CredentialsCorruptError(
      `fallback BLOB too short: expected at least ${minLen} bytes, got ${blob.length}`,
    );
  }
  let off = CRYPTO_V1_PREFIX_BYTES;
  const salt = blob.subarray(off, off + SALT_BYTES);
  off += SALT_BYTES;
  const iv = blob.subarray(off, off + IV_BYTES);
  off += IV_BYTES;
  const tag = blob.subarray(off, off + TAG_BYTES);
  off += TAG_BYTES;
  const ct = blob.subarray(off);

  const masterKey = loadOrCreateMasterKey();
  let aesKey: Buffer;
  try {
    aesKey = scryptSync(masterKey, salt, AES_KEY_BYTES);
  } catch (e) {
    throw new CredentialsCryptoError(
      "kdf",
      `scrypt key derivation failed during decrypt: ${
        e instanceof Error ? e.message : String(e)
      }`,
      e,
    );
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", aesKey, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf8");
  } catch (e) {
    // Node throws a plain Error on tag mismatch with message
    // "Unsupported state or unable to authenticate data". Any throw
    // here means the BLOB was tampered OR the master key changed —
    // both are integrity signals per TED rev 2 §错误分支决策表.
    throw new CredentialsCorruptError(
      `AES-GCM auth tag mismatch (fallback BLOB tampered or wrong master key): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

export function decryptFromStorage(blob: Buffer): string {
  if (startsWithAsciiPrefix(blob, AIFIGHT_KEYCHAIN_V1_PREFIX)) {
    return decryptKeychainBlob(blob);
  }
  if (startsWithAsciiPrefix(blob, AIFIGHT_CRYPTO_V1_PREFIX)) {
    return decryptFallbackBlob(blob);
  }
  throw new CredentialsCorruptError(
    `unknown format version (blob does not start with a known AIFIGHT_* prefix)`,
  );
}

// ─── Delete ─────────────────────────────────────────────────────────

export function deleteFromStorage(blob: Buffer): void {
  if (startsWithAsciiPrefix(blob, AIFIGHT_KEYCHAIN_V1_PREFIX)) {
    const uuid = parseKeychainUuid(blob);
    try {
      new Entry(getServiceName(), uuid).deletePassword();
    } catch (e) {
      throw new CredentialsKeychainUnavailableError(
        `keychain unavailable while deleting entry for ${uuid}: ${
          e instanceof Error ? e.message : String(e)
        }`,
        e,
      );
    }
    return;
  }
  if (startsWithAsciiPrefix(blob, AIFIGHT_CRYPTO_V1_PREFIX)) {
    // Fallback BLOBs have no sidecar state to delete. The caller is
    // responsible for removing the agents row.
    return;
  }
  throw new CredentialsCorruptError(
    `unknown format version in deleteFromStorage`,
  );
}
