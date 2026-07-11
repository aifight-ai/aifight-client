// R14-F01 — IPC sender authorization. Every renderer→main handler is wrapped so
// it runs ONLY for a call from the TOP frame of our trusted renderer page. This
// pins that authorizeIpcSender accepts exactly that case and rejects everything
// else (untrusted URL, subframe, missing frame) — a renderer-side injection or a
// stray frame must not be able to reach a main-process capability.
//
// Runs in node (vitest): ipc-guard imports only trusted-url (node builtins) +
// a type-only electron import (erased), so no electron runtime is needed.

import { describe, expect, it } from "vitest";
import type { IpcMainInvokeEvent } from "electron";

import { authorizeIpcSender } from "./ipc-guard";
import { getTrustedRendererUrl } from "./trusted-url";

/** A fake invoke event carrying just the senderFrame fields the guard reads. */
function fakeEvent(frame: { url?: string; parent?: unknown } | null): IpcMainInvokeEvent {
  return { senderFrame: frame } as unknown as IpcMainInvokeEvent;
}

describe("authorizeIpcSender (renderer→main sender authorization)", () => {
  const trusted = getTrustedRendererUrl();

  it("accepts a call from the top frame of the trusted renderer URL", () => {
    expect(authorizeIpcSender(fakeEvent({ url: trusted, parent: null }))).toBe(true);
  });

  it("rejects a call from a different (untrusted) URL", () => {
    expect(authorizeIpcSender(fakeEvent({ url: "https://evil.example.com/", parent: null }))).toBe(false);
    expect(authorizeIpcSender(fakeEvent({ url: "file:///etc/passwd", parent: null }))).toBe(false);
    expect(authorizeIpcSender(fakeEvent({ url: trusted + "?x=1", parent: null }))).toBe(false);
  });

  it("rejects a subframe even when its URL matches the trusted page", () => {
    // A nested frame (parent present) is not our privileged top frame, even if it
    // somehow carries the same URL.
    expect(authorizeIpcSender(fakeEvent({ url: trusted, parent: { url: trusted } }))).toBe(false);
  });

  it("rejects when there is no sender frame", () => {
    expect(authorizeIpcSender(fakeEvent(null))).toBe(false);
    expect(authorizeIpcSender(fakeEvent({ parent: null }))).toBe(false); // url undefined
  });
});
