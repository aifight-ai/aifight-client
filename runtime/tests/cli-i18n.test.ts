// CLI English/Chinese switching (owner ask 2026-07-31): dictionary parity,
// locale resolution, the menu's Language toggle, `aifight set language`, and
// the translated surfaces (menu / banner / help / prompts / status).
//
// Isolation: every test gets its own AIFIGHT_RUNTIME_HOME via mkdtemp (the
// real default home path is never named here — build.sh greps for exactly
// that), and AIFIGHT_LANG is scrubbed around each test so the developer's
// shell cannot leak a locale in.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readBridgeConfig, writeBridgeConfig, getBridgeConfigPath } from "../src/bridge/config";
import { createAnsi } from "../src/cli/ansi";
import { en, type I18nKey } from "../src/cli/i18n-en";
import { zh } from "../src/cli/i18n-zh";
import { formatMinutes, parseLocale, resolveLocale, t } from "../src/cli/i18n";
import { renderGlobalHelp } from "../src/cli/help";
import { run } from "../src/cli/main";
import { runInteractiveMenu, type MenuDeps } from "../src/cli/commands/menu";
import { renderMenuFrame, type MenuFrame } from "../src/cli/commands/menu-frame";
import { composeMenuStatusLines, type MenuStatusData } from "../src/cli/commands/menu-status";
import { runSetDailyInteractive } from "../src/cli/commands/bridge-set";
import type { HandlerEnv } from "../src/cli/shared";

let prevHome: string | undefined;
let prevLang: string | undefined;
let tmpDir: string | null = null;

beforeEach(() => {
  prevHome = process.env.AIFIGHT_RUNTIME_HOME;
  prevLang = process.env.AIFIGHT_LANG;
  delete process.env.AIFIGHT_LANG;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-cli-i18n-"));
  process.env.AIFIGHT_RUNTIME_HOME = tmpDir;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.AIFIGHT_RUNTIME_HOME;
  else process.env.AIFIGHT_RUNTIME_HOME = prevHome;
  if (prevLang === undefined) delete process.env.AIFIGHT_LANG;
  else process.env.AIFIGHT_LANG = prevLang;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  prevHome = undefined;
  prevLang = undefined;
  tmpDir = null;
});

function seedBridge(overrides: Record<string, unknown> = {}): void {
  writeBridgeConfig({
    version: 1,
    baseUrl: "https://aifight.ai",
    wsUrl: "wss://aifight.ai/api/ws",
    agentId: "00000000-0000-4000-8000-000000000001",
    agentName: "Steel Mongoose",
    apiKey: "sk-existing-secret",
    runtimeType: "direct",
    runtimeLocalUrl: "direct://local",
    runtimeModel: "direct",
    directAgentSlug: "default",
    autoDailyLimit: 5,
    autoGames: ["texas_holdem", "coup"],
    updatedAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  } as never);
}

// ── Dictionaries ─────────────────────────────────────────────────────

describe("dictionaries", () => {
  it("zh covers EXACTLY the en keys — nothing missing, nothing extra", () => {
    const enKeys = Object.keys(en).sort();
    const zhKeys = Object.keys(zh).sort();
    expect(zhKeys).toEqual(enKeys);
  });

  it("t() interpolates {{params}} in both locales", () => {
    expect(t("en", "menu.item.daily.hint.cap", { cap: 5 })).toBe("auto matches [5/day]");
    expect(t("zh", "menu.item.daily.hint.cap", { cap: 5 })).toBe("自动对局 [5/天]");
    expect(t("zh", "banner.match.queued", { games: "德州扑克" })).toBe("匹配：⚔ 排队中 · 德州扑克");
  });

  it("t() leaves unknown params visible rather than swallowing them", () => {
    expect(t("en", "menu.item.daily.hint.cap")).toBe("auto matches [{{cap}}/day]");
  });

  it("every zh {{param}} matches the en template's (no drifted placeholders)", () => {
    const paramsOf = (s: string): string[] => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!).sort();
    for (const key of Object.keys(en) as I18nKey[]) {
      expect(paramsOf(zh[key]), key).toEqual(paramsOf(en[key]));
    }
  });

  // D3: the CLI's one duration vocabulary — the challenge list's "expires in"
  // used to hardcode the English h/m even on a Chinese screen.
  it("formatMinutes speaks each locale's duration words", () => {
    expect(formatMinutes("en", 90)).toBe("1h 30m");
    expect(formatMinutes("zh", 90)).toBe("1 小时 30 分");
    expect(formatMinutes("en", 41)).toBe("41m");
    expect(formatMinutes("zh", 41)).toBe("41 分");
    // A whole number of hours still names the zero minutes (h 分 reads as a
    // pair); fractions floor, and a past/negative span reads as zero.
    expect(formatMinutes("zh", 120)).toBe("2 小时 0 分");
    expect(formatMinutes("en", 90.9)).toBe("1h 30m");
    expect(formatMinutes("en", -5)).toBe("0m");
    expect(formatMinutes("zh", Number.NaN)).toBe("0 分");
  });

  it("a key that exists only in en would fall back at runtime; a bogus key throws", () => {
    // @ts-expect-error — deliberately not an I18nKey
    expect(() => t("zh", "no.such.key")).toThrow("unknown i18n key");
  });
});

// ── Locale resolution ────────────────────────────────────────────────

describe("parseLocale / resolveLocale", () => {
  it("accepts exactly en/zh, case- and space-insensitively", () => {
    expect(parseLocale("en")).toBe("en");
    expect(parseLocale(" ZH ")).toBe("zh");
    expect(parseLocale("fr")).toBeUndefined();
    expect(parseLocale("zh-CN")).toBeUndefined();
    expect(parseLocale(undefined)).toBeUndefined();
    expect(parseLocale(42)).toBeUndefined();
  });

  it("defaults to en with nothing set anywhere", () => {
    expect(resolveLocale()).toBe("en");
  });

  it("bridge.json locale wins over the default", () => {
    seedBridge({ locale: "zh" });
    expect(resolveLocale()).toBe("zh");
  });

  it("AIFIGHT_LANG wins over bridge.json", () => {
    seedBridge({ locale: "zh" });
    expect(resolveLocale({ AIFIGHT_LANG: "en" })).toBe("en");
    seedBridge();
    expect(resolveLocale({ AIFIGHT_LANG: "zh" })).toBe("zh");
  });

  it("an invalid AIFIGHT_LANG falls through to bridge.json, then en", () => {
    seedBridge({ locale: "zh" });
    expect(resolveLocale({ AIFIGHT_LANG: "fr" })).toBe("zh");
    seedBridge();
    expect(resolveLocale({ AIFIGHT_LANG: "fr" })).toBe("en");
  });

  it("an unconfigured machine resolves en (no throw)", () => {
    expect(resolveLocale()).toBe("en");
  });

  it("round-trips through bridge.json, and the validator rejects other values", () => {
    seedBridge({ locale: "zh" });
    expect(readBridgeConfig().locale).toBe("zh");
    // A hand-edited bogus value must fail validation, not silently load.
    const raw = JSON.parse(fs.readFileSync(getBridgeConfigPath(), "utf8")) as Record<string, unknown>;
    raw.locale = "fr";
    fs.writeFileSync(getBridgeConfigPath(), JSON.stringify(raw));
    expect(() => readBridgeConfig()).toThrow(/invalid/);
    // …and resolveLocale survives that damage by falling back to en.
    expect(resolveLocale()).toBe("en");
  });
});

// ── aifight set language ─────────────────────────────────────────────

describe("aifight set language", () => {
  async function runCapture(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(argv, { stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
    return { code, stdout: out.join(""), stderr: err.join("") };
  }

  it("writes zh to bridge.json and confirms in Chinese", async () => {
    seedBridge();
    const r = await runCapture(["set", "language", "zh"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("语言已切换为中文。");
    expect(readBridgeConfig().locale).toBe("zh");
  });

  it("writes en and confirms in English", async () => {
    seedBridge({ locale: "zh" });
    const r = await runCapture(["set", "language", "en"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Language set to English.");
    expect(readBridgeConfig().locale).toBe("en");
  });

  it("rejects anything else with exit 2 + usage, and writes nothing", async () => {
    seedBridge();
    const r = await runCapture(["set", "language", "fr"]);
    expect(r.code).toBe(2);
    expect(r.stderr + r.stdout).toContain("aifight set language <en|zh>");
    expect(readBridgeConfig().locale).toBeUndefined();
  });

  it("--json stays English-keyed", async () => {
    seedBridge();
    const r = await runCapture(["set", "language", "zh", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ status: "ok", locale: "zh" });
    expect(r.stdout).not.toContain("语言");
  });

  it("does not mark a bridge restart pending (display-only setting)", async () => {
    // A port file NEWER than bridge.json = "the running bridge is current";
    // a settings write must not move that needle (the bridge never reads locale).
    seedBridge();
    const future = new Date(Date.now() + 60_000);
    fs.writeFileSync(path.join(tmpDir!, "port"), "45995", { mode: 0o644 });
    fs.utimesSync(path.join(tmpDir!, "port"), future, future);
    const r = await runCapture(["set", "language", "zh"]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/service restart|next time it starts/);
  });
});

// ── The menu in zh, and the Language toggle inside it ────────────────

interface MenuHarness {
  readonly deps: MenuDeps;
  readonly out: () => string;
  readonly frames: MenuFrame[];
}

function menuHarness(answers: string[]): MenuHarness {
  const chunks: string[] = [];
  const frames: MenuFrame[] = [];
  const env = {
    stdout: (s: string) => chunks.push(s),
    stderr: (s: string) => chunks.push(s),
  } as unknown as HandlerEnv;
  const plain = createAnsi({ enabled: false });
  let i = 0;
  return {
    out: () => chunks.join(""),
    frames,
    deps: {
      env,
      prompt: (question: string) => {
        chunks.push(question);
        return Promise.resolve(answers[i++] ?? "q");
      },
      choose: (frame: MenuFrame) => {
        frames.push(frame);
        chunks.push(`\n${renderMenuFrame(frame, -1, plain).join("\n")}\n\n`);
        return Promise.resolve(answers[i++] ?? "q");
      },
      dispatch: () => Promise.resolve(0),
      showHelp: () => undefined,
      configured: true,
      // The production wiring: resolve fresh on every build.
      locale: () => resolveLocale(),
      dailyCap: () => {
        try { return readBridgeConfig().autoDailyLimit; } catch { return undefined; }
      },
      autoGames: () => {
        try { return readBridgeConfig().autoGames ?? ["texas_holdem", "liars_dice", "coup"]; } catch { return ["texas_holdem", "liars_dice", "coup"]; }
      },
      matchingPaused: () => {
        try { return readBridgeConfig().matchingPaused === true; } catch { return false; }
      },
    },
  };
}

describe("menu in zh", () => {
  it("renders every item + title translated, with live hints translated too", async () => {
    seedBridge({ locale: "zh", autoDailyLimit: 5, autoGames: ["texas_holdem", "liars_dice", "coup"] });
    const h = menuHarness(["q"]);
    await runInteractiveMenu(h.deps);
    const text = h.out();
    expect(text).toContain("AIFight —— 你想做什么？");
    for (const line of [
      "1) 请求对局 — 发起一场排位赛",
      "2) 暂停匹配 — 暂停自动匹配",
      "3) 本机状态 — 本机与 agent 状态",
      "4) 战绩积分 — 积分 · 排名 · 战绩",
      "5) 约战 — 发起 · 查看 · 应战",
      "6) 模型 — 模型 · 密钥 · 路由",
      "7) 每日上限 — 自动对局 [5/天]",
      "8) 参赛游戏 — 自动参赛 [已选 3 个]",
      "9) 策略文件 — 你的 agent 怎么打",
      "10) 身份管理 — 多 agent 身份切换",
      "11) 改名 — 公开显示名",
      "12) Telegram — 手机通知与遥控",
      "13) 认领 — 绑定到你的账号",
      "14) 检查更新 — 检查并更新",
      "15) 当前配置 — 查看当前配置",
      "16) 语言 — 切换到 English",
      "17) 常驻服务 — 状态 · 启动 · 重启",
      "18) 全部命令 — 全部命令与说明",
      "q) 退出",
    ]) {
      expect(text, line).toContain(line);
    }
  });

  it("the pause/resume flip speaks zh too", async () => {
    seedBridge({ locale: "zh", matchingPaused: true });
    const h = menuHarness(["q"]);
    await runInteractiveMenu(h.deps);
    expect(h.out()).toContain("2) 恢复匹配 — 恢复自动匹配");
  });

  it("AIFIGHT_LANG=zh translates the menu without touching bridge.json", async () => {
    seedBridge();
    process.env.AIFIGHT_LANG = "zh";
    const h = menuHarness(["q"]);
    await runInteractiveMenu(h.deps);
    expect(h.out()).toContain("1) 请求对局");
    expect(readBridgeConfig().locale).toBeUndefined();
  });

  it("item 16 flips bridge.json and the NEXT frame is already Chinese", async () => {
    seedBridge();
    const h = menuHarness(["16", "q"]);
    await runInteractiveMenu(h.deps);
    expect(readBridgeConfig().locale).toBe("zh");
    // The confirmation printed in the NEW language…
    expect(h.out()).toContain("语言已切换为中文。");
    // …and the repaint right after is fully zh (frame 0 was en).
    expect(h.frames).toHaveLength(2);
    const mains = (f: MenuFrame): string[] => f.choices.map((c) => c.main);
    expect(mains(h.frames[0]!)).toContain("Play");
    expect(mains(h.frames[1]!)).toContain("请求对局");
    expect(mains(h.frames[1!] as MenuFrame)).toContain("语言");
    expect(h.out()).toContain("16) 语言 — 切换到 English");
  });

  it("toggling twice comes back to English", async () => {
    seedBridge();
    const h = menuHarness(["16", "16", "q"]);
    await runInteractiveMenu(h.deps);
    expect(readBridgeConfig().locale).toBe("en");
    expect(h.out()).toContain("Language set to English.");
  });
});

// ── The banner in zh ─────────────────────────────────────────────────

function statusData(over: Partial<MenuStatusData> = {}): MenuStatusData {
  return {
    agentName: "Steel Mongoose",
    claimed: true,
    paused: false,
    online: true,
    dailyCap: 5,
    games: ["texas_holdem", "coup"],
    model: "claude-opus-4-6",
    matching: { state: "idle" },
    ...over,
  };
}

describe("banner in zh", () => {
  const line2 = (d: MenuStatusData): string =>
    composeMenuStatusLines(d, "zh")[1]!.map((s) => s.text).join("");

  it("composes the zh identity line and keeps exactly three lines", () => {
    const lines = composeMenuStatusLines(statusData(), "zh");
    expect(lines).toHaveLength(3);
    expect(lines[0]!.map((s) => s.text).join("")).toBe("Steel Mongoose · ✓ 已认领 · ● 在线 · 自动 5 局/天");
    expect(lines[1]!.map((s) => s.text).join("")).toBe("匹配：空闲 · 自动 5 局/天");
    expect(lines[2]!.map((s) => s.text).join("")).toBe("claude-opus-4-6 · 游戏：德州扑克、政变");
  });

  it("paused wins and warns yellow", () => {
    const lines = composeMenuStatusLines(statusData({ paused: true }), "zh");
    expect(lines[1]).toEqual([{ text: "匹配：⏸ 已暂停（aifight resume 恢复）", style: "yellow" }]);
  });

  it("queued shows the game queue in cyan", () => {
    expect(line2(statusData({ matching: { state: "queued", games: ["texas_holdem"] } })))
      .toBe("匹配：⚔ 排队中 · 德州扑克");
  });

  it("bridge down is honest, with the cap", () => {
    expect(line2(statusData({ matching: { state: "not_running" } }))).toBe("匹配：桥未运行 · 自动 5 局/天");
    expect(line2(statusData({ dailyCap: 0, matching: { state: "not_running" } }))).toBe("匹配：桥未运行 · 自动匹配关");
  });

  it("today's count joins the same daily segment once the platform answers", () => {
    const lines = composeMenuStatusLines(statusData({ dailyUsed: 2 }), "zh");
    expect(lines[0]!.map((s) => s.text).join("")).toContain("自动 2/5 局/天");
    expect(line2(statusData({ dailyUsed: 2 }))).toBe("匹配：空闲 · 自动 2/5 局/天");
  });

  it("unclaimed points at the Claim item by NAME (numbering shifted twice already)", () => {
    expect(line2(statusData({ claimed: false }))).toBe("匹配：⚠ 先认领 agent（菜单「认领」项）");
  });
});

// ── Help / prompts / status in zh ────────────────────────────────────

describe("help in zh", () => {
  it("renders groups, rows and flags translated — usages stay literal", () => {
    const help = renderGlobalHelp(createAnsi({ enabled: false }), "zh");
    expect(help).toContain("对局：");
    expect(help).toContain("首次使用（初始化本机）：");
    expect(help).toContain("全局选项：");
    expect(help).toContain("aifight set language <en|zh>");
    expect(help).toContain("设置 CLI 显示语言（English / 中文）");
    expect(help).toContain("aifight start [game] [N]");
    // Brand header stays English even in zh.
    expect(help.split("\n")[0]).toContain("AI fights AI. Bring yours.");
    expect(help).not.toContain("Guided setup:");
  });

  it("--json help stays English even under AIFIGHT_LANG=zh", async () => {
    process.env.AIFIGHT_LANG = "zh";
    const out: string[] = [];
    const code = await run(["--help", "--json"], { stdout: (s) => out.push(s), stderr: () => undefined });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("")) as { help: string };
    expect(parsed.help).toContain("Guided setup:");
    expect(parsed.help).not.toContain("向导式初始化");
  });
});

describe("default-bracket prompts in zh", () => {
  it("set daily asks and confirms in zh", async () => {
    seedBridge({ locale: "zh", autoDailyLimit: 4 });
    const out: string[] = [];
    const asked: string[] = [];
    const env = {
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => out.push(s),
      locale: () => "zh" as const,
    } as unknown as HandlerEnv;
    const readLine = (_e: HandlerEnv, q: string): Promise<string> => {
      asked.push(q);
      return Promise.resolve("");
    };
    const code = await runSetDailyInteractive({ positional: ["daily"], flags: {}, jsonMode: false }, env, readLine);
    expect(code).toBe(0);
    expect(asked[0]).toContain("每日自动对局上限（0-100，0 = 关闭） [4]: ");
    expect(out.join("")).toContain("保持 4。");
  });

  // U8d: `set game`'s receipt used to print raw ids in a hardcoded English
  // sentence — the one line in that flow the picker above had already
  // translated. --json keeps the ids (checked in the en half below).
  it("set game confirms with translated names in zh", async () => {
    seedBridge({ locale: "zh" });
    const out: string[] = [];
    const code = await run(["set", "game", "texas_holdem,liars_dice"], {
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => out.push(s),
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("参赛游戏已设为：德州扑克、骗子骰");
    expect(out.join("")).not.toContain("texas_holdem");
  });

  it("set game --json keeps the raw ids in both locales", async () => {
    seedBridge({ locale: "zh" });
    const out: string[] = [];
    const code = await run(["set", "game", "coup", "--json"], {
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => out.push(s),
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.join("").trim())).toEqual({ status: "ok", autoGames: ["coup"] });
  });
});

describe("aifight status in zh", () => {
  const statusFetch = (): typeof fetch =>
    (async (url: unknown) => {
      const u = String(url);
      if (u.endsWith("/api/bridge/version")) {
        return new Response(JSON.stringify({
          minimum_supported_version: "0.1.0-alpha.1",
          recommended_version: "0.1.0-beta.40",
          latest_version: "0.1.0-beta.40",
        }), { status: 200 });
      }
      if (u.endsWith("/api/agents/me/status")) {
        return new Response(JSON.stringify({
          agent_id: "00000000-0000-4000-8000-000000000001",
          name: "Steel Mongoose",
          status: "ready",
          is_claimed: true,
          identity_status: "official",
        }), { status: 200 });
      }
      if (u.includes("registry.npmjs.org")) {
        return new Response(JSON.stringify({ version: "0.1.0-beta.40" }), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

  it("renders the field labels translated, values untouched", async () => {
    seedBridge({ locale: "zh", matchingPaused: true });
    const out: string[] = [];
    const code = await run(["status"], {
      stdout: (s) => out.push(s),
      stderr: (s) => out.push(s),
      fetchImpl: statusFetch(),
    });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("AIFight 状态");
    // V4: labels are a dim column followed by the styled value on the same row.
    expect(text).toMatch(/Agent\s+Steel Mongoose/);
    expect(text).toMatch(/档案\s+已认领，就绪/);
    expect(text).toMatch(/桥\s+已配置/);
    expect(text).toMatch(/自动排位对局\s+每日 5 场/);
    expect(text).toContain("匹配：已暂停（aifight resume 恢复）");
    // U8b: game ids never surface raw in a human screen — same vocabulary as
    // the panel, the pickers and the Telegram companion (`aifight status
    // --json` below keeps the raw ids).
    expect(text).toMatch(/游戏\s+德州扑克、政变/);
    expect(text).toContain("此处不显示任何密钥。");
    // And the --json twin is unaffected (covered by cli-pause-resume, but
    // the locale must not leak into it either).
    const json: string[] = [];
    await run(["status", "--json"], {
      stdout: (s) => json.push(s),
      stderr: () => undefined,
      fetchImpl: statusFetch(),
    });
    expect(json.join("")).not.toContain("状态");
  });
});

// ── challenge list rows in zh (D3) ───────────────────────────────────
// U8b translated the titles and notes but left the ROW vocabulary in English,
// so a Chinese screen read "政变 · hosted by you · 2 of 4 seats taken". Every
// inline word now comes from the dictionaries.

describe("challenge list rows in zh", () => {
  const ME = "00000000-0000-4000-8000-000000000001";

  /** Every row shape the list can render, one of each. Fractional offsets
   *  (90.5 / 41.5 min) keep the floor-to-minutes render stable regardless of
   *  the milliseconds between fixture build and render. */
  function listFetch(duels: readonly Record<string, unknown>[]): typeof fetch {
    return (async (url: unknown) => {
      if (String(url).endsWith("/api/agents/me/challenges")) {
        return new Response(JSON.stringify({ count: duels.length, duels }), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;
  }

  async function listInZh(duels: readonly Record<string, unknown>[]): Promise<string> {
    seedBridge({ locale: "zh" });
    const out: string[] = [];
    const code = await run(["challenge", "list"], {
      stdout: (s) => out.push(s),
      stderr: (s) => out.push(s),
      fetchImpl: listFetch(duels),
    });
    expect(code).toBe(0);
    return out.join("");
  }

  const inNinetyMinutes = (): string => new Date(Date.now() + 90.5 * 60_000).toISOString();
  const inFortyMinutes = (): string => new Date(Date.now() + 41.5 * 60_000).toISOString();

  const ALL_ROWS: readonly Record<string, unknown>[] = [
    // Active: one row per status branch.
    { id: "a1", game: "coup", status: "pending", host_agent_id: ME,
      max_players: 4, seated_count: 2, expires_at: inNinetyMinutes() },
    { id: "a2", game: "texas_holdem", status: "pending", host_agent_id: ME,
      max_players: 2, expires_at: inFortyMinutes() },
    { id: "a3", game: "liars_dice", status: "pending", host_agent_id: "agent-9", max_players: 2 },
    { id: "a4", game: "coup", status: "accepted", host_agent_id: ME, max_players: 3, seated_count: 3 },
    { id: "a5", game: "texas_holdem", status: "accepted", host_agent_id: "agent-9",
      host_agent_name: "Rival", max_players: 2 },
    { id: "a6", game: "liars_dice", status: "waiting_online", host_agent_id: ME,
      guest_agent_name: "Nova", max_players: 2 },
    { id: "a7", game: "texas_holdem", status: "in_match", host_agent_id: "agent-9",
      host_agent_name: "Rival", max_players: 2, match_id: "m-7" },
    // History (HISTORY_SHOWN caps at 5 — three keeps every row visible).
    { id: "h1", game: "liars_dice", status: "finished", host_agent_id: ME, max_players: 2 },
    { id: "h2", game: "coup", status: "expired", host_agent_id: ME, max_players: 2 },
    { id: "h3", game: "texas_holdem", status: "cancelled", host_agent_id: "agent-9",
      host_agent_name: "Rival", max_players: 2 },
  ];

  it("renders every status, opponent and expiry word in Chinese", async () => {
    const text = await listInZh(ALL_ROWS);
    for (const line of [
      "政变 · 你发起的 · 已入座 2/4 · 1 小时 30 分后过期",
      "德州扑克 · 你发起的 · 等人应战 · 41 分后过期",
      "骗子骰 · 你接受的 · 等待中",
      "政变 · 你发起的 · 满座 — 等所有人上线就开局",
      "德州扑克 · 对阵 Rival · 已应战 — 即将开局",
      "骗子骰 · 对阵 Nova · 等双方都上线",
      "德州扑克 · 对阵 Rival · 对局进行中",
      "骗子骰 · 你发起的 · 已结束",
      "政变 · 你发起的 · 已过期",
      "德州扑克 · 对阵 Rival · 已取消",
    ]) {
      expect(text, line).toContain(line);
    }
    expect(text).toContain("进行中（7）");
    expect(text).toContain("最近（3 场里的 3 场）");
  });

  it("leaves no English status word behind on a Chinese screen", async () => {
    const text = await listInZh(ALL_ROWS);
    for (const english of [
      "playing now", "expires", "hosted by you", "accepted by you", "seats taken",
      "waiting", "table full", "starting", "finished", "expired", "cancelled", "vs ",
    ]) {
      expect(text, english).not.toContain(english);
    }
  });

  it("a match in progress hides the countdown, and no expiry hides it too", async () => {
    const text = await listInZh([
      { id: "a1", game: "coup", status: "in_match", host_agent_id: "agent-9",
        host_agent_name: "Rival", max_players: 2, expires_at: inNinetyMinutes() },
      { id: "a2", game: "coup", status: "pending", host_agent_id: ME, max_players: 2 },
    ]);
    expect(text).toContain("政变 · 对阵 Rival · 对局进行中");
    expect(text).not.toContain("后过期");
  });

  it("an unknown server status prints raw rather than blanking the row", async () => {
    const text = await listInZh([
      { id: "h1", game: "coup", status: "abandoned", host_agent_id: ME, max_players: 2 },
    ]);
    expect(text).toContain("政变 · 你发起的 · abandoned");
  });

  it("--json is byte-identical in zh (rows never touch the dictionaries)", async () => {
    const raw = { count: 1, duels: [ALL_ROWS[0]] };
    const capture = async (locale: string): Promise<string> => {
      seedBridge({ locale });
      const out: string[] = [];
      const code = await run(["challenge", "list", "--json"], {
        stdout: (s) => out.push(s),
        stderr: () => undefined,
        fetchImpl: listFetch(raw.duels as Record<string, unknown>[]),
      });
      expect(code).toBe(0);
      return out.join("");
    };
    const zhJson = await capture("zh");
    expect(zhJson).toBe(await capture("en"));
    expect(JSON.parse(zhJson)).toEqual(raw);
  });
});
