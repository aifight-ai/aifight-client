// D1 + D2 (U8d, owner ruling 2026-08-03) — 恢复匹配 means "go back on standby",
// not "pick a game and queue for it". The desktop's resume button used to call
// joinAutoMatch() → pickAutoGame() → runner.joinQueue(): the last client-side
// game pick left after U8a cleared the connect edge. It now delegates to
// BridgeRunner.resumeMatching(), which decides by POSTURE, and mirrors the
// runner's standby belief into BridgeStatus so the pill can say 待命.
//
// What these pin:
//   1. default (declare) posture — resume declares standby and joins NOTHING;
//   2. legacy posture (standbyFallbackJoinMinutes set) — the self-join stands;
//   3. daily cap 0 — nothing automatic to re-enter, still no join;
//   4. no bridge running — the pause flag alone is the resume (no throw, no
//      join, and an honest "next connect" log);
//   5. standbyGames() reaches the renderer through BridgeStatus.standby, and
//      the async declaration re-projects the status when it lands.
//
// The engine and the version check are mocked at their import specifiers, and
// AIFIGHT_RUNTIME_HOME points at a throwaway dir, so nothing native loads, no
// network is touched, and the real ~/.aifight is never read or written.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeBridgeConfig, type BridgeConfig } from "@aifight/aifight/bridge/config";
import type { BridgeUpdateCheck } from "@aifight/aifight/bridge/update-check";
import type { BridgeLogEvent, BridgeStatus } from "../shared/ipc";

/** The runner's resumeMatching() answer for the next call, per test. */
type ResumeAnswer =
  | { readonly mode: "standby"; readonly games: readonly string[] }
  | { readonly mode: "joined"; readonly game: string }
  | { readonly mode: "cap_off" };

interface FakeRunner {
  onLog: (event: BridgeLogEvent) => void;
  joinCalls: Array<{ game: string; mode?: string }>;
  leaveCalls: number;
  /** Model a leave that never reached the server (socket already dead). */
  leaveThrows: boolean;
  resumeCalls: number;
  /** What resumeMatching() returns; null makes it throw (no connected agent). */
  resumeAnswer: ResumeAnswer | null;
  /** What standbyGames() reports — the platform's accepted declaration. */
  standby: readonly string[] | null;
}
const runners: FakeRunner[] = [];

vi.mock("@aifight/aifight/bridge/runner", () => ({
  BridgeRunner: class {
    #self: FakeRunner;
    constructor(opts: { onLog: (event: BridgeLogEvent) => void }) {
      this.#self = {
        onLog: opts.onLog,
        joinCalls: [],
        leaveCalls: 0,
        leaveThrows: false,
        resumeCalls: 0,
        resumeAnswer: { mode: "standby", games: ["coup", "liars_dice"] },
        standby: null,
      };
      runners.push(this.#self);
    }
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    onConnectionStateChange(): () => void {
      return () => {};
    }
    joinQueue(game: string, mode?: string): void {
      this.#self.joinCalls.push({ game, mode });
    }
    leaveQueue(): void {
      this.#self.leaveCalls += 1;
      if (this.#self.leaveThrows) throw new Error("socket is not connected");
    }
    resumeMatching(): ResumeAnswer {
      this.#self.resumeCalls += 1;
      const answer = this.#self.resumeAnswer;
      // The real runner throws through #requireAgent when the bridge is not
      // connected — model that, it is the desktop's catch path.
      if (answer === null) throw new Error("bridge is not running");
      if (answer.mode === "standby") this.#self.standby = answer.games;
      else this.#self.standby = null;
      return answer;
    }
    standbyGames(): readonly string[] | null {
      return this.#self.standby;
    }
    poke(): void {}
    suspendConnection(): void {}
    resumeConnection(): void {}
  },
}));

vi.mock("@aifight/aifight/bridge/update-check", () => ({
  checkBridgeUpdate: async (): Promise<BridgeUpdateCheck> => ({
    status: "current",
    currentVersion: "0.2.0-beta.10",
    message: "current",
  }),
}));

/** ui-flags writes to the app's userData dir in production; keep it in memory. */
const flags = new Map<string, boolean>();
vi.mock("./ui-flags", () => ({
  getFlag: (key: string) => flags.get(key) === true,
  setFlag: (key: string, value: boolean) => {
    flags.set(key, value);
  },
}));

const { BridgeHost } = await import("./bridge-host");

const ORIGINAL_HOME = process.env.AIFIGHT_RUNTIME_HOME;
const tmpDirs: string[] = [];

function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-resume-standby-"));
  tmpDirs.push(dir);
  process.env.AIFIGHT_RUNTIME_HOME = dir;
  return dir;
}

function validConfig(over: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    version: 1,
    baseUrl: "https://aifight.ai",
    wsUrl: "wss://aifight.ai/api/ws",
    agentId: "agent-resume",
    agentName: "Resume Agent",
    apiKey: "sk-not-a-real-key",
    runtimeType: "direct",
    runtimeLocalUrl: "direct://local",
    runtimeLocalToken: "token-not-real",
    autoGames: ["coup", "liars_dice"],
    updatedAt: "2026-08-03T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  runners.length = 0;
  flags.clear();
  freshHome();
  writeBridgeConfig(validConfig());
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const r of tmpDirs.splice(0)) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  if (ORIGINAL_HOME === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
  else process.env.AIFIGHT_RUNTIME_HOME = ORIGINAL_HOME;
});

describe("resume = standby (D1)", () => {
  it("default posture: resume declares standby and joins NO queue", async () => {
    const logs: BridgeLogEvent[] = [];
    const statuses: BridgeStatus[] = [];
    const host = new BridgeHost({ onLog: (e) => logs.push(e), onStatus: (s) => statuses.push(s) });
    await host.start();
    expect(runners).toHaveLength(1);

    await host.setMatchingPaused(true);
    expect(runners[0]!.leaveCalls).toBe(1);
    await host.setMatchingPaused(false);

    expect(runners[0]!.resumeCalls, "resume must go through the runner's posture").toBe(1);
    expect(runners[0]!.joinCalls, "the desktop must never pick a game on resume").toEqual([]);
    expect(
      logs.some((e) => e.code === "desktop.matching_resumed" && e.message.includes("standing by")),
      "the resume outcome is reported by mode",
    ).toBe(true);
    // D2: the declared pool reaches the renderer on the very same emit.
    expect(statuses.at(-1)?.standby).toEqual(["coup", "liars_dice"]);
    expect(statuses.at(-1)?.matchingPaused).toBe(false);
  });

  it("resume never asks the server for the policy (no cap fetch, no blind join)", async () => {
    const fetchMock = vi.fn();
    const host = new BridgeHost();
    await host.start();
    vi.stubGlobal("fetch", fetchMock);

    await host.setMatchingPaused(false);

    expect(fetchMock, "the runner owns the cap decision now").not.toHaveBeenCalled();
    expect(runners[0]!.joinCalls).toEqual([]);
  });

  it("legacy posture (standbyFallbackJoinMinutes set): the self-join answer is honoured verbatim", async () => {
    const logs: BridgeLogEvent[] = [];
    const host = new BridgeHost({ onLog: (e) => logs.push(e) });
    await host.start();
    runners[0]!.resumeAnswer = { mode: "joined", game: "coup" };

    await host.setMatchingPaused(false);

    expect(runners[0]!.resumeCalls).toBe(1);
    // The join is the RUNNER's (it happens inside resumeMatching); the host adds
    // none of its own, and reports the legacy posture honestly.
    expect(runners[0]!.joinCalls).toEqual([]);
    expect(logs.some((e) => e.code === "desktop.matching_resumed" && e.message.includes("legacy self-join"))).toBe(true);
  });

  it("daily cap 0: resume re-enters nothing and says so", async () => {
    const logs: BridgeLogEvent[] = [];
    const statuses: BridgeStatus[] = [];
    const host = new BridgeHost({ onLog: (e) => logs.push(e), onStatus: (s) => statuses.push(s) });
    await host.start();
    runners[0]!.resumeAnswer = { mode: "cap_off" };

    await host.setMatchingPaused(false);

    expect(runners[0]!.joinCalls).toEqual([]);
    expect(logs.some((e) => e.code === "desktop.matching_resumed" && e.message.includes("daily cap is 0"))).toBe(true);
    expect(statuses.at(-1)?.standby ?? null).toBeNull();
  });

  it("no bridge running: resume only clears the flag, with an honest 'next connect' log", async () => {
    const logs: BridgeLogEvent[] = [];
    const statuses: BridgeStatus[] = [];
    // Never started — this is the launch window where the flag IS the resume.
    const host = new BridgeHost({ onLog: (e) => logs.push(e), onStatus: (s) => statuses.push(s) });
    flags.set("matchingPaused", true);

    await host.setMatchingPaused(false);

    expect(runners, "no runner may be constructed by a resume").toHaveLength(0);
    expect(flags.get("matchingPaused")).toBe(false);
    expect(statuses.at(-1)?.matchingPaused).toBe(false);
    expect(statuses.at(-1)?.standby ?? null).toBeNull();
    expect(logs.some((e) => e.code === "desktop.resume_pending" && e.level === "info")).toBe(true);
  });

  it("a runner with no connected agent: the throw is caught and logged, never surfaced as a crash", async () => {
    const logs: BridgeLogEvent[] = [];
    const host = new BridgeHost({ onLog: (e) => logs.push(e) });
    await host.start();
    runners[0]!.resumeAnswer = null; // #requireAgent throws

    await expect(host.setMatchingPaused(false)).resolves.toBeUndefined();

    expect(logs.some((e) => e.code === "desktop.resume_failed" && e.level === "warning")).toBe(true);
  });
});

// 2026-08-06: pausing has a server half (auto_requeue) that only the leave can
// close. When the runner's own leave cannot be delivered, the platform endpoint
// is the fallback — otherwise the agent stays selectable by the supply sweep
// while the app shows 已暂停.
describe("pause falls back to the platform when the runner's leave fails", () => {
  it("a throwing leaveQueue() is followed by the platform leave", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(String(url));
      return { ok: true, status: 200 };
    }));
    const logs: BridgeLogEvent[] = [];
    const host = new BridgeHost({ onLog: (e) => logs.push(e) });
    await host.start();
    runners[0]!.leaveThrows = true;

    await host.setMatchingPaused(true);

    expect(runners[0]!.leaveCalls).toBe(1);
    expect(calls).toEqual(["https://aifight.ai/api/queue/leave"]);
    expect(logs.some((e) => e.code === "desktop.pause_failed" && e.level === "warning")).toBe(true);
  });

  it("a leave the runner DID deliver needs no platform call", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(String(url));
      return { ok: true, status: 200 };
    }));
    const host = new BridgeHost();
    await host.start();

    await host.setMatchingPaused(true);

    expect(runners[0]!.leaveCalls).toBe(1);
    expect(calls).toEqual([]);
  });
});

describe("standby reaches the renderer (D2)", () => {
  it("the async declaration re-projects the status when the platform's answer lands", async () => {
    const statuses: BridgeStatus[] = [];
    const host = new BridgeHost({ onStatus: (s) => statuses.push(s) });
    await host.start();
    const runner = runners[0]!;
    // The connected-edge emit happens BEFORE the declaration is accepted.
    expect(statuses.at(-1)?.standby ?? null).toBeNull();

    // The platform accepts a moment later; the runner flips its belief and logs.
    runner.standby = ["coup"];
    runner.onLog({ level: "info", code: "bridge.standby_declared", message: "Standing by for coup" });

    expect(statuses.at(-1)?.standby).toEqual(["coup"]);
  });

  it("a refused declaration clears the row again", async () => {
    const statuses: BridgeStatus[] = [];
    const host = new BridgeHost({ onStatus: (s) => statuses.push(s) });
    await host.start();
    const runner = runners[0]!;
    runner.standby = ["coup"];
    runner.onLog({ level: "info", code: "bridge.standby_redeclared", message: "re-declared" });
    expect(statuses.at(-1)?.standby).toEqual(["coup"]);

    runner.standby = null;
    runner.onLog({ level: "info", code: "bridge.standby_declare_failed", message: "refused" });

    expect(statuses.at(-1)?.standby ?? null).toBeNull();
  });
});
