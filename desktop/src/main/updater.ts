// Auto-update via electron-updater. Flattens the updater lifecycle into a single
// UpdateStatus stream the renderer renders in Settings → About. Active only in
// packaged builds with a publish feed (electron-builder.yml `publish`); in dev
// there is no feed, so a manual check reports "not-available" rather than throwing.

import { app } from "electron";
import { autoUpdater } from "electron-updater";

import { type UpdateStatus } from "../shared/ipc";
import { getFlag, setFlag } from "./ui-flags";

type Send = (status: UpdateStatus) => void;
let send: Send = () => {};

// Fail-closed opt-in: absent flag ⇒ getFlag returns false ⇒ automatic updates are
// DISABLED by default. Nothing auto-downloads or installs unless the user turns
// this on in Settings. A renderer-side injection therefore cannot silently trigger
// an auto-update, and a fresh install never background-fetches until the user
// consents. (Signed-publisher / notarization VERIFICATION of the update payload is
// release-infra owned — tracked separately as R14-F03/R15 — and is deliberately
// NOT stubbed here; this flag only governs the automatic trigger.)
const AUTO_UPDATE_FLAG = "autoUpdateEnabled";

/** Whether automatic updates are enabled (persisted flag; default false). */
export function getAutoUpdate(): boolean {
  return getFlag(AUTO_UPDATE_FLAG);
}

/**
 * Persist the auto-update opt-in and apply it to electron-updater immediately so
 * the change takes effect this session (not just next launch). Turning it ON also
 * kicks a check — with autoDownload now true, that fetches + installs-on-quit.
 */
export function setAutoUpdate(enabled: boolean): void {
  setFlag(AUTO_UPDATE_FLAG, enabled);
  autoUpdater.autoDownload = enabled;
  autoUpdater.autoInstallOnAppQuit = enabled;
  if (enabled && app.isPackaged) void autoUpdater.checkForUpdates().catch(() => {});
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function initUpdater(sink: Send): void {
  send = sink;
  // Fail-closed: mirror the persisted opt-in. When disabled, autoDownload +
  // autoInstallOnAppQuit are false, so a manual "Check for updates" still SURFACES
  // availability but never downloads/installs without the user's explicit action.
  const enabled = getAutoUpdate();
  autoUpdater.autoDownload = enabled;
  autoUpdater.autoInstallOnAppQuit = enabled;
  // While we ship -beta/-rc builds, track the matching pre-release channel so a
  // beta updates to the next beta. Stable builds (no "-" in the version) only see
  // stable releases. Without this, GitHub's /releases/latest hides pre-releases,
  // so a beta build would find nothing and the check would surface as an error.
  autoUpdater.allowPrerelease = app.getVersion().includes("-");
  // electron-updater is chatty on its own logger; we forward status ourselves.
  autoUpdater.logger = null;

  autoUpdater.on("checking-for-update", () => send({ state: "checking" }));
  autoUpdater.on("update-available", (info) => send({ state: "available", version: String(info.version) }));
  autoUpdater.on("update-not-available", () => send({ state: "not-available" }));
  autoUpdater.on("download-progress", (p) => send({ state: "downloading", percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (info) => send({ state: "downloaded", version: String(info.version) }));
  autoUpdater.on("error", (err) => send({ state: "error", message: errMessage(err) }));

  // Quiet check on launch ONLY when the user opted in (packaged builds). Disabled
  // is the default → do nothing automatically on launch.
  if (app.isPackaged && enabled) void autoUpdater.checkForUpdates().catch(() => {});
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

/**
 * Manual download of the update the last check surfaced ("Update & restart").
 * This is the missing middle of the opted-OUT flow: with automatic updates
 * disabled a check stops at "available" and nothing in the app could move it
 * forward — the user saw the new version but had no way to install it.
 * Progress/completion arrive via the status stream; electron-updater requires
 * a prior check in this session, which the renderer guarantees by only
 * offering this action from the "available" state.
 */
export async function downloadUpdate(): Promise<void> {
  if (!app.isPackaged) {
    send({ state: "not-available" });
    return;
  }
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    send({ state: "error", message: errMessage(err) });
  }
}

/**
 * Quit and install a downloaded update (the "Restart & update" prompt). The
 * caller sets `isQuitting` first so the close-to-tray handler lets the quit
 * through (see main.ts); electron-updater then installs and relaunches. Windows
 * shows its installer briefly — that's fine, the user explicitly asked to update.
 */
export function quitAndInstall(): void {
  if (app.isPackaged) autoUpdater.quitAndInstall();
}
