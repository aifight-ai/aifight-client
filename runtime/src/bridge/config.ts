import fs from "node:fs";
import path from "node:path";

import {
  AIFIGHT_KEYCHAIN_V1_PREFIX,
  decryptFromStorage,
  deleteFromStorage,
  encryptForStorage,
} from "../account/credentials";
import { CredentialsKeychainUnavailableError } from "../account/errors";
import { ensureRuntimeHome, getRuntimeHome, safePathSegment } from "../store/paths";

export type BridgeRuntimeType = "mock" | "direct";

export class RuntimeLocalUrlError extends Error {
  override readonly name = "RuntimeLocalUrlError";
}

/** Telegram companion settings (non-secret half). Absent = the companion is
 *  not enabled on this machine, so nothing starts and nothing is polled.
 *  The bot token itself lives in the top-level `telegramBotToken` field so it
 *  rides the existing ENCRYPTED_FIELDS pipeline. */
export interface BridgeTelegramConfig {
  /** The one chat allowed to talk to this bot; set when pairing succeeds. */
  readonly chatId: number;
  /** Match-result notification granularity. */
  readonly results: "per_match" | "daily" | "both" | "off";
  /** "HH:MM" in this machine's local time. Default 22:00. */
  readonly digestAt?: string;
  readonly alerts: boolean;
  readonly challengeEvents: boolean;
  /** Two-way remote control; false = notifications only. */
  readonly control: boolean;
  /** Absent = decide from the environment (AIFIGHT_LOCALE / LC_ALL / LANG). */
  readonly locale?: "zh" | "en";
  /** Epoch ms; notifications (never alerts) stay quiet until then. */
  readonly mutedUntil?: number;
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
   * Optional pinned DECLARED MODEL — the public model label the leaderboard and
   * agent profile show for this agent. Absent/empty = not pinned: the label
   * falls back to the active agent profile's configured LLM model, then to
   * "direct" (see bridge/declared-model.ts). Trimmed, max 100 chars; written
   * via `aifight set declared-model <name>` and synced to the platform
   * (PATCH /api/agents/me/policy {"declared_model"}). PUBLIC — never put
   * anything sensitive here.
   */
  readonly declaredModel?: string;
  /**
   * How many times an unparseable/illegal model output is retried with
   * corrective feedback before falling back (§3 Phase A). Each retry is one
   * extra model call on the user's own key, so it is capped at 2. Default 1.
   */
  readonly illegalRetryCount?: number;
  readonly autoDailyLimit?: number;
  readonly autoGames?: readonly string[];
  /**
   * `aifight pause` sets this; `aifight resume` clears it. When true the
   * bridge does not join the matchmaking queue by itself — neither the
   * connect-edge auto-join nor the reconnect re-join (the runner reads this
   * flag fresh at every connect edge, so a running CLI bridge honors a pause
   * without a restart). Manual matches and challenges are unaffected.
   */
  readonly matchingPaused?: boolean;
  /**
   * CLI display language ("en" default, "zh" 中文). Display-only: the bridge
   * runner never reads it, so writes go through writeBridgeConfig with
   * preserveMtime (no spurious restart offer). Set via the menu's Language
   * item or `aifight set language <en|zh>`; AIFIGHT_LANG overrides it.
   */
  readonly locale?: "en" | "zh";
  /** Telegram bot token. Flat on purpose: ENCRYPTED_FIELDS works on top-level
   *  field names, so this gets encryption-at-rest, redaction and old-secret
   *  release for free. */
  readonly telegramBotToken?: string;
  readonly telegram?: BridgeTelegramConfig;
  readonly updatedAt: string;
}

export interface RedactedBridgeConfig
  extends Omit<BridgeConfig, "apiKey" | "runtimeLocalToken" | "claimToken" | "telegramBotToken"> {
  readonly apiKey: string;
  readonly runtimeLocalToken?: string;
  readonly claimToken?: string;
  readonly telegramBotToken?: string;
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
 *   - the ws_url MUST be wss:// unless the base host is loopback. Previously a
 *     plaintext (non-loopback) http base would accept ws:// to that public host,
 *     leaking the upgrade-header API key over the wire; now only a loopback base
 *     (dev / self-hosted on this machine) may use ws://.
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
  if (isLoopbackHost(base.hostname)) {
    return ws.protocol === "ws:" || ws.protocol === "wss:";
  }
  return ws.protocol === "wss:";
}

/**
 * F-05: the platform API key / pairing code is sent to this base URL, so a
 * plaintext-http or credentialed base would leak it. Require https: for any
 * real host; permit http: ONLY to a loopback host AND only when the explicit
 * dev escape hatch AIFIGHT_ALLOW_INSECURE_BASE_URL is set (local platform dev).
 * Rejects embedded userinfo. Returns the normalized base (origin + path, no
 * query/fragment, no trailing slash). Throws a clear, actionable error on
 * anything unsafe. Mirrors the provider-URL gate in profile/config-schema.ts.
 */
export function validatePlatformBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`AIFight base URL is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(
      "AIFight base URL must not embed credentials (user:pass@host) — the API key is sent in request headers",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`AIFight base URL must use https, got ${url.protocol}//`);
  }
  if (url.protocol === "http:") {
    const loopbackDevAllowed =
      isLoopbackHost(url.hostname) && isTruthyEnvValue(process.env.AIFIGHT_ALLOW_INSECURE_BASE_URL);
    if (!loopbackDevAllowed) {
      throw new Error(
        `AIFight base URL uses plain http, which would send your API key unencrypted to ${url.hostname}. ` +
          "Use https://. For local platform development against a loopback host, set " +
          "AIFIGHT_ALLOW_INSECURE_BASE_URL=1.",
      );
    }
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function isTruthyEnvValue(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "no";
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
 *  path segment — leaving it plaintext would void encrypting claimToken.
 *  telegramBotToken is full control of the user's own Telegram bot. */
const ENCRYPTED_FIELDS = ["apiKey", "claimToken", "claimUrl", "telegramBotToken"] as const;

function isEncryptedField(value: string): boolean {
  return value.startsWith(ENC_FIELD_PREFIX);
}

const KEYCHAIN_PREFIX_BYTES = Buffer.byteLength(AIFIGHT_KEYCHAIN_V1_PREFIX, "ascii");

/** True when an on-disk encrypted ref points at a legacy OS-keychain entry
 *  (AIFIGHT_KEYCHAIN_V1 BLOB) rather than an AES-256-GCM file BLOB — the signal
 *  to migrate it to the unified file backend on read (D1), so future reads never
 *  touch the keychain (→ no macOS authorization popup). */
function isKeychainFormatRef(value: string): boolean {
  if (!isEncryptedField(value)) return false;
  try {
    const blob = Buffer.from(value.slice(ENC_FIELD_PREFIX.length), "base64");
    return blob.subarray(0, KEYCHAIN_PREFIX_BYTES).toString("ascii") === AIFIGHT_KEYCHAIN_V1_PREFIX;
  } catch {
    return false;
  }
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
    // SECURITY (codex-security 2026-07-28): agentId comes from the pairing
    // service's response and is only validated as a string, so a hostile or
    // compromised endpoint could put traversal segments in it and steer this
    // write outside the runtime home. Same guard the session/strategy paths
    // already use — this one call site was the exception.
    const archivePath = path.join(
      getRuntimeHome(),
      `bridge.replaced-${safePathSegment(config.agentId)}.json`,
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

export interface WriteBridgeConfigOptions {
  /**
   * Restore the file's mtime to what it was before this write.
   *
   * apply-settings judges "a restart is pending" by bridge.json being newer
   * than the port file, but some writes change nothing the RUNNING bridge
   * would read differently — lazy encryption migration, dead claim-credential
   * cleanup, the Telegram companion saving a change it already applied in
   * memory. Without this, those behaviour-neutral writes still bump the mtime
   * and produce a restart prompt that does nothing.
   *
   * Concurrency: the mtime is read before the write and restored after it, so
   * another writer landing in between can have its timestamp masked (one
   * missed restart hint) or its own restore resurrected (one spurious hint).
   * Both are tolerable — the hint is advisory, never a gate.
   */
  readonly preserveMtime?: boolean;
}

export function writeBridgeConfig(config: BridgeConfig, opts: WriteBridgeConfigOptions = {}): void {
  ensureRuntimeHome();
  const filePath = getBridgeConfigPath();
  // Every encrypt mints a fresh keychain entry, so collect the previous refs
  // first and release whichever are not carried over once the new file lands
  // — otherwise each save would leak one entry.
  const staleRefs = readStoredFieldRefs(filePath);
  const previousMtime = opts.preserveMtime === true ? statMtime(filePath) : undefined;

  const onDisk: Record<string, unknown> = { ...config };
  for (const field of ENCRYPTED_FIELDS) {
    const v = onDisk[field];
    // Defensive: a value that is already an encrypted ref is carried over
    // verbatim rather than double-wrapped.
    if (typeof v === "string" && !isEncryptedField(v)) onDisk[field] = encryptField(v);
  }
  // declaredModel normalization, centralized so every writer gets the same
  // semantics: store trimmed, and strip the key entirely when the trimmed
  // value is empty (absent = not pinned — an explicit "" would be dead weight).
  if (typeof onDisk.declaredModel === "string") {
    const trimmed = onDisk.declaredModel.trim();
    if (trimmed === "") delete onDisk.declaredModel;
    else onDisk.declaredModel = trimmed;
  }
  // Per-process tmp name: two processes writing bridge.json at once (the desktop
  // bridge + the CLI, e.g. during the keychain→file migration) must not share
  // one fixed `.tmp` path and clobber each other's staging file or race the
  // rename to ENOENT. rename() is atomic, so the last writer still wins cleanly.
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(onDisk, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // best effort — never leave a half-written staging file behind
    }
    throw e;
  }
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Best effort. The runtime home itself is still narrowed to 0700.
    }
  }
  if (previousMtime !== undefined) {
    try {
      fs.utimesSync(filePath, new Date(), previousMtime);
    } catch {
      // Best effort: a fresh mtime here only means one extra restart hint.
    }
  }
  const carriedOver = new Set(
    ENCRYPTED_FIELDS.map((f) => onDisk[f]).filter((v): v is string => typeof v === "string"),
  );
  for (const ref of staleRefs) {
    if (!carriedOver.has(ref)) releaseFieldSecret(ref);
  }
}

/** The file's current mtime, or undefined when there is no file yet (a first
 *  write has no timestamp worth preserving). */
function statMtime(filePath: string): Date | undefined {
  try {
    return fs.statSync(filePath).mtime;
  } catch {
    return undefined;
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

  // R13 (2026-07-26): wrap the parse like readStoredFieldRefs does — corruption
  // is an expected state. A raw SyntaxError would otherwise reach the CLI catchall
  // with the wrong exit class, and modern V8 embeds a source excerpt near the
  // error position, which for a pre-F10 plaintext bridge.json could echo an apiKey
  // fragment to stderr. Deliberately no { cause } / parser message for that reason.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("bridge config is invalid; run `aifight connect <PAIRING_CODE>` or `aifight setup`");
  }
  // The telegram block is an optional convenience section, not part of the
  // agent's identity: a hand-edited or half-written one must never brick the
  // bridge (which is what failing isBridgeConfig would do — the runner would
  // refuse to start and even `aifight telegram uninstall` could not recover).
  // Drop it instead; the companion then reads as "not set up".
  if (parsed !== null && typeof parsed === "object" && "telegram" in parsed) {
    const record = parsed as Record<string, unknown>;
    if (record.telegram !== undefined && !isBridgeTelegramConfig(record.telegram)) {
      delete record.telegram;
    }
  }
  if (!isBridgeConfig(parsed)) {
    throw new Error("bridge config is invalid; run connect again");
  }

  const record = parsed as unknown as Record<string, unknown>;
  const decrypted: Record<string, unknown> = { ...record };
  let anyEncrypted = false;
  let anyPlaintext = false;
  let anyKeychainFormat = false;
  try {
    for (const field of ENCRYPTED_FIELDS) {
      const v = record[field];
      if (typeof v !== "string") continue;
      if (isEncryptedField(v)) {
        if (isKeychainFormatRef(v)) anyKeychainFormat = true;
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

  // F-05: reject a hand-edited / downgraded plaintext base on every read — the
  // API key is sent to this host, so a non-https base outside loopback dev is
  // unsafe. Throws with an actionable message rather than silently trusting it.
  validatePlatformBaseUrl(config.baseUrl);

  // Lazy migration to the unified file backend, on first read. Two triggers:
  //   - anyPlaintext: a pre-F10 install stored these fields unencrypted.
  //   - anyKeychainFormat: a prior install stored them as OS-keychain refs;
  //     rewriting them as AES-256-GCM file BLOBs means future reads never touch
  //     the keychain (→ no macOS authorization popup). writeBridgeConfig then
  //     releases the now-orphaned keychain entries (releaseFieldSecret).
  // Best effort — reading must keep working even when a rewrite fails, so a
  // failed migration just leaves the file as-is and the next read retries.
  // preserveMtime: the migration changes the ENCODING, not any value, so it
  // must not read as "settings changed since the bridge started".
  if (anyPlaintext || anyKeychainFormat) {
    try {
      writeBridgeConfig(config, { preserveMtime: true });
    } catch {
      // Keep the existing file; the next read retries the migration.
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
    // preserveMtime: dropping already-dead credentials changes nothing the
    // running bridge reads, so it must not look like a settings edit.
    writeBridgeConfig({ ...rest, updatedAt: new Date().toISOString() }, { preserveMtime: true });
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
    ...(config.telegramBotToken !== undefined
      ? { telegramBotToken: redactSecret(config.telegramBotToken) }
      : {}),
  };
}

function redactSecret(secret: string): string {
  // R13 (2026-07-26): only show head+tail when at least 12 chars stay hidden.
  // Token lengths are platform-chosen and validated nowhere; a short (9-16 char)
  // token previously had 50-89% of its characters preserved in redactBridgeConfig
  // output, which archiveReplacedBridgeConfig persists to disk indefinitely.
  if (secret.length < 20) return "***";
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
    // Optional convenience label: accept any string within the platform's
    // 100-char cap (trim/strip happens on write; a hand-edited longer value
    // must not brick the whole bridge config read — the platform PATCH simply
    // rejects it and the sync surfaces that as a warning).
    (v.declaredModel === undefined ||
      (typeof v.declaredModel === "string" && v.declaredModel.length <= 100)) &&
    (v.illegalRetryCount === undefined ||
      (typeof v.illegalRetryCount === "number" &&
        Number.isInteger(v.illegalRetryCount) &&
        v.illegalRetryCount >= 0 &&
        v.illegalRetryCount <= 2)) &&
    (v.autoDailyLimit === undefined || (typeof v.autoDailyLimit === "number" && Number.isInteger(v.autoDailyLimit) && v.autoDailyLimit >= 0)) &&
    (v.autoGames === undefined || (Array.isArray(v.autoGames) && v.autoGames.every((g) => typeof g === "string"))) &&
    (v.matchingPaused === undefined || typeof v.matchingPaused === "boolean") &&
    (v.locale === undefined || v.locale === "en" || v.locale === "zh") &&
    // On disk this is the "enc:" reference, in memory the plaintext token —
    // both are strings, so one check covers pre- and post-decrypt validation.
    (v.telegramBotToken === undefined || typeof v.telegramBotToken === "string") &&
    (v.telegram === undefined || isBridgeTelegramConfig(v.telegram))
  );
}

/** Shape check for the optional telegram settings block. Exported so the
 *  companion and the CLI validate one definition instead of three. */
export function isBridgeTelegramConfig(value: unknown): value is BridgeTelegramConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.chatId === "number" &&
    Number.isInteger(t.chatId) &&
    (t.results === "per_match" || t.results === "daily" || t.results === "both" || t.results === "off") &&
    (t.digestAt === undefined || (typeof t.digestAt === "string" && isDigestTime(t.digestAt))) &&
    typeof t.alerts === "boolean" &&
    typeof t.challengeEvents === "boolean" &&
    typeof t.control === "boolean" &&
    (t.locale === undefined || t.locale === "zh" || t.locale === "en") &&
    (t.mutedUntil === undefined ||
      (typeof t.mutedUntil === "number" && Number.isFinite(t.mutedUntil) && t.mutedUntil >= 0))
  );
}

/** "HH:MM" on a 24-hour clock. */
export function isDigestTime(raw: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(raw);
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
