// The application menu. Electron shows a minimal default menu when you set none,
// which on macOS omits a proper Edit menu — so Cmd+C / Cmd+V / Cmd+X stop working
// in our config text inputs. This builds the standard menu (with working clipboard
// roles), a native About entry, a Preferences item (⌘,) that jumps to Settings,
// and Help links into the website. Role-based items auto-localize to the OS
// language on macOS; the few custom items are English (menus are secondary chrome).

import { app, Menu, shell, type MenuItemConstructorOptions } from "electron";

const WEB_BASE = "https://aifight.ai";

export interface AppMenuHooks {
  /** Ask the renderer to switch to a view (e.g. "settings"). */
  navigate: (view: string) => void;
}

export function buildAppMenu(hooks: AppMenuHooks): Menu {
  const isMac = process.platform === "darwin";
  const openExternal = (url: string): void => void shell.openExternal(url);

  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Preferences…", accelerator: "CmdOrCtrl+,", click: () => hooks.navigate("settings") },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  } else {
    template.push({
      label: "File",
      submenu: [
        { label: "Settings", accelerator: "CmdOrCtrl+,", click: () => hooks.navigate("settings") },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  // Edit — clipboard + undo/redo. Without this, macOS apps lose Cmd+C/V/X in inputs.
  template.push({ role: "editMenu" });

  // View — reload + zoom + fullscreen; devtools only in unpackaged dev runs.
  template.push({
    label: "View",
    submenu: [
      { role: "reload" },
      { role: "forceReload" },
      ...(!app.isPackaged ? [{ role: "toggleDevTools" } as MenuItemConstructorOptions] : []),
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  });

  template.push({ role: "windowMenu" });

  template.push({
    role: "help",
    submenu: [
      { label: "Quick Start", click: () => openExternal(`${WEB_BASE}/quickstart`) },
      { label: "Documentation", click: () => openExternal(`${WEB_BASE}/developer`) },
      { label: "Open Dashboard", click: () => openExternal(`${WEB_BASE}/dashboard`) },
      ...(isMac
        ? []
        : [
            { type: "separator" } as MenuItemConstructorOptions,
            { role: "about" } as MenuItemConstructorOptions,
          ]),
    ],
  });

  return Menu.buildFromTemplate(template);
}
