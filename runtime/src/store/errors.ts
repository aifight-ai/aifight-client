// Typed error hierarchy for the store layer.
//
// Mirrors src/account/errors.ts in shape so M1-05 (credentials) and
// M1-06 (wsclient) can colocate their own hierarchies under the same
// pattern. Programmatic branching uses `kind` discriminator or
// `instanceof`; message text is free-form English and MUST NOT be
// parsed.

export type StoreErrorKind = "open" | "migration" | "query";

export abstract class StoreError extends Error {
  abstract readonly kind: StoreErrorKind;
}

export class StoreOpenError extends StoreError {
  readonly kind = "open" as const;
  readonly path: string;
  readonly cause?: unknown;
  constructor(path: string, cause: unknown, message: string) {
    super(message);
    this.name = "StoreOpenError";
    this.path = path;
    this.cause = cause;
  }
}

export class StoreMigrationError extends StoreError {
  readonly kind = "migration" as const;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly cause?: unknown;
  constructor(
    fromVersion: number,
    toVersion: number,
    cause: unknown,
    message: string,
  ) {
    super(message);
    this.name = "StoreMigrationError";
    this.fromVersion = fromVersion;
    this.toVersion = toVersion;
    this.cause = cause;
  }
}

export class StoreQueryError extends StoreError {
  readonly kind = "query" as const;
  readonly sql: string;
  readonly cause?: unknown;
  constructor(sql: string, cause: unknown, message: string) {
    super(message);
    this.name = "StoreQueryError";
    this.sql = sql;
    this.cause = cause;
  }
}
