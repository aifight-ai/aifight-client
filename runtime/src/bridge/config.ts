import fs from "node:fs";
import path from "node:path";

import {
  decryptFromStorage,
  deleteFromStorage,
  encryptForStorage,
} from "../account/credentials";
import { CredentialsKeychainUnavailableError } from "../account/errors";
import { ensureRuntimeHome, getRuntimeHome } from "../store/paths";

export type BridgeRuntimeType = "mock" | "direct";

export class RuntimeLocalUrlError extends Error {
  override readonly name = "RuntimeLocalUrlError";
}

export interface BridgeConfig {
  readonly version: 1;
  readonly baseUrl: string;
  readonly wsUrl: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly suggestedName?: string;
  readonly apiKey: string;
  readonly claimUrl?: string;
  readonly claimToken?: string;
  readonly runtimeType: BridgeRuntimeType;
  readonly runtimeLocalUrl: string;
  readonly runtimeLocalToken?: string;
  readonly runtimeModel?: string;
  /** For runtimeType "direct": which agent profile (<aifight-home>/agents/<slug>) drives decisions. Defaults to "default". */
  readonly directAgentSlug?: string;
  /**
   * How many times an unparseable/illegal model output is retried with
   * corrective feedback before falling back (§3 Phase A). Each retry is one
   * extra model call on the user's own key, so it is capped at 2. Default 1.
   */
  readonly illegalRetryCount?: number;
  readonly autoDailyLimit?: number;
  readonly autoGames?: readonly string[];
  readonly updatedAt: string;
}

export interface RedactedBridgeConfig extends Omit<BridgeConfig, "apiKey" | "runtimeLocalToken" | "claimToken"> {
  readonly apiKey: string;
  readonly runtimeLocalToken?: string;
  readonly claimToken?: string;
}

export function defaultRuntimeLocalUrl(runtimeType: BridgeRuntimeType): string {
  switch (runtimeType) {
    case "mock":
      return "mock://local";
    case "direct":
      return "direct://local";
  }
}

export function normalizeRuntimeLocalUrl(raw: string, runtimeType: BridgeRuntimeType): string {
  const value = raw.trim();
  if (runtimeType === "mock" && value === "mock://local") return value;
  if (runtimeType === "direct" && value === "direct://local") return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RuntimeLocalUrlError("runtime URL must be a valid localhost HTTP URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RuntimeLocalUrlError("runtime URL must use http:// or https://");
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new RuntimeLocalUrlError("runtime URL must point to localhost, 127.0.0.1, or [::1]");
  }
  if (url.username !== "" || url.password !== "") {
    throw new RuntimeLocalUrlError("runtime URL must not include credentials");
  }
  if ((url.pathname !== "" && url.pathname !== "/") || url.search !== "" || url.hash !== "") {
    throw new RuntimeLocalUrlError("runtime URL must be a base URL without path, query, or fragment");
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

/**
 * wsUrlIsValid checks a server-supplied (or on-disk) WebSocket URL against the
 * platform base URL. The agent API key travels in the WS upgrade header, so an
 * attacker-controlled or downgraded ws_url would leak it and turn the bridge
 * into a client for an arbitrary host. Rules:
 *   - must parse as a URL with no embedded credentials
 *   - hostname must equal the base URL's hostname (no redirect to another host)
 *   - if the base URL is https (production), the ws_url MUST be wss:// — no
 *     plaintext downgrade. Over http (dev / self-hosted loopback) ws:// or
 *     wss:// is allowed.
 */
export function wsUrlIsValid(rawWsUrl: string, baseUrl: string): boolean {
  let ws: URL;
  let base: URL;
  try {
    ws = new URL(rawWsUrl);
    base = new URL(baseUrl);
  } catch {
    return false;
  }
  if (ws.username !== "" || ws.password !== "") return false;
  if (ws.hostname !== base.hostname) return false;
  if (base.protocol === "https:") {
    return ws.protocol === "wss:";
  }
  return ws.protocol === "ws:" || ws.protocol === "wss:";
}

export function defaultRuntimeModel(runtimeType: BridgeRuntimeType): string {
  switch (runtimeType) {
    case "mock":
      return "mock";
    case "direct":
      return "direct";
  }
}

export function getBridgeConfigPath(): string {
  return path.join(getRuntimeHome(), "bridge.json");
}

// ─── F10/AIF-04: credentials never live in bridge.json in plaintext ──
//
// The platform API key and claim token are encrypted at the read/write
// boundary of this module: on disk they are "enc:" + base64(BLOB), where the
// BLOB comes from account/credentials.ts (OS-keychain reference on
// macOS/Windows/Linux-with-secret-service, AES-256-GCM ciphertext under
// ~/.aifight/runtime/master.key otherwise). Everything above this module —
// runner, CLI commands, desktop host — keeps receiving plaintext in memory,
// so no consumer changes. Pre-F10 plaintext files migrate lazily on first
// read.

/** On-disk marker for an encrypted credential field. */
const ENC_FIELD_PREFIX = "enc:";

/** The credential fields of bridge.json that are encrypted at rest.
 *  claimUrl is included because the claim token is embedded in its last
 *  path segment — leaving it plaintext would void encrypting claimToken. */
const ENCRYPTED_FIELDS = ["apiKey", "claimToken", "claimUrl"] as const;

function isEncryptedField(value: string): boolean {
  return value.startsWith(ENC_FIELD_PREFIX);
}

function encryptField(plaintext: string): string {
  return ENC_FIELD_PREFIX + encryptForStorage(plaintext).toString("base64");
}

function decryptField(value: string): string {
  return decryptFromStorage(Buffer.from(value.slice(ENC_FIELD_PREFIX.length), "base64"));
}

/** Release the keychain entry behind an encrypted ref. Best effort: a
 *  locked/absent keychain must never block a config rewrite or removal. */
function releaseFieldSecret(value: string): void {
  if (!isEncryptedField(value)) return;
  try {
    deleteFromStorage(Buffer.from(value.slice(ENC_FIELD_PREFIX.length), "base64"));
  } catch {
    // Orphaned entry at worst; the file-side reference is already gone.
  }
}

/** Read the on-disk encrypted refs without validating or decrypting —
 *  used to release old keychain entries on rewrite/removal. */
function readStoredFieldRefs(filePath: string): string[] {
  try {
    const prev = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const refs: string[] = [];
    for (const field of ENCRYPTED_FIELDS) {
      const v = prev[field];
      if (typeof v === "string" && isEncryptedField(v)) refs.push(v);
    }
    return refs;
  } catch {
    return []; // no previous file, or unparseable — nothing to release
  }
}

export function removeBridgeConfig(): void {
  const filePath = getBridgeConfigPath();
  for (const ref of readStoredFieldRefs(filePath)) releaseFieldSecret(ref);
  fs.rmSync(filePath, { force: true });
}

/** Archive a redacted snapshot of the active bridge.json before a re-register
 *  replaces it (aifight setup --replace), so the prior agent's identity record
 *  (id / name / host — secrets redacted) is preserved on disk. Local sessions
 *  (runtime/agents/<id>/) and the shared agents/<slug> LLM config are NOT
 *  touched by re-registration; this just keeps a record of the old pointer.
 *  Best-effort: returns the archive path, or null if it could not be written
 *  (must never block the re-register). */
export function archiveReplacedBridgeConfig(config: BridgeConfig): string | null {
  try {
    ensureRuntimeHome();
    const archivePath = path.join(
      getRuntimeHome(),
      `bridge.replaced-${config.agentId}.json`,
    );
    const snapshot = {
      ...redactBridgeConfig(config),
      replacedAt: new Date().toISOString(),
    };
    fs.writeFileSync(archivePath, JSON.stringify(snapshot, null, 2) + "\n", {
      mode: 0o600,
    });
    return archivePath;
  } catch {
    return null;
  }
}

export function writeBridgeConfig(config: BridgeConfig): void {
  ensureRuntimeHome();
  const filePath = getBridgeConfigPath();
  // Every encrypt mints a fresh keychain entry, so collect the previous refs
  // first and release whichever are not carried over once the new file lands
  // — otherwise each save would leak one entry.
  const staleRefs = readStoredFieldRefs(filePath);

  const onDisk: Record<string, unknown> = { ...config };
  for (const field of ENCRYPTED_FIELDS) {
    const v = onDisk[field];
    // Defensive: a value that is already an encrypted ref is carried over
    // verbatim rather than double-wrapped.
    if (typeof v === "string" && !isEncryptedField(v)) onDisk[field] = encryptField(v);
  }
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(onDisk, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Best effort. The runtime home itself is still narrowed to 0700.
    }
  }
  const carriedOver = new Set(
    ENCRYPTED_FIELDS.map((f) => onDisk[f]).filter((v): v is string => typeof v === "string"),
  );
  for (const ref of staleRefs) {
    if (!carriedOver.has(ref)) releaseFieldSecret(ref);
  }
}

export function readBridgeConfig(): BridgeConfig {
  const filePath = getBridgeConfigPath();
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error("bridge is not configured; run `aifight setup` for a new agent or `aifight connect <PAIRING_CODE>` for an existing agent");
    }
    throw cause;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!isBridgeConfig(parsed)) {
    throw new Error("bridge config is invalid; run connect again");
  }

  const record = parsed as unknown as Record<string, unknown>;
  const decrypted: Record<string, unknown> = { ...record };
  let anyEncrypted = false;
  let anyPlaintext = false;
  try {
    for (const field of ENCRYPTED_FIELDS) {
      const v = record[field];
      if (typeof v !== "string") continue;
      if (isEncryptedField(v)) {
        decrypted[field] = decryptField(v);
        anyEncrypted = true;
      } else {
        anyPlaintext = true;
      }
    }
  } catch (cause) {
    if (cause instanceof CredentialsKeychainUnavailableError) {
      throw new Error(
        "bridge credentials are stored in the OS keychain, which is currently unavailable; unlock the keychain (or log in to your desktop session) and retry",
        { cause },
      );
    }
    throw new Error(
      "stored bridge credentials are unreadable on this machine; run `aifight connect <PAIRING_CODE>` or `aifight setup` to re-link the agent",
      { cause },
    );
  }
  const config = (anyEncrypted ? decrypted : record) as unknown as BridgeConfig;

  // Lazy migration: a pre-F10 install stored these fields in plaintext.
  // Re-write encrypted on first read; best effort — reading must keep
  // working even when the keychain refuses, so a failed migration just
  // leaves the file as-is (the pre-F10 status quo).
  if (anyPlaintext) {
    try {
      writeBridgeConfig(config);
    } catch {
      // Keep the plaintext file; the next read retries.
    }
  }

  return config;
}

/**
 * F10: the claim handshake artifacts (claimToken + the tokenized claimUrl)
 * are single-purpose credentials. Once the platform reports the agent as
 * claimed they are dead weight — drop them from disk and release the
 * keychain entry instead of retaining them indefinitely. Best-effort and
 * idempotent; call whenever a client observes is_claimed=true.
 */
export function dropClaimCredentialsAfterClaim(): void {
  let config: BridgeConfig;
  try {
    config = readBridgeConfig();
  } catch {
    return;
  }
  if (config.claimToken === undefined && config.claimUrl === undefined) return;
  const { claimToken: _claimToken, claimUrl: _claimUrl, ...rest } = config;
  try {
    writeBridgeConfig({ ...rest, updatedAt: new Date().toISOString() });
  } catch {
    // Keep the old file; a later observation retries.
  }
}

export function redactBridgeConfig(config: BridgeConfig): RedactedBridgeConfig {
  return {
    ...config,
    apiKey: redactSecret(config.apiKey),
    ...(config.claimUrl !== undefined
      ? { claimUrl: redactClaimUrl(config.claimUrl) }
      : {}),
    ...(config.claimToken !== undefined
      ? { claimToken: redactSecret(config.claimToken) }
      : {}),
    ...(config.runtimeLocalToken !== undefined
      ? { runtimeLocalToken: redactSecret(config.runtimeLocalToken) }
      : {}),
  };
}

function redactSecret(secret: string): string {
  if (secret.length <= 8) return "***";
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function redactClaimUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const parts = url.pathname.split("/");
    const last = parts.at(-1);
    if (last && last.length > 0) {
      parts[parts.length - 1] = "<redacted>";
      url.pathname = parts.join("/");
    }
    return url.toString();
  } catch {
    return "<redacted>";
  }
}

function isBridgeConfig(value: unknown): value is BridgeConfig {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    typeof v.baseUrl === "string" &&
    typeof v.wsUrl === "string" &&
    wsUrlIsValid(v.wsUrl as string, v.baseUrl as string) &&
    typeof v.agentId === "string" &&
    typeof v.agentName === "string" &&
    (v.suggestedName === undefined || typeof v.suggestedName === "string") &&
    typeof v.apiKey === "string" &&
    (v.claimUrl === undefined || typeof v.claimUrl === "string") &&
    (v.claimToken === undefined || typeof v.claimToken === "string") &&
    (v.runtimeType === "mock" || v.runtimeType === "direct") &&
    typeof v.runtimeLocalUrl === "string" &&
    isAllowedRuntimeLocalUrl(v.runtimeLocalUrl, v.runtimeType) &&
    typeof v.updatedAt === "string" &&
    (v.runtimeLocalToken === undefined || typeof v.runtimeLocalToken === "string") &&
    (v.runtimeModel === undefined || typeof v.runtimeModel === "string") &&
    (v.directAgentSlug === undefined || typeof v.directAgentSlug === "string") &&
    (v.illegalRetryCount === undefined ||
      (typeof v.illegalRetryCount === "number" &&
        Number.isInteger(v.illegalRetryCount) &&
        v.illegalRetryCount >= 0 &&
        v.illegalRetryCount <= 2)) &&
    (v.autoDailyLimit === undefined || (typeof v.autoDailyLimit === "number" && Number.isInteger(v.autoDailyLimit) && v.autoDailyLimit >= 0)) &&
    (v.autoGames === undefined || (Array.isArray(v.autoGames) && v.autoGames.every((g) => typeof g === "string")))
  );
}

function isAllowedRuntimeLocalUrl(raw: string, runtimeType: unknown): boolean {
  if (runtimeType !== "mock" && runtimeType !== "direct") return false;
  try {
    normalizeRuntimeLocalUrl(raw, runtimeType);
    return true;
  } catch {
    return false;
  }
}

function isLoopbackHost(raw: string): boolean {
  const host = raw.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}
