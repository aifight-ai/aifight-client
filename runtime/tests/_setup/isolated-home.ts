// Suite-wide safety net: no test may write into the developer's real AIFight
// home directory.
//
// Same intent as the AIFIGHT_FORCE_FALLBACK line in vitest.config.ts, which
// keeps tests off the real OS keychain. The home needs the same guard because
// several commands write there as a side effect — `connect` and `setup` now
// stamp the machine's device id on success, and any test driving them without
// its own override would leave that file in the user's own account.
//
// Per FILE, not per suite: each test file gets its own directory, so files
// cannot see each other's leftovers. A file that sets AIFIGHT_HOME itself keeps
// full control — this only fills in a default when there is none.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll } from "vitest";

if (!process.env.AIFIGHT_HOME) {
  const dir = mkdtempSync(join(tmpdir(), "aifight-test-home-"));
  process.env.AIFIGHT_HOME = dir;
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}
