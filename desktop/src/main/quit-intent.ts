// D6b (windows-loop R12, P3) — the isQuitting latch, extracted so its one
// nontrivial transition is testable without Electron.
//
// The window's close handler hides to tray unless a quit is in flight. "In
// flight" used to be a single one-way boolean set in three places, and the
// updateInstall path exposed the flaw: the handler must pre-set it because
// electron-updater's quitAndInstall CLOSES ALL WINDOWS FIRST and only fires
// before-quit afterwards — so when the install then fails (the macOS Squirrel
// failure path), no quit ever happens and the latch stays true for the rest of
// the session. From then on every ✕ genuinely destroys the window (live cockpit
// state lost) instead of hiding to the tray.
//
// The fix resets the latch when the updater reports an error — but ONLY the
// install-requested half of it. The obvious unconditional reset has a race the
// R12 double-review called out: a background update check failing in the window
// between before-quit and window-close would clear the latch mid-quit, the
// close handler would preventDefault, and Electron cancels the whole quit — a
// swallowed ⌘Q. Keeping REAL quits (before-quit, tray Quit) on their own
// unresettable latch confines the reset to exactly the state the error belongs
// to.

export interface QuitIntent {
  /** The close handler's question: let this close through, or hide to tray? */
  isQuitting(): boolean;
  /** A genuine exit: before-quit / tray Quit. Never rolled back. */
  markRealQuit(): void;
  /** "Restart & update" was clicked; quitAndInstall is about to close windows. */
  markInstallRequested(): void;
  /**
   * The updater surfaced an error. If an install was the only reason we were
   * letting closes through, stop letting them through — the install did not
   * happen and the session continues. A real quit in flight is untouched.
   */
  onUpdaterError(): void;
}

export function createQuitIntent(): QuitIntent {
  let realQuit = false;
  let installQuit = false;
  return {
    isQuitting: () => realQuit || installQuit,
    markRealQuit: () => {
      realQuit = true;
    },
    markInstallRequested: () => {
      installQuit = true;
    },
    onUpdaterError: () => {
      installQuit = false;
    },
  };
}
