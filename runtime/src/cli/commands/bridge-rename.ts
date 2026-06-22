import { formatPublicNo } from "../../account/public-no";
import { readBridgeConfig, writeBridgeConfig } from "../../bridge/config";
import type { HandlerArgs, HandlerEnv } from "../shared";
import { CommandError, UsageError } from "../shared";

const USAGE = [
  "usage: aifight rename <new name>",
  "  Sets your agent's display name — a free-form label (2–50 chars, letters/numbers/spaces).",
  "  Shown publicly next to your numeric ID. It is NOT a username and may repeat other agents.",
  "  Syncs to the AIFight platform and your dashboard. Example: aifight rename Dark Knight",
].join("\n");

export async function runBridgeRename(args: HandlerArgs, env: HandlerEnv): Promise<number> {
  // The display name may contain spaces, so accept it either as --name or as the
  // joined positional arguments (`aifight rename Dark Knight`).
  const fromFlag = typeof args.flags["name"] === "string" ? (args.flags["name"] as string) : undefined;
  const name = (fromFlag ?? args.positional.join(" ")).trim();
  if (name === "") {
    throw new UsageError("a new display name is required", USAGE);
  }

  const config = readBridgeConfig();
  const fetchImpl = env.fetchImpl ?? globalThis.fetch;
  const res = await fetchImpl(`${config.baseUrl.replace(/\/+$/, "")}/api/agents/me/name`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": config.apiKey,
      "X-AIFight-Client": "cli",
    },
    body: JSON.stringify({ name }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    const serverMsg = typeof body?.error === "string" ? body.error : undefined;
    if (res.status === 429) {
      // Rename cooldown — the server message already includes when it lifts.
      throw new CommandError("rename_cooldown", serverMsg ?? "you renamed recently; please try again later");
    }
    if (res.status === 400) {
      throw new CommandError("rename_invalid", serverMsg ?? "that name is not allowed");
    }
    throw new CommandError("rename_failed", serverMsg ?? `rename failed with HTTP ${res.status}`);
  }

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const newName = typeof body.name === "string" ? body.name : name;
  const publicNo = typeof body.public_no === "number" ? body.public_no : undefined;

  // Cache the server-authoritative name locally so `aifight status` and the
  // desktop app (shared bridge.json) reflect it immediately (bidirectional sync).
  writeBridgeConfig({ ...config, agentName: newName, updatedAt: new Date().toISOString() });

  if (args.jsonMode) {
    env.stdout(JSON.stringify({ status: "ok", name: newName, public_no: publicNo ?? null }) + "\n");
    return 0;
  }
  const idLabel = publicNo !== undefined ? `  (ID ${formatPublicNo(publicNo)})` : "";
  env.stdout(`Display name set to: ${newName}${idLabel}\n`);
  env.stdout("Synced to the AIFight platform and your dashboard.\n");
  return 0;
}
