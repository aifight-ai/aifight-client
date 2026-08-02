// pickOneKey — the P1 primitive's shared chooser/line entry (统一交互规范 §2).

import { describe, expect, it } from "vitest";

import { pickOneKey, type PickOneDeps } from "../src/cli/commands/pick-one";
import type { MenuFrame } from "../src/cli/commands/menu-frame";

const FRAME: MenuFrame = {
  title: "Pick a game",
  banner: [],
  choices: [
    { key: "1", main: "Texas Hold'em" },
    { key: "2", main: "Coup" },
    { key: "q", main: "Back" },
  ],
};

function lineDeps(answers: string[]): { deps: PickOneDeps; out: () => string } {
  const chunks: string[] = [];
  let i = 0;
  return {
    out: () => chunks.join(""),
    deps: {
      env: { stdout: (s: string) => chunks.push(s), stderr: (s: string) => chunks.push(s) } as never,
      locale: "en",
      prompt: () => Promise.resolve(answers[i++] ?? ""),
    },
  };
}

describe("pickOneKey", () => {
  it("line fallback prints the frame once and resolves a valid number", async () => {
    const { deps, out } = lineDeps(["2"]);
    expect(await pickOneKey(deps, FRAME)).toBe("2");
    expect(out()).toContain("Pick a game");
    expect(out()).toContain("1) Texas Hold'em");
  });

  it("line fallback re-asks on an unknown answer instead of cancelling", async () => {
    const { deps, out } = lineDeps(["7", "1"]);
    expect(await pickOneKey(deps, FRAME)).toBe("1");
    expect(out()).toContain("Unknown choice '7'");
  });

  it("q, blank, and exhausted scripts all cancel with null", async () => {
    for (const answers of [["q"], [""], []]) {
      const { deps } = lineDeps(answers);
      expect(await pickOneKey(deps, FRAME)).toBeNull();
    }
  });

  it("chooser path forwards the frame and normalizes q to null", async () => {
    const seen: MenuFrame[] = [];
    const base = lineDeps([]).deps;
    const choose = (frame: MenuFrame): Promise<string> => {
      seen.push(frame);
      return Promise.resolve("Q");
    };
    expect(await pickOneKey({ ...base, choose: choose as never }, FRAME)).toBeNull();
    expect(seen[0]).toBe(FRAME);
  });

  it("chooser path returns the picked key untouched", async () => {
    const base = lineDeps([]).deps;
    const choose = (): Promise<string> => Promise.resolve("2");
    expect(await pickOneKey({ ...base, choose: choose as never }, FRAME)).toBe("2");
  });
});
