import fs from "node:fs/promises";
import path from "node:path";

import { createLocalMatchSessionStore, type LocalMatchSessionListItem } from "../../session/local-match-session-store";
import { CommandError, expectArity, type HandlerArgs, type HandlerEnv, UsageError } from "../shared";
import { resolveAgentDir } from "../../profile/profile-loader";
import { validateConfig } from "../../profile/config-schema";
import { resolveModelCapabilities } from "../../llm/capabilities/validate-capabilities";

/** The model ceiling for a truncated session's profile — the "raise it to" target. */
async function truncationFixTokens(profileId: string | undefined): Promise<number | undefined> {
  if (!profileId) return undefined;
  try {
    const raw = await fs.readFile(path.join(resolveAgentDir("default"), "config.json"), "utf8");
    const parsed = validateConfig(JSON.parse(raw));
    if (!parsed.ok) return undefined;
    const p = parsed.config.profiles[profileId];
    if (!p) return undefined;
    return resolveModelCapabilities(p.protocol, p.model).maxOutputTokens;
  } catch {
    return undefined;
  }
}

const USAGE = [
  "usage: aifight sessions list",
  "       aifight sessions show <session_or_match_id> [--reasoning]",
  "       aifight sessions path <session_or_match_id>",
  "       aifight sessions export <session_or_match_id>",
].join("\n");

export async function runBridgeSessions(
  args: HandlerArgs,
  env: HandlerEnv,
): Promise<number> {
  const sub = args.positional[0];
  if (!sub) {
    throw new UsageError("missing sessions command", USAGE);
  }
  const store = createLocalMatchSessionStore();

  if (sub === "list") {
    expectArity({ ...args, positional: args.positional.slice(1) }, 0, 0, USAGE);
    const sessions = store.listSessions();
    if (args.jsonMode) {
      env.stdout(JSON.stringify({ sessions }) + "\n");
      return 0;
    }
    if (sessions.length === 0) {
      env.stdout("No local AIFight match sessions found yet.\n");
      return 0;
    }
    env.stdout(sessions.map(formatSessionLine).join("\n") + "\n");
    return 0;
  }

  if (sub === "show") {
    const rest = args.positional.slice(1);
    expectArity({ ...args, positional: rest }, 1, 1, USAGE);
    const item = requireSession(store, rest[0]!);
    if (args.jsonMode) {
      env.stdout(JSON.stringify({ session: item }) + "\n");
      return 0;
    }
    const fix = (item.token_truncation_count ?? 0) > 0
      ? await truncationFixTokens(item.truncated_profile)
      : undefined;
    env.stdout(formatSessionDetail(item, fix));
    if (args.flags["reasoning"] === true) {
      env.stdout(formatSessionReasoning(store, item));
    }
    return 0;
  }

  if (sub === "path") {
    const rest = args.positional.slice(1);
    expectArity({ ...args, positional: rest }, 1, 1, USAGE);
    const item = requireSession(store, rest[0]!);
    if (args.jsonMode) {
      env.stdout(JSON.stringify({ path: item.path }) + "\n");
    } else {
      env.stdout(`${item.path}\n`);
    }
    return 0;
  }

  if (sub === "export") {
    const rest = args.positional.slice(1);
    expectArity({ ...args, positional: rest }, 1, 1, USAGE);
    const exported = store.exportSession(rest[0]!);
    if (!exported) throw new CommandError("session_not_found", `local match session not found: ${rest[0]}`);
    env.stdout(JSON.stringify(exported, null, 2) + "\n");
    return 0;
  }

  throw new UsageError(`unknown sessions command '${sub}'`, USAGE);
}

function requireSession(
  store: ReturnType<typeof createLocalMatchSessionStore>,
  selector: string,
): LocalMatchSessionListItem {
  const item = store.getSession(selector);
  if (!item) {
    throw new CommandError("session_not_found", `local match session not found: ${selector}`);
  }
  return item;
}

function formatSessionLine(item: LocalMatchSessionListItem): string {
  const game = item.game ?? "unknown_game";
  const result = item.result_label ?? item.status;
  const match = item.real_match_id ? ` match=${shortId(item.real_match_id)}` : "";
  return [
    shortId(item.session_id),
    game,
    result,
    `decisions=${item.decision_count}`,
    (item.token_truncation_count ?? 0) > 0 ? `truncated=${item.token_truncation_count}` : "",
    errorClassTotal(item) > 0 ? `errors=${errorClassTotal(item)}` : "",
    `updated=${item.updated_at}`,
    match.trim(),
  ].filter(Boolean).join("  ");
}

function formatSessionDetail(item: LocalMatchSessionListItem, fixTokens?: number): string {
  const lines = [
    `Session: ${item.session_id}`,
    `Agent: ${item.agent_name} (${item.agent_id})`,
    `Status: ${item.status}`,
    `Game: ${item.game ?? "unknown"}`,
    `Started: ${item.started_at}`,
    `Updated: ${item.updated_at}`,
    `Decisions: ${item.decision_count}`,
    `Inbound messages: ${item.inbound_count}`,
    `Outbound actions: ${item.final_action_count}`,
    `Path: ${item.path}`,
  ];
  if (typeof item.player_count === "number") lines.splice(4, 0, `Players: ${item.player_count}`);
  if (typeof item.event_count === "number") lines.splice(lines.length - 1, 0, `Match events: ${item.event_count}`);
  if (item.real_match_id) lines.splice(1, 0, `Match: ${item.real_match_id}`);
  if (item.result_label) lines.push(`Result: ${item.result_label}`);
  if (item.replay_url) lines.push(`Replay: ${item.replay_url}`);
  if (item.strategy_hashes.length > 0) {
    lines.push(`Strategy snapshots: ${item.strategy_hashes.length}`);
  }
  if ((item.token_truncation_count ?? 0) > 0) {
    const prof = item.truncated_profile ?? "<profile>";
    const target = fixTokens ? String(fixTokens) : "<your model's max>";
    lines.push(
      `⚠ Truncated: ${item.token_truncation_count} decision(s) hit the max_tokens cap — your agent may not have played its best.`,
      `  Raise it: aifight config update ${prof} --max-tokens ${target}`,
    );
  }
  const errorCounts = item.error_class_counts;
  if (errorCounts && Object.keys(errorCounts).length > 0) {
    const total = errorClassTotal(item);
    lines.push(`⚠ ${total} decision(s) fell back to a safe move after an API error:`);
    for (const [cls, n] of Object.entries(errorCounts).sort((a, b) => b[1] - a[1])) {
      lines.push(`  • ${cls} ×${n} — ${errorClassHint(cls)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function errorClassTotal(item: LocalMatchSessionListItem): number {
  return Object.values(item.error_class_counts ?? {}).reduce((a, b) => a + b, 0);
}

// Terminal cap per decision so a DeepSeek-length capture stays readable;
// the full text is always available via `sessions export`.
const SHOW_THINKING_MAX = 600;

/** `sessions show --reasoning`: captured model thinking, one block per decision.
 *  Local data only (decisions.jsonl) — this never talks to the platform. */
function formatSessionReasoning(
  store: ReturnType<typeof createLocalMatchSessionStore>,
  item: LocalMatchSessionListItem,
): string {
  const exported = store.exportSession(item.session_id);
  const lines: string[] = ["", "Model thinking (local only):"];
  let shown = 0;
  const decisions = exported?.decisions ?? [];
  decisions.forEach((decision, i) => {
    if (typeof decision !== "object" || decision === null) return;
    const d = decision as { traces?: unknown; final_action?: unknown };
    const traces = Array.isArray(d.traces) ? d.traces : [];
    // Attribution gate (mirrors build-review-context.extractThinking): only a
    // model-authored final action (final_action.source === "runtime") may show
    // thinking, and strictly from the LAST runtime_success — a fallback action
    // must never inherit a rejected call's thinking.
    let finalSource: unknown;
    for (let j = traces.length - 1; j >= 0; j--) {
      const tr = traces[j] as { type?: unknown; source?: unknown } | null;
      if (tr && tr.type === "final_action") {
        finalSource = tr.source;
        break;
      }
    }
    if (finalSource !== "runtime") return;
    let thinking: string | undefined;
    for (let j = traces.length - 1; j >= 0; j--) {
      const tr = traces[j] as { type?: unknown; reasoning?: { text?: unknown } } | null;
      if (!tr || tr.type !== "runtime_success") continue;
      const text = tr.reasoning?.text;
      if (typeof text === "string" && text.trim() !== "") thinking = text.trim();
      break;
    }
    if (thinking === undefined) return;
    shown++;
    const fa = d.final_action as { type?: unknown } | undefined;
    const chose = fa && typeof fa.type === "string" ? fa.type : "?";
    const capped =
      thinking.length <= SHOW_THINKING_MAX ? thinking : `${thinking.slice(0, SHOW_THINKING_MAX)}…[truncated]`;
    lines.push(`  [t${i + 1}] chose ${chose}`);
    for (const row of capped.split("\n")) lines.push(`      ${row}`);
  });
  if (shown === 0) {
    lines.push("  (none recorded — enable with: aifight config reasoning on)");
  }
  return `${lines.join("\n")}\n`;
}

/** One-line, actionable hint per failure class for `sessions show`. */
function errorClassHint(cls: string): string {
  switch (cls) {
    case "auth":
      return "API key was rejected — check it with: aifight config test";
    case "quota":
      return "out of API credits/quota — top up or switch provider";
    case "config":
      return "provider rejected the request (bad model id or parameter) — check the profile";
    case "content_filter":
      return "the model blocked its own response (content filter)";
    case "rate_limit":
      return "rate-limited — slow down or use a higher-tier key";
    case "server":
      return "provider server error / overload (usually transient)";
    case "timeout":
      return "the request timed out — try a faster model or a larger timeout";
    case "network":
      return "network error reaching the provider";
    case "token_limit":
      return "cut off by max_tokens — see the truncation hint above";
    default:
      return "unclassified API error";
  }
}

function shortId(value: string): string {
  return value.length <= 12 ? value : value.slice(0, 12);
}
