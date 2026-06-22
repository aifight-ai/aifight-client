// `aifight review <session_or_match_id>` — generate or print a local post-match
// self-review (SELF_REVIEW_DESIGN.md §8.2). Pure-local + one LLM call on the
// user's own key; the review is stored in the session dir and never uploaded.
//
//   aifight review <id>            generate if missing, else print the stored one
//   aifight review <id> --regen    force a fresh review (overwrites, D9)
//   aifight review <id> --model X  use profile X for this review only
//   aifight review <id> --locale zh  write the report in a specific language

import { readBridgeConfig } from "../../bridge/config";
import { loadAgentProfile, resolveAgentDir } from "../../profile/profile-loader";
import { runSelfReview, type SelfReview } from "../../review/self-review";
import { createLocalMatchSessionStore } from "../../session/local-match-session-store";
import { CommandError, expectArity, type HandlerArgs, type HandlerEnv } from "../shared";

const USAGE =
  "usage: aifight review <session_or_match_id> [--regen] [--no-generate] [--model <profile>] [--locale <code>]";

export async function runReview(args: HandlerArgs, env: HandlerEnv): Promise<number> {
  expectArity(args, 1, 1, USAGE);
  const selector = args.positional[0]!;
  const store = createLocalMatchSessionStore();
  const item = store.getSession(selector);
  if (!item) {
    throw new CommandError("session_not_found", `local match session not found: ${selector}`);
  }

  const regen = args.flags.regen === true;
  const noGenerate = args.flags["no-generate"] === true;
  if (!regen) {
    const existing = store.readSelfReview(item.session_id);
    if (existing) {
      printReview(env, existing, args.jsonMode);
      return 0;
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
  printReview(env, review, args.jsonMode);
  return 0;
}

function resolveLocale(flag: string | number | boolean | undefined): string {
  if (typeof flag === "string" && flag.trim() !== "") return flag.trim();
  const env = process.env.AIFIGHT_LOCALE ?? process.env.LC_ALL ?? process.env.LANG ?? "";
  if (/^zh/i.test(env)) return "zh";
  return "en";
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
