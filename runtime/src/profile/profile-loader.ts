// Unified agent profile loader.
//
// An "agent profile" is the set of four files that describe one agent
// in ~/.aifight/agents/<slug>/:
//
//   config.json    — LLM provider + model + auth (required)
//   strategy.json  — per-game strategy overrides (required)
//   soul.md        — competitive personality capsule (required)
//   identity.json  — public display name + avatar (optional)
//
// This module owns:
//   loadAgentProfile(agentDir)  — parse + validate all four files
//   computeFileHash(filePath)   — SHA-256 of file bytes
//   resolveAgentDir(slug)       — ~/.aifight/agents/<slug>
//   ensureAgentDir(slug)        — mkdir -p the agent directory
//
// Internal-only — not re-exported at the package root until the
// profile subsystem stabilises in a later milestone.

import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

import { getAgentsRoot } from "../store/paths.js";
import { validateConfig, type LLMConfig } from "./config-schema.js";
import { validateStrategy, type Strategy } from "./strategy-schema.js";
import { validateIdentity, type AgentIdentity } from "./identity-schema.js";
import { loadSoul, validateSoul } from "./soul.js";

// ─── Types ───────────────────────────────────────────────────────────

/** Combined in-memory representation of all profile files. */
export interface AgentProfile {
  /** Parsed and validated config.json. */
  readonly config: LLMConfig;
  /** Parsed and validated strategy.json. */
  readonly strategy: Strategy;
  /** Raw Markdown content of soul.md. */
  readonly soul: string;
  /** Parsed and validated identity.json, or null if the file is absent. */
  readonly identity: AgentIdentity | null;
}

/** SHA-256 hashes of each profile file at load time.
 *  Used by the daemon to detect on-disk changes without re-reading. */
export interface AgentProfileHashes {
  readonly config: string;
  readonly strategy: string;
  readonly soul: string;
  /** null when identity.json is absent (file is optional). */
  readonly identity: string | null;
}

export interface AgentProfileResult {
  readonly profile: AgentProfile;
  readonly hashes: AgentProfileHashes;
}

// ─── Path helpers ────────────────────────────────────────────────────

/**
 * Returns the canonical directory for an agent slug.
 * Example: resolveAgentDir("my-bot") → "<aifight-home>/agents/my-bot"
 * (default ~/.aifight/agents/my-bot; honors AIFIGHT_HOME).
 *
 * Resolves from the unified AIFight home (store/paths) so the CLI and the
 * desktop app share one config folder. Does NOT verify the dir exists.
 */
export function resolveAgentDir(agentSlug: string): string {
  return path.join(getAgentsRoot(), agentSlug);
}

/**
 * Creates the agent directory (and all parent directories) if it does
 * not already exist. Idempotent — safe to call on every startup.
 */
export async function ensureAgentDir(agentSlug: string): Promise<void> {
  const dir = resolveAgentDir(agentSlug);
  await fs.mkdir(dir, { recursive: true });
}

// ─── Hash helper ─────────────────────────────────────────────────────

/**
 * Computes a lowercase hex SHA-256 hash of a file's raw bytes.
 * Propagates fs errors (ENOENT, EACCES, …) to the caller.
 */
export async function computeFileHash(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// ─── Profile loader ──────────────────────────────────────────────────

/** Raised when a required profile file cannot be loaded or fails validation. */
export class ProfileLoadError extends Error {
  override readonly name = "ProfileLoadError";
  /** Which file triggered the error. */
  readonly file: string;
  override readonly cause?: unknown;

  constructor(file: string, message: string, cause?: unknown) {
    super(message);
    this.file = file;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Reads and validates all profile files for an agent.
 *
 * - config.json and strategy.json are required JSON files validated by
 *   their respective schema modules.
 * - soul.md is required and validated by validateSoul().
 * - identity.json is optional; absent file yields profile.identity = null.
 *
 * Throws ProfileLoadError on any read or validation failure for required
 * files. For identity.json, ENOENT is silently treated as absent.
 */
export async function loadAgentProfile(agentDir: string): Promise<AgentProfileResult> {
  // ── config.json (required) ──────────────────────────────────────
  const configPath = path.join(agentDir, "config.json");
  let configRaw: string;
  try {
    configRaw = await fs.readFile(configPath, "utf8");
  } catch (e) {
    throw new ProfileLoadError(
      configPath,
      `cannot read config.json at ${configPath}: ${(e as Error).message}`,
      e,
    );
  }
  let configParsed: unknown;
  try {
    configParsed = JSON.parse(configRaw);
  } catch (e) {
    throw new ProfileLoadError(
      configPath,
      `config.json at ${configPath} is not valid JSON: ${(e as Error).message}`,
      e,
    );
  }
  const configResult = validateConfig(configParsed);
  if (!configResult.ok) {
    throw new ProfileLoadError(
      configPath,
      `config.json validation failed: ${configResult.errors.join("; ")}`,
    );
  }
  const configHash = crypto.createHash("sha256").update(configRaw, "utf8").digest("hex");

  // ── strategy.json (required) ────────────────────────────────────
  const strategyPath = path.join(agentDir, "strategy.json");
  let strategyRaw: string;
  try {
    strategyRaw = await fs.readFile(strategyPath, "utf8");
  } catch (e) {
    throw new ProfileLoadError(
      strategyPath,
      `cannot read strategy.json at ${strategyPath}: ${(e as Error).message}`,
      e,
    );
  }
  let strategyParsed: unknown;
  try {
    strategyParsed = JSON.parse(strategyRaw);
  } catch (e) {
    throw new ProfileLoadError(
      strategyPath,
      `strategy.json at ${strategyPath} is not valid JSON: ${(e as Error).message}`,
      e,
    );
  }
  const strategyResult = validateStrategy(strategyParsed);
  if (!strategyResult.ok) {
    throw new ProfileLoadError(
      strategyPath,
      `strategy.json validation failed: ${strategyResult.errors.join("; ")}`,
    );
  }
  const strategyHash = crypto.createHash("sha256").update(strategyRaw, "utf8").digest("hex");

  // ── soul.md (required) ──────────────────────────────────────────
  const soulPath = path.join(agentDir, "soul.md");
  let soulResult: { content: string; hash: string };
  try {
    soulResult = await loadSoul(soulPath);
  } catch (e) {
    throw new ProfileLoadError(
      soulPath,
      `cannot read soul.md at ${soulPath}: ${(e as Error).message}`,
      e,
    );
  }
  const soulValidation = validateSoul(soulResult.content);
  if (!soulValidation.ok) {
    throw new ProfileLoadError(
      soulPath,
      `soul.md validation failed: ${soulValidation.errors.join("; ")}`,
    );
  }

  // ── identity.json (optional) ────────────────────────────────────
  const identityPath = path.join(agentDir, "identity.json");
  let identity: AgentIdentity | null = null;
  let identityHash: string | null = null;

  let identityRaw: string | null = null;
  try {
    identityRaw = await fs.readFile(identityPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ProfileLoadError(
        identityPath,
        `cannot read identity.json at ${identityPath}: ${(e as Error).message}`,
        e,
      );
    }
    // ENOENT → optional file absent, leave identity = null
  }

  if (identityRaw !== null) {
    let identityParsed: unknown;
    try {
      identityParsed = JSON.parse(identityRaw);
    } catch (e) {
      throw new ProfileLoadError(
        identityPath,
        `identity.json at ${identityPath} is not valid JSON: ${(e as Error).message}`,
        e,
      );
    }
    const identityResult = validateIdentity(identityParsed);
    if (!identityResult.ok) {
      throw new ProfileLoadError(
        identityPath,
        `identity.json validation failed: ${identityResult.errors.join("; ")}`,
      );
    }
    identity = identityResult.identity;
    identityHash = crypto.createHash("sha256").update(identityRaw, "utf8").digest("hex");
  }

  return {
    profile: {
      config: configResult.config,
      strategy: strategyResult.strategy,
      soul: soulResult.content,
      identity,
    },
    hashes: {
      config: configHash,
      strategy: strategyHash,
      soul: soulResult.hash,
      identity: identityHash,
    },
  };
}
