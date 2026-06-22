// Electron main process entry.
//
// D1 scaffold: open a single clean window that loads the built renderer.
// D2: own the bridge engine (BridgeHost) and read the shared config on launch.
// D3 will replace the console callbacks below with real IPC channels.

import { app, BrowserWindow, ipcMain, Menu, shell } from "electron";
import path from "node:path";

import { BridgeHost } from "./bridge-host";
import { registerBridgeIpc } from "./ipc";
import { buildAppMenu } from "./menu";
import { loadWindowState, persistWindowState } from "./window-state";
import { initUpdater, checkForUpdates, quitAndInstall } from "./updater";
import { IPC } from "../shared/ipc";

// A stable product name for the macOS app menu, About panel, and userData folder.
// (In dev, app.name would otherwise be "Electron".) Set before the app is ready.
app.setName("AIFight");

// Windows toast notifications require the process AppUserModelID to match the
// Start-Menu shortcut's AUMID, which the NSIS installer sets to the
// electron-builder appId. Without this line, `new Notification(...)` in the
// renderer silently shows nothing on Windows 10/11. No-op on other platforms.
if (process.platform === "win32") app.setAppUserModelId("ai.aifight.desktop");

const WEB_BASE = "https://aifight.ai";

let mainWindow: BrowserWindow | null = null;

/** Push an event to the renderer, if a live window exists. */
function broadcast(channel: string, payload: unknown): void {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// The single owner of the bridge engine for this process. Constructed here but
// NOT started: starting opens a WebSocket to the platform and loads native
// modules, which is a user-driven action (the renderer invokes bridge:start via
// IPC). Its callbacks fan the four live streams out to the renderer.
const bridgeHost = new BridgeHost({
  onStatus: (status) => {
    const detail = status.message !== undefined ? ` — ${status.message}` : "";
    const agent = status.config !== undefined ? ` (${status.config.runtimeType}:${status.config.agentName})` : "";
    console.log(`[bridge] ${status.phase}${agent}${detail}`);
    broadcast(IPC.status, status);
  },
  onLog: (event) => broadcast(IPC.log, event),
  onTrace: (trace) => broadcast(IPC.trace, trace),
  onServerMessage: (message) => broadcast(IPC.serverMessage, message),
});

registerBridgeIpc(bridgeHost);

// Bring the window forward when an OS match notification is clicked. The renderer
// owns the notification (it has i18n + the live store); this just raises the app.
// Renderer→main, no payload — nothing sensitive crosses.
ipcMain.handle(IPC.focusWindow, () => {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// Auto-update controls (renderer Settings → About). Status is pushed back via
// IPC.updateStatus from initUpdater (wired in whenReady).
ipcMain.handle(IPC.updateCheck, () => checkForUpdates());
ipcMain.handle(IPC.updateInstall, () => quitAndInstall());

function createWindow(): void {
  // Restore the last window size/position (validated to be on-screen).
  const winState = loadWindowState({ width: 1240, height: 820 });
  mainWindow = new BrowserWindow({
    width: winState.width,
    height: winState.height,
    ...(winState.x !== undefined && winState.y !== undefined ? { x: winState.x, y: winState.y } : {}),
    minWidth: 960,
    minHeight: 620,
    backgroundColor: "#0e0e10",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    // Pin the macOS traffic lights to a known spot so the renderer can reserve a
    // matching top inset (see App.tsx TRAFFIC_INSET) and the logo never sits under
    // them. Ignored on non-darwin platforms.
    trafficLightPosition: { x: 14, y: 10 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Dev aid: surface the renderer's console in the terminal when running
  // `npm start`. Off in packaged builds (renderer logs go to its own devtools).
  if (!app.isPackaged) {
    mainWindow.webContents.on("console-message", (_event, _level, message) => {
      console.log(`[renderer] ${message}`);
    });
  }

  // Open external links (replay URLs, docs) in the user's browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  if (winState.isMaximized) mainWindow.maximize();
  persistWindowState(mainWindow);

  void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // Native About panel (shown by the app-menu "About AIFight" role).
  app.setAboutPanelOptions({
    applicationName: "AIFight",
    applicationVersion: app.getVersion(),
    copyright: "AIFight",
    website: WEB_BASE,
  });
  // Application menu: working Edit/clipboard roles, Preferences (⌘,) → Settings,
  // and Help links. The Preferences hook asks the renderer to switch views.
  Menu.setApplicationMenu(buildAppMenu({ navigate: (view) => broadcast(IPC.navigate, view) }));

  // Auto-update: forward the updater lifecycle to the renderer; check on launch
  // (packaged builds only — see updater.ts).
  initUpdater((status) => broadcast(IPC.updateStatus, status));

  createWindow();
  // Desktop lifecycle (D11): opening the app === going online. There is no manual
  // online/offline toggle — if this machine is already configured we auto-connect
  // on launch, and (when a daily auto-match cap is set) enter automatic matchmaking
  // so the platform can pull us into matches up to that cap at its own pace.
  // Unconfigured → stay offline; the renderer shows onboarding. A failed start
  // surfaces as phase "error" for the UI. Matching always starts un-paused; the
  // renderer's "pause matching" toggle is session-only and resets each launch.
  const summary = bridgeHost.readConfigSummary();
  if (summary.config !== undefined) {
    const status = await bridgeHost.start();
    if (status.phase === "running") await bridgeHost.joinAutoMatch();
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // Standard macOS behavior: keep the app alive until Cmd+Q.
  if (process.platform !== "darwin") app.quit();
});
