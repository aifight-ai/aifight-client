// Render a stored self-review as a Markdown document, and write it to a
// directory of the owner's choosing (SELF_REVIEW export batch, 2026-08-02).
//
// One renderer serves both doors: `aifight review <id> --md/--out` and the
// auto-review hook in the bridge runner (selfReview.exportDir). The file is a
// plain human document — frontmatter with the match facts, the report text,
// the optional strategy suggestion — and never contains keys or prompts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LocalMatchSessionSummary, LocalSessionExport } from "../session/local-match-session-store.js";
import { sameOriginUrl } from "../notify/safe-url.js";
import type { SelfReview } from "./self-review.js";

export interface ReviewMarkdownMeta {
  readonly sessionId: string;
  readonly game?: string;
  readonly resultLabel?: string;
  readonly opponents?: readonly string[];
  readonly finishedAt?: string;
  readonly replayUrl?: string;
}

/** Pull the frontmatter facts out of a session summary. baseUrl (the AIFight
 *  origin) turns the stored replay path into a clickable absolute URL. */
export function reviewMetaFromSummary(summary: LocalMatchSessionSummary, baseUrl?: string): ReviewMarkdownMeta {
  const replay = summary.replay_url !== undefined && baseUrl !== undefined
    ? sameOriginUrl(baseUrl, summary.replay_url)
    : undefined;
  return {
    sessionId: summary.session_id,
    ...(summary.game !== undefined ? { game: summary.game } : {}),
    ...(summary.result_label !== undefined ? { resultLabel: summary.result_label } : {}),
    ...(summary.opponents !== undefined ? { opponents: summary.opponents } : {}),
    ...(summary.ended_at !== undefined ? { finishedAt: summary.ended_at } : {}),
    ...(replay !== undefined ? { replayUrl: replay } : {}),
  };
}

/** Same, from a full session export (the auto-review path already holds one). */
export function reviewMetaFromExport(exported: LocalSessionExport, baseUrl?: string): ReviewMarkdownMeta {
  return reviewMetaFromSummary(exported.summary, baseUrl);
}

export function renderReviewMarkdown(review: SelfReview, meta: ReviewMarkdownMeta): string {
  const zh = review.locale === "zh";
  const date = review.generated_at.slice(0, 10);

  const front: string[] = ["---"];
  if (meta.game !== undefined) front.push(`game: ${yaml(meta.game)}`);
  if (meta.resultLabel !== undefined) front.push(`result: ${yaml(meta.resultLabel)}`);
  if (meta.opponents !== undefined && meta.opponents.length > 0) {
    front.push(`opponents: [${meta.opponents.map(yaml).join(", ")}]`);
  }
  if (meta.finishedAt !== undefined) front.push(`finished_at: ${yaml(meta.finishedAt)}`);
  front.push(`model: ${yaml(review.model)}`);
  front.push(`trigger: ${yaml(review.trigger)}`);
  front.push(`session: ${yaml(meta.sessionId)}`);
  if (meta.replayUrl !== undefined) front.push(`replay: ${yaml(meta.replayUrl)}`);
  front.push("---");

  const title = [
    zh ? "复盘" : "Review",
    gameTitle(zh, meta.game),
    ...(meta.resultLabel !== undefined ? [meta.resultLabel] : []),
  ].join(" · ");

  const lines: string[] = [...front, "", `# ${title}（${date}）`, "", review.report_text.trim()];

  if (review.suggestion !== null && review.suggestion.text.trim() !== "") {
    lines.push(
      "",
      zh
        ? `## 改进建议（scope: ${review.suggestion.scope}）`
        : `## Suggested improvement (scope: ${review.suggestion.scope})`,
      "",
      review.suggestion.text.trim(),
    );
  }

  lines.push(
    "",
    `—— model ${review.model} · tokens in ${review.token_usage.input} / out ${review.token_usage.output} · ${review.trigger} · ${review.generated_at}`,
    "",
  );
  return lines.join("\n");
}

/** `<YYYY-MM-DD>-<game>-<result>-<sid8>.md`, every part filename-safe. */
export function reviewMarkdownFilename(review: SelfReview, meta: ReviewMarkdownMeta): string {
  const parts = [
    review.generated_at.slice(0, 10),
    meta.game ?? "match",
    meta.resultLabel ?? "result",
    meta.sessionId.slice(0, 8),
  ];
  return `${parts.map(slugify).filter((p) => p !== "").join("-")}.md`;
}

/**
 * Write the Markdown next to whatever else lives in `dir` (created if
 * missing, "~" expanded). Returns the absolute file path. Throws on I/O
 * failure — the runner logs it, the CLI reports it.
 */
export function exportReviewMarkdown(
  dir: string,
  review: SelfReview,
  meta: ReviewMarkdownMeta,
): string {
  const target = path.resolve(expandHome(dir));
  fs.mkdirSync(target, { recursive: true });
  const file = path.join(target, reviewMarkdownFilename(review, meta));
  fs.writeFileSync(file, renderReviewMarkdown(review, meta), "utf8");
  return file;
}

export function expandHome(raw: string): string {
  const value = raw.trim();
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

/** Three games is not a translation framework; anything new passes through. */
function gameTitle(zh: boolean, game: string | undefined): string {
  switch (game) {
    case "texas_holdem":
      return zh ? "德州扑克" : "Texas Hold'em";
    case "liars_dice":
      return zh ? "骗子骰" : "Liar's Dice";
    case "coup":
      return zh ? "政变" : "Coup";
    case undefined:
      return zh ? "对局" : "Match";
    default:
      return game;
  }
}

/** JSON string quoting is valid YAML for scalars, and handles every quote. */
function yaml(value: string): string {
  return JSON.stringify(value);
}

function slugify(raw: string): string {
  return raw
    .replace(/[^A-Za-z0-9_一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
