// runtime/src/account/device-id.ts
//
// Per-device identity for agent single-device binding (anti-theft). The server
// binds an agent's credential to a deviceId on first authenticated connect and
// rejects that credential presented from any other device.
//
// deviceId = sha256(deviceSecret + ":" + machineId). The secret is a random
// 32-byte value kept in a 0600 file at ~/.aifight/device.key (D1 unified
// local-file backend). A prior install that stored it in the OS keychain is
// migrated to the file ONCE, on first read. It is NEVER written into
// bridge.json, so copying the agent credential file does not carry it.
//
// The machine id (see machine-id.ts) is the second half and closes the case the
// secret alone cannot: copying the ENTIRE home directory to another laptop
// carries the secret too, and a secret-only hash would present that copy as the
// same device. Mixing in a value the OS holds rather than the directory makes
// the copy hash differently, so the server refuses it. Neither input leaves the
// machine — the server only ever sees the hash.
//
// Keeping the random per-install secret in the formula (rather than hashing the
// machine id alone) preserves the privacy property that a reinstall is a fresh,
// uncorrelatable identity.
//
// The OS keychain is only READ (once) to adopt a legacy secret, then dropped —
// never written for new secrets, so it raises no macOS authorization popup.
// isKeychainAvailable() honors AIFIGHT_FORCE_FALLBACK and the
// AIFIGHT_KEYCHAIN_SERVICE test override.

import { Entry } from "@napi-rs/keyring";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import { getBridgeConfigPath } from "../bridge/config";
import { getAifightHome } from "../store/paths";
import { AIFIGHT_RUNTIME_SERVICE, isKeychainAvailable } from "./credentials";
import { getMachineId } from "./machine-id";

const DEVICE_KEY_FILENAME = "device.key";
const DEVICE_ID_FILENAME = "device.id";
const DEVICE_KEYCHAIN_ACCOUNT = "device-secret";
const DEVICE_SECRET_BYTES = 32;
const HEX64 = /^[0-9a-f]{64}$/;

export interface DeviceIdBackendInfo {
  readonly backend: "keychain" | "file";
  /** Populated only for the file backend. */
  readonly path?: string;
}

let cachedSecret: string | null = null;
let cachedBackend: DeviceIdBackendInfo | null = null;
/** Process-local: whether we have already warned that keychain migration was
 *  deferred this run (so the note is printed at most once). */
let keychainDeferralWarned = false;

/** Test-only: clear cached secret + backend between cases. Not re-exported from index. */
export function resetDeviceIdCacheForTests(): void {
  cachedSecret = null;
  cachedBackend = null;
  keychainDeferralWarned = false;
}

function getServiceName(): string {
  const override = process.env.AIFIGHT_KEYCHAIN_SERVICE;
  return override && override.length > 0 ? override : AIFIGHT_RUNTIME_SERVICE;
}

function deviceKeyPath(): string {
  return join(getAifightHome(), DEVICE_KEY_FILENAME);
}

/** Read a valid device secret from the 0600 file, re-asserting perms. Returns
 *  undefined when the file is absent or malformed. */
function readValidSecretFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  let existing: string;
  try {
    existing = readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
  if (!HEX64.test(existing)) return undefined;
  if (process.platform !== "win32") {
    try {
      chmodSync(path, 0o600);
    } catch {
      // best effort
    }
  }
  return existing;
}

/** The outcome of committing a device secret to the 0600 file. */
interface CommittedSecret {
  /** The secret that is authoritative on disk afterwards. */
  readonly secret: string;
  /** True once we have READ that secret back out of the file — the signal that
   *  it is durably stored and safe to drop the legacy keychain copy. */
  readonly durable: boolean;
}

/**
 * Publish `candidate` to the 0600 file atomically with FIRST-WRITER-WINS
 * semantics, and report the secret that is authoritative on disk afterwards plus
 * whether it was read back (durable).
 *
 * Two independent processes can hit a fresh machine at once (the desktop app
 * auto-starts its bridge while a headless `aifight` CLI runs), each with no file
 * present. A clobbering write would let them mint two DIFFERENT secrets → the
 * deviceId flips → the server's single-device binding 403s the user's own agent.
 *
 * POSIX: write to a private tmp, fsync it, then `link()` it into place. link
 * fails EEXIST if the target already exists, so a concurrent winner's file is
 * never half-overwritten and no reader ever observes a present-but-empty
 * device.key. On Windows (hard-link semantics vary by filesystem) fall back to
 * the O_EXCL create path — still first-writer-wins, still read-back verified.
 */
function commitDeviceSecret(path: string, candidate: string): CommittedSecret {
  mkdirSync(getAifightHome(), { recursive: true });
  if (process.platform === "win32") {
    return commitViaExclusiveCreate(path, candidate);
  }
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeSecretFileDurable(tmp, candidate, "wx");
    try {
      linkSync(tmp, path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // Someone published first (or a valid file was already here). Adopt its
      // secret if valid; only replace a genuinely corrupt file — there is no
      // bound secret to lose in that case.
      const winner = readSettledSecretFile(path);
      if (winner !== undefined) return { secret: winner, durable: true };
      writeSecretFileDurable(path, candidate, "w");
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // best effort — a stray tmp file is harmless
    }
  }
  // Re-assert 0600 and read back so the caller only drops the keychain copy
  // after a verified, durable write of the secret it means to keep.
  const readBack = readValidSecretFile(path);
  if (readBack === undefined) return { secret: candidate, durable: false };
  return { secret: readBack, durable: true };
}

/** Windows fallback for commitDeviceSecret: O_EXCL create (no atomic link). */
function commitViaExclusiveCreate(path: string, candidate: string): CommittedSecret {
  try {
    // "wx" = O_WRONLY|O_CREAT|O_EXCL — create-or-fail.
    writeFileSync(path, candidate, { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const winner = readSettledSecretFile(path);
    if (winner !== undefined) return { secret: winner, durable: true };
    writeFileSync(path, candidate, { mode: 0o600 });
  }
  const readBack = readValidSecretFile(path);
  if (readBack === undefined) return { secret: candidate, durable: false };
  return { secret: readBack, durable: true };
}

/** Write `content` to `file` with the given flag ("wx" create-or-fail, or "w"
 *  truncate-in-place for a confirmed-corrupt overwrite), fsync it, then close so
 *  a crash cannot leave a torn/empty file. */
function writeSecretFileDurable(file: string, content: string, flag: "wx" | "w"): void {
  const fd = openSync(file, flag, 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    try {
      closeSync(fd);
    } catch {
      // best effort — the bytes are already fsync'd
    }
  }
}

/** Read a HEX64 secret, waiting briefly between retries to ride out the gap
 *  between a concurrent winner creating the file and its write landing. On POSIX
 *  the file is link-published complete, so this returns on the first read; the
 *  wait matters for the Windows direct-write fallback, where a loser could
 *  otherwise read a 0-byte file and replace a winner's still-landing secret. */
function readSettledSecretFile(path: string): string | undefined {
  for (let i = 0; i < 8; i++) {
    const v = readValidSecretFile(path);
    if (v !== undefined) return v;
    if (i < 7) sleepSyncMs(5);
  }
  return undefined;
}

/** Block ~ms without busy-spinning, to space out create-race settle reads.
 *  Degrades to an immediate return where SharedArrayBuffer/Atomics are absent. */
function sleepSyncMs(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Atomics.wait / SharedArrayBuffer unavailable — skip the wait.
  }
}

/** What the one-time keychain migration probe found. `unavailable` means the
 *  keychain is temporarily unreachable AND we cannot rule out a legacy secret
 *  behind it — minting now could flip the deviceId permanently, so the caller
 *  must NOT mint this run. */
type LegacySecretProbe =
  | { readonly kind: "found"; readonly secret: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unavailable" };

/**
 * One-time migration read of a legacy keychain-stored device secret, as a
 * three-way verdict (see the decision table below). The subtle case is `Deny`:
 * a macOS user who dismisses the keychain authorization dialog must NOT cause a
 * fresh secret to be minted — that would make the file win forever and 403 the
 * agent whose real secret is still sitting in the keychain. So a refusal, or an
 * unreachable keychain on an EXISTING macOS install, returns `unavailable`
 * rather than falling through to a mint.
 */
function adoptLegacyKeychainSecret(): LegacySecretProbe {
  // (1) Forced file backend: there is no keychain to consult and nothing is
  // "temporarily locked" — mint straight into the file.
  if (process.env.AIFIGHT_FORCE_FALLBACK === "1") return { kind: "absent" };

  if (isKeychainAvailable()) {
    // The keychain is reachable (the probe wrote + deleted a self-owned entry,
    // popup-free). Read the legacy device-secret entry.
    try {
      const existing = new Entry(getServiceName(), DEVICE_KEYCHAIN_ACCOUNT).getPassword();
      // (2) No legacy entry → nothing to adopt → mint.
      if (existing === null || existing === undefined) return { kind: "absent" };
      // (3) A valid legacy secret → adopt it so the deviceId stays stable.
      if (HEX64.test(existing)) return { kind: "found", secret: existing };
      // Present but malformed: not a usable secret. Mint a fresh file secret and
      // leave the junk entry as-is (deleting it is not our job here).
      return { kind: "absent" };
    } catch {
      // (4) getPassword() threw — the user clicked "Deny", or this entry's
      // ACL/lock blocks this reader. We cannot tell whether a legacy secret
      // exists, so minting could permanently flip the deviceId. Retry next run.
      return { kind: "unavailable" };
    }
  }

  // The keychain probe failed and this is NOT a forced fallback. On a machine
  // that never had a keychain device-secret this is the normal steady state
  // (Linux without a Secret Service) — mint. But on an EXISTING macOS install a
  // legacy secret may be sitting behind a currently-unreachable keychain (e.g.
  // an SSH session whose login keychain is locked); minting would flip the
  // deviceId. Use the presence of bridge.json as the "existing install, tread
  // carefully" signal.
  if (process.platform === "darwin" && existsSync(getBridgeConfigPath())) {
    return { kind: "unavailable" };
  }
  return { kind: "absent" };
}

/**
 * The raw per-device secret (64-char hex), created once then stable — OR the
 * empty string when the OS keychain is temporarily unavailable and a legacy
 * secret cannot be ruled out (migration deferred to a later run; see
 * adoptLegacyKeychainSecret). getDeviceId() maps "" to no X-Device-Id header.
 */
export function getOrCreateDeviceSecret(): string {
  if (cachedSecret !== null) return cachedSecret;
  cachedSecret = resolveDeviceSecret();
  return cachedSecret;
}

function resolveDeviceSecret(): string {
  const path = deviceKeyPath();

  // Steady state (all platforms, D1): the secret is a 0600 file. Reading it
  // never touches the OS keychain, so there is no authorization popup.
  const existing = readValidSecretFile(path);
  if (existing !== undefined) {
    cachedBackend = { backend: "file", path };
    return existing;
  }

  // No file yet. A prior macOS install kept the secret in the OS keychain;
  // consult it ONCE so the deviceId (the server's single-device binding) stays
  // stable, then stop using the keychain.
  const probe = adoptLegacyKeychainSecret();

  if (probe.kind === "unavailable") {
    // The keychain is temporarily unreachable and we cannot rule out a legacy
    // secret. Do NOT mint (that would flip the deviceId and 403 the agent) and
    // do NOT write anything. Return "" → getDeviceId() sends no X-Device-Id, the
    // server treats it as Missing (non-strict: allowed, no poison binding), and
    // the NEXT process run retries this one-time migration. The empty string is
    // cached for THIS process only (getOrCreateDeviceSecret memoizes it), so we
    // never re-raise the authorization dialog within a single run.
    cachedBackend = { backend: "file", path };
    warnKeychainDeferredOnce();
    return "";
  }

  const candidate =
    probe.kind === "found" ? probe.secret : randomBytes(DEVICE_SECRET_BYTES).toString("hex");
  const committed = commitDeviceSecret(path, candidate);
  cachedBackend = { backend: "file", path };

  // Drop the adopted keychain entry ONLY once its secret is DURABLY the one on
  // disk — never before a verified read-back, and never if we lost a create race
  // to a different secret (deleting then could orphan the sole copy of a
  // still-needed secret / flip the deviceId).
  if (probe.kind === "found" && committed.durable && committed.secret === candidate) {
    try {
      new Entry(getServiceName(), DEVICE_KEYCHAIN_ACCOUNT).deletePassword();
    } catch {
      // Orphaned entry at worst; the file copy is authoritative now.
    }
  }
  return committed.secret;
}

/** Once per process, tell the user (stderr) that device binding is deferred
 *  because the keychain was unreachable — connecting unbound this run, will
 *  retry next run. Kept to one line and out of stdout so it never corrupts
 *  --json output. */
function warnKeychainDeferredOnce(): void {
  if (keychainDeferralWarned) return;
  keychainDeferralWarned = true;
  process.stderr.write(
    "note: the OS keychain is locked/unavailable, so this machine's one-time " +
      "device-id migration is deferred; connecting unbound this run. Unlock or " +
      "allow keychain access and run the command again to finish it.\n",
  );
}

/** The device id sent to the server (X-Device-Id): sha256(secret + ":" +
 *  machineId), 64-char hex. Returns "" (→ header omitted) when EITHER input is
 *  unavailable this run — a deferred keychain migration, or a machine that will
 *  not name itself.
 *
 *  Both halves are required, and the machine half is the one that is easy to get
 *  wrong. Hashing an empty machine id would yield a perfectly well-formed
 *  fingerprint that means "I don't know which machine this is" while looking
 *  exactly like "I am certain which machine this is" — and the server, which
 *  cannot see the inputs, would trust-on-first-use bind it. The moment the read
 *  recovered, the same laptop would present a different id and be refused as a
 *  different computer. Sending nothing is honest and the server already has a
 *  meaning for it: unidentified, admitted under the lenient default, refused
 *  under strict.
 *
 *  The separator is what keeps the two inputs from running together: without it
 *  a secret ending in some prefix of the machine id would collide with another
 *  pair, and the secret is fixed-width hex so a literal ":" cannot appear in it. */
export function getDeviceId(): string {
  const secret = getOrCreateDeviceSecret();
  if (secret === "") return "";
  const machineId = getMachineId();
  if (machineId === "") return "";
  return createHash("sha256").update(`${secret}:${machineId}`).digest("hex");
}

function deviceIdPath(): string {
  return join(getAifightHome(), DEVICE_ID_FILENAME);
}

/**
 * The verdict of the local identity self-check.
 *
 *  - `ok`             this home was set up on this machine (or has just been
 *                     stamped for the first time, which every upgrade does).
 *  - `unverifiable`   nothing to compare against this run — no device secret, or
 *                     a machine that will not name itself. Never an alarm: the
 *                     degraded read is exactly what a container looks like.
 *  - `foreign`        the stamp was written by a DIFFERENT machine. Somebody
 *                     copied the home directory here.
 */
export type LocalDeviceIdentity =
  | { readonly status: "ok" }
  | { readonly status: "unverifiable" }
  | { readonly status: "foreign"; readonly stamped: string; readonly current: string };

/**
 * Compare this machine against the stamp left in the home directory, and stamp
 * it on the way past if there is none yet.
 *
 * This exists purely so a copied home fails in the first second, offline, with
 * words that say what happened — rather than connecting, getting a 403, and
 * looking like a network fault. It is NOT a security boundary: the file is the
 * user's own and trivially editable, and forging it changes nothing, because
 * the server's record is what actually decides. So a mismatch is never
 * overwritten (that would erase the only local evidence) and a missing stamp is
 * never treated as suspicious (that is just an install that predates the file).
 */
export function checkLocalDeviceIdentity(): LocalDeviceIdentity {
  const current = getDeviceId();
  // No secret this run (deferred keychain migration), or a machine that gave no
  // id: in both cases the id we would compare is not stable enough to accuse
  // anyone with. A transient failure to read the machine id must not tell a user
  // their own laptop is someone else's.
  if (current === "" || getMachineId() === "") return { status: "unverifiable" };

  const path = deviceIdPath();
  const stamped = readStampedDeviceId(path);
  if (stamped === undefined) {
    writeStampedDeviceId(path, current);
    return { status: "ok" };
  }
  if (stamped === current) return { status: "ok" };
  return { status: "foreign", stamped, current };
}

/**
 * Re-stamp the home directory with this machine's device id.
 *
 * Called after a successful pairing: the owner has just said, from the
 * Dashboard, that this machine is where the agent belongs, so the old stamp is
 * answered and this is now legitimately a local identity.
 */
export function stampLocalDeviceIdentity(): void {
  const current = getDeviceId();
  if (current === "" || getMachineId() === "") return;
  writeStampedDeviceId(deviceIdPath(), current);
}

function readStampedDeviceId(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const v = readFileSync(path, "utf8").trim();
    return HEX64.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Best effort by design: a home directory that cannot be written is a problem
 *  for the parts that store real state, not for a diagnostic stamp. Failing to
 *  write it must never keep an agent from playing. */
function writeStampedDeviceId(path: string, deviceID: string): void {
  try {
    mkdirSync(getAifightHome(), { recursive: true });
    writeFileSync(path, `${deviceID}\n`, { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } catch {
    // Diagnostics only.
  }
}

/** Which backend stored the device secret (diagnostics / `aifight status`). */
export function getDeviceIdBackend(): DeviceIdBackendInfo {
  if (cachedBackend === null) {
    getOrCreateDeviceSecret();
  }
  return cachedBackend ?? { backend: "file", path: deviceKeyPath() };
}
