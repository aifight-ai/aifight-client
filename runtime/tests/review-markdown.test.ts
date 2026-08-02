// The Markdown face of a self-review: rendering, filenames, and the exportDir
// writer. Real filesystem only inside a mkdtemp sandbox.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  expandHome,
  exportReviewMarkdown,
  renderReviewMarkdown,
  reviewMarkdownFilename,
  reviewMetaFromSummary,
} from "../src/review/review-markdown";
import type { SelfReview } from "../src/review/self-review";

const REVIEW: SelfReview = {
  schema: 1,
  generated_at: "2026-08-02T13:05:00.000Z",
  trigger: "auto",
  model: "claude-sonnet-5",
  locale: "en",
  prompt_version: "sr-v1",
  report_text: "Solid, patient play. The river call on t12 was the turning point.",
  suggestion: { scope: "texas_holdem", text: "Fold small pairs out of position pre-flop." },
  token_usage: { input: 3210, output: 412 },
  source_strategy_hashes: ["abc"],
};

const META = reviewMetaFromSummary(
  {
    session_id: "sess_abcdef1234",
    agent_id: "agent-1",
    status: "completed",
    game: "texas_holdem",
    started_at: "2026-08-02T12:50:00.000Z",
    updated_at: "2026-08-02T13:02:00.000Z",
    ended_at: "2026-08-02T13:02:00.000Z",
    result_label: "1st place",
    opponents: ['GPT"Shark"', "DeepBluff"],
    replay_url: "/replay/xyz",
    inbound_count: 0,
    outbound_count: 0,
    decision_count: 0,
    final_action_count: 0,
    strategy_hashes: [],
  } as never,
  "https://aifight.ai",
);

describe("renderReviewMarkdown", () => {
  it("writes frontmatter, the report, the suggestion, and the meta line", () => {
    const md = renderReviewMarkdown(REVIEW, META);
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain('game: "texas_holdem"');
    expect(md).toContain('result: "1st place"');
    // Opponent names are quote-safe (JSON string quoting is valid YAML).
    expect(md).toContain('opponents: ["GPT\\"Shark\\"", "DeepBluff"]');
    expect(md).toContain('replay: "https://aifight.ai/replay/xyz"');
    expect(md).toContain("# Review · Texas Hold'em · 1st place（2026-08-02）");
    expect(md).toContain("river call on t12");
    expect(md).toContain("## Suggested improvement (scope: texas_holdem)");
    expect(md).toContain("tokens in 3210 / out 412");
  });

  it("speaks Chinese when the review does, and omits what it does not have", () => {
    const zh: SelfReview = { ...REVIEW, locale: "zh", suggestion: null };
    const md = renderReviewMarkdown(zh, { sessionId: "sess_x" });
    expect(md).toContain("# 复盘 · 对局");
    expect(md).not.toContain("Suggested improvement");
    expect(md).not.toContain("改进建议");
    expect(md).not.toContain("game:");
    expect(md).not.toContain("replay:");
  });
});

describe("reviewMarkdownFilename", () => {
  it("is dated, slugged and short", () => {
    expect(reviewMarkdownFilename(REVIEW, META)).toBe("2026-08-02-texas_holdem-1st-place-sess_abc.md");
  });
});

describe("exportReviewMarkdown", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-review-md-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates the directory and writes the file", () => {
    const target = path.join(dir, "nested", "reviews");
    const file = exportReviewMarkdown(target, REVIEW, META);
    expect(file).toBe(path.join(target, "2026-08-02-texas_holdem-1st-place-sess_abc.md"));
    expect(fs.readFileSync(file, "utf8")).toContain("# Review · Texas Hold'em");
  });

  it("throws (rather than lying) when the directory cannot be created", () => {
    const blocked = path.join(dir, "not-a-dir");
    fs.writeFileSync(blocked, "file in the way");
    expect(() => exportReviewMarkdown(path.join(blocked, "sub"), REVIEW, META)).toThrow();
  });
});

describe("expandHome", () => {
  it("expands ~ and leaves everything else alone", () => {
    expect(expandHome("~")).toBe(os.homedir());
    expect(expandHome("~/reviews")).toBe(path.join(os.homedir(), "reviews"));
    expect(expandHome("/abs/path")).toBe("/abs/path");
    expect(expandHome("relative")).toBe("relative");
  });
});
