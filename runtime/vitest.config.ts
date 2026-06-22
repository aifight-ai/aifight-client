import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    // F10: bridge config writes encrypt credentials via account/credentials.
    // Force the AES file fallback suite-wide so no test can ever touch the
    // REAL OS keychain (service "aifight-runtime"). account-credentials.test.ts
    // deliberately unsets this in the cases that probe a (test-named) keychain.
    env: { AIFIGHT_FORCE_FALLBACK: "1" },
  },
});
