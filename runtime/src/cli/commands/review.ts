// `aifight review <session_or_match_id>` — generate or print a local post-match
// self-review (SELF_REVIEW_DESIGN.md §8.2). Pure-local + one LLM call on the
// user's own key; the review is stored in the session dir and never uploaded.
//
//   aifight review <id>            generate if missing, else print the stored one
//   aifight review <id> --regen    force a fresh review (overwrites, D9)
//   aifight review <id> --model X  use profile X for this review only
//   aifight review <id> --locale zh  write the report in a specific language
//   aifight review <id> --md       print the review as Markdown (redirectable)
//   aifight review <id> --out P    write the Markdown to a file or directory

import fsSync from "node:fs";
import path from "node:path";

import { envNotifyLocale } from "../../notify/locale";
import { readBridgeConfig } from "../../bridge/config";
import { loadAgentProfile, resolveAgentDir } from "../../profile/profile-loader";
import {
  expandHome,
  exportReviewMarkdown,
  renderReviewMarkdown,
  reviewMetaFromSummary,
  type ReviewMarkdownMeta,
} from "../../review/review-markdown";
import { runSelfReview, type SelfReview, type SelfReviewSuggestion } from "../../review/self-review";
import {
  createLocalMatchSessionStore,
  type LocalMatchSessionSummary,
} from "../../session/local-match-session-store";
import { CommandError, UsageError, expectArity, type HandlerArgs, type HandlerEnv } from "../shared";

const USAGE =
  "usage: aifight review <session_or_match_id> [--regen] [--no-generate] [--model <profile>] [--locale <code>] [--md] [--out <file|dir>]";

export async function runReview(args: HandlerArgs, env: HandlerEnv): Promise<number> {
  expectArity(args, 1, 1, USAGE);
  const selector = args.positional[0]!;
  const store = createLocalMatchSessionStore();
  const item = store.getSession(selector);
  if (!item) {
    throw new CommandError("session_not_found", `local match session not found: ${selector}`);
  }

  const mdMode = args.flags.md === true;
  if (args.flags.out === true) throw new UsageError("--out needs a path", USAGE);
  const outPath = typeof args.flags.out === "string" ? args.flags.out.trim() : "";
  if ((mdMode || outPath !== "") && args.jsonMode) {
    throw new UsageError("--md/--out cannot be combined with --json", USAGE);
  }

  const regen = args.flags.regen === true;
  const noGenerate = args.flags["no-generate"] === true;
  if (!regen) {
    const existing = store.readSelfReview(item.session_id);
    if (existing) {
      return outputReview(env, existing, item, args.jsonMode, { md: mdMode, out: outPath });
    }
    if (noGenerate) {
      // Read-only check (the desktop uses this on view to avoid spending tokens
      // just by opening a replay): report "none" instead of generating.
      if (args.jsonMode) env.stdout(JSON.stringify({ review: null }) + "\n");
      else env.stdout("(no self-review yet)\n");
      return 0;
    }
  }

  const exported = store.exportSession(item.session_id);
  if (!exported) {
    throw new CommandError("session_not_found", `local match session not found: ${selector}`);
  }

  const bridge = readBridgeConfig();
  const slug = bridge.directAgentSlug ?? "default";
  let config;
  try {
    const { profile } = await loadAgentProfile(resolveAgentDir(slug));
    config = profile.config;
  } catch (cause) {
    throw new CommandError(
      "llm_not_configured",
      `cannot load the LLM config for agent profile "${slug}": ${(cause as Error).message}`,
      { hint: "configure an LLM key first (see `aifight setup`)" },
    );
  }

  const modelOverride = typeof args.flags.model === "string" ? args.flags.model.trim() : "";
  if (modelOverride !== "" && !config.profiles[modelOverride]) {
    throw new CommandError(
      "unknown_profile",
      `--model "${modelOverride}" is not a configured profile`,
      { hint: `known profiles: ${Object.keys(config.profiles).join(", ") || "(none)"}` },
    );
  }
  const effectiveConfig =
    modelOverride !== ""
      ? { ...config, selfReview: { ...(config.selfReview ?? {}), model: modelOverride } }
      : config;

  const locale = resolveLocale(args.flags.locale);

  let review: SelfReview;
  try {
    review = await runSelfReview({ exported, config: effectiveConfig, trigger: "manual", locale });
  } catch (cause) {
    throw new CommandError("review_failed", `self-review failed: ${(cause as Error).message}`);
  }
  store.writeSelfReview(item.session_id, review);
  return outputReview(env, review, item, args.jsonMode, { md: mdMode, out: outPath });
}

/** Route the finished review to the asked-for output: human text (default),
 *  JSON, Markdown on stdout (--md), or a Markdown file (--out). */
function outputReview(
  env: HandlerEnv,
  review: unknown,
  summary: LocalMatchSessionSummary,
  jsonMode: boolean,
  opts: { readonly md: boolean; readonly out: string },
): number {
  if (!opts.md && opts.out === "") {
    printReview(env, review, jsonMode);
    return 0;
  }
  const typed = coerceSelfReview(review);
  if (typed === null) {
    throw new CommandError("review_invalid", "the stored review file is malformed; regenerate it with --regen");
  }
  const meta = reviewMetaFromSummary(summary, tryBaseUrl());
  if (opts.out !== "") {
    const file = writeReviewMarkdownTo(opts.out, typed, meta);
    env.stdout(file + "\n");
    return 0;
  }
  env.stdout(renderReviewMarkdown(typed, meta));
  return 0;
}

/** A path ending in .md is a file; anything else (existing directory or not)
 *  is a directory that receives the standard filename. */
function writeReviewMarkdownTo(out: string, review: SelfReview, meta: ReviewMarkdownMeta): string {
  const expanded = path.resolve(expandHome(out));
  const isExistingDir = (() => {
    try {
      return fsSync.statSync(expanded).isDirectory();
    } catch {
      return false;
    }
  })();
  if (isExistingDir || !expanded.toLowerCase().endsWith(".md")) {
    return exportReviewMarkdown(expanded, review, meta);
  }
  fsSync.mkdirSync(path.dirname(expanded), { recursive: true });
  fsSync.writeFileSync(expanded, renderReviewMarkdown(review, meta), "utf8");
  return expanded;
}

/** The replay link is a nice-to-have; a missing bridge config just drops it. */
function tryBaseUrl(): string | undefined {
  try {
    return readBridgeConfig().baseUrl;
  } catch {
    return undefined;
  }
}

/** Structural check for a stored self_review.json — written by this CLI, but
 *  hand-editable, so trust nothing. */
function coerceSelfReview(review: unknown): SelfReview | null {
  if (!isObject(review)) return null;
  const usage = review.token_usage;
  const suggestion = review.suggestion;
  const suggestionOk =
    suggestion === null ||
    suggestion === undefined ||
    (isObject(suggestion) && typeof suggestion.scope === "string" && typeof suggestion.text === "string");
  if (
    typeof review.report_text !== "string" ||
    typeof review.generated_at !== "string" ||
    typeof review.model !== "string" ||
    (review.trigger !== "auto" && review.trigger !== "manual") ||
    typeof review.locale !== "string" ||
    !isObject(usage) ||
    typeof usage.input !== "number" ||
    typeof usage.output !== "number" ||
    !suggestionOk
  ) {
    return null;
  }
  return {
    schema: 1,
    generated_at: review.generated_at,
    trigger: review.trigger,
    model: review.model,
    locale: review.locale,
    prompt_version: typeof review.prompt_version === "string" ? review.prompt_version : "",
    report_text: review.report_text,
    suggestion: (suggestion ?? null) as SelfReviewSuggestion | null,
    token_usage: { input: usage.input, output: usage.output },
    source_strategy_hashes: Array.isArray(review.source_strategy_hashes)
      ? (review.source_strategy_hashes.filter((h) => typeof h === "string") as string[])
      : [],
  };
}

function resolveLocale(flag: string | number | boolean | undefined): string {
  // --locale wins; otherwise the shared environment rule (one definition for
  // the CLI, the auto-review, and the notification channels).
  if (typeof flag === "string" && flag.trim() !== "") return flag.trim();
  return envNotifyLocale();
}

function printReview(env: HandlerEnv, review: unknown, jsonMode: boolean): void {
  if (jsonMode) {
    env.stdout(JSON.stringify({ review }) + "\n");
    return;
  }
  env.stdout(formatReviewHuman(review));
}

function formatReviewHuman(review: unknown): string {
  if (!isObject(review)) return "(no review)\n";
  const lines: string[] = [];
  const report = typeof review.report_text === "string" ? review.report_text.trim() : "";
  lines.push(report === "" ? "(empty review)" : report);
  const suggestion = review.suggestion;
  if (isObject(suggestion) && typeof suggestion.text === "string" && suggestion.text.trim() !== "") {
    const scope = typeof suggestion.scope === "string" ? suggestion.scope : "?";
    lines.push("");
    lines.push(`Suggestion [${scope}]: ${suggestion.text.trim()}`);
  }
  const meta = reviewMetaLine(review);
  if (meta !== "") {
    lines.push("");
    lines.push(meta);
  }
  return lines.join("\n") + "\n";
}

function reviewMetaLine(review: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof review.model === "string" && review.model !== "") parts.push(`model ${review.model}`);
  const usage = review.token_usage;
  if (isObject(usage)) {
    const inTok = typeof usage.input === "number" ? usage.input : 0;
    const outTok = typeof usage.output === "number" ? usage.output : 0;
    parts.push(`tokens in ${inTok} / out ${outTok}`);
  }
  if (typeof review.trigger === "string") parts.push(review.trigger);
  if (typeof review.generated_at === "string") parts.push(review.generated_at);
  return parts.length > 0 ? `(${parts.join(" · ")})` : "";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
