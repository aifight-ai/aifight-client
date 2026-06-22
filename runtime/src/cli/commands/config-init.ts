// `aifight config init [agent-slug]` — Initialize a new agent profile.
//
// Creates config.json + strategy.json + soul.md in the agent directory
// (~/.aifight/agents/<slug>/). This only scaffolds the files — it never
// reads your environment or your API keys. Connect and test an LLM key
// interactively with `aifight config` (or point a profile at a key with
// `aifight config set-key`).
//
// Behavior:
//   1. Resolve agent slug (positional arg or "default").
//   2. ensureAgentDir — create ~/.aifight/agents/<slug>/ if missing.
//   3. Write config.json (a neutral DEFAULT_CONFIG scaffold), strategy.json,
//      and soul.md, skipping any file that already exists so user edits are
//      never clobbered.
//   4. Print a summary of what was created / already existed.
//
// Errors:
//   - fs failures on ensureAgentDir / writeFile → exit 1 with message.
//   - extra positional → UsageError → exit 2 via main.ts funnel.

import fs from "node:fs/promises";
import path from "node:path";

import type { HandlerArgs, HandlerEnv } from "../shared.js";
import { expectArity } from "../shared.js";
import { DEFAULT_CONFIG } from "../../profile/config-schema.js";
import { DEFAULT_STRATEGY } from "../../profile/strategy-schema.js";
import { DEFAULT_SOUL } from "../../profile/soul.js";
import { resolveAgentDir, ensureAgentDir } from "../../profile/profile-loader.js";

const USAGE = "usage: aifight config init [agent-slug]";

async function writeIfAbsent(
  filePath: string,
  content: string,
): Promise<"created" | "exists"> {
  try {
    await fs.access(filePath);
    return "exists";
  } catch {
    await fs.writeFile(filePath, content, "utf8");
    return "created";
  }
}

export async function runConfigInit(
  args: HandlerArgs,
  env: HandlerEnv,
): Promise<number> {
  expectArity(args, 0, 1, USAGE);

  const slug = (args.positional[0] as string | undefined) ?? "default";
  const agentDir = resolveAgentDir(slug);

  try {
    await ensureAgentDir(slug);
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    env.stderr(`aifight: config init: cannot create agent directory: ${msg}\n`);
    return 1;
  }

  // Scaffold only — never read the environment or any API key. The user
  // connects an LLM interactively with `aifight config`.
  const config = DEFAULT_CONFIG;

  const configPath = path.join(agentDir, "config.json");
  const strategyPath = path.join(agentDir, "strategy.json");
  const soulPath = path.join(agentDir, "soul.md");

  let configStatus: "created" | "exists";
  let strategyStatus: "created" | "exists";
  let soulStatus: "created" | "exists";

  try {
    configStatus = await writeIfAbsent(configPath, JSON.stringify(config, null, 2) + "\n");
    strategyStatus = await writeIfAbsent(strategyPath, JSON.stringify(DEFAULT_STRATEGY, null, 2) + "\n");
    soulStatus = await writeIfAbsent(soulPath, DEFAULT_SOUL);
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    env.stderr(`aifight: config init: write failed: ${msg}\n`);
    return 1;
  }

  if (args.jsonMode) {
    env.stdout(
      JSON.stringify({
        agentSlug: slug,
        agentDir,
        files: {
          "config.json": configStatus,
          "strategy.json": strategyStatus,
          "soul.md": soulStatus,
        },
      }) + "\n",
    );
    return 0;
  }

  env.stdout(`aifight config init: agent "${slug}"\n`);
  env.stdout(`  directory   : ${agentDir}\n`);
  env.stdout(`  config.json : ${configStatus}\n`);
  env.stdout(`  strategy.json : ${strategyStatus}\n`);
  env.stdout(`  soul.md     : ${soulStatus}\n`);

  env.stdout(
    [
      "",
      "Scaffold ready. No environment or API key was read.",
      "",
      "Next steps:",
      "  1. Run `aifight config` to choose a provider, paste your LLM key, and test it.",
      "  2. Edit soul.md to personalise your agent's competitive style.",
      "  3. Review strategy.json and tune per-game tactics.",
      "",
    ].join("\n"),
  );

  return 0;
}
