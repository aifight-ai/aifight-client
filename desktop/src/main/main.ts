// Electron main process entry.
//
// D1 scaffold: open a single clean window that loads the built renderer.
// D2: own the bridge engine (BridgeHost) and read the shared config on launch.
// D3 will replace the console callbacks below with real IPC channels.

import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, shell, Tray } from "electron";
import path from "node:path";

import { BridgeHost } from "./bridge-host";
import { registerBridgeIpc } from "./ipc";
import { authorizeIpcSender } from "./ipc-guard";
import { getTrustedRendererUrl } from "./trusted-url";
import { buildAppMenu } from "./menu";
import { loadWindowState, persistWindowState } from "./window-state";
import { getFlag, setFlag } from "./ui-flags";
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

/**
 * Origin-anchored allowlist for URLs we hand to the OS browser (shell.openExternal).
 * A renderer-side injection or an accidental navigation must NOT be able to
 * exfiltrate data via an arbitrary external URL, so a naive `startsWith("https://")`
 * check is not enough (it would open https://evil.example/?leak=…). We require:
 *   - https only (no http, file:, custom schemes),
 *   - the origin to EXACTLY equal the canonical platform origin (aifight.ai),
 *   - no embedded credentials (userinfo), which browsers can use for phishing,
 *   - a sane length cap.
 * Dev / self-host origins are intentionally NOT opened externally — the app's own
 * external links (replay/docs/dashboard) always live on the platform origin, and
 * widening this to a configured baseUrl is not worth the extra attack surface here.
 */
function isAllowedExternalUrl(raw: string): boolean {
  if (typeof raw !== "string" || raw.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  return url.origin === new URL(WEB_BASE).origin;
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
// Set on before-quit so the window's "close" handler can tell a real exit
// (tray "Quit" / ⌘Q / app menu) from a close-to-tray, and let it through.
let isQuitting = false;
app.on("before-quit", () => {
  isQuitting = true;
});

// Single instance: a second launch (double-click while already running in the
// tray, or an updater relaunch racing a manual open) must not spawn a second
// process and a second menu-bar icon. The first instance keeps the lock; any
// later one exits immediately and just re-focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());
}

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
ipcMain.handle(IPC.focusWindow, (event) => {
  if (!authorizeIpcSender(event)) throw new Error("unauthorized ipc sender");
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// Auto-update controls (renderer Settings → About). Status is pushed back via
// IPC.updateStatus from initUpdater (wired in whenReady).
ipcMain.handle(IPC.updateCheck, (event) => {
  if (!authorizeIpcSender(event)) throw new Error("unauthorized ipc sender");
  return checkForUpdates();
});
ipcMain.handle(IPC.updateInstall, (event) => {
  if (!authorizeIpcSender(event)) throw new Error("unauthorized ipc sender");
  // "Restart & update" is a real exit, not a close-to-tray. Without this flag the
  // window's close handler would preventDefault + hide, so electron-updater's
  // quit-to-install never completes and the app merely vanishes to the tray
  // (the update then only applies on the next genuine quit). Setting isQuitting
  // lets the quit through so the update installs and the app relaunches now.
  isQuitting = true;
  quitAndInstall();
});

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
  // Only origin-allowlisted https URLs on the platform origin ever reach the OS
  // browser; everything else is denied (and never opened).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  // Navigation lock: this single packaged window only ever renders our bundled
  // page. A renderer-side injection (or an accidental in-page navigation to
  // untrusted content) must not be able to point the top frame — or any subframe
  // — at another origin and inherit the preload bridge. Pin every navigation to
  // the exact trusted renderer URL, and deny embedding a <webview>. loadFile
  // (below) is a programmatic load, not a "navigation", so it is unaffected.
  const trustedRendererUrl = getTrustedRendererUrl();
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== trustedRendererUrl) event.preventDefault();
  });
  mainWindow.webContents.on("will-frame-navigate", (event) => {
    if (event.url !== trustedRendererUrl) event.preventDefault();
  });
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());

  if (winState.isMaximized) mainWindow.maximize();
  persistWindowState(mainWindow);

  void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));

  // Closing the window (red X / Alt+F4) hides it to the tray / menu bar rather
  // than quitting, so the bridge keeps the agent online in the background. A real
  // exit (tray "Quit" / ⌘Q / app menu) sets isQuitting via before-quit, which lets
  // this close proceed. Telegram/Slack-style background behavior.
  mainWindow.on("close", (event) => {
    if (!isQuitting && mainWindow !== null) {
      event.preventDefault();
      mainWindow.hide();
      maybeShowBackgroundHint();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/** Bring the main window back from the tray / menu bar (recreate if needed). */
function showMainWindow(): void {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** A tray / menu-bar presence so the app stays reachable while its window is hidden. */
function createTray(): void {
  if (tray !== null) return;
  // macOS: a black-on-transparent "…Template" image the menu bar tints for
  // light/dark automatically. Windows/Linux: the full-color app mark.
  const iconRel = process.platform === "darwin" ? "tray/trayTemplate.png" : "tray/tray.png";
  const image = nativeImage.createFromPath(path.join(__dirname, iconRel));
  tray = new Tray(image);
  tray.setToolTip("AIFight");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open AIFight", click: () => showMainWindow() },
      { type: "separator" },
      {
        label: "Quit AIFight",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  // Windows/Linux: left-click reopens (right-click shows the menu). macOS pops the
  // menu on click by default, so no extra click handler is needed there.
  if (process.platform !== "darwin") {
    tray.on("click", () => showMainWindow());
  }
}

/** One-time nudge so the first window-close doesn't read as a quit. */
function maybeShowBackgroundHint(): void {
  if (getFlag("backgroundHintShown")) return;
  setFlag("backgroundHintShown", true);
  if (!Notification.isSupported()) return;
  const body =
    process.platform === "darwin"
      ? "AIFight is still running so your agent stays online. Reopen it from the Dock or the menu-bar icon; quit with ⌘Q."
      : "AIFight is still running in the system tray so your agent stays online. Click the tray icon to reopen it, or right-click to quit.";
  new Notification({ title: "AIFight is still running", body }).show();
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
  createTray();
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
    // Dock click (macOS) or relaunch — bring the window back from the tray.
    showMainWindow();
  });
});

app.on("window-all-closed", () => {
  // The app stays alive in the tray / menu bar after its window is closed (so the
  // agent stays online); quitting is always explicit (tray "Quit" / ⌘Q / app menu)
  // and routes through before-quit. So never auto-quit here, on any platform — an
  // empty handler also overrides Electron's default quit-on-all-closed.
});
