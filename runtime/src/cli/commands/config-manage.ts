// `aifight config remove` / `aifight config clear-key` — the profile-management
// actions the desktop app has (delete a profile, clear a stored key) brought to
// the CLI.
//
// Design authority: docs/agent-bridge/CLI_LLM_CONFIG_COMMANDS_SPEC.md
//   D10  remove: clean routing, delete the managed key file (never a user's
//        own env/file), refuse to remove the active profile
//   §5.5 clear-key: delete only the AIFight-managed 0600 key file

import fs from "node:fs/promises";

import type { HandlerArgs, HandlerEnv } from "../shared.js";
import { UsageError } from "../shared.js";
import type { LLMConfig } from "../../profile/config-schema.js";
import {
  readExistingConfig,
  writeValidatedConfig,
  managedKeyPath,
  isManagedKeyRef,
} from "./config-edit.js";
import { configError, boolFlag } from "./config-shared.js";
import { createOnboardIO } from "./onboard-io.js";

// ─── remove ──────────────────────────────────────────────────────────

const REMOVE_USAGE = "usage: aifight config remove <profile> [--yes] [agent-slug]";

export async function runConfigRemove(args: HandlerArgs, env: HandlerEnv): Promise<number> {
  const profileId = args.positional[0];
  if (profileId === undefined || profileId.trim() === "") {
    throw new UsageError("config remove requires a <profile> id", REMOVE_USAGE);
  }
  const slug = (args.positional[1] as string | undefined) ?? "default";

  const config = await readExistingConfig(slug);
  if (!config || !config.profiles[profileId]) {
    throw configError("config_remove_unknown_profile", {
      problem: `unknown profile "${profileId}"`,
      valid: `Available profiles: ${config ? Object.keys(config.profiles).join(", ") || "(none)" : "(no config yet)"}`,
      example: "aifight config show",
    });
  }

  // D10: refuse to remove the active profile — the agent would have nothing to
  // play with. Require an explicit switch first.
  if (config.activeProfile === profileId) {
    const other = Object.keys(config.profiles).find((p) => p !== profileId);
    throw configError("config_remove_active", {
      problem: `"${profileId}" is the active profile`,
      valid: "Switch to another profile before removing this one.",
      example: other ? `aifight config use ${other}` : "aifight config add <another> --protocol … --env …",
      next: `Then run \`aifight config remove ${profileId}\` again.`,
    });
  }

  // Confirmation (human TTY only; --json / non-TTY / --yes skip it).
  if (!args.jsonMode && !boolFlag(args.flags, "yes") && process.stdin.isTTY === true) {
    const io = createOnboardIO(env);
    const answer = (await io.promptLine(`Type "${profileId}" to confirm removal (or Enter to cancel): `)).trim();
    if (answer !== profileId) {
      env.stdout("Cancelled — nothing removed.\n");
      return 0;
    }
  }

  const profile = config.profiles[profileId]!;
  const keyWasManaged = isManagedKeyRef(slug, profileId, profile.apiKeyRef);

  // Remove the profile + clean every reference to it.
  const next: LLMConfig = { ...config, profiles: { ...config.profiles } };
  delete next.profiles[profileId];
  cleanRouting(next, profileId);

  await writeValidatedConfig(slug, next);

  // Delete the managed key file only (never a user's own --env/--file key).
  let keyDeleted = false;
  if (keyWasManaged) {
    try {
      await fs.rm(managedKeyPath(slug, profileId), { force: true });
      keyDeleted = true;
    } catch {
      // best-effort; the profile is already gone from config
    }
  }

  if (args.jsonMode) {
    env.stdout(JSON.stringify({ status: "removed", agentSlug: slug, profile: profileId, keyFileDeleted: keyDeleted }) + "\n");
    return 0;
  }
  env.stdout(`aifight config remove: profile "${profileId}" removed.\n`);
  if (keyDeleted) env.stdout("  Its managed key file was deleted.\n");
  else if (profile.apiKeyRef.type === "env") env.stdout(`  Its key source (${describeEnv(profile)}) was left untouched.\n`);
  env.stdout("\n");
  return 0;
}

/** Drop routing entries that referenced the removed profile; keep the config valid. */
function cleanRouting(config: LLMConfig, removedId: string): void {
  const routing = { ...config.routing };
  if (routing.byGame) {
    const kept: Record<string, string> = {};
    for (const [game, id] of Object.entries(routing.byGame)) {
      if (id !== removedId) kept[game] = id;
    }
    routing.byGame = kept as LLMConfig["routing"]["byGame"];
  }
  if (routing.fallbackProfile === removedId) delete routing.fallbackProfile;
  // routing.default should already point at the (still-present) active profile,
  // but repair it defensively if a hand-edited config pointed it at the removed one.
  if (!config.profiles[routing.default]) routing.default = config.activeProfile;
  config.routing = routing;
}

function describeEnv(profile: LLMConfig["profiles"][string]): string {
  return profile.apiKeyRef.type === "env" ? `env:${profile.apiKeyRef.name}` : profile.apiKeyRef.type;
}

// ─── clear-key ───────────────────────────────────────────────────────

const CLEAR_USAGE = "usage: aifight config clear-key <profile> [agent-slug]";

export async function runConfigClearKey(args: HandlerArgs, env: HandlerEnv): Promise<number> {
  const profileId = args.positional[0];
  if (profileId === undefined || profileId.trim() === "") {
    throw new UsageError("config clear-key requires a <profile> id", CLEAR_USAGE);
  }
  const slug = (args.positional[1] as string | undefined) ?? "default";

  const config = await readExistingConfig(slug);
  if (!config || !config.profiles[profileId]) {
    throw configError("config_clearkey_unknown_profile", {
      problem: `unknown profile "${profileId}"`,
      valid: `Available profiles: ${config ? Object.keys(config.profiles).join(", ") || "(none)" : "(no config yet)"}`,
      example: "aifight config show",
    });
  }

  const ref = config.profiles[profileId]!.apiKeyRef;
  if (!isManagedKeyRef(slug, profileId, ref)) {
    throw configError("config_clearkey_not_managed", {
      problem: `the key for "${profileId}" is not managed by AIFight`,
      valid:
        ref.type === "env"
          ? `It reads from environment variable ${ref.name}. Unset that variable yourself, or point the profile elsewhere.`
          : "It points at a key file you supplied. Delete or rotate that file yourself.",
      next: `To change where the key is read from: aifight config set-key ${profileId} --env <NAME> | --file <PATH>`,
    });
  }

  await fs.rm(managedKeyPath(slug, profileId), { force: true });

  if (args.jsonMode) {
    env.stdout(JSON.stringify({ status: "key_cleared", agentSlug: slug, profile: profileId }) + "\n");
    return 0;
  }
  env.stdout(`aifight config clear-key: deleted the managed key for "${profileId}".\n`);
  env.stdout(`  The profile remains; set a new key with \`aifight config update ${profileId} --key-stdin\` (or --env/--file).\n\n`);
  return 0;
}
