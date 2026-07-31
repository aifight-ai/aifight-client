// Prompts with defaults (owner ask 2026-07-30, the 3x-ui habit): every
// prompt shows its current value in brackets — Enter keeps it, q/Esc
// cancels, a new value is applied. Covers the shared helper plus the three
// interactive command paths (bare `set daily` / `set game` / `rename`).
//
// Isolation: mkdtemp AIFIGHT_RUNTIME_HOME per test; the line reader is
// injected — no real stdin is ever touched.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readBridgeConfig, writeBridgeConfig } from "../src/bridge/config";
import {
  promptDefault,
  resolveDefaultAnswer,
} from "../src/cli/commands/onboard-io";
import {
  runSetDailyInteractive,
  runSetGamesInteractive,
} from "../src/cli/commands/bridge-set";
import { runRenameInteractive } from "../src/cli/commands/bridge-rename";
import type { HandlerArgs, HandlerEnv } from "../src/cli/shared";

let prevHome: string | undefined;
let tmpDir: string | null = null;

beforeEach(() => {
  prevHome = process.env.AIFIGHT_RUNTIME_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-prompt-default-"));
  process.env.AIFIGHT_RUNTIME_HOME = tmpDir;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
  else process.env.AIFIGHT_RUNTIME_HOME = prevHome;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  prevHome = undefined;
  tmpDir = null;
});

function makeEnv(): { env: HandlerEnv; out: () => string } {
  const chunks: string[] = [];
  const env = {
    stdout: (s: string) => chunks.push(s),
    stderr: (s: string) => chunks.push(s),
  } as unknown as HandlerEnv;
  return { env, out: () => chunks.join("") };
}

function seedBridge(overrides: Record<string, unknown> = {}): void {
  writeBridgeConfig({
    version: 1,
    baseUrl: "https://aifight.ai",
    wsUrl: "wss://aifight.ai/api/ws",
    agentId: "00000000-0000-4000-8000-000000000001",
    agentName: "Phantom Maverick",
    apiKey: "sk-existing-secret",
    runtimeType: "direct",
    runtimeLocalUrl: "direct://local",
    runtimeModel: "direct",
    directAgentSlug: "default",
    autoDailyLimit: 2,
    autoGames: ["coup"],
    updatedAt: "2026-07-27T00:00:00.000Z",
    ...overrides,
  } as never);
}

/** A readLine that plays the scripted answers and records the questions. */
function reader(answers: string[], asked: string[]) {
  let i = 0;
  return (_env: HandlerEnv, question: string): Promise<string> => {
    asked.push(question);
    return Promise.resolve(answers[i++] ?? "");
  };
}

describe("resolveDefaultAnswer", () => {
  it("bare Enter (or whitespace) keeps the current value", () => {
    expect(resolveDefaultAnswer("")).toEqual({ kind: "keep" });
    expect(resolveDefaultAnswer("   ")).toEqual({ kind: "keep" });
  });

  it("q, Q, or an Esc keypress cancels", () => {
    expect(resolveDefaultAnswer("q")).toEqual({ kind: "cancel" });
    expect(resolveDefaultAnswer("Q")).toEqual({ kind: "cancel" });
    expect(resolveDefaultAnswer("\x1b")).toEqual({ kind: "cancel" });
  });

  it("anything else is the new value, trimmed", () => {
    expect(resolveDefaultAnswer("5")).toEqual({ kind: "value", value: "5" });
    // A name with spaces is a VALUE, not a cancel.
    expect(resolveDefaultAnswer("Dark Knight")).toEqual({ kind: "value", value: "Dark Knight" });
    expect(resolveDefaultAnswer(" 7 ")).toEqual({ kind: "value", value: "7" });
  });
});

describe("promptDefault", () => {
  it("renders the current value in brackets: `Question [current]: `", async () => {
    const { env } = makeEnv();
    const asked: string[] = [];
    const answer = await promptDefault(env, "Daily cap", "2", reader([""], asked));
    expect(asked).toEqual(["Daily cap [2]: "]);
    expect(answer).toEqual({ kind: "keep" });
  });
});

describe("bare `aifight set daily` (interactive)", () => {
  const args: HandlerArgs = { positional: ["daily"], flags: {}, jsonMode: false };

  it("asks with the current cap as the default; a number sets it", async () => {
    seedBridge({ autoDailyLimit: 2 });
    const { env, out } = makeEnv();
    const asked: string[] = [];
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      expect(url).toContain("/api/agents/me/policy");
      return new Response(JSON.stringify({ policy: { max_games_per_day: 5, auto_requeue: true } }), { status: 200 });
    }) as typeof fetch;
    const code = await runSetDailyInteractive(args, { ...env, fetchImpl }, reader(["5"], asked));
    expect(code).toBe(0);
    expect(asked[0]).toBe(`Daily cap (0-100, 0 = off) [2]: `);
    expect(readBridgeConfig().autoDailyLimit).toBe(5);
    expect(out()).toContain("Automatic ranked matches set to 5 per day.");
  });

  it("Enter keeps the current cap — no write, no network", async () => {
    seedBridge({ autoDailyLimit: 2 });
    const { env, out } = makeEnv();
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const asked: string[] = [];
    const code = await runSetDailyInteractive(args, { ...env, fetchImpl }, reader([""], asked));
    expect(code).toBe(0);
    expect(readBridgeConfig().autoDailyLimit).toBe(2);
    expect(fetched).toBe(false);
    expect(out()).toContain("Kept 2.");
  });

  it("q cancels without changes", async () => {
    seedBridge({ autoDailyLimit: 2 });
    const { env, out } = makeEnv();
    const code = await runSetDailyInteractive(args, env, reader(["q"], []));
    expect(code).toBe(0);
    expect(readBridgeConfig().autoDailyLimit).toBe(2);
    expect(out()).toContain("No changes made.");
  });

  it("0 disables automatic matches", async () => {
    seedBridge({ autoDailyLimit: 2 });
    const { env, out } = makeEnv();
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ policy: { auto_requeue: false } }), { status: 200 })) as typeof fetch;
    const code = await runSetDailyInteractive(args, { ...env, fetchImpl }, reader(["0"], []));
    expect(code).toBe(0);
    expect(readBridgeConfig().autoDailyLimit).toBe(0);
    expect(out()).toContain("Daily automatic ranked matches disabled.");
  });

  it("a non-number is explained and nothing is written", async () => {
    seedBridge({ autoDailyLimit: 2 });
    const { env, out } = makeEnv();
    const code = await runSetDailyInteractive(args, env, reader(["lots"], []));
    expect(code).toBe(0);
    expect(readBridgeConfig().autoDailyLimit).toBe(2);
    expect(out()).toContain("Enter a whole number");
  });

  it("an invalid number RE-ASKS (current value still in the bracket), then accepts", async () => {
    seedBridge({ autoDailyLimit: 2 });
    const { env, out } = makeEnv();
    const asked: string[] = [];
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ policy: { max_games_per_day: 7, auto_requeue: true } }), { status: 200 })) as typeof fetch;
    const code = await runSetDailyInteractive(args, { ...env, fetchImpl }, reader(["lots", "150", "7"], asked));
    expect(code).toBe(0);
    // All three prompts kept the current value in the bracket — no error-out.
    expect(asked).toEqual([
      "Daily cap (0-100, 0 = off) [2]: ",
      "Daily cap (0-100, 0 = off) [2]: ",
      "Daily cap (0-100, 0 = off) [2]: ",
    ]);
    expect(out().match(/Enter a whole number/g)).toHaveLength(2);
    expect(readBridgeConfig().autoDailyLimit).toBe(7);
  });

  it("an invalid number then q cancels, changing nothing", async () => {
    seedBridge({ autoDailyLimit: 2 });
    const { env, out } = makeEnv();
    const code = await runSetDailyInteractive(args, env, reader(["lots", "q"], []));
    expect(code).toBe(0);
    expect(readBridgeConfig().autoDailyLimit).toBe(2);
    expect(out()).toContain("Enter a whole number");
    expect(out()).toContain("No changes made.");
  });

  it("shows 'server default' when no cap was ever set", async () => {
    seedBridge();
    writeBridgeConfig((() => {
      const { autoDailyLimit: _dropped, ...rest } = readBridgeConfig();
      return rest;
    })() as never);
    const { env } = makeEnv();
    const asked: string[] = [];
    await runSetDailyInteractive(args, env, reader([""], asked));
    expect(asked[0]).toBe("Daily cap (0-100, 0 = off) [server default]: ");
  });
});

describe("bare `aifight set game` (interactive)", () => {
  const args: HandlerArgs = { positional: ["game"], flags: {}, jsonMode: false };

  it("the picker is offered the current selection; its picks are written", async () => {
    seedBridge({ autoGames: ["coup"] });
    const { env, out } = makeEnv();
    let offered: readonly string[] = [];
    const code = await runSetGamesInteractive(args, env, (_e, current) => {
      offered = current;
      return Promise.resolve(["texas_holdem", "coup"]);
    });
    expect(code).toBe(0);
    expect(offered).toEqual(["coup"]);
    expect(readBridgeConfig().autoGames).toEqual(["texas_holdem", "coup"]);
    expect(out()).toContain("Automatic match games set to: texas_holdem, coup");
  });

  it("an unset preference pre-checks ALL supported games", async () => {
    seedBridge();
    writeBridgeConfig((() => {
      const { autoGames: _dropped, ...rest } = readBridgeConfig();
      return rest;
    })() as never);
    const { env } = makeEnv();
    let offered: readonly string[] = [];
    await runSetGamesInteractive(args, env, (_e, current) => {
      offered = current;
      return Promise.resolve(null);
    });
    expect(offered).toEqual(["texas_holdem", "liars_dice", "coup"]);
  });

  it("cancelling the picker changes nothing", async () => {
    seedBridge({ autoGames: ["coup"] });
    const { env, out } = makeEnv();
    const code = await runSetGamesInteractive(args, env, () => Promise.resolve(null));
    expect(code).toBe(0);
    expect(readBridgeConfig().autoGames).toEqual(["coup"]);
    expect(out()).toContain("No changes made.");
  });

  it("an empty selection (a picker bypassing the checkbox guard) is refused without writing", async () => {
    seedBridge({ autoGames: ["coup"] });
    const { env, out } = makeEnv();
    const code = await runSetGamesInteractive(args, env, () => Promise.resolve([]));
    expect(code).toBe(0);
    expect(readBridgeConfig().autoGames).toEqual(["coup"]);
    expect(out()).toContain("select at least 1");
  });
});

describe("bare `aifight rename` (interactive)", () => {
  it("asks with the current name as the default; a new name is used", async () => {
    seedBridge({ agentName: "Phantom Maverick" });
    const { env } = makeEnv();
    const asked: string[] = [];
    const name = await runRenameInteractive(env, reader(["Dark Knight"], asked));
    expect(asked).toEqual(["Public name [Phantom Maverick]: "]);
    expect(name).toBe("Dark Knight");
  });

  it("Enter keeps the current name (undefined = nothing to do)", async () => {
    seedBridge({ agentName: "Phantom Maverick" });
    const { env, out } = makeEnv();
    const name = await runRenameInteractive(env, reader([""], []));
    expect(name).toBeUndefined();
    expect(out()).toContain("Kept Phantom Maverick.");
  });

  it("q cancels without changes", async () => {
    seedBridge({ agentName: "Phantom Maverick" });
    const { env, out } = makeEnv();
    const name = await runRenameInteractive(env, reader(["q"], []));
    expect(name).toBeUndefined();
    expect(out()).toContain("No changes made.");
  });

  it("over 50 chars re-asks with a hint, then accepts a shorter name", async () => {
    seedBridge({ agentName: "Phantom Maverick" });
    const { env, out } = makeEnv();
    const asked: string[] = [];
    const name = await runRenameInteractive(env, reader(["N".repeat(60), "Dark Knight"], asked));
    expect(asked).toEqual(["Public name [Phantom Maverick]: ", "Public name [Phantom Maverick]: "]);
    expect(out()).toContain("50");
    expect(name).toBe("Dark Knight");
  });

  it("over 50 chars then q cancels — nothing to change", async () => {
    seedBridge({ agentName: "Phantom Maverick" });
    const { env, out } = makeEnv();
    const name = await runRenameInteractive(env, reader(["N".repeat(60), "q"], []));
    expect(name).toBeUndefined();
    expect(out()).toContain("No changes made.");
  });
});
