// `aifight config validate [agent-slug]` — Validate an agent's config files.
//
// Loads the profile files for the agent and reports validation results.
// Exits 0 if config.json passes; exits 1 if any errors are found.
//
// Strategy is validated separately with `aifight strategy validate` — it is
// free-form Markdown, not part of the profile.
//
// Behavior:
//   1. Resolve agent slug (positional arg or "default").
//   2. loadAgentProfile — reads and validates config.json (required) and
//      identity.json (optional).
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
  env.stdout(`Strategy is separate: run \`aifight strategy validate\` to check your Markdown strategy.\n`);
  return 0;
}
