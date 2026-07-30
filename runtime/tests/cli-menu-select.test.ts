// The arrow-key chooser (menu-select.ts), driven with scripted raw key
// sequences through a fake stdin — the panel's primary interaction
// (owner ask 2026-07-30: colors, scannable rows, ↑/↓ + Enter).

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { createAnsi } from "../src/cli/ansi";
import type { MenuFrame } from "../src/cli/commands/menu-frame";
import { selectMenuKey, type RawInput } from "../src/cli/commands/menu-select";
import type { HandlerEnv } from "../src/cli/shared";

interface FakeStdin extends RawInput {
  /** Feed one chunk of raw input, as the terminal would deliver it. */
  press(data: string): void;
  readonly rawModes: boolean[];
  pausedCount: number;
}

function fakeStdin(): FakeStdin {
  const ee = new EventEmitter();
  const fake: FakeStdin = {
    rawModes: [],
    pausedCount: 0,
    on: (event, cb) => ee.on(event, cb),
    removeListener: (event, cb) => ee.removeListener(event, cb),
    resume: () => undefined,
    pause: () => {
      fake.pausedCount += 1;
    },
    setEncoding: () => undefined,
    setRawMode: (on) => {
      fake.rawModes.push(on);
    },
    press: (data) => {
      ee.emit("data", data);
    },
  };
  return fake;
}

function makeEnv(): { env: HandlerEnv; out: () => string } {
  const chunks: string[] = [];
  const env = {
    stdout: (s: string) => chunks.push(s),
    stderr: (s: string) => chunks.push(s),
  } as unknown as HandlerEnv;
  return { env, out: () => chunks.join("") };
}

/** The real panel's shape: 14 numbered actions + the Quit row. */
function frame(over: Partial<MenuFrame> = {}): MenuFrame {
  return {
    title: "AIFight — what would you like to do?",
    banner: [],
    choices: [
      ...Array.from({ length: 14 }, (_, i) => ({ key: String(i + 1), label: `Action ${i + 1}` })),
      { key: "q", label: "Quit" },
    ],
    ...over,
  };
}

const PLAIN = createAnsi({ enabled: false });
const COLOR = createAnsi({ enabled: true });

describe("arrow-key chooser", () => {
  it("Enter runs the highlighted row (first by default)", async () => {
    const stdin = fakeStdin();
    const { env } = makeEnv();
    const picked = selectMenuKey(env, frame(), stdin, { ansi: PLAIN });
    stdin.press("\r");
    await expect(picked).resolves.toBe("1");
  });

  it("↓ then Enter picks the second row", async () => {
    const stdin = fakeStdin();
    const { env } = makeEnv();
    const picked = selectMenuKey(env, frame(), stdin, { ansi: PLAIN });
    stdin.press("\x1b[B");
    stdin.press("\r");
    await expect(picked).resolves.toBe("2");
  });

  it("several keys in one chunk all land (↓ ↓ Enter = third row)", async () => {
    const stdin = fakeStdin();
    const { env } = makeEnv();
    const picked = selectMenuKey(env, frame(), stdin, { ansi: PLAIN });
    stdin.press("\x1b[B\x1b[B\r");
    await expect(picked).resolves.toBe("3");
  });

  it("↑ wraps around to the last row — Quit, so pure-arrow usage can exit", async () => {
    const stdin = fakeStdin();
    const { env } = makeEnv();
    const picked = selectMenuKey(env, frame(), stdin, { ansi: PLAIN });
    stdin.press("\x1b[A");
    stdin.press("\r");
    await expect(picked).resolves.toBe("q");
  });

  it("q quits, and so do Esc, Ctrl-C and Ctrl-D", async () => {
    for (const key of ["q", "\x1b", "\x03", "\x04"]) {
      const stdin = fakeStdin();
      const { env } = makeEnv();
      const picked = selectMenuKey(env, frame(), stdin, { ansi: PLAIN });
      stdin.press(key);
      await expect(picked).resolves.toBe("q");
    }
  });

  it("a number key runs its row immediately, without Enter", async () => {
    const stdin = fakeStdin();
    const { env } = makeEnv();
    const picked = selectMenuKey(env, frame(), stdin, { ansi: PLAIN });
    stdin.press("5");
    await expect(picked).resolves.toBe("5");
  });

  it("multi-digit shortcuts still reach items 10-14: '1' then '4' runs 14", async () => {
    const stdin = fakeStdin();
    const { env } = makeEnv();
    const picked = selectMenuKey(env, frame(), stdin, { ansi: PLAIN, digitCommitMs: 5 });
    stdin.press("1");
    stdin.press("4");
    await expect(picked).resolves.toBe("14");
  });

  it("a lone ambiguous digit commits after a beat: '1' runs item 1", async () => {
    const stdin = fakeStdin();
    const { env } = makeEnv();
    const picked = selectMenuKey(env, frame(), stdin, { ansi: PLAIN, digitCommitMs: 5 });
    stdin.press("1");
    await expect(picked).resolves.toBe("1");
  });

  it("restores the terminal on the way out: raw mode off, stdin paused", async () => {
    const stdin = fakeStdin();
    const { env } = makeEnv();
    const picked = selectMenuKey(env, frame(), stdin, { ansi: PLAIN });
    stdin.press("q");
    await picked;
    expect(stdin.rawModes).toEqual([true, false]);
    expect(stdin.pausedCount).toBe(1);
  });

  it("erases the menu after a pick instead of leaving a frozen copy", async () => {
    const stdin = fakeStdin();
    const { env, out } = makeEnv();
    const picked = selectMenuKey(env, frame(), stdin, { ansi: PLAIN });
    stdin.press("q");
    await picked;
    expect(out()).toContain("\x1b[J"); // clear-from-cursor after moving back up
  });

  it("repaints in place: moving the cursor up + clearing lines, not re-scrolling", async () => {
    const stdin = fakeStdin();
    const { env, out } = makeEnv();
    const picked = selectMenuKey(env, frame(), stdin, { ansi: PLAIN });
    stdin.press("\x1b[B");
    stdin.press("q");
    await picked;
    // After the first draw, the ↓ redraw starts by going back up to the
    // first drawn line (CSI <n>F), then rewrites each line (CSI 2K).
    expect(out()).toContain("F\x1b[2K");
  });
});

describe("chooser colors", () => {
  it("with color on: ▸ row in inverse, numbers cyan, banner yellow, title bold", async () => {
    const stdin = fakeStdin();
    const { env, out } = makeEnv();
    const f = frame({ banner: ["⚠ NOT CLAIMED — this agent cannot play until you claim it."] });
    const picked = selectMenuKey(env, f, stdin, { ansi: COLOR });
    stdin.press("q");
    await picked;
    const text = out();
    expect(text).toContain("\x1b[7m"); // inverse on the selected row
    expect(text).toContain("\x1b[36m"); // cyan item numbers
    expect(text).toContain("\x1b[33m"); // yellow NOT CLAIMED banner
    expect(text).toContain("\x1b[1m"); // bold title
    expect(text).toContain("▸"); // the pointer
  });

  it("with color off (NO_COLOR & co.): no SGR color codes, layout intact", async () => {
    const stdin = fakeStdin();
    const { env, out } = makeEnv();
    const f = frame({ banner: ["⚠ NOT CLAIMED — this agent cannot play until you claim it."] });
    const picked = selectMenuKey(env, f, stdin, { ansi: PLAIN });
    stdin.press("q");
    await picked;
    const text = out();
    for (const sgr of ["\x1b[7m", "\x1b[36m", "\x1b[33m", "\x1b[1m", "\x1b[2m"]) {
      expect(text, `no color code ${JSON.stringify(sgr)}`).not.toContain(sgr);
    }
    expect(text).toContain("NOT CLAIMED");
    expect(text).toContain("14) Action 14");
    expect(text).toContain("▸"); // the pointer survives without color
  });
});

describe("ansi color gate", () => {
  it("colors only on a TTY with NO_COLOR unset and TERM != dumb", () => {
    expect(createAnsi({ isTTY: true, env: {} }).enabled).toBe(true);
    expect(createAnsi({ isTTY: false, env: {} }).enabled).toBe(false);
    expect(createAnsi({ isTTY: true, env: { NO_COLOR: "1" } }).enabled).toBe(false);
    expect(createAnsi({ isTTY: true, env: { NO_COLOR: "" } }).enabled).toBe(true); // empty = unset
    expect(createAnsi({ isTTY: true, env: { TERM: "dumb" } }).enabled).toBe(false);
  });
});
