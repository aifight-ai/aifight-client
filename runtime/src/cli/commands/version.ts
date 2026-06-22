// `aifight version` / `--version` / `-v` — daemon-independent.
//
// rev2 fix #4: this handler MUST NOT construct controlClient; it only
// reads the local RUNTIME_VERSION constant. The client-construction lazy
// contract (Step 2) means construction would not throw either, but the
// principle is "version works on a machine where the daemon was never
// installed".

import { RUNTIME_VERSION } from "../../index";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { expectArity } from "../shared";

export async function runVersion(
  args: HandlerArgs,
  env: HandlerEnv,
): Promise<number> {
  expectArity(args, 0, 0, "usage: aifight version");
  if (args.jsonMode) {
    env.stdout(JSON.stringify({ version: RUNTIME_VERSION }) + "\n");
  } else {
    env.stdout(`${RUNTIME_VERSION}\n`);
  }
  return 0;
}
