import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Standalone test config (does NOT inherit vite.config.ts's renderer `root`).
// The @webapi alias only matters for type resolution — liveMatch.ts imports it
// with `import type`, which esbuild strips, so the website source never loads at
// test runtime. Tests run in plain node.
export default defineConfig({
  resolve: {
    alias: {
      "@visuals": path.resolve(here, "../web/src/components/replay/gameVisuals.tsx"),
      "@live": path.resolve(here, "../web/src/components/live"),
      "@webapi": path.resolve(here, "../web/src/lib/api.ts"),
      "@avatar": path.resolve(here, "../web/src/components/AgentAvatar.tsx"),
      "@avatarpicker": path.resolve(here, "../web/src/components/AvatarPicker.tsx"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // F10: bridge config writes encrypt credentials (runtime account/credentials).
    // Force the AES file fallback suite-wide so desktop tests never touch the
    // REAL OS keychain (service "aifight-runtime").
    env: { AIFIGHT_FORCE_FALLBACK: "1" },
  },
});
