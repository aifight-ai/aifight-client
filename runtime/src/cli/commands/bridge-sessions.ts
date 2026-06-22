import { createLocalMatchSessionStore, type LocalMatchSessionListItem } from "../../session/local-match-session-store";
import { CommandError, expectArity, type HandlerArgs, type HandlerEnv, UsageError } from "../shared";

const USAGE = [
  "usage: aifight sessions list",
  "       aifight sessions show <session_or_match_id>",
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
    env.stdout(formatSessionDetail(item));
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
    `updated=${item.updated_at}`,
    match.trim(),
  ].filter(Boolean).join("  ");
}

function formatSessionDetail(item: LocalMatchSessionListItem): string {
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
  if (item.real_match_id) lines.splice(1, 0, `Match: ${item.real_match_id}`);
  if (item.result_label) lines.push(`Result: ${item.result_label}`);
  if (item.replay_url) lines.push(`Replay: ${item.replay_url}`);
  if (item.strategy_hashes.length > 0) {
    lines.push(`Strategy snapshots: ${item.strategy_hashes.length}`);
  }
  return `${lines.join("\n")}\n`;
}

function shortId(value: string): string {
  return value.length <= 12 ? value : value.slice(0, 12);
}
