// Persist the main window's size, position, and maximized state across launches.
// Electron has no built-in for this; we keep a small JSON in userData and validate
// that saved bounds still land on a connected display before restoring them (so a
// window saved on a now-disconnected monitor never opens off-screen).

import { app, screen, type BrowserWindow } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized: boolean;
}

function stateFile(): string {
  return path.join(app.getPath("userData"), "window-state.json");
}

/** Read saved bounds, falling back to defaults. Off-screen positions are dropped. */
export function loadWindowState(defaults: { width: number; height: number }): WindowState {
  try {
    const raw = JSON.parse(readFileSync(stateFile(), "utf8")) as Partial<WindowState>;
    const width = typeof raw.width === "number" && raw.width >= 480 ? raw.width : defaults.width;
    const height = typeof raw.height === "number" && raw.height >= 360 ? raw.height : defaults.height;
    const state: WindowState = { width, height, isMaximized: raw.isMaximized === true };
    if (typeof raw.x === "number" && typeof raw.y === "number") {
      const area = screen.getDisplayMatching({ x: raw.x, y: raw.y, width, height }).workArea;
      const onScreen =
        raw.x + width > area.x &&
        raw.x < area.x + area.width &&
        raw.y + height > area.y &&
        raw.y < area.y + area.height;
      if (onScreen) {
        state.x = raw.x;
        state.y = raw.y;
      }
    }
    return state;
  } catch {
    return { width: defaults.width, height: defaults.height, isMaximized: false };
  }
}

/** Save the window's bounds on resize/move/close (debounced). */
export function persistWindowState(window: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = (): void => {
    if (window.isDestroyed()) return;
    const isMaximized = window.isMaximized();
    // getNormalBounds() is the restored (un-maximized) rect — what we want to
    // reopen at next launch even if the window is currently maximized.
    const b = window.getNormalBounds();
    const state: WindowState = { width: b.width, height: b.height, x: b.x, y: b.y, isMaximized };
    try {
      writeFileSync(stateFile(), JSON.stringify(state));
    } catch {
      // Best effort — a failed write just means we restore defaults next time.
    }
  };
  const debounced = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  window.on("resize", debounced);
  window.on("move", debounced);
  window.on("close", save);
}
