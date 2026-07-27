// Single source of truth for the ONE URL our main-frame renderer is ever allowed
// to be: the bundled renderer entry loaded via BrowserWindow.loadFile. Both the
// navigation lock (main.ts) and the IPC sender guard (ipc-guard.ts) compare
// against this exact file:// href, so "is this really our trusted renderer?" has
// a single definition. We compare the FRAME URL — not the BrowserWindow object —
// because the window is recreatable (tray reopen) while the trusted page URL is
// stable, which sidesteps the stale-`mainWindow`-binding coupling problem.

import path from "node:path";
import { pathToFileURL } from "node:url";

/** The path, relative to dist/main, that main.ts hands to loadFile. */
export const RENDERER_ENTRY_RELATIVE = "../renderer/index.html";

/**
 * The file:// URL of the packaged renderer's index.html. Mirrors main.ts's
 * `loadFile(path.join(__dirname, "../renderer/index.html"))` — from dist/main to
 * dist/renderer/index.html — so it equals the committed URL of the loaded page.
 *
 * pathToFileURL (not string concatenation) is load-bearing on Windows, where the
 * install path is routinely `C:\Program Files\...`: Chromium reports the frame
 * URL percent-encoded (`Program%20Files`) with forward slashes, so a hand-built
 * `"file://" + dir` would never match and EVERY ipc call would be rejected — the
 * app would look bricked with a correct-looking guard.
 *
 * baseDir exists only so tests can pin that encoding without relocating dist.
 */
export function getTrustedRendererUrl(baseDir: string = __dirname): string {
  return pathToFileURL(path.join(baseDir, RENDERER_ENTRY_RELATIVE)).href;
}
