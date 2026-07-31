// The Profile submenu (cli/commands/profile-menu.ts, V3 ④): rows for each
// stored identity (● active / ○ others) + ＋ create + ← back, switch with the
// desktop-seat guard, and the create-then-maybe-switch flow.
//
// Isolation: mkdtemp AIFIGHT_RUNTIME_HOME per test; every probe (desktop seat,
// CLI bridge, registration) is an injected seam — no network, no lock files.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readBridgeConfig, writeBridgeConfig, type BridgeConfig } from "../src/bridge/config";
import { identitiesDir, writeIdentity } from "../src/bridge/identities";
import { runProfileMenu, type ProfileMenuDeps } from "../src/cli/commands/profile-menu";
import type { MenuFrame } from "../src/cli/commands/menu-frame";
import type { HandlerEnv } from "../src/cli/shared";

let prevHome: string | undefined;
let tmpDir: string | null = null;

beforeEach(() => {
  prevHome = process.env.AIFIGHT_RUNTIME_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-profile-menu-"));
  process.env.AIFIGHT_RUNTIME_HOME = tmpDir;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
  else process.env.AIFIGHT_RUNTIME_HOME = prevHome;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  prevHome = undefined;
  tmpDir = null;
});

function config(agentId: string, agentName: string, over: Record<string, unknown> = {}): BridgeConfig {
  return {
    version: 1,
    baseUrl: "https://aifight.ai",
    wsUrl: "wss://aifight.ai/api/ws",
    agentId,
    agentName,
    apiKey: `sk-key-for-${agentId}`,
    runtimeType: "direct",
    runtimeLocalUrl: "direct://local",
    runtimeModel: "direct",
    directAgentSlug: "default",
    updatedAt: "2026-07-31T00:00:00.000Z",
    ...over,
  } as BridgeConfig;
}

interface Harness {
  readonly deps: ProfileMenuDeps;
  readonly out: () => string;
  readonly frames: MenuFrame[];
  readonly chooseOpts: Array<{ locale?: "en" | "zh"; singleColumn?: boolean } | undefined>;
  switched: number;
}

/** The submenu driven by scripted chooser keys (menu rows) and scripted
 *  prompt answers (confirm questions interleave in `answers`). */
function harness(
  keys: string[],
  answers: string[] = [],
  opts: Partial<Omit<ProfileMenuDeps, "locale">> & { locale?: "en" | "zh" } = {},
): Harness {
  const chunks: string[] = [];
  const frames: MenuFrame[] = [];
  const chooseOpts: Harness["chooseOpts"] = [];
  const env = {
    stdout: (s: string) => chunks.push(s),
    stderr: (s: string) => chunks.push(s),
  } as unknown as HandlerEnv;
  let ki = 0;
  let ai = 0;
  const { locale, ...seams } = opts;
  const h: Harness = {
    out: () => chunks.join(""),
    frames,
    chooseOpts,
    switched: 0,
    deps: {
      env,
      locale: () => locale ?? "en",
      prompt: (question: string) => {
        chunks.push(question);
        return Promise.resolve(answers[ai++] ?? "");
      },
      choose: (frame, chooseOpt) => {
        frames.push(frame);
        chooseOpts.push(chooseOpt);
        return Promise.resolve(keys[ki++] ?? "q");
      },
      onIdentitySwitched: () => {
        h.switched += 1;
      },
      desktopSeatActive: () => Promise.resolve(false),
      cliBridgeRunning: () => Promise.resolve(false),
      ...seams,
    },
  };
  return h;
}

function seedTwoIdentities(): void {
  writeBridgeConfig(config("agent-1", "Steel Mongoose", { declaredModel: "claude-opus-4-6" }));
  writeIdentity(config("agent-1", "Steel Mongoose", { declaredModel: "claude-opus-4-6" }));
  writeIdentity(config("agent-2", "Phantom Maverick", { claimUrl: "https://aifight.ai/claim/xyz" }));
}

describe("profile submenu", () => {
  it("shows the active identity header and every row, single-column", async () => {
    seedTwoIdentities();
    const h = harness(["q"]);
    await runProfileMenu(h.deps);

    const frame = h.frames[0]!;
    expect(frame.title).toBe("Profile Manage");
    expect(frame.subheader?.join("\n")).toContain("Active: Steel Mongoose");
    expect(frame.subheader?.join("\n")).toContain("claude-opus-4-6");
    const mains = frame.choices.map((c) => c.main);
    expect(mains[0]).toBe("● Steel Mongoose");
    expect(mains[1]).toBe("○ Phantom Maverick");
    expect(mains[2]).toBe("＋ Create new agent");
    expect(mains[3]).toBe("← Back");
    // The active row says so; the other shows its claim state.
    expect(frame.choices[0]!.hint).toContain("current");
    expect(frame.choices[0]!.hint).toContain("claimed");
    expect(frame.choices[1]!.hint).toContain("unclaimed");
    // The chooser was asked for the single-column layout.
    expect(h.chooseOpts[0]?.singleColumn).toBe(true);
  });

  it("says so when there is only one identity instead of showing an empty list", async () => {
    writeBridgeConfig(config("agent-1", "Steel Mongoose"));
    const h = harness(["q"]);
    await runProfileMenu(h.deps);
    expect(h.frames[0]!.subheader?.join("\n")).toContain("only identity");
  });

  it("Back and q both return without touching bridge.json", async () => {
    seedTwoIdentities();
    for (const key of ["4", "q"]) {
      const h = harness([key]);
      await runProfileMenu(h.deps);
      expect(readBridgeConfig().agentId).toBe("agent-1");
      expect(h.switched).toBe(0);
    }
  });

  it("picking the already-active identity is a noted no-op", async () => {
    seedTwoIdentities();
    const h = harness(["1", "q"]);
    await runProfileMenu(h.deps);
    expect(h.out()).toContain("already the active identity");
    expect(readBridgeConfig().agentId).toBe("agent-1");
    expect(h.switched).toBe(0);
  });

  it("switching writes the target over bridge.json, snapshots the outgoing, and says ✓", async () => {
    seedTwoIdentities();
    const h = harness(["2"]);
    await runProfileMenu(h.deps);

    expect(h.out()).toContain("✓ switched to Phantom Maverick");
    expect(readBridgeConfig().agentId).toBe("agent-2");
    // The outgoing active is back in the store for a later switch.
    expect(h.switched).toBe(1);
    // No CLI bridge running → no restart note.
    expect(h.out()).not.toContain("restart");
  });

  it("adds the restart note only when a CLI bridge is running", async () => {
    seedTwoIdentities();
    const h = harness(["2"], [], { cliBridgeRunning: () => Promise.resolve(true) });
    await runProfileMenu(h.deps);
    expect(h.out()).toContain("restart it to bring Phantom Maverick online");
  });

  it("desktop seat: warns and switches only after an explicit yes", async () => {
    seedTwoIdentities();
    const declined = harness(["2"], ["n"], { desktopSeatActive: () => Promise.resolve(true) });
    await runProfileMenu(declined.deps);
    expect(declined.out()).toContain("desktop app is running an agent");
    expect(readBridgeConfig().agentId).toBe("agent-1");

    const accepted = harness(["2"], ["y"], { desktopSeatActive: () => Promise.resolve(true) });
    await runProfileMenu(accepted.deps);
    expect(readBridgeConfig().agentId).toBe("agent-2");
  });

  it("＋ create stores the fresh identity and switches when the user says yes", async () => {
    seedTwoIdentities();
    const fresh = config("agent-3", "Newcomer Fox", { claimUrl: "https://aifight.ai/claim/new" });
    const h = harness(["3"], ["y"], { registerFresh: () => Promise.resolve(fresh) });
    await runProfileMenu(h.deps);

    expect(h.out()).toContain("✓ Created Newcomer Fox");
    expect(h.out()).toContain("https://aifight.ai/claim/new");
    expect(fs.existsSync(path.join(identitiesDir(), "agent-3.json"))).toBe(true);
    expect(readBridgeConfig().agentId).toBe("agent-3");
    expect(h.out()).toContain("✓ switched to Newcomer Fox");
  });

  it("＋ create + no keeps the current identity (bridge.json never clobbered)", async () => {
    seedTwoIdentities();
    const fresh = config("agent-3", "Newcomer Fox", { claimUrl: "https://aifight.ai/claim/new" });
    const h = harness(["3"], ["n"], { registerFresh: () => Promise.resolve(fresh) });
    await runProfileMenu(h.deps);

    expect(fs.existsSync(path.join(identitiesDir(), "agent-3.json"))).toBe(true);
    expect(readBridgeConfig().agentId).toBe("agent-1");
    expect(h.out()).toContain("Staying with Steel Mongoose");
  });

  it("＋ create reports a registration failure and changes nothing", async () => {
    seedTwoIdentities();
    const h = harness(["3"], [], { registerFresh: () => Promise.reject(new Error("platform down")) });
    await runProfileMenu(h.deps);
    expect(h.out()).toContain("Could not create the agent: platform down");
    expect(fs.existsSync(path.join(identitiesDir(), "agent-3.json"))).toBe(false);
    expect(readBridgeConfig().agentId).toBe("agent-1");
  });

  it("speaks zh (title, header, switch line)", async () => {
    seedTwoIdentities();
    const h = harness(["2"], [], { locale: "zh" });
    await runProfileMenu(h.deps);
    expect(h.frames[0]!.title).toBe("身份管理");
    expect(h.frames[0]!.subheader?.join("\n")).toContain("当前激活：Steel Mongoose");
    expect(h.out()).toContain("✓ 已切换到 Phantom Maverick");
  });
});
