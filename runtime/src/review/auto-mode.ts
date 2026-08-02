// Read/write the ONE self-review knob the Telegram panel exposes: autoMode.
//
// The CLI (`aifight config review auto …`) and the desktop Settings panel edit
// the same field through cli/commands/config.ts; the companion cannot use that
// path (it is a command handler, CommandError and all), so this module patches
// the agent profile's config.json directly — minimally, preserving every other
// field byte-for-byte, and validating before it writes, exactly like
// writeConfigJson does.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { validateConfig, type SelfReviewAutoMode } from "../profile/config-schema.js";
import { loadAgentProfile, resolveAgentDir } from "../profile/profile-loader.js";

export type { SelfReviewAutoMode };

export function isSelfReviewAutoMode(raw: string): raw is SelfReviewAutoMode {
  return raw === "off" || raw === "all" || raw === "losses_only";
}

/** The current auto-review mode, or null when the agent profile has no usable
 *  LLM config on this machine (nothing to review with → nothing to offer). */
export async function readSelfReviewAutoMode(slug: string): Promise<SelfReviewAutoMode | null> {
  try {
    const { profile } = await loadAgentProfile(resolveAgentDir(slug));
    return profile.config.selfReview?.autoMode ?? "off";
  } catch {
    return null;
  }
}

/** Set autoMode on the profile's config.json. Throws a plain Error with a
 *  human-readable message on any failure — the caller turns it into a notice. */
export async function writeSelfReviewAutoMode(slug: string, mode: SelfReviewAutoMode): Promise<void> {
  const configPath = path.join(resolveAgentDir(slug), "config.json");
  const raw = await fs.readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const selfReview = parsed.selfReview !== null && typeof parsed.selfReview === "object" && !Array.isArray(parsed.selfReview)
    ? (parsed.selfReview as Record<string, unknown>)
    : {};
  const next = { ...parsed, selfReview: { ...selfReview, autoMode: mode } };
  const result = validateConfig(next);
  if (!result.ok) {
    throw new Error(`refusing to write invalid config: ${result.errors.join("; ")}`);
  }
  // Unique temp name per writer + atomic rename, same as every other
  // config.json writer in this repo.
  const tmp = `${configPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    await fs.rename(tmp, configPath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
