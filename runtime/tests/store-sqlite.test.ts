// runtime/tests/store-sqlite.test.ts
//
// 12 cases covering openDatabase + migrations + CRUD + lifecycle.
// Case 2 is tmp-file idempotency (open same DB twice); the rest
// prefer :memory: for speed. ZERO test writes to the user's real
// runtime home directory; build.sh grep-asserts this file does not
// reference the production home path.

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  openDatabase,
  StoreMigrationError,
  StoreOpenError,
  StoreQueryError,
  type AgentRow,
  type StoreHandle,
} from "../src";

function tmpDbPath(): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-m1-04-"));
  return { dir, dbPath: path.join(dir, "state.db") };
}

const disposables: StoreHandle[] = [];
const tmpDirs: string[] = [];

afterEach(() => {
  while (disposables.length > 0) {
    const h = disposables.pop()!;
    try {
      h.close();
    } catch {
      // already closed
    }
  }
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function openMem() {
  const h = openDatabase({ path: ":memory:" });
  disposables.push(h);
  return h;
}

function openTmp(dbPath?: string) {
  let resolvedPath = dbPath;
  if (!resolvedPath) {
    const { dir, dbPath: p } = tmpDbPath();
    tmpDirs.push(dir);
    resolvedPath = p;
  }
  const h = openDatabase({ path: resolvedPath });
  disposables.push(h);
  return h;
}

// api_key and claim_token are Buffer in the v2 store surface — the
// store layer no longer accepts string. Encryption lives one level
// up in account/credentials.ts#encryptForStorage. These sample
// bytes are NOT encrypted blobs — they are just arbitrary bytes
// that happen to be human-readable, which is fine at the store-
// layer unit-test level (we're testing SQLite plumbing, not crypto).
const sampleRow = {
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  name: "test-bot",
  api_key: Buffer.from("sk-fake-1234567890abcdef", "utf8"),
  claim_token: Buffer.from("ct-0123456789abcdef", "utf8"),
  model: "claude-opus-4-7",
};

describe("openDatabase + migrations", () => {
  it("1. :memory: empty DB applies v1 + v2 migrations → user_version = 2", () => {
    const h = openMem();
    expect(h.schemaVersion).toBe(2);
    expect(h.raw().pragma("user_version", { simple: true })).toBe(2);
    const tables = h
      .raw()
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='agents'",
      )
      .all();
    expect(tables).toHaveLength(1);
  });

  it("2. migration idempotency: same tmp file opened twice preserves data + user_version, no re-run", () => {
    // First open: write a row, then close.
    const { dir, dbPath } = tmpDbPath();
    tmpDirs.push(dir);
    const h1 = openDatabase({ path: dbPath });
    h1.upsertAgent(sampleRow);
    expect(h1.schemaVersion).toBe(2);
    h1.close();

    // Second open on the SAME FILE: must not re-run v1 (re-running
    // CREATE TABLE without IF NOT EXISTS would throw; our schema
    // uses IF NOT EXISTS so that failure mode is masked — we instead
    // assert the row is still there and user_version is unchanged).
    // Under M1-05 v2, api_key / claim_token are Buffer columns;
    // Buffer equality needs .equals(), .toBe() would compare
    // references and pass silently with unrelated bytes.
    const h2 = openDatabase({ path: dbPath });
    disposables.push(h2);
    expect(h2.schemaVersion).toBe(2);
    expect(h2.raw().pragma("user_version", { simple: true })).toBe(2);
    const row = h2.getAgentByName(sampleRow.name);
    expect(row).toBeDefined();
    expect(row?.id).toBe(sampleRow.id);
    expect(Buffer.isBuffer(row?.api_key)).toBe(true);
    expect(row?.api_key.equals(sampleRow.api_key)).toBe(true);
    expect(Buffer.isBuffer(row?.claim_token)).toBe(true);
    expect(row?.claim_token.equals(sampleRow.claim_token)).toBe(true);
  });
});

describe("agents CRUD", () => {
  it("3. upsertAgent + getAgentByName round-trip", () => {
    const h = openMem();
    const inserted = h.upsertAgent(sampleRow);
    expect(inserted.id).toBe(sampleRow.id);
    expect(inserted.name).toBe(sampleRow.name);
    // Buffer fields: explicit type + byte-equality assertions so a
    // string-vs-buffer mismatch (or same-reference trick) cannot
    // silently pass.
    expect(Buffer.isBuffer(inserted.api_key)).toBe(true);
    expect(inserted.api_key.equals(sampleRow.api_key)).toBe(true);
    expect(Buffer.isBuffer(inserted.claim_token)).toBe(true);
    expect(inserted.claim_token.equals(sampleRow.claim_token)).toBe(true);
    expect(inserted.model).toBe(sampleRow.model);
    expect(inserted.created_at).toBeGreaterThan(0);
    expect(inserted.updated_at).toBeGreaterThan(0);

    const fetched = h.getAgentByName(sampleRow.name);
    expect(fetched).toBeDefined();
    expect(fetched?.id).toBe(inserted.id);
    expect(fetched?.name).toBe(inserted.name);
    expect(fetched?.api_key.equals(inserted.api_key)).toBe(true);
    expect(fetched?.claim_token.equals(inserted.claim_token)).toBe(true);
    expect(fetched?.model).toBe(inserted.model);
    expect(fetched?.created_at).toBe(inserted.created_at);
    expect(fetched?.updated_at).toBe(inserted.updated_at);
  });

  it("4. upsertAgent same name twice: updated_at bumped, created_at unchanged", () => {
    const h = openMem();
    const first = h.upsertAgent({ ...sampleRow, created_at: 1_000_000, updated_at: 1_000_000 });
    // Force a later wall-clock by supplying explicit timestamps.
    const rotatedKey = Buffer.from("sk-rotated-key", "utf8");
    const second = h.upsertAgent({
      ...sampleRow,
      api_key: rotatedKey,
      created_at: 999_999_999, // ignored on conflict
      updated_at: 2_000_000,
    });
    expect(second.created_at).toBe(first.created_at); // preserved
    expect(second.updated_at).toBe(2_000_000); // bumped
    expect(second.api_key.equals(rotatedKey)).toBe(true); // updated field wins
  });

  it("5. upsertAgent duplicate id with different name → StoreQueryError (PK conflict)", () => {
    const h = openMem();
    h.upsertAgent(sampleRow);
    expect(() =>
      h.upsertAgent({
        ...sampleRow,
        name: "another-name",
        // same id — ON CONFLICT(name) doesn't resolve id collisions
      }),
    ).toThrow(StoreQueryError);
  });

  it("6. listAgents returns rows sorted by name ASC", () => {
    const h = openMem();
    h.upsertAgent({ ...sampleRow, id: "id-c", name: "charlie" });
    h.upsertAgent({ ...sampleRow, id: "id-a", name: "alpha" });
    h.upsertAgent({ ...sampleRow, id: "id-b", name: "bravo" });
    const list = h.listAgents();
    expect(list.map((r: AgentRow) => r.name)).toEqual(["alpha", "bravo", "charlie"]);
    for (const r of list) {
      expect(Buffer.isBuffer(r.api_key)).toBe(true);
      expect(r.api_key.length).toBeGreaterThan(0);
      expect(r.created_at).toBeGreaterThan(0);
    }
  });

  it("7. deleteAgent existing → true, subsequent get returns undefined", () => {
    const h = openMem();
    h.upsertAgent(sampleRow);
    expect(h.deleteAgent(sampleRow.name)).toBe(true);
    expect(h.getAgentByName(sampleRow.name)).toBeUndefined();
  });

  it("8. deleteAgent non-existing → false, no throw", () => {
    const h = openMem();
    expect(h.deleteAgent("never-inserted")).toBe(false);
  });
});

describe("persistence + path handling", () => {
  it("9. tmp file open → write → close → re-open → data survives", () => {
    const { dir, dbPath } = tmpDbPath();
    tmpDirs.push(dir);
    const h1 = openDatabase({ path: dbPath });
    h1.upsertAgent(sampleRow);
    h1.close();
    expect(fs.existsSync(dbPath)).toBe(true);

    const h2 = openDatabase({ path: dbPath });
    disposables.push(h2);
    expect(h2.getAgentByName(sampleRow.name)?.id).toBe(sampleRow.id);
  });

  it.skipIf(process.platform === "win32")(
    "10. POSIX: opening under a 0000 parent dir → StoreOpenError",
    () => {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-m1-04-denied-"));
      tmpDirs.push(parent);
      const dbPath = path.join(parent, "state.db");
      fs.chmodSync(parent, 0o000);
      try {
        expect(() => openDatabase({ path: dbPath })).toThrow(StoreOpenError);
      } finally {
        // Restore so afterEach's rmSync can clean it up.
        fs.chmodSync(parent, 0o700);
      }
    },
  );
});

describe("migration guards + lifecycle", () => {
  it("11. user_version > target → StoreMigrationError on open (downgrade blocked)", () => {
    const { dir, dbPath } = tmpDbPath();
    tmpDirs.push(dir);
    // First open at v1 via normal path, then bump user_version out of range.
    const seed = openDatabase({ path: dbPath });
    seed.raw().pragma("user_version = 99");
    seed.close();

    expect(() => openDatabase({ path: dbPath })).toThrow(StoreMigrationError);
  });

  it("12. close() then use → StoreQueryError on subsequent call", () => {
    const h = openMem();
    h.upsertAgent(sampleRow);
    h.close();
    expect(() => h.getAgentByName(sampleRow.name)).toThrow(StoreQueryError);
  });

  it("13. migration failure closes the Database handle (no file-lock leak — Roy P2#3)", () => {
    const { dir, dbPath } = tmpDbPath();
    tmpDirs.push(dir);

    // Seed a valid v1 DB, then corrupt user_version to block reopen.
    const seed = openDatabase({ path: dbPath });
    seed.upsertAgent(sampleRow);
    seed.raw().pragma("user_version = 99");
    seed.close();

    // The throwing openDatabase() must close its Database before
    // propagating, otherwise we leak an OS file descriptor + WAL lock.
    expect(() => openDatabase({ path: dbPath })).toThrow(StoreMigrationError);

    // SQLite auto-checkpoints and removes the WAL sidecar when the
    // last connection closes cleanly. If the failing openDatabase()
    // leaked its handle, *-wal would still exist here.
    expect(fs.existsSync(dbPath + "-wal")).toBe(false);

    // And a fresh connection at a different path opens cleanly —
    // proves the failed open didn't wedge anything process-wide.
    const { dir: d2, dbPath: p2 } = tmpDbPath();
    tmpDirs.push(d2);
    const fresh = openDatabase({ path: p2 });
    disposables.push(fresh);
    expect(fresh.schemaVersion).toBe(2);
  });

  it("14. v1 empty DB upgrades to v2 on default open", () => {
    const { dir, dbPath } = tmpDbPath();
    tmpDirs.push(dir);

    // Seed an empty v1 via explicit target — stops migrations after v1.
    const v1 = openDatabase({ path: dbPath, targetVersion: 1 });
    expect(v1.schemaVersion).toBe(1);
    expect(v1.raw().pragma("user_version", { simple: true })).toBe(1);
    v1.close();

    // Default open applies the v2 delta; COUNT(*) check passes (empty).
    const v2 = openDatabase({ path: dbPath });
    disposables.push(v2);
    expect(v2.schemaVersion).toBe(2);
    expect(v2.raw().pragma("user_version", { simple: true })).toBe(2);

    // agents table survived the re-create step and is empty.
    const tables = v2
      .raw()
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='agents'",
      )
      .all();
    expect(tables).toHaveLength(1);
    expect(v2.listAgents()).toHaveLength(0);

    // And the table now accepts + round-trips raw bytes as a BLOB.
    const probe = Buffer.from([0x00, 0xff, 0x7f, 0x80, 0x01, 0xfe]);
    v2.upsertAgent({
      id: "probe-id",
      name: "probe",
      api_key: probe,
      claim_token: Buffer.from("ct-v2", "utf8"),
      model: "",
    });
    const read = v2.getAgentByName("probe");
    expect(read).toBeDefined();
    expect(Buffer.isBuffer(read?.api_key)).toBe(true);
    expect(read?.api_key.equals(probe)).toBe(true);
  });

  it("15. v1 populated DB refuses v2 migration (fresh-only)", () => {
    const { dir, dbPath } = tmpDbPath();
    tmpDirs.push(dir);

    // Seed a v1 DB and insert a row via RAW SQL — the stored values
    // are real TEXT plaintext, the pre-M1-05 shape the guard must
    // refuse. (Using upsertAgent here would require a Buffer input,
    // which SQLite would store as a BLOB value in a TEXT column,
    // still triggering COUNT(*) > 0 but muddying the scenario.)
    const v1 = openDatabase({ path: dbPath, targetVersion: 1 });
    const now = Date.now();
    v1.raw()
      .prepare(
        `INSERT INTO agents (id, name, api_key, claim_token, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "v1-id-aaaa-bbbb-cccc",
        "v1-name",
        "sk-v1-plaintext",
        "ct-v1-plaintext",
        "",
        now,
        now,
      );
    expect(v1.raw().pragma("user_version", { simple: true })).toBe(1);
    v1.close();

    // Default open triggers v2 migration; COUNT(*) > 0 → refuses.
    expect(() => openDatabase({ path: dbPath })).toThrow(StoreMigrationError);
  });
});
