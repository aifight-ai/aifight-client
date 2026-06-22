// `aifight config validate [agent-slug]` — Validate an agent's config files.
//
// Loads all four profile files for the agent and reports validation
// results. Exits 0 if all required files pass; exits 1 if any errors
// are found.
//
// Behavior:
//   1. Resolve agent slug (positional arg or "default").
//   2. loadAgentProfile — reads and validates config.json, strategy.json,
//      soul.md (required) and identity.json (optional).
//   3. Print per-file OK / error status.
//   4. Exit 0 on full pass, exit 1 if ProfileLoadError is thrown.
//
// Errors:
//   - ProfileLoadError → print file + errors, exit 1.
//   - extra positional → UsageError → exit 2 via main.ts funnel.

import type { HandlerArgs, HandlerEnv } from "../shared.js";
import { expectArity } from "../shared.js";
import {
  loadAgentProfile,
  resolveAgentDir,
  ProfileLoadError,
} from "../../profile/profile-loader.js";

const USAGE = "usage: aifight config validate [agent-slug]";

export async function runConfigValidate(
  args: HandlerArgs,
  env: HandlerEnv,
): Promise<number> {
  expectArity(args, 0, 1, USAGE);

  const slug = (args.positional[0] as string | undefined) ?? "default";
  const agentDir = resolveAgentDir(slug);

  let profileResult: Awaited<ReturnType<typeof loadAgentProfile>>;
  try {
    profileResult = await loadAgentProfile(agentDir);
  } catch (cause) {
    if (cause instanceof ProfileLoadError) {
      if (args.jsonMode) {
        env.stderr(
          JSON.stringify({
            error: {
              code: "config_validate_failed",
              file: cause.file,
              message: cause.message,
            },
          }) + "\n",
        );
      } else {
        env.stderr(`aifight: config validate: ${cause.message}\n`);
      }
      return 1;
    }
    const msg = cause instanceof Error ? cause.message : String(cause);
    if (args.jsonMode) {
      env.stderr(
        JSON.stringify({
          error: { code: "config_validate_failed", message: msg },
        }) + "\n",
      );
    } else {
      env.stderr(`aifight: config validate: ${msg}\n`);
    }
    return 1;
  }

  const { profile, hashes } = profileResult;

  if (args.jsonMode) {
    env.stdout(
      JSON.stringify({
        agentSlug: slug,
        agentDir,
        files: {
          "config.json": {
            ok: true,
            activeProfile: profile.config.activeProfile,
            profileCount: Object.keys(profile.config.profiles).length,
            hash: hashes.config,
          },
          "strategy.json": {
            ok: true,
            name: profile.strategy.name,
            version: profile.strategy.version,
            gameCount: Object.keys(profile.strategy.games).length,
            hash: hashes.strategy,
          },
          "soul.md": {
            ok: true,
            bytes: Buffer.byteLength(profile.soul, "utf8"),
            hash: hashes.soul,
          },
          "identity.json": {
            ok: true,
            present: profile.identity !== null,
            agentSlug: profile.identity?.agentSlug ?? null,
            hash: hashes.identity,
          },
        },
      }) + "\n",
    );
    return 0;
  }

  const configProfileNames = Object.keys(profile.config.profiles);

  env.stdout(`aifight config validate: agent "${slug}"\n`);
  env.stdout(`  directory     : ${agentDir}\n`);
  env.stdout(`\n`);
  env.stdout(`  config.json   : OK\n`);
  env.stdout(`    active profile : ${profile.config.activeProfile}\n`);
  env.stdout(`    profiles       : ${configProfileNames.join(", ")}\n`);
  env.stdout(`    hash           : ${hashes.config.slice(0, 12)}...\n`);
  env.stdout(`\n`);
  env.stdout(`  strategy.json : OK\n`);
  env.stdout(`    name           : ${profile.strategy.name}\n`);
  env.stdout(`    version        : ${profile.strategy.version}\n`);
  env.stdout(`    games          : ${Object.keys(profile.strategy.games).join(", ")}\n`);
  env.stdout(`    hash           : ${hashes.strategy.slice(0, 12)}...\n`);
  env.stdout(`\n`);
  env.stdout(`  soul.md       : OK\n`);
  env.stdout(`    size           : ${Buffer.byteLength(profile.soul, "utf8")} bytes\n`);
  env.stdout(`    hash           : ${hashes.soul.slice(0, 12)}...\n`);
  env.stdout(`\n`);

  if (profile.identity !== null) {
    env.stdout(`  identity.json : OK\n`);
    env.stdout(`    agent slug     : ${profile.identity.agentSlug}\n`);
    if (profile.identity.displayName) {
      env.stdout(`    display name   : ${profile.identity.displayName}\n`);
    }
    env.stdout(`    environment    : ${profile.identity.platform.environment}\n`);
    env.stdout(`    hash           : ${(hashes.identity ?? "").slice(0, 12)}...\n`);
  } else {
    env.stdout(`  identity.json : (absent — optional, skip for now)\n`);
  }

  env.stdout(`\nAll required files OK.\n`);
  return 0;
}
