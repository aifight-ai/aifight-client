// Auto-update via electron-updater. Flattens the updater lifecycle into a single
// UpdateStatus stream the renderer renders in Settings → About. Active only in
// packaged builds with a publish feed (electron-builder.yml `publish`); in dev
// there is no feed, so a manual check reports "not-available" rather than throwing.

import { app } from "electron";
import { autoUpdater } from "electron-updater";

import { type UpdateStatus } from "../shared/ipc";

type Send = (status: UpdateStatus) => void;
let send: Send = () => {};

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function initUpdater(sink: Send): void {
  send = sink;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // electron-updater is chatty on its own logger; we forward status ourselves.
  autoUpdater.logger = null;

  autoUpdater.on("checking-for-update", () => send({ state: "checking" }));
  autoUpdater.on("update-available", (info) => send({ state: "available", version: String(info.version) }));
  autoUpdater.on("update-not-available", () => send({ state: "not-available" }));
  autoUpdater.on("download-progress", (p) => send({ state: "downloading", percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (info) => send({ state: "downloaded", version: String(info.version) }));
  autoUpdater.on("error", (err) => send({ state: "error", message: errMessage(err) }));

  // Quiet check on launch in packaged builds (auto-download, install on quit).
  if (app.isPackaged) void autoUpdater.checkForUpdates().catch(() => {});
}

/** Manual "Check for updates" from the renderer. No-op-with-status in dev. */
export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) {
    send({ state: "not-available" });
    return;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    send({ state: "error", message: errMessage(err) });
  }
}

/** Quit and install a downloaded update (renderer "Restart & update"). */
export function quitAndInstall(): void {
  if (app.isPackaged) autoUpdater.quitAndInstall();
}
