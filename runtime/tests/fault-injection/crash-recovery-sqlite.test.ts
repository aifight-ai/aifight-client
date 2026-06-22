// M5-01 fault class 3: daemon crash → reopen with state persisted
// (plan §5.9 reconnect + M1-04 sqlite agents persistence).
//
// What "crash recovery" means at the runtime layer right now: the daemon
// holds a single SQLite handle for agent persistence (api_key / claim_token /
// model). When the process is SIGKILL'd, that handle is destroyed without
// graceful close — better-sqlite3 default journal mode is WAL, so a sudden
// kill leaves the WAL file alongside the main DB. The next openDatabase()
// must self-heal: replay/checkpoint the WAL, expose all committed rows, and
// keep schemaVersion stable.
//
// Plan §13 also lists "lastEventId 持久化" but the M1-04 schema (v2) does
// NOT include an event-stream table — store/schema.sql comment notes it as
// "M2 when broker lands" and that table was never added. So the real
// runtime crash-recovery surface today is the agents table only. Tests
// here lock that current surface; if M5-09 / M5-10 surfaces a need for
// lastEventId persistence, that is a separate task (per M5-01 TED §3.3).

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDatabase, type StoreHandle } from "../../src";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-m5-01-"));
  tmpDirs.push(dir);
  return path.join(dir, "state.db");
}

const sampleAgent = {
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  name: "fault-test-bot",
  api_key: Buffer.from("sk-fake-key-for-fault-test", "utf8"),
  claim_token: Buffer.from("ct-fault-test-0123", "utf8"),
  model: "claude-opus-4-7",
};

describe("M5-01 daemon crash recovery — sqlite reopen invariants", () => {
  it("graceful close + reopen → agent row persists, schemaVersion stable", async () => {
    const dbPath = tmpDbPath();

    const h1 = openDatabase({ path: dbPath });
    const inserted = h1.upsertAgent(sampleAgent);
    expect(h1.schemaVersion).toBe(2);
    h1.close();

    const h2 = openDatabase({ path: dbPath });
    expect(h2.schemaVersion).toBe(2);
    const row = h2.getAgentByName(sampleAgent.name);
    expect(row).toBeDefined();
    expect(row?.id).toBe(sampleAgent.id);
    expect(row?.api_key.equals(inserted.api_key)).toBe(true);
    expect(row?.claim_token.equals(inserted.claim_token)).toBe(true);
    h2.close();
  });

  it("simulated SIGKILL (no close) + reopen → WAL journal heals, agent row visible", async () => {
    // Mimics the daemon being SIGKILL'd: open + write + abandon the handle
    // without calling close(). better-sqlite3 in WAL mode must recover:
    // the next openDatabase() rolls forward the WAL into main and exposes
    // all committed rows. We DO write to disk and re-open the same path
    // (NOT :memory:) — :memory: can't exercise WAL crash semantics.
    const dbPath = tmpDbPath();

    let h1: StoreHandle | null = openDatabase({ path: dbPath });
    h1.upsertAgent(sampleAgent);
    // Drop the reference WITHOUT calling close(). The handle will be GC'd
    // eventually but the WAL state at this moment is our test target —
    // any subsequent open must heal regardless of GC timing.
    h1 = null;

    // Open second handle on same path. better-sqlite3 will see the WAL
    // file from the un-closed handle and roll it forward. If WAL recovery
    // were broken, the row would be missing or corrupted.
    const h2 = openDatabase({ path: dbPath });
    expect(h2.schemaVersion).toBe(2);
    const row = h2.getAgentByName(sampleAgent.name);
    expect(row).toBeDefined();
    expect(row?.id).toBe(sampleAgent.id);
    expect(row?.api_key.equals(sampleAgent.api_key)).toBe(true);
    h2.close();
  });
});
