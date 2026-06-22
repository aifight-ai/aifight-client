// Bundles the Electron main + preload processes. They run in Node, reuse the
// AIFight bridge core directly from ../runtime/src, and keep native modules
// external (rebuilt for Electron's ABI by `npm run rebuild`).
import { readFileSync, cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

// Single source of truth for the app version: package.json. Injected into both
// bundles via define so the renderer footer + About panel show the real version
// without an IPC round-trip (the sandboxed preload can't call app.getVersion()).
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const APP_VERSION = JSON.stringify(pkg.version);

// electron-updater is kept external (required from node_modules at runtime, like
// the native modules) rather than bundled — it has dynamic requires and ships as
// a production dependency, so electron-builder includes it in the packaged app.
const NATIVE_EXTERNALS = ["electron", "electron-updater", "better-sqlite3", "@napi-rs/keyring", "ws"];

const common = {
  outdir: "dist/main",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: NATIVE_EXTERNALS,
  sourcemap: true,
  logLevel: "info",
  define: { __APP_VERSION__: APP_VERSION },
};

// Main process: the runtime uses import.meta.url to locate its protocol/schema
// tree (schemas.ts). In a CJS bundle import.meta.url is empty, so shim it to the
// bundle's own file URL. From desktop/dist/main, schemas.ts candidate
// "../../../protocol/schema" then resolves to the repo's protocol/schema (dev
// layout). Packaged builds will ship schemas alongside (P4a). The banner uses
// __filename, which exists in the main process but NOT the sandboxed preload —
// so it is applied to main only (preload is built separately below).
await esbuild.build({
  ...common,
  entryPoints: { main: "src/main/main.ts" },
  banner: { js: "const import_meta_url = require('node:url').pathToFileURL(__filename).toString();" },
  define: { ...common.define, "import.meta.url": "import_meta_url" },
});

// Preload runs in the sandbox: no __filename, and it has no import.meta.url use.
await esbuild.build({
  ...common,
  entryPoints: { preload: "src/preload/preload.ts" },
});

// Copy the protocol/schema tree next to the bundled main process so the runtime's
// schema loader resolves its first candidate (`./schemas`) in BOTH the packaged
// app (inside app.asar) and dev — with no reliance on the repo layout. The files
// are plain JSON read via fs, which Electron serves transparently from inside asar.
const schemaSrc = fileURLToPath(new URL("../protocol/schema", import.meta.url));
const schemaDest = fileURLToPath(new URL("./dist/main/schemas", import.meta.url));
rmSync(schemaDest, { recursive: true, force: true });
cpSync(schemaSrc, schemaDest, { recursive: true });

console.log("[esbuild] main + preload bundled → dist/main (+ schemas/)");
