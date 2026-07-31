// The local identity store behind the panel's Profile item (V3 ④, design
// CLI_UX_V3_DESIGN_2026-07-31.html §4): several agent identities may live on
// this machine, exactly ONE is active at a time.
//
// Layout: <runtime-home>/identities/<agentId>.json — each a full BridgeConfig
// (same encryption-at-rest pipeline as bridge.json, via the path-taking
// read/write variants in bridge/config.ts). bridge.json remains the ACTIVE
// truth: switching = snapshot the outgoing active back to its identity file,
// then write the chosen identity over bridge.json.
//
// Transparent migration: the store seeds itself from the current bridge.json
// the first time it is listed (an existing single-agent install becomes its
// own first identity; nothing the user has to do).

import fs from "node:fs";
import path from "node:path";

import { getRuntimeHome, safePathSegment } from "../store/paths";
import {
  getBridgeConfigPath,
  readBridgeConfig,
  readBridgeConfigFromPath,
  writeBridgeConfigToPath,
  type BridgeConfig,
} from "./config";

export interface IdentityEntry {
  /** The agentId this identity belongs to (the file name is derived from it). */
  readonly agentId: string;
  readonly config: BridgeConfig;
}

/** The directory holding one file per stored identity. */
export function identitiesDir(): string {
  return path.join(getRuntimeHome(), "identities");
}

function identityPath(agentId: string): string {
  // safePathSegment: agentId comes from the platform — never let it walk the
  // path out of the store (same guard archiveReplacedBridgeConfig uses).
  return path.join(identitiesDir(), `${safePathSegment(agentId)}.json`);
}

function ensureIdentitiesDir(): void {
  fs.mkdirSync(identitiesDir(), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(identitiesDir(), 0o700);
    } catch {
      // Best effort — the runtime home itself is already 0700.
    }
  }
}

/**
 * Every stored identity, in stable name order. Unreadable/invalid files are
 * skipped (a hand-edited identity must not brick the panel; `aifight doctor`
 * is where damage gets reported). Seeds the store from the active bridge.json
 * on first use (see the module comment).
 */
export function listIdentities(): IdentityEntry[] {
  seedIdentitiesFromActive();
  let names: string[];
  try {
    names = fs.readdirSync(identitiesDir());
  } catch {
    return [];
  }
  const out: IdentityEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const config = readBridgeConfigFromPath(path.join(identitiesDir(), name));
      out.push({ agentId: config.agentId, config });
    } catch {
      // Skip the damaged file — see the doc comment.
    }
  }
  out.sort((a, b) => a.config.agentName.localeCompare(b.config.agentName));
  return out;
}

/** One stored identity by agentId, or undefined when absent/unreadable. */
export function readIdentity(agentId: string): BridgeConfig | undefined {
  try {
    return readBridgeConfigFromPath(identityPath(agentId));
  } catch {
    return undefined;
  }
}

/** Save an identity under its agentId (create or update). */
export function writeIdentity(config: BridgeConfig): void {
  ensureIdentitiesDir();
  writeBridgeConfigToPath(identityPath(config.agentId), config);
}

/**
 * The switch primitive: snapshot the CURRENT active (bridge.json) back to its
 * identity file — changes made since it was seeded (rename, daily cap, games)
 * would otherwise be lost — then write the chosen identity over bridge.json.
 * NOT preserveMtime on the bridge.json write: the switch is the one true
 * restart-needed change (with LLM edits), and the mtime bump is exactly what
 * arms the panel's once-at-the-end restart offer.
 */
export function switchActiveIdentity(target: BridgeConfig): void {
  try {
    writeIdentity(readBridgeConfig());
  } catch {
    // No readable active config (first run / damaged) — there is nothing
    // worth snapshotting; the switch itself still proceeds.
  }
  writeIdentity(target);
  // writeBridgeConfigToPath rather than writeBridgeConfig only because the
  // call site reads better next to the identity writes — same pipeline, same
  // default (mtime-bumping) options.
  writeBridgeConfigToPath(getBridgeConfigPath(), { ...target, updatedAt: new Date().toISOString() });
}

/**
 * Seed the store from the active bridge.json when it has no file for that
 * agent yet (transparent migration for pre-V3 installs, and the first-run
 * path right after setup). No-op when unconfigured or already seeded.
 */
export function seedIdentitiesFromActive(): void {
  let active: BridgeConfig;
  try {
    active = readBridgeConfig();
  } catch {
    return; // unconfigured — nothing to seed
  }
  if (readIdentity(active.agentId) !== undefined) return;
  try {
    writeIdentity(active);
  } catch {
    // Best effort: the panel still works with an empty store (it shows the
    // active identity from bridge.json directly).
  }
}
