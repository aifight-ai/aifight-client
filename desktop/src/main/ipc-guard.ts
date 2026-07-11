// IPC sender authorization (defense-in-depth for the renderer→main boundary).
//
// The renderer is sandboxed (contextIsolation + sandbox) and only ever loads our
// bundled page, but a renderer-side injection — or an accidental navigation to
// untrusted content that then slips a frame past the navigation lock — must NOT
// be able to invoke main-process capabilities. Every ipcMain.handle in this app
// is wrapped so it runs ONLY when the call originates from the top frame of our
// trusted renderer page. We compare the sender FRAME's URL against the single
// source of truth (trusted-url.ts), never the recreatable window object.

import type { IpcMainInvokeEvent } from "electron";

import { getTrustedRendererUrl } from "./trusted-url";

/**
 * True only when an IPC invoke originates from the top frame of OUR trusted
 * renderer page. A subframe, a navigated-away top frame, or any other sender
 * fails. Callers throw on false so the renderer sees a rejected invoke rather
 * than a silently-executed privileged action.
 */
export function authorizeIpcSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  if (frame === null || frame === undefined) return false;
  // Top frame only: a nested frame (even same-URL) is not our privileged page.
  if (frame.parent !== null && frame.parent !== undefined) return false;
  return frame.url === getTrustedRendererUrl();
}
