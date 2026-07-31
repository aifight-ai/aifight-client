// The checkbox multi-select (select-multi.ts), driven with scripted raw key
// sequences through a fake stdin — the games picker's interaction (V3 design
// §1: space toggles, Enter confirms, a rejected confirm shows a yellow inline
// message and picking continues).

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { createAnsi } from "../src/cli/ansi";
import type { RawInput } from "../src/cli/commands/menu-select";
import { selectMulti, type MultiSelectSpec } from "../src/cli/commands/select-multi";
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

function spec(over: Partial<MultiSelectSpec> = {}): MultiSelectSpec {
  return {
    title: "Games to auto-play:",
    items: [
      { label: "Texas Hold'em", hint: "poker", checked: true },
      { label: "Liar's Dice", hint: "dice", checked: true },
      { label: "Coup", hint: "roles", checked: false },
    ],
    ...over,
  };
}

const PLAIN = createAnsi({ enabled: false });
const COLOR = createAnsi({ enabled: true });

describe("checkbox multi-select", () => {
  it("Enter confirms the pre-checked rows", async () => {
    const stdin = fakeStdin();
    const { env, out } = makeEnv();
    const picked = selectMulti(env, spec(), stdin, { ansi: PLAIN });
    stdin.press("\r");
    await expect(picked).resolves.toEqual([0, 1]);
    expect(out()).toContain("[x] Texas Hold'em");
    expect(out()).toContain("[ ] Coup");
  });

  it("space toggles the highlighted row, then Enter confirms the new set", async () => {
    const stdin = fakeStdin();
    const { env } = makeEnv();
    const picked = selectMulti(env, spec(), stdin, { ansi: PLAIN });
    stdin.press("\x1b[B"); // down to Liar's Dice
    stdin.press("\x1b[B"); // down to Coup
    stdin.press(" "); // check Coup
    stdin.press("\r");
    await expect(picked).resolves.toEqual([0, 1, 2]);
  });

  it("toggling a checked row OFF removes it from the result", async () => {
    const stdin = fakeStdin();
    const { env, out } = makeEnv();
    const picked = selectMulti(env, spec(), stdin, { ansi: PLAIN });
    stdin.press(" "); // uncheck Texas Hold'em
    stdin.press("\r");
    await expect(picked).resolves.toEqual([1]);
    expect(out()).toContain("[ ] Texas Hold'em");
  });

  it("↑ wraps to the last row", async () => {
    const stdin = fakeStdin();
    const { env } = makeEnv();
    const picked = selectMulti(env, spec(), stdin, { ansi: PLAIN });
    stdin.press("\x1b[A"); // wrap to Coup
    stdin.press(" ");
    stdin.press("\r");
    await expect(picked).resolves.toEqual([0, 1, 2]);
  });

  it("q, Esc, Ctrl-C and Ctrl-D all cancel with null", async () => {
    for (const key of ["q", "Q", "\x1b", "\x03", "\x04"]) {
      const stdin = fakeStdin();
      const { env } = makeEnv();
      const picked = selectMulti(env, spec(), stdin, { ansi: PLAIN });
      stdin.press(key);
      await expect(picked).resolves.toBeNull();
    }
  });

  it("a rejected confirm shows the message inline and keeps picking", async () => {
    const stdin = fakeStdin();
    const { env, out } = makeEnv();
    const picked = selectMulti(
      env,
      spec({
        validate: (selected) => (selected.length === 0 ? "select at least 1" : undefined),
      }),
      stdin,
      { ansi: PLAIN },
    );
    stdin.press(" "); // uncheck #1
    stdin.press("\x1b[B ");
    stdin.press("\r"); // zero selected → rejected
    await Promise.resolve();
    expect(out()).toContain("select at least 1");
    stdin.press(" "); // re-check #2 (still highlighted)
    stdin.press("\r");
    await expect(picked).resolves.toEqual([1]);
  });

  it("a new toggle clears the rejection message", async () => {
    const stdin = fakeStdin();
    const { env, out } = makeEnv();
    const picked = selectMulti(
      env,
      spec({ validate: () => "still wrong" }),
      stdin,
      { ansi: PLAIN },
    );
    stdin.press("\r"); // rejected
    await Promise.resolve();
    stdin.press(" "); // toggle clears the message, redraws
    await Promise.resolve();
    // The last drawn block must not carry the message anymore.
    const tail = out().split("still wrong");
    expect(tail.length).toBe(2); // appeared exactly once (not repainted after the toggle)
    stdin.press("\x1b"); // cancel to settle the promise
    await expect(picked).resolves.toBeNull();
  });

  it("restores the terminal on the way out: raw mode off, stdin paused", async () => {
    const stdin = fakeStdin();
    const { env } = makeEnv();
    const picked = selectMulti(env, spec(), stdin, { ansi: PLAIN });
    stdin.press("\r");
    await picked;
    expect(stdin.rawModes).toEqual([true, false]);
    expect(stdin.pausedCount).toBe(1);
  });

  it("erases the picker on the way out and repaints in place while picking", async () => {
    const stdin = fakeStdin();
    const { env, out } = makeEnv();
    const picked = selectMulti(env, spec(), stdin, { ansi: PLAIN });
    stdin.press(" "); // one repaint: moves up the drawn block first
    await Promise.resolve();
    expect(out()).toContain("\x1b[8F"); // blank + title + 3 rows + blank + reserved + nav = 8
    stdin.press("\r");
    await picked;
    expect(out()).toContain("\x1b[J"); // block erased
    expect(out()).toContain("\x1b[?25h"); // cursor back on
  });

  it("styles the boxes and the selected row when colors are on", async () => {
    const stdin = fakeStdin();
    const { env, out } = makeEnv();
    const picked = selectMulti(env, spec(), stdin, { ansi: COLOR });
    await Promise.resolve();
    expect(out()).toContain("\x1b[32m[x]\x1b[39m"); // green checked box
    expect(out()).toContain("\x1b[2m[ ]\x1b[22m"); // dim unchecked box
    expect(out()).toContain("\x1b[7m"); // inverse selected row
    stdin.press("\r");
    await picked;
  });

  it("uses the spec's nav hint, or the i18n default (zh here)", async () => {
    const stdin = fakeStdin();
    const { env, out } = makeEnv();
    const custom = selectMulti(env, spec({ navHint: "  custom hint" }), stdin, { ansi: PLAIN });
    await Promise.resolve();
    expect(out()).toContain("custom hint");
    stdin.press("\x1b");
    await custom;

    const stdin2 = fakeStdin();
    const { env: env2, out: out2 } = makeEnv();
    const dflt = selectMulti(env2, spec(), stdin2, { ansi: PLAIN, locale: "zh" });
    await Promise.resolve();
    expect(out2()).toContain("↑/↓ 移动 · 空格 选中/取消 · Enter 确认 · q 取消");
    stdin2.press("\x1b");
    await dflt;
  });
});
