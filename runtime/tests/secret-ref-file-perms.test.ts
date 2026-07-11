import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveSecret } from "../src/profile/secret-ref";

// R13 F-07: file / env_file SecretRefs must verify the file is a private,
// current-user-owned regular file (not a symlink, not group/other-readable)
// BEFORE reading it. The mode/uid checks are POSIX-only; symlink and
// non-regular-file rejection applies on every platform.
const isWin = process.platform === "win32";

describe("file-backed SecretRef permission gate (R13 F-07)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "aifight-secret-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a 0600 file secret and returns its trimmed value", async () => {
    const p = path.join(dir, "key.txt");
    writeFileSync(p, "sk-secret-value\n", { mode: 0o600 });
    chmodSync(p, 0o600);
    await expect(resolveSecret({ type: "file", path: p })).resolves.toBe("sk-secret-value");
  });

  it.skipIf(isWin)("rejects a 0644 (group/other-readable) file secret with an actionable error", async () => {
    const p = path.join(dir, "key.txt");
    writeFileSync(p, "sk-secret-value\n", { mode: 0o644 });
    chmodSync(p, 0o644);
    await expect(resolveSecret({ type: "file", path: p })).rejects.toThrow(/chmod 600/);
  });

  it.skipIf(isWin)("rejects a symlink pointing at a secret file (never follows it)", async () => {
    const real = path.join(dir, "real.txt");
    writeFileSync(real, "sk-secret-value\n", { mode: 0o600 });
    chmodSync(real, 0o600);
    const link = path.join(dir, "link.txt");
    symlinkSync(real, link);
    await expect(resolveSecret({ type: "file", path: link })).rejects.toThrow(/symlink/i);
  });

  it("rejects a non-regular file (directory) as a secret path", async () => {
    const p = path.join(dir, "adir");
    mkdirSync(p);
    await expect(resolveSecret({ type: "file", path: p })).rejects.toThrow(/not a regular file/i);
  });

  it("accepts a 0600 env_file and reads the named variable", async () => {
    const p = path.join(dir, ".env");
    writeFileSync(p, "OTHER=x\nMY_KEY=sk-env-value\n", { mode: 0o600 });
    chmodSync(p, 0o600);
    await expect(
      resolveSecret({ type: "env_file", path: p, name: "MY_KEY" }),
    ).resolves.toBe("sk-env-value");
  });

  it.skipIf(isWin)("rejects a 0644 env_file BEFORE reading its contents", async () => {
    const p = path.join(dir, ".env");
    writeFileSync(p, "MY_KEY=sk-env-value\n", { mode: 0o644 });
    chmodSync(p, 0o644);
    await expect(
      resolveSecret({ type: "env_file", path: p, name: "MY_KEY" }),
    ).rejects.toThrow(/insecure permissions|chmod 600/);
  });
});
