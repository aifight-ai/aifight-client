// `aifight setup` speaks the display language (批 U7, 统一交互规范 §3 的最后
// 一行). The V1 i18n boundary deliberately left the wizard English; the owner
// overturned that on 2026-08-02, so the ONE command a newcomer runs must be
// translated end to end — welcome banner, pre-flight frame, LLM review screen,
// closing checklist.
//
// What these pin:
//   * both dictionaries actually carry the wizard's own prose (a zh run must
//     not fall back to English mid-screen);
//   * the pre-flight is a P1 frame, not the old hand-typed `[U/c/n/q]` letters;
//   * the checklist's kv columns are measured in VISIBLE width, so the wider
//     zh labels never glue onto their values (the whole reason the hand-padded
//     layout had to go).

import { describe, expect, it } from "vitest";

import { visibleWidth } from "../src/cli/ansi";
import { en } from "../src/cli/i18n-en";
import { zh } from "../src/cli/i18n-zh";
import { renderMenuFrame } from "../src/cli/commands/menu-frame";
import { createAnsi } from "../src/cli/ansi";
import { buildPreflightFrame, renderSetupChecklist } from "../src/cli/commands/setup";
import type { BridgeConfig } from "../src/bridge/config";

const CONFIG = {
  version: 1,
  baseUrl: "https://aifight.ai",
  wsUrl: "wss://aifight.ai/api/ws",
  agentId: "00000000-0000-4000-8000-000000000001",
  agentName: "Steel Mongoose",
  apiKey: "sk-secret",
  claimUrl: "https://aifight.ai/claim/abc123",
  runtimeType: "direct",
  runtimeLocalUrl: "direct://local",
  runtimeModel: "direct",
  directAgentSlug: "default",
  updatedAt: "2026-08-02T00:00:00.000Z",
} as unknown as BridgeConfig;

const plain = (frameLines: readonly string[]): string => frameLines.join("\n");

// ── The dictionaries carry the whole wizard ──────────────────────────

describe("the wizard's prose is in BOTH dictionaries", () => {
  it("every wizard.* / llmhub.wizard.* key has a real zh translation", () => {
    const keys = Object.keys(en).filter(
      (k) => k.startsWith("wizard.") || k.startsWith("llmhub.wizard.") || k.startsWith("llmhub.probe."),
    );
    // The batch is only meaningful if it actually moved a wizard's worth of
    // text: a shrinking count means someone deleted the translations.
    expect(keys.length).toBeGreaterThan(80);
    for (const key of keys) {
      const zhText = zh[key as keyof typeof zh];
      expect(zhText, `${key} missing from zh`).toBeTruthy();
      // Command names, URLs and model ids stay English on purpose, so "equals
      // the English" is only suspicious for sentences — flag the ones that are
      // pure prose (no backtick command, no scheme, no {{param}}-only value).
      if (/^[A-Za-z][A-Za-z ,.'—-]{18,}$/.test(en[key as keyof typeof en])) {
        expect(zhText, `${key} looks untranslated`).not.toBe(en[key as keyof typeof en]);
      }
    }
  });

  it("no yes/no question spells its own [Y/n] bracket (P4)", () => {
    // promptYesNo appends the suffix; a question that carries one shows it
    // twice. Same rule cli-confirm-u4 enforces for the confirm.* family.
    for (const table of [en, zh]) {
      for (const [key, text] of Object.entries(table)) {
        if (!key.startsWith("wizard.") && !key.startsWith("llmhub.wizard.")) continue;
        expect(text, `${key}`).not.toMatch(/\[[Yy]\/[Nn]\]/);
      }
    }
  });
});

// ── Pre-flight: a P1 frame, in both languages ────────────────────────

describe("pre-flight identity choice (P1)", () => {
  it("renders four rows with the agent and the machine caveat — en", () => {
    const text = plain(
      renderMenuFrame(buildPreflightFrame(CONFIG, "en"), -1, createAnsi({ enabled: false }), 0, {
        singleColumn: true,
      }),
    );
    expect(text).toContain("Found an existing AIFight agent on this machine");
    expect(text).toContain("Steel Mongoose (00000000-0000-4000-8000-000000000001)");
    expect(text).toContain("This identity only works on the machine it was set up on.");
    expect(text).toContain("1) Use it");
    expect(text).toContain("2) Connect");
    expect(text).toContain("3) New agent");
    expect(text).toContain("q) Quit");
    // The hand-typed letter prompt is gone for good.
    expect(text).not.toContain("[U/c/n/q]");
  });

  it("renders the same four rows in zh", () => {
    const text = plain(
      renderMenuFrame(buildPreflightFrame(CONFIG, "zh"), -1, createAnsi({ enabled: false }), 0, {
        singleColumn: true,
      }),
    );
    expect(text).toContain("本机已经有一个 AIFight agent");
    expect(text).toContain("这个身份只在当初配置它的那台机器上能用。");
    expect(text).toContain("1) 继续用它");
    expect(text).toContain("2) 接管过来");
    expect(text).toContain("3) 新建 agent");
    expect(text).toContain("q) 退出");
    expect(text).not.toContain("Use it");
  });

  it("row hints stay inside the ≤29-column budget in both languages", () => {
    // IMPLEMENTATION_RULES «CLI Menu Copy Rules» — a longer hint truncates
    // with an ellipsis, and a truncated zh hint is unreadable.
    for (const loc of ["en", "zh"] as const) {
      for (const choice of buildPreflightFrame(CONFIG, loc).choices) {
        expect(visibleWidth(choice.hint ?? ""), `${loc} ${choice.key}`).toBeLessThanOrEqual(29);
      }
    }
  });
});

// ── The closing checklist ────────────────────────────────────────────

describe("setup checklist", () => {
  const state = (llm: boolean, service: boolean) => ({
    config: CONFIG,
    llmConfigured: llm,
    serviceInstalled: service,
  });

  it("marks what is done with ✓ and what is left with ☐ — en", () => {
    const lines = renderSetupChecklist("en", state(true, false));
    const text = lines.join("\n");
    expect(text).toContain("Setup summary");
    expect(text).toContain("✓ Agent");
    expect(text).toContain("✓ LLM");
    expect(text).toContain("configured & tested");
    expect(text).toContain("☐ Service");
    expect(text).toContain("not installed — run `aifight service install`");
    expect(text).toContain("☐ Claim");
    expect(text).toContain("https://aifight.ai/claim/abc123");
    expect(text).toContain("Handy commands:");
    expect(text).toContain("aifight strategy path");
  });

  it("translates every line of the checklist in zh (nothing falls back)", () => {
    const text = renderSetupChecklist("zh", state(false, true)).join("\n");
    expect(text).toContain("初始化小结");
    expect(text).toContain("☐ 大模型");
    expect(text).toContain("还没配——运行 aifight config");
    expect(text).toContain("✓ 常驻服务");
    expect(text).toContain("aifight.service 运行中");
    expect(text).toContain("☐ 认领");
    expect(text).toContain("打开下面的链接验证邮箱（上场前必做）");
    expect(text).toContain("常用命令：");
    // The English wording must not survive anywhere in a zh run.
    expect(text).not.toContain("Setup summary");
    expect(text).not.toContain("Handy commands");
    expect(text).not.toContain("not set up");
  });

  it("aligns the value column by VISIBLE width, so zh rows do not glue", () => {
    // The bug the hand-padded layout had: `.length` counts a CJK ideograph as
    // 1 while the terminal draws it as 2, so a zh label overran its column.
    for (const loc of ["en", "zh"] as const) {
      const lines = renderSetupChecklist(loc, state(true, true));
      const itemRows = lines.filter((l) => /^ {2}[✓☐] /.test(l));
      expect(itemRows).toHaveLength(5);
      const valueStarts = itemRows.map((row) => {
        // Every row is "  <mark> <label><padding><value>"; the value starts
        // after the run of ≥2 spaces that follows the label.
        const match = /^ {2}[✓☐] .*?\s{2,}/.exec(row);
        return visibleWidth(match![0]);
      });
      expect(new Set(valueStarts).size, `${loc} value column drifts`).toBe(1);
    }
  });

  it("hangs the claim URL and the strategy tail under their row's value column", () => {
    const lines = renderSetupChecklist("zh", state(true, true));
    const claimRow = lines.findIndex((l) => l.includes("☐ 认领"));
    const urlLine = lines[claimRow + 1]!;
    expect(urlLine).toContain("https://aifight.ai/claim/abc123");
    const claimValueStart = visibleWidth(/^ {2}[✓☐] .*?\s{2,}/.exec(lines[claimRow]!)![0]);
    expect(visibleWidth(urlLine) - visibleWidth(urlLine.trimStart())).toBe(claimValueStart);
  });
});
