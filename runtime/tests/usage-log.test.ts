// §7A acceptance: JSONL rolls by month, malformed lines are skipped, the
// window read touches only relevant files, and writes are silent on failure
// (stats must never break a match).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendUsageRecord,
  readUsageRecordsSince,
  usageFilePath,
  usageMonthKey,
  type UsageRecord,
} from "../src/usage/usage-log";

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-usage-test-"));
  prevHome = process.env.AIFIGHT_HOME;
  process.env.AIFIGHT_HOME = tmpHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.AIFIGHT_HOME;
  else process.env.AIFIGHT_HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function rec(ts: string, model = "claude-x"): UsageRecord {
  return {
    ts,
    match_id: "m-1",
    game: "coup",
    provider: "anthropic_messages",
    model,
    input_tokens: 10,
    output_tokens: 20,
    decision_source: "model",
  };
}

describe("usage log (§7A)", () => {
  it("appends to the month file named after the record timestamp", () => {
    appendUsageRecord(rec("2026-06-12T01:00:00.000Z"));
    appendUsageRecord(rec("2026-07-01T00:30:00.000Z"));
    expect(fs.existsSync(usageFilePath("2026-06"))).toBe(true);
    expect(fs.existsSync(usageFilePath("2026-07"))).toBe(true);
  });

  it("round-trips records within the window and skips malformed lines", () => {
    appendUsageRecord(rec("2026-06-10T00:00:00.000Z"));
    appendUsageRecord(rec("2026-06-12T00:00:00.000Z", "gpt-y"));
    fs.appendFileSync(usageFilePath("2026-06"), "not json at all\n{broken\n", "utf8");

    const all = readUsageRecordsSince(
      new Date("2026-06-01T00:00:00Z"),
      new Date("2026-06-30T00:00:00Z"),
    );
    expect(all).toHaveLength(2);

    const narrow = readUsageRecordsSince(
      new Date("2026-06-11T00:00:00Z"),
      new Date("2026-06-30T00:00:00Z"),
    );
    expect(narrow).toHaveLength(1);
    expect(narrow[0]!.model).toBe("gpt-y");
  });

  it("reads across month boundaries", () => {
    appendUsageRecord(rec("2026-05-31T23:00:00.000Z"));
    appendUsageRecord(rec("2026-06-01T01:00:00.000Z"));
    const both = readUsageRecordsSince(
      new Date("2026-05-30T00:00:00Z"),
      new Date("2026-06-02T00:00:00Z"),
    );
    expect(both).toHaveLength(2);
  });

  it("usageMonthKey is UTC-based and zero-padded", () => {
    expect(usageMonthKey(new Date("2026-06-12T03:00:00Z"))).toBe("2026-06");
    expect(usageMonthKey(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
  });

  it("write failure is silent (home pointing at a FILE, mkdir fails)", () => {
    const fileAsHome = path.join(tmpHome, "not-a-dir");
    fs.writeFileSync(fileAsHome, "x", "utf8");
    process.env.AIFIGHT_HOME = fileAsHome;
    expect(() => appendUsageRecord(rec("2026-06-12T01:00:00.000Z"))).not.toThrow();
  });
});
