#!/usr/bin/env node
// aifight — CLI entry point.
//
// M1-17 Step 3 wires this entry to runtime/src/cli/main.ts. The full
// command surface (Tier A real handlers + later Tier B/C stubs in Step
// 4) lives there; this file is just the process bridge.
//
// Last-resort safety net: run() should already swallow + map all known
// errors to exit codes. Anything reaching the .then(_, e => ...) branch
// here is a bug — exit 99 with the message only (no stack), per Risks #8.

import { run } from "../src/cli/main";

run(process.argv).then(
  (code) => process.exit(code),
  (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`aifight: unexpected fatal: ${msg}\n`);
    process.exit(99);
  },
);
