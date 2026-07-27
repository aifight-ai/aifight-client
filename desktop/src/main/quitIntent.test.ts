// D6b (windows-loop R12) — the isQuitting latch semantics. What can be pinned
// headlessly is the decision logic; the end-to-end trigger (a real macOS
// Squirrel install failure) needs a real machine and is honestly out of scope
// here — see the module comment in quit-intent.ts and the wiring in main.ts.

import { describe, expect, it } from "vitest";

import { createQuitIntent } from "./quit-intent";

describe("quit intent latch (close-to-tray vs real close)", () => {
  it("starts as not-quitting: a plain ✕ hides to tray", () => {
    expect(createQuitIntent().isQuitting()).toBe(false);
  });

  it("recovers close-to-tray after a failed install (the R12 bug)", () => {
    const q = createQuitIntent();
    q.markInstallRequested();
    expect(q.isQuitting(), "quitAndInstall closes windows BEFORE before-quit fires").toBe(true);
    // Squirrel failed; the app is still running. Before this reset existed the
    // latch stayed true for the rest of the session and every later ✕ destroyed
    // the window instead of hiding it.
    q.onUpdaterError();
    expect(q.isQuitting()).toBe(false);
  });

  it("never rolls back a real quit (the race the double-review flagged)", () => {
    // ⌘Q in flight; a background update check happens to fail in the window
    // between before-quit and window-close. An unconditional reset here would
    // preventDefault the close and Electron cancels the whole quit — a
    // swallowed ⌘Q. The real-quit latch must be untouchable by updater errors.
    const q = createQuitIntent();
    q.markRealQuit();
    q.onUpdaterError();
    expect(q.isQuitting()).toBe(true);
  });

  it("keeps a real quit through a concurrent failed install", () => {
    // User clicked "Restart & update", it failed, and they then quit for real
    // (or the orders interleave the other way). Whatever the interleaving, a
    // real quit stays a quit.
    const q = createQuitIntent();
    q.markInstallRequested();
    q.markRealQuit();
    q.onUpdaterError();
    expect(q.isQuitting()).toBe(true);
  });

  it("a retried install re-arms the latch after an earlier failure", () => {
    const q = createQuitIntent();
    q.markInstallRequested();
    q.onUpdaterError();
    q.markInstallRequested();
    expect(q.isQuitting()).toBe(true);
  });

  it("an updater error with nothing in flight changes nothing", () => {
    // Background check failures are routine (offline laptop); they must not
    // leave any residue on quit behaviour.
    const q = createQuitIntent();
    q.onUpdaterError();
    expect(q.isQuitting()).toBe(false);
    q.markRealQuit();
    expect(q.isQuitting()).toBe(true);
  });
});
