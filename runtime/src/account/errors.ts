// Typed error hierarchy for src/account/ — registration (M1-03) and
// credentials (M1-05) both live here by design: both are "account"
// concerns, both share the abstract-base + `kind`-discriminator shape,
// and keeping them colocated lets future M1-06 (wsclient) etc. follow
// the same pattern without retrofitting.
//
// Error messages are free-form English; callers SHOULD NOT parse them.
// Programmatic behavior branches on the `kind` discriminator or
// `instanceof`. Critically: nothing in this file touches disk, logs,
// or network — these are pure data carriers.

export type RegisterErrorKind = "network" | "http" | "schema";

export abstract class RegisterError extends Error {
  abstract readonly kind: RegisterErrorKind;
}

export class RegisterNetworkError extends RegisterError {
  readonly kind = "network" as const;
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "RegisterNetworkError";
    this.cause = cause;
  }
}

export class RegisterHttpError extends RegisterError {
  readonly kind = "http" as const;
  readonly status: number;
  readonly body: { error?: string } | string;
  constructor(status: number, body: { error?: string } | string, message: string) {
    super(message);
    this.name = "RegisterHttpError";
    this.status = status;
    this.body = body;
  }
}

export interface AjvLikeError {
  readonly instancePath: string;
  readonly message?: string;
}

export class RegisterSchemaError extends RegisterError {
  readonly kind = "schema" as const;
  readonly ajvErrors: readonly AjvLikeError[];
  constructor(ajvErrors: readonly AjvLikeError[], message: string) {
    super(message);
    this.name = "RegisterSchemaError";
    this.ajvErrors = ajvErrors;
  }
}

// ─── Credentials errors (M1-05) ──────────────────────────────────────
//
// Parallel to the Register* family: one abstract base + concrete
// subclasses with a `kind` discriminator. Thrown by src/account/
// credentials.ts to signal keychain availability, crypto failures, or
// tampered BLOBs. All messages are free-form English; callers branch
// on `instanceof` or `kind`, never on message substring.

export type CredentialsErrorKind = "keychain-unavailable" | "crypto" | "corrupt";

export abstract class CredentialsError extends Error {
  abstract readonly kind: CredentialsErrorKind;
}

/** OS keychain is unreachable (probe failed, secret-service / D-Bus
 *  down, libsecret missing, etc.). Callers who need a keychain-ref
 *  BLOB to succeed should either fall back via isKeychainAvailable()
 *  first, or rethrow and surface a user-actionable message. */
export class CredentialsKeychainUnavailableError extends CredentialsError {
  readonly kind = "keychain-unavailable" as const;
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "CredentialsKeychainUnavailableError";
    this.cause = cause;
  }
}

/** Fallback crypto path failed: KDF (cannot read/write the master
 *  key), AES-256-GCM encrypt, or AES-256-GCM decrypt surface not
 *  covered by the more specific CredentialsCorruptError (e.g. scrypt
 *  OOM). The `op` discriminator lets callers distinguish key-
 *  derivation, encrypt, and decrypt time failures. */
export class CredentialsCryptoError extends CredentialsError {
  readonly kind = "crypto" as const;
  readonly op: "encrypt" | "decrypt" | "kdf";
  readonly cause?: unknown;
  constructor(
    op: "encrypt" | "decrypt" | "kdf",
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "CredentialsCryptoError";
    this.op = op;
    this.cause = cause;
  }
}

/** BLOB integrity check failed: unknown version prefix, keychain
 *  entry missing for a keychain-ref BLOB, or AES-GCM auth tag
 *  mismatch on a fallback BLOB. This is a data-integrity signal, not
 *  an upstream error — no `cause` field. Callers who see this MUST
 *  treat the stored row as untrusted; silent retry hides tampering. */
export class CredentialsCorruptError extends CredentialsError {
  readonly kind = "corrupt" as const;
  constructor(message: string) {
    super(message);
    this.name = "CredentialsCorruptError";
  }
}
