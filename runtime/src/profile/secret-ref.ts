// SecretRef resolver — resolves API key references without storing
// raw secrets in config files. Supports env, env_file, and file
// backends (P0). Keychain and command backends are P1/P2.
//
// Security contract:
// - Never return secrets in error messages
// - Never log resolved secret values
// - File secrets must be chmod 0600
// - env_file paths must be explicitly configured

import { readFile, lstat, writeFile, mkdir, chmod } from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";

// ─── Types ──────────────────────────────────────────────────────────

export type SecretRef =
  | { readonly type: "env"; readonly name: string }
  | { readonly type: "env_file"; readonly path: string; readonly name: string }
  | { readonly type: "file"; readonly path: string }
  | {
      readonly type: "keychain";
      readonly service: string;
      readonly account: string;
    }
  | {
      readonly type: "command";
      readonly command: string;
      readonly args?: readonly string[];
      readonly timeoutMs?: number;
    };

export type SecretRefP0 = Extract<SecretRef, { type: "env" | "env_file" | "file" }>;

export interface SecretStatus {
  readonly ref: SecretRef;
  readonly available: boolean;
  readonly sourceDescription: string; // e.g. "env:ANTHROPIC_API_KEY" — never the value
}

export class SecretResolutionError extends Error {
  override readonly name = "SecretResolutionError";
  readonly refType: string;
  constructor(refType: string, message: string) {
    super(message);
    this.refType = refType;
  }
}

// ─── Resolve ────────────────────────────────────────────────────────

/**
 * Resolve a SecretRef to its string value.
 * Throws SecretResolutionError if the secret cannot be found.
 * Never includes the secret value in error messages.
 */
export async function resolveSecret(ref: SecretRef): Promise<string> {
  switch (ref.type) {
    case "env":
      return resolveEnv(ref.name);
    case "env_file":
      return resolveEnvFile(ref.path, ref.name);
    case "file":
      return resolveFile(ref.path);
    case "keychain":
      throw new SecretResolutionError(
        "keychain",
        "Keychain secret provider is not yet implemented (P1 roadmap)",
      );
    case "command":
      throw new SecretResolutionError(
        "command",
        "Command secret provider is not yet implemented (P1 roadmap)",
      );
  }
}

function resolveEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new SecretResolutionError(
      "env",
      `Environment variable ${name} is not set or empty`,
    );
  }
  return value.trim();
}

async function resolveEnvFile(filePath: string, name: string): Promise<string> {
  const resolved = expandHome(filePath);
  await assertSecretFileSecure(resolved, filePath, "env_file");
  let content: string;
  try {
    content = await readFile(resolved, "utf-8");
  } catch (cause) {
    throw new SecretResolutionError(
      "env_file",
      `Cannot read env file at ${filePath}: ${describeError(cause)}`,
    );
  }

  // Parse .env format: KEY=VALUE, one per line, # comments, empty lines
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (key !== name) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value.length === 0) {
      throw new SecretResolutionError(
        "env_file",
        `Variable ${name} found in ${filePath} but value is empty`,
      );
    }
    return value;
  }

  throw new SecretResolutionError(
    "env_file",
    `Variable ${name} not found in ${filePath}`,
  );
}

async function resolveFile(filePath: string): Promise<string> {
  const resolved = expandHome(filePath);
  await assertSecretFileSecure(resolved, filePath, "file");
  let content: string;
  try {
    content = await readFile(resolved, "utf-8");
  } catch (cause) {
    throw new SecretResolutionError(
      "file",
      `Cannot read secret file at ${filePath}: ${describeError(cause)}`,
    );
  }
  const value = content.trim();
  if (value.length === 0) {
    throw new SecretResolutionError("file", `Secret file at ${filePath} is empty`);
  }
  return value;
}

// ─── Check status (without revealing values) ────────────────────────

/**
 * Check whether a SecretRef can be resolved, without returning the value.
 */
export async function checkSecretStatus(ref: SecretRef): Promise<SecretStatus> {
  const sourceDescription = describeRef(ref);
  try {
    await resolveSecret(ref);
    return { ref, available: true, sourceDescription };
  } catch {
    return { ref, available: false, sourceDescription };
  }
}

/**
 * Human-readable description of a SecretRef (never includes the value).
 */
export function describeRef(ref: SecretRef): string {
  switch (ref.type) {
    case "env":
      return `env:${ref.name}`;
    case "env_file":
      return `env_file:${ref.path}:${ref.name}`;
    case "file":
      return `file:${ref.path}`;
    case "keychain":
      return `keychain:${ref.service}/${ref.account}`;
    case "command":
      return `command:${ref.command}`;
  }
}

// ─── Store secret to file (for `aifight secret set`) ────────────────

/**
 * Store a secret value to a file with chmod 0600.
 * Creates parent directories if needed.
 */
export async function storeSecretFile(
  filePath: string,
  value: string,
): Promise<void> {
  const resolved = expandHome(filePath);
  await mkdir(dirname(resolved), { recursive: true, mode: 0o700 });
  await writeFile(resolved, value + "\n", { mode: 0o600 });
  // Ensure permissions even if file already existed
  await chmod(resolved, 0o600);
}

/**
 * Fail-closed permission/type gate for file-backed secrets (`file` and
 * `env_file`). Applied BEFORE reading so a world/group-readable key, a symlink,
 * a non-regular file (fifo/device/dir), or a file owned by another user is
 * never opened. Called from resolveFile and resolveEnvFile.
 *
 * POSIX: rejects any file with group/other permission bits set (mode & 0o077),
 * and — best effort where process.getuid exists — any file not owned by the
 * current uid. Windows: NTFS ACLs differ, so the mode/uid checks are skipped,
 * but symlinks and non-regular files are still rejected. Uses lstat (no-follow)
 * so a symlink is caught rather than transparently followed.
 */
async function assertSecretFileSecure(
  resolvedPath: string,
  displayPath: string,
  refType: "file" | "env_file",
): Promise<void> {
  let st: Stats;
  try {
    st = await lstat(resolvedPath);
  } catch (cause) {
    throw new SecretResolutionError(
      refType,
      `Cannot access secret file at ${displayPath}: ${describeError(cause)}`,
    );
  }

  if (st.isSymbolicLink()) {
    throw new SecretResolutionError(
      refType,
      `Refusing to read a secret from a symlink at ${displayPath}; ` +
        `point the reference at a real, private file (chmod 600).`,
    );
  }
  if (!st.isFile()) {
    throw new SecretResolutionError(
      refType,
      `Secret path at ${displayPath} is not a regular file; ` +
        `use a private file (chmod 600).`,
    );
  }

  // On Windows the POSIX mode/owner bits are not meaningful (access is governed
  // by NTFS ACLs), so we stop after the symlink/regular-file checks above.
  if (process.platform === "win32") return;

  if ((st.mode & 0o077) !== 0) {
    const mode = (st.mode & 0o777).toString(8).padStart(3, "0");
    throw new SecretResolutionError(
      refType,
      `Secret file at ${displayPath} has insecure permissions ${mode} ` +
        `(group/other can read it); run: chmod 600 ${displayPath}`,
    );
  }

  const getuid = typeof process.getuid === "function" ? process.getuid.bind(process) : undefined;
  if (getuid && st.uid !== getuid()) {
    throw new SecretResolutionError(
      refType,
      `Secret file at ${displayPath} is not owned by the current user; ` +
        `move it to a private file you own (chmod 600).`,
    );
  }
}

// ─── Environment detection ──────────────────────────────────────────

/** Well-known LLM API key environment variable names. */
export const KNOWN_LLM_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "GEMINI_API_KEY",
] as const;

export interface DetectedEnvKey {
  readonly name: string;
  readonly present: boolean;
  readonly provider: string;
}

/**
 * Detect which well-known LLM API key env vars are set in the
 * daemon's process environment. Returns variable names and provider
 * hints, NEVER values.
 */
export function detectLLMEnvironment(): DetectedEnvKey[] {
  const providerMap: Record<string, string> = {
    ANTHROPIC_API_KEY: "anthropic",
    OPENAI_API_KEY: "openai",
    DEEPSEEK_API_KEY: "deepseek",
    GEMINI_API_KEY: "google",
  };

  return KNOWN_LLM_ENV_VARS.map((name) => ({
    name,
    present: !!(process.env[name] && process.env[name]!.trim().length > 0),
    provider: providerMap[name] ?? "unknown",
  }));
}

// ─── Validation ─────────────────────────────────────────────────────

/**
 * Validate a SecretRef shape. Does NOT check if the secret exists.
 */
export function validateSecretRef(
  raw: unknown,
): { ok: true; ref: SecretRef } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "SecretRef must be an object" };
  }
  const obj = raw as Record<string, unknown>;
  const type = obj.type;

  if (type === "env") {
    if (typeof obj.name !== "string" || !obj.name) {
      return { ok: false, error: "env SecretRef requires non-empty 'name'" };
    }
    return { ok: true, ref: { type: "env", name: obj.name } };
  }

  if (type === "env_file") {
    if (typeof obj.path !== "string" || !obj.path) {
      return { ok: false, error: "env_file SecretRef requires non-empty 'path'" };
    }
    if (typeof obj.name !== "string" || !obj.name) {
      return { ok: false, error: "env_file SecretRef requires non-empty 'name'" };
    }
    return { ok: true, ref: { type: "env_file", path: obj.path, name: obj.name } };
  }

  if (type === "file") {
    if (typeof obj.path !== "string" || !obj.path) {
      return { ok: false, error: "file SecretRef requires non-empty 'path'" };
    }
    return { ok: true, ref: { type: "file", path: obj.path } };
  }

  if (type === "keychain" || type === "command") {
    // F23/AIF-08: typed for the P1 roadmap but not implemented in
    // resolveSecret — reject at validation time so a config that can never
    // resolve a key fails loud and early, not mid-match.
    return {
      ok: false,
      error: `SecretRef type "${type}" is not implemented yet — use env, env_file, or file`,
    };
  }

  return {
    ok: false,
    error: `Unknown SecretRef type: ${String(type)}. Supported: env, env_file, file`,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return p.replace("~", homedir());
  }
  return p;
}

function describeError(cause: unknown): string {
  if (cause instanceof Error) {
    if ("code" in cause && typeof cause.code === "string") {
      return cause.code;
    }
    return cause.message;
  }
  return String(cause);
}
