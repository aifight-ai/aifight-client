// runtime/src/account/device-id.ts
//
// Per-device identity for agent single-device binding (anti-theft). The server
// binds an agent's credential to a deviceId on first authenticated connect and
// rejects that credential presented from any other device.
//
// deviceId = sha256(deviceSecret). The secret is a random 32-byte value kept in
// the OS keychain (primary) or, when no keychain is available, a 0600 file at
// ~/.aifight/device.key. It is NEVER written into bridge.json, so copying the
// agent credential file — or even all of ~/.aifight/runtime — does not carry the
// secret to another machine; a copied credential presented elsewhere yields a
// different (or no) deviceId and is rejected by the server.
//
// Reuses the keychain backend selection proven in credentials.ts
// (isKeychainAvailable honors AIFIGHT_FORCE_FALLBACK and the
// AIFIGHT_KEYCHAIN_SERVICE test override).

import { Entry } from "@napi-rs/keyring";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getAifightHome } from "../store/paths";
import { AIFIGHT_RUNTIME_SERVICE, isKeychainAvailable } from "./credentials";

const DEVICE_KEY_FILENAME = "device.key";
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

/** Test-only: clear cached secret + backend between cases. Not re-exported from index. */
export function resetDeviceIdCacheForTests(): void {
  cachedSecret = null;
  cachedBackend = null;
}

function getServiceName(): string {
  const override = process.env.AIFIGHT_KEYCHAIN_SERVICE;
  return override && override.length > 0 ? override : AIFIGHT_RUNTIME_SERVICE;
}

function deviceKeyPath(): string {
  return join(getAifightHome(), DEVICE_KEY_FILENAME);
}

function loadOrCreateFromFile(): string {
  const path = deviceKeyPath();
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (HEX64.test(existing)) {
      if (process.platform !== "win32") {
        try {
          chmodSync(path, 0o600);
        } catch {
          // best effort
        }
      }
      cachedBackend = { backend: "file", path };
      return existing;
    }
    // Malformed file → regenerate below.
  }
  const secret = randomBytes(DEVICE_SECRET_BYTES).toString("hex");
  mkdirSync(getAifightHome(), { recursive: true });
  writeFileSync(path, secret, { mode: 0o600 });
  if (process.platform !== "win32") {
    try {
      chmodSync(path, 0o600);
    } catch {
      // best effort
    }
  }
  cachedBackend = { backend: "file", path };
  return secret;
}

function loadOrCreateFromKeychain(): string {
  const entry = new Entry(getServiceName(), DEVICE_KEYCHAIN_ACCOUNT);
  const existing = entry.getPassword();
  if (existing !== null && existing !== undefined && HEX64.test(existing)) {
    cachedBackend = { backend: "keychain" };
    return existing;
  }
  const secret = randomBytes(DEVICE_SECRET_BYTES).toString("hex");
  entry.setPassword(secret);
  cachedBackend = { backend: "keychain" };
  return secret;
}

/** The raw per-device secret (64-char hex). Created once, then stable. */
export function getOrCreateDeviceSecret(): string {
  if (cachedSecret !== null) return cachedSecret;
  // isKeychainAvailable() already honors AIFIGHT_FORCE_FALLBACK=1 (→ false).
  if (isKeychainAvailable()) {
    try {
      cachedSecret = loadOrCreateFromKeychain();
      return cachedSecret;
    } catch {
      // Keychain hiccup at read/write time — fall through to the file backend.
    }
  }
  cachedSecret = loadOrCreateFromFile();
  return cachedSecret;
}

/** The device id sent to the server (X-Device-Id): sha256(secret), 64-char hex. */
export function getDeviceId(): string {
  return createHash("sha256").update(getOrCreateDeviceSecret()).digest("hex");
}

/** Which backend stored the device secret (diagnostics / `aifight status`). */
export function getDeviceIdBackend(): DeviceIdBackendInfo {
  if (cachedBackend === null) {
    getOrCreateDeviceSecret();
  }
  return cachedBackend ?? { backend: "file", path: deviceKeyPath() };
}
