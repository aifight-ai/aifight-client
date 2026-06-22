// runtime/src/profile/identity-schema.ts
//
// TypeScript schema and validator for the AIFight daemon's identity.json file.
// Holds platform identity info (agent ID, environment, public slug) and auth
// references. NO raw secrets — only SecretRef pointers.
//
// Self-contained: no imports from other project files.

// ---------------------------------------------------------------------------
// SecretRef — pointer to a credential, never the credential itself
// ---------------------------------------------------------------------------

export type SecretRef =
  | { type: "env"; name: string }
  | { type: "env_file"; path: string; name: string }
  | { type: "file"; path: string }
  | { type: "keychain"; service: string; account: string }
  | { type: "command"; command: string; args?: string[]; timeoutMs?: number };

// ---------------------------------------------------------------------------
// Constituent types
// ---------------------------------------------------------------------------

export type PlatformEnvironment = "local" | "beta" | "prod";

export type HostType =
  | "openclaw"
  | "hermes"
  | "claude_desktop"
  | "qclaw"
  | "cowork"
  | "cli"
  | "other";

export interface HostInfo {
  /** Which runtime is hosting this daemon. */
  type: HostType;
  /** Human-readable label for display (e.g. "OpenClaw local"). */
  label?: string;
  /** Which plugin or tool created this identity file. */
  createdBy?: string;
}

export interface PlatformInfo {
  /** Target AIFight environment. */
  environment: PlatformEnvironment;
  /** Base URL of the AIFight API (e.g. "https://beta.aifight.ai"). */
  baseURL: string;
  /** Owner account ID on the AIFight platform (e.g. "owner_..."). */
  ownerId: string;
  /** Agent ID on the AIFight platform (e.g. "agt_..."). */
  agentId: string;
  /** Public URL slug for this agent (e.g. "roy-openclaw-lobster"). */
  publicSlug: string;
  /** Rating system in use. */
  ratingSystem: "glicko2" | string;
}

export interface AuthInfo {
  /** SecretRef pointing to the agent API key. */
  agentApiKeyRef: SecretRef;
}

export interface RuntimeMeta {
  /** Schema version for forward-compat checks. Must equal schemaVersion at the top level. */
  profileVersion: number;
  /** ISO 8601 timestamp when this profile was first created. */
  createdAt: string;
  /** ISO 8601 timestamp when this profile was last updated. */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Top-level identity document
// ---------------------------------------------------------------------------

export interface AgentIdentity {
  /** Integer schema version — bump when breaking changes are made. */
  schemaVersion: number;
  /** URL-safe slug identifying this agent (e.g. "roy-openclaw-lobster"). */
  agentSlug: string;
  /** Human-readable display name (e.g. "Roy's OpenClaw Lobster"). */
  displayName?: string;
  host: HostInfo;
  platform: PlatformInfo;
  auth: AuthInfo;
  runtime: RuntimeMeta;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_HOST_TYPES: readonly HostType[] = [
  "openclaw",
  "hermes",
  "claude_desktop",
  "qclaw",
  "cowork",
  "cli",
  "other",
];

const VALID_ENVIRONMENTS: readonly PlatformEnvironment[] = [
  "local",
  "beta",
  "prod",
];

const VALID_SECRET_REF_TYPES = ["env", "env_file", "file", "keychain", "command"] as const;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isIsoTimestamp(v: unknown): boolean {
  if (typeof v !== "string") return false;
  return !isNaN(Date.parse(v));
}

function validateSecretRef(ref: unknown, path: string, errors: string[]): void {
  if (typeof ref !== "object" || ref === null) {
    errors.push(`${path}: must be an object`);
    return;
  }
  const r = ref as Record<string, unknown>;
  if (!VALID_SECRET_REF_TYPES.includes(r.type as typeof VALID_SECRET_REF_TYPES[number])) {
    errors.push(`${path}.type: must be one of ${VALID_SECRET_REF_TYPES.join(", ")}`);
    return;
  }
  switch (r.type) {
    case "env":
      if (!isNonEmptyString(r.name)) errors.push(`${path}.name: required non-empty string`);
      break;
    case "env_file":
      if (!isNonEmptyString(r.path)) errors.push(`${path}.path: required non-empty string`);
      if (!isNonEmptyString(r.name)) errors.push(`${path}.name: required non-empty string`);
      break;
    case "file":
      if (!isNonEmptyString(r.path)) errors.push(`${path}.path: required non-empty string`);
      break;
    case "keychain":
      if (!isNonEmptyString(r.service)) errors.push(`${path}.service: required non-empty string`);
      if (!isNonEmptyString(r.account)) errors.push(`${path}.account: required non-empty string`);
      break;
    case "command":
      if (!isNonEmptyString(r.command)) errors.push(`${path}.command: required non-empty string`);
      if (r.args !== undefined && !Array.isArray(r.args)) {
        errors.push(`${path}.args: must be an array if provided`);
      }
      if (r.timeoutMs !== undefined && typeof r.timeoutMs !== "number") {
        errors.push(`${path}.timeoutMs: must be a number if provided`);
      }
      break;
  }
}

// ---------------------------------------------------------------------------
// Public validator
// ---------------------------------------------------------------------------

export function validateIdentity(
  raw: unknown,
): { ok: true; identity: AgentIdentity } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  if (typeof raw !== "object" || raw === null) {
    return { ok: false, errors: ["identity: must be a non-null object"] };
  }

  const doc = raw as Record<string, unknown>;

  // schemaVersion
  if (doc.schemaVersion !== 1) {
    errors.push(`schemaVersion: must be 1, got ${JSON.stringify(doc.schemaVersion)}`);
  }

  // agentSlug
  if (!isNonEmptyString(doc.agentSlug)) {
    errors.push("agentSlug: required non-empty string");
  } else if (!/^[a-z0-9-]+$/.test(doc.agentSlug)) {
    errors.push("agentSlug: must be lowercase alphanumeric and hyphens only");
  }

  // displayName (optional)
  if (doc.displayName !== undefined && typeof doc.displayName !== "string") {
    errors.push("displayName: must be a string if provided");
  }

  // host
  if (typeof doc.host !== "object" || doc.host === null) {
    errors.push("host: required object");
  } else {
    const h = doc.host as Record<string, unknown>;
    if (!VALID_HOST_TYPES.includes(h.type as HostType)) {
      errors.push(`host.type: must be one of ${VALID_HOST_TYPES.join(", ")}`);
    }
    if (h.label !== undefined && typeof h.label !== "string") {
      errors.push("host.label: must be a string if provided");
    }
    if (h.createdBy !== undefined && typeof h.createdBy !== "string") {
      errors.push("host.createdBy: must be a string if provided");
    }
  }

  // platform
  if (typeof doc.platform !== "object" || doc.platform === null) {
    errors.push("platform: required object");
  } else {
    const p = doc.platform as Record<string, unknown>;
    if (!VALID_ENVIRONMENTS.includes(p.environment as PlatformEnvironment)) {
      errors.push(`platform.environment: must be one of ${VALID_ENVIRONMENTS.join(", ")}`);
    }
    if (!isNonEmptyString(p.baseURL)) errors.push("platform.baseURL: required non-empty string");
    if (!isNonEmptyString(p.ownerId)) errors.push("platform.ownerId: required non-empty string");
    if (!isNonEmptyString(p.agentId)) errors.push("platform.agentId: required non-empty string");
    if (!isNonEmptyString(p.publicSlug)) errors.push("platform.publicSlug: required non-empty string");
    if (!isNonEmptyString(p.ratingSystem)) errors.push("platform.ratingSystem: required non-empty string");
  }

  // auth
  if (typeof doc.auth !== "object" || doc.auth === null) {
    errors.push("auth: required object");
  } else {
    const a = doc.auth as Record<string, unknown>;
    validateSecretRef(a.agentApiKeyRef, "auth.agentApiKeyRef", errors);
  }

  // runtime
  if (typeof doc.runtime !== "object" || doc.runtime === null) {
    errors.push("runtime: required object");
  } else {
    const r = doc.runtime as Record<string, unknown>;
    if (typeof r.profileVersion !== "number" || r.profileVersion < 1) {
      errors.push("runtime.profileVersion: must be a positive integer");
    }
    if (!isIsoTimestamp(r.createdAt)) errors.push("runtime.createdAt: must be a valid ISO 8601 timestamp");
    if (!isIsoTimestamp(r.updatedAt)) errors.push("runtime.updatedAt: must be a valid ISO 8601 timestamp");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, identity: raw as AgentIdentity };
}
