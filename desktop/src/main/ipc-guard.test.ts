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
import fs from "node:fs";
import path from "node:path";

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

// ---------------------------------------------------------------------------
// E5 (windows-loop). The tests above pin that the guard DECIDES correctly. They
// say nothing about whether it is actually ASKED — and that is the regression
// with teeth: a new `ipcMain.handle` added without the wrapper is a privileged
// main-process capability reachable by any frame, and every existing test still
// passes. So walk the source and account for every registration.

const REGISTRATION_RE = /ipcMain\.(handle|on)\(([^,]+),/;

/**
 * Registration sites, each with the lines up to the NEXT registration.
 *
 * The window must stop there. A fixed lookahead reads into the following
 * handler's guard, and a short unguarded handler then passes on its neighbour's
 * check — which is exactly what this test exists to catch (found by mutation:
 * stripping the guard off a 3-line handler went undetected).
 */
function ipcRegistrations(): { file: string; channel: string; body: string }[] {
  const dir = __dirname;
  const out: { file: string; channel: string; body: string }[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const lines = fs.readFileSync(path.join(dir, file), "utf8").split("\n");
    const starts = lines.flatMap((line, i) => (REGISTRATION_RE.test(line) ? [i] : []));
    starts.forEach((start, n) => {
      const end = Math.min(starts[n + 1] ?? lines.length, start + 12);
      out.push({
        file,
        channel: REGISTRATION_RE.exec(lines[start])![2].trim(),
        body: lines.slice(start, end).join("\n"),
      });
    });
  }
  return out;
}

describe("every renderer→main registration is behind the guard", () => {
  it("finds registrations at all (the scan must not silently match nothing)", () => {
    expect(ipcRegistrations().length).toBeGreaterThan(0);
  });

  it("has each registration call authorizeIpcSender before doing anything", () => {
    for (const reg of ipcRegistrations()) {
      // ipc.ts registers through its local `handle` wrapper; the ONE raw
      // ipcMain.handle there is that wrapper itself, and it guards inline. Any
      // other raw registration must guard inline too.
      expect(
        reg.body.includes("authorizeIpcSender"),
        `${reg.file}: ipcMain registration for ${reg.channel} does not check authorizeIpcSender — ` +
          `it is reachable from any frame. Register it through ipc.ts's handle() wrapper, or guard it inline.`,
      ).toBe(true);
    }
  });

  it("keeps ipc.ts's bypass surface at exactly the one wrapper", () => {
    // ipc.ts holds most channels. If a second raw ipcMain.handle ever appears
    // there it is a channel that skipped the wrapper — the check above would
    // still pass if the guard happened to sit within six lines for another
    // reason, so count them too.
    const src = fs.readFileSync(path.join(__dirname, "ipc.ts"), "utf8");
    const raw = src.match(/ipcMain\.handle\(/g) ?? [];
    expect(raw.length, "ipc.ts should call ipcMain.handle exactly once: inside its handle() wrapper").toBe(1);
    const wrapped = src.match(/^\s{2}handle\(IPC\./gm) ?? [];
    expect(wrapped.length, "no channels registered through the wrapper — did it get renamed?").toBeGreaterThan(10);
  });
});
