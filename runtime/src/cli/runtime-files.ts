// Read-side helpers for the running Bridge's local token + port files.
//
// Bridge lifecycle owns the write side (atomic rename, 0600 chmod,
// rotation). M1-17 only reads. CLI consumers — internal only, not
// re-exported to the package root.
//
// Path resolution reuses M1-04 getRuntimeHome():
//   default: $HOME/.aifight/runtime/{token,port}
//   tests / multi-tenancy: AIFIGHT_RUNTIME_HOME env var override
//
// Errors are a single 4-kind class with a `kind` discriminator. The
// control-client wraps these into ControlClientError at the request-path
// boundary (M1-17 TED rev7 拍板点 #4 + rev4 fix #1).

import path from "node:path";
import fs from "node:fs";

import { getRuntimeHome } from "../store/paths";

export type RuntimeFilesErrorKind =
  | "token_missing"
  | "port_missing"
  | "token_corrupt"
  | "port_corrupt";

export class RuntimeFilesError extends Error {
  override readonly name = "RuntimeFilesError";
  readonly kind: RuntimeFilesErrorKind;
  readonly filePath: string;
  constructor(kind: RuntimeFilesErrorKind, filePath: string, message: string) {
    super(message);
    this.kind = kind;
    this.filePath = filePath;
  }
}

export function tokenFilePath(): string {
  return path.join(getRuntimeHome(), "token");
}

export function portFilePath(): string {
  return path.join(getRuntimeHome(), "port");
}

export function readToken(): string {
  const p = tokenFilePath();
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new RuntimeFilesError(
        "token_missing",
        p,
        `token file not found at ${p}; AIFight Bridge must be running`,
      );
    }
    throw new RuntimeFilesError(
      "token_corrupt",
      p,
      `failed to read token file at ${p}: ${(e as Error).message}`,
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new RuntimeFilesError(
      "token_corrupt",
      p,
      `token file at ${p} is empty`,
    );
  }
  return trimmed;
}

export function readPort(): number {
  const p = portFilePath();
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new RuntimeFilesError(
        "port_missing",
        p,
        `port file not found at ${p}; AIFight Bridge must be running`,
      );
    }
    throw new RuntimeFilesError(
      "port_corrupt",
      p,
      `failed to read port file at ${p}: ${(e as Error).message}`,
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new RuntimeFilesError(
      "port_corrupt",
      p,
      `port file at ${p} is empty`,
    );
  }
  if (!/^-?\d+$/.test(trimmed)) {
    throw new RuntimeFilesError(
      "port_corrupt",
      p,
      `port file at ${p} is not a number: "${trimmed}"`,
    );
  }
  const n = Number.parseInt(trimmed, 10);
  if (n < 1 || n > 65535) {
    throw new RuntimeFilesError(
      "port_corrupt",
      p,
      `port file at ${p} is out of range [1, 65535]: ${n}`,
    );
  }
  return n;
}
