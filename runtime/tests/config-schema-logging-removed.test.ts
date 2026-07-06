import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, validateConfig } from "../src/profile/config-schema.js";

// The `logging` block (storePrompts / storeRawProviderResponses /
// storeReasoningContent) was a no-op knob — nothing in the runtime ever read it
// to gate the local session ledger — so it was removed from the schema and from
// every write site. These tests pin the two guarantees that removal must keep:
//   1. Back-compat: a config.json written by an OLDER client still carries a
//      `logging` block on disk. Loading it MUST NOT error — the key is now inert
//      (ignored), not rejected.
//   2. New writes no longer emit the key.

function cloneDefault(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Record<string, unknown>;
}

describe("logging config removal", () => {
  it("still accepts a stored config that carries the old logging block", () => {
    const stored = cloneDefault();
    stored.logging = {
      storePrompts: "redacted",
      storeRawProviderResponses: false,
      storeReasoningContent: false,
    };
    const res = validateConfig(stored);
    expect(res.ok).toBe(true);
  });

  it("accepts every legacy storePrompts value (full / redacted / none)", () => {
    for (const mode of ["full", "redacted", "none"]) {
      const stored = cloneDefault();
      stored.logging = { storePrompts: mode };
      expect(validateConfig(stored).ok).toBe(true);
    }
  });

  it("no longer validates the logging block — a once-illegal value is now simply ignored", () => {
    const stored = cloneDefault();
    // Under the old validator this would have failed with
    // `logging.storePrompts: must be "full", "redacted", or "none"`.
    stored.logging = { storePrompts: "bogus", storeRawProviderResponses: "yes" };
    expect(validateConfig(stored).ok).toBe(true);
  });

  it("DEFAULT_CONFIG no longer emits a logging key", () => {
    expect("logging" in DEFAULT_CONFIG).toBe(false);
  });
});
