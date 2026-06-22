// Tiny persisted UI flags (e.g. "have we shown the close-to-tray hint yet").
// Kept in its own small JSON in userData so it never races window-state.json.

import { app } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function flagsFile(): string {
  return path.join(app.getPath("userData"), "ui-flags.json");
}

function readAll(): Record<string, boolean> {
  try {
    const raw = JSON.parse(readFileSync(flagsFile(), "utf8")) as Record<string, unknown>;
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(raw)) if (v === true) out[k] = true;
    return out;
  } catch {
    return {};
  }
}

/** True only if this flag was previously persisted as true. */
export function getFlag(key: string): boolean {
  return readAll()[key] === true;
}

/** Best-effort persist; a failed write just means the flag resets next launch. */
export function setFlag(key: string, value: boolean): void {
  try {
    const all = readAll();
    all[key] = value;
    writeFileSync(flagsFile(), JSON.stringify(all));
  } catch {
    // best effort
  }
}
