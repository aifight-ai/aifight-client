// runtime/src/store/sqlite.ts
//
// M1-04 surface: open a local SQLite DB, apply migrations, and provide
// minimum CRUD on an `agents` table. Nothing here writes encrypted
// payloads (M1-05) and nothing calls registerAgent() (M1-03 is
// untouched). The sole caller in this TED is the test file; the real
// wiring happens in a later TED.
//
// Migration strategy: PRAGMA user_version. Each MIGRATIONS step is
// transactional; failure rolls back and throws StoreMigrationError.
// The DB refuses to open if its user_version > our current target
// (prevents silent downgrade).
//
// better-sqlite3 is a native module. esbuild is configured with
// --external:better-sqlite3 so dist/index.mjs preserves the import
// statement; consumers resolve it from their installed node_modules.

import Database from "better-sqlite3";
import type { Database as DatabaseType, Statement } from "better-sqlite3";

import { SCHEMA_SQL_V1 } from "./schema.generated";
import {
  StoreError,
  StoreMigrationError,
  StoreOpenError,
  StoreQueryError,
} from "./errors";
import { ensureRuntimeHome, getDefaultDbPath } from "./paths";

// ─── Current schema (v2) ─────────────────────────────────────────────
//
// After MIGRATIONS is fully applied (v1 + v2), the agents table is:
//
//   CREATE TABLE agents (
//     id           TEXT PRIMARY KEY,
//     name         TEXT UNIQUE NOT NULL,
//     api_key      BLOB NOT NULL,     -- encrypted by account/credentials.ts
//     claim_token  BLOB NOT NULL,     -- encrypted by account/credentials.ts
//     model        TEXT DEFAULT '',
//     created_at   INTEGER NOT NULL,
//     updated_at   INTEGER NOT NULL
//   );
//
// schema.sql only describes v1's byte source (SCHEMA_SQL_V1) and is
// immutable per the M1-04 directive. The v2 migration step below
// re-creates the table with BLOB columns using the standard SQLite
// "CREATE new → INSERT SELECT → DROP → RENAME" pattern.
//
// Store-layer API accepts ONLY Buffer for api_key / claim_token.
// Encryption is the caller's responsibility via
// account/credentials.ts#encryptForStorage(). The store does not,
// and MUST NOT, encrypt implicitly — that would create a reverse
// dependency store → credentials or hide a plaintext path masquerading
// as encrypted (Roy P1#1).

// ─── Migrations ──────────────────────────────────────────────────────

interface MigrationStep {
  readonly version: number;
  up(db: DatabaseType): void;
}

const MIGRATIONS: readonly MigrationStep[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(SCHEMA_SQL_V1);
    },
  },
  {
    version: 2,
    up: (db) => {
      // M1-05: re-create agents with BLOB columns for encrypted
      // api_key / claim_token. FRESH-ONLY: if agents has any rows,
      // they were written in v1 as TEXT plaintext and cannot be
      // silently reinterpreted as encrypted BLOBs. Require manual
      // remediation (back up, DELETE FROM agents, re-open). A "real"
      // re-encrypt migration would need a separate TED with its own
      // KDF / master-key-rotation semantics; this one deliberately
      // refuses the ambiguous path.
      const count = (
        db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }
      ).n;
      if (count > 0) {
        throw new Error(
          `M1-05 migration refuses to upgrade a populated agents table ` +
            `(${count} rows). These rows were written in schema v1 with ` +
            `TEXT plaintext columns and cannot be silently reinterpreted ` +
            `as encrypted BLOBs. Remediation: back up the DB file, then ` +
            `DELETE FROM agents, then re-open to trigger migration. For ` +
            `a real re-encrypt migration, open a new TED.`,
        );
      }
      db.exec(`
        CREATE TABLE agents_new (
          id           TEXT NOT NULL PRIMARY KEY,
          name         TEXT NOT NULL UNIQUE,
          api_key      BLOB NOT NULL,
          claim_token  BLOB NOT NULL,
          model        TEXT NOT NULL DEFAULT '',
          created_at   INTEGER NOT NULL,
          updated_at   INTEGER NOT NULL
        );
        INSERT INTO agents_new SELECT * FROM agents;
        DROP TABLE agents;
        ALTER TABLE agents_new RENAME TO agents;
        DROP INDEX IF EXISTS idx_agents_name;
        CREATE INDEX idx_agents_name ON agents(name);
      `);
    },
  },
  // Future migrations APPEND here. Never mutate a committed step.
];

const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

function readUserVersion(db: DatabaseType): number {
  return db.pragma("user_version", { simple: true }) as number;
}

function applyMigrations(db: DatabaseType, target: number): number {
  const current = readUserVersion(db);
  if (current > target) {
    throw new StoreMigrationError(
      current,
      target,
      undefined,
      `DB user_version ${current} is newer than runtime target ${target}; downgrade not supported`,
    );
  }
  for (const step of MIGRATIONS) {
    if (step.version > current && step.version <= target) {
      try {
        const run = db.transaction(() => {
          step.up(db);
          db.pragma(`user_version = ${step.version}`);
        });
        run();
      } catch (e) {
        throw new StoreMigrationError(
          current,
          step.version,
          e,
          `migration v${current} → v${step.version} failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
  }
  return readUserVersion(db);
}

// ─── Public API ──────────────────────────────────────────────────────

export interface OpenDatabaseOptions {
  /** Default: getDefaultDbPath(). Pass ":memory:" for tests. */
  path?: string;
  /** Skip ensureRuntimeHome(); tests with in-memory or mkdtemp DBs use this. */
  skipEnsureHome?: boolean;
  /** Override CURRENT_SCHEMA_VERSION. Tests use this to assert
   *  downgrade-detection. Production callers MUST omit. */
  targetVersion?: number;
}

export interface AgentRow {
  id: string;
  name: string;
  /** Encrypted BLOB; produced by account/credentials.ts#encryptForStorage. */
  api_key: Buffer;
  /** Encrypted BLOB; produced by account/credentials.ts#encryptForStorage. */
  claim_token: Buffer;
  model: string;
  created_at: number;
  updated_at: number;
}

export type UpsertAgentInput = Omit<AgentRow, "created_at" | "updated_at"> & {
  created_at?: number;
  updated_at?: number;
};

export interface StoreHandle {
  readonly path: string;
  readonly schemaVersion: number;
  close(): void;
  getAgentByName(name: string): AgentRow | undefined;
  upsertAgent(row: UpsertAgentInput): AgentRow;
  listAgents(): AgentRow[];
  deleteAgent(name: string): boolean;
  raw(): DatabaseType;
}

export function openDatabase(opts: OpenDatabaseOptions = {}): StoreHandle {
  const target = opts.targetVersion ?? CURRENT_SCHEMA_VERSION;
  const path = opts.path ?? getDefaultDbPath();
  const inMemory = path === ":memory:";

  if (!inMemory && !opts.skipEnsureHome && opts.path === undefined) {
    // Only auto-ensure when using the default home path. If caller
    // passed an explicit path, they're responsible for the dir.
    ensureRuntimeHome();
  }

  let db: DatabaseType;
  try {
    db = new Database(path);
  } catch (e) {
    throw new StoreOpenError(
      path,
      e,
      `failed to open SQLite at ${path}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  // Single failure envelope covering pragmas, migrations, and prepared-
  // statement compilation. Any throw here MUST close the Database handle
  // before propagating — otherwise the WAL file + OS file descriptor
  // leak and a rebooted process can't reopen cleanly. (Roy M1-04 P2#3.)
  let schemaVersion: number;
  let stmtGet: Statement<[string], AgentRow>;
  let stmtList: Statement<[], AgentRow>;
  let stmtDelete: Statement<[string], unknown>;
  let stmtUpsert: Statement<
    [
      {
        id: string;
        name: string;
        api_key: Buffer;
        claim_token: Buffer;
        model: string;
        created_at: number;
        updated_at: number;
      },
    ],
    AgentRow
  >;
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    db.pragma("synchronous = NORMAL");

    schemaVersion = applyMigrations(db, target);

    // Prepared statements — reused for the lifetime of the handle.
    stmtGet = db.prepare<string, AgentRow>(
      `SELECT id, name, api_key, claim_token, model, created_at, updated_at
       FROM agents WHERE name = ?`,
    );
    stmtList = db.prepare<[], AgentRow>(
      `SELECT id, name, api_key, claim_token, model, created_at, updated_at
       FROM agents ORDER BY name ASC`,
    );
    stmtDelete = db.prepare<string>(`DELETE FROM agents WHERE name = ?`);
    stmtUpsert = db.prepare<
      {
        id: string;
        name: string;
        api_key: Buffer;
        claim_token: Buffer;
        model: string;
        created_at: number;
        updated_at: number;
      },
      AgentRow
    >(
      `INSERT INTO agents (id, name, api_key, claim_token, model, created_at, updated_at)
       VALUES (@id, @name, @api_key, @claim_token, @model, @created_at, @updated_at)
       ON CONFLICT(name) DO UPDATE SET
         api_key     = excluded.api_key,
         claim_token = excluded.claim_token,
         model       = excluded.model,
         updated_at  = excluded.updated_at
       RETURNING id, name, api_key, claim_token, model, created_at, updated_at`,
    );
  } catch (e) {
    if (db.open) db.close();
    // Preserve specific Store* subclasses (e.g. StoreMigrationError from
    // applyMigrations). Only rewrap low-level bs3 errors (like a bad
    // prepared statement) as StoreOpenError so callers see a consistent
    // "initialization failed" type.
    if (e instanceof StoreError) throw e;
    throw new StoreOpenError(
      path,
      e,
      `failed to initialize DB at ${path}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  const handle: StoreHandle = {
    path,
    schemaVersion,

    close() {
      if (db.open) db.close();
    },

    getAgentByName(name) {
      try {
        return stmtGet.get(name);
      } catch (e) {
        throw new StoreQueryError(
          "SELECT agents WHERE name = ?",
          e,
          `getAgentByName('${name}') failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    },

    upsertAgent(row) {
      const now = Date.now();
      const params = {
        id: row.id,
        name: row.name,
        api_key: row.api_key,
        claim_token: row.claim_token,
        model: row.model,
        created_at: row.created_at ?? now,
        updated_at: row.updated_at ?? now,
      };
      try {
        const result = stmtUpsert.get(params);
        if (result === undefined) {
          throw new Error("RETURNING yielded no row — should be impossible");
        }
        return result;
      } catch (e) {
        throw new StoreQueryError(
          "INSERT agents ON CONFLICT(name) ...",
          e,
          `upsertAgent(name='${row.name}') failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    },

    listAgents() {
      try {
        return stmtList.all();
      } catch (e) {
        throw new StoreQueryError(
          "SELECT agents ORDER BY name",
          e,
          `listAgents() failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },

    deleteAgent(name) {
      try {
        const info = stmtDelete.run(name);
        return info.changes > 0;
      } catch (e) {
        throw new StoreQueryError(
          "DELETE agents WHERE name = ?",
          e,
          `deleteAgent('${name}') failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    },

    raw() {
      return db;
    },
  };

  return handle;
}
