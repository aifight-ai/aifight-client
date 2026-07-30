// The DECLARED MODEL: the public model label the leaderboard and the agent
// profile show for a self-hosted agent (owner decision 2026-07-30). Until now
// every CLI-registered agent showed "direct" forever because setup registers
// with model="direct" and nothing ever updated it.
//
// Effective value resolution:
//   1. bridge.json `declaredModel` (non-empty after trim) — an explicit pin
//      (`aifight set declared-model <name>`)
//   2. the ACTIVE agent profile's configured LLM model — runtimeType "direct"
//      only, a mock agent runs no LLM
//      (<aifight-home>/agents/<directAgentSlug ?? "default">/config.json →
//       profiles[activeProfile].model, then routing.default)
//   3. "direct" — the historical behavior when nothing is configured
//
// Platform write path: PATCH {baseUrl}/api/agents/me/policy with
// {"declared_model": effective} under the agent's own API key. Best-effort
// everywhere — sync failures come back as ok:false for the caller to warn
// about, never as throws, and every bridge startup re-syncs so a change made
// while offline eventually propagates.

import fs from "node:fs";
import path from "node:path";

import { fetchNoFollow } from "../net/guarded-fetch";
import { getAgentsRoot, safePathSegment } from "../store/paths";
import { readBridgeConfig, type BridgeConfig } from "./config";

/** Matches the platform rule (agents.model is varchar(100)). */
export const DECLARED_MODEL_MAX_CHARS = 100;

/** The label when nothing is pinned and no profile model exists — the value
 *  CLI setup has always registered with. */
export const DECLARED_MODEL_FALLBACK = "direct";

/** Nobody blocks on this sync's answer beyond a warning, so it is bounded well
 *  under the 15s policy PATCH of daily-policy.ts — a wedged platform must not
 *  hold up `aifight run` startup or a `set` command. */
const DECLARED_MODEL_SYNC_TIMEOUT_MS = 5_000;

export type DeclaredModelOrigin = "custom" | "model_config" | "default";

export interface EffectiveDeclaredModel {
  readonly value: string;
  readonly origin: DeclaredModelOrigin;
}

/** Short human tag for status / command output: where the label comes from. */
export function declaredModelOriginLabel(origin: DeclaredModelOrigin): string {
  switch (origin) {
    case "custom":
      return "custom";
    case "model_config":
      return "from model config";
    case "default":
      return "default";
  }
}

/** Pure resolution of the effective label. The profile-model reader is
 *  injectable so tests never touch a real home directory. The profile lookup
 *  only applies to runtimeType "direct" — a mock agent runs no LLM, so its
 *  label is the pin or the "direct" fallback, never a profile's model. */
export function resolveEffectiveDeclaredModel(
  config: Pick<BridgeConfig, "declaredModel" | "directAgentSlug" | "runtimeType">,
  readProfileModel: (slug: string) => string | undefined = readActiveProfileModel,
): EffectiveDeclaredModel {
  const pinned = config.declaredModel?.trim() ?? "";
  if (pinned !== "") return { value: pinned, origin: "custom" };
  if (config.runtimeType === "direct") {
    const slug = config.directAgentSlug ?? "default";
    const fromProfile = readProfileModel(slug)?.trim() ?? "";
    if (fromProfile !== "") return { value: fromProfile, origin: "model_config" };
  }
  return { value: DECLARED_MODEL_FALLBACK, origin: "default" };
}

/** The active profile's configured LLM model for an agent slug, read straight
 *  from <aifight-home>/agents/<slug>/config.json. Deliberately lenient: this
 *  runs on bridge startup and in `aifight status`, so a missing, corrupt, or
 *  half-written config yields undefined (→ the "direct" fallback), never an
 *  exception. Prefers `activeProfile`, then `routing.default` — the two names
 *  the CLI's own config commands keep in lockstep. */
export function readActiveProfileModel(slug: string): string | undefined {
  try {
    const configPath = path.join(getAgentsRoot(), safePathSegment(slug), "config.json");
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object") return undefined;
    const cfg = parsed as {
      activeProfile?: unknown;
      routing?: { default?: unknown };
      profiles?: Record<string, { model?: unknown }>;
    };
    if (cfg.profiles === null || typeof cfg.profiles !== "object") return undefined;
    const candidates = [
      typeof cfg.activeProfile === "string" ? cfg.activeProfile : undefined,
      typeof cfg.routing?.default === "string" ? cfg.routing.default : undefined,
    ];
    for (const name of candidates) {
      if (name === undefined) continue;
      const model = cfg.profiles[name]?.model;
      if (typeof model === "string" && model.trim() !== "") return model.trim();
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export type DeclaredModelSyncResult =
  | { readonly ok: true; readonly value: string; readonly origin: DeclaredModelOrigin }
  | { readonly ok: false; readonly value: string; readonly origin: DeclaredModelOrigin; readonly error: string };

/** Push the effective declared model to the platform. NEVER throws — the
 *  local config is the source of truth and every bridge startup re-syncs, so
 *  a failure here is a warning, not a command failure. */
export async function syncDeclaredModel(
  config: BridgeConfig,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<DeclaredModelSyncResult> {
  const effective = resolveEffectiveDeclaredModel(config);
  try {
    const res = await fetchNoFollow(
      `${config.baseUrl.replace(/\/+$/, "")}/api/agents/me/policy`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": config.apiKey,
        },
        body: JSON.stringify({ declared_model: effective.value }),
        signal: AbortSignal.timeout(DECLARED_MODEL_SYNC_TIMEOUT_MS),
      },
      { fetchImpl },
    );
    if (!res.ok) {
      return { ...effective, ok: false, error: await readAPIError(res, `HTTP ${res.status}`) };
    }
    return { ...effective, ok: true };
  } catch (cause) {
    return { ...effective, ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** One best-effort platform sync at bridge startup (`aifight run`, the
 *  service, `aifight start`) so declared-model changes made while offline
 *  propagate. Once per process start — NOT on reconnect. Silent on success;
 *  warns via the callback on failure. Never throws. */
export async function syncDeclaredModelAtStartup(
  config: BridgeConfig,
  opts: { readonly fetchImpl?: typeof fetch; readonly warn: (message: string) => void },
): Promise<void> {
  const result = await syncDeclaredModel(config, opts.fetchImpl ?? globalThis.fetch);
  if (!result.ok) {
    opts.warn(
      `could not sync the declared model ("${result.value}") to the platform (${result.error}) — the leaderboard keeps the previous value; the next start retries`,
    );
  }
}

/** After an LLM config edit (`aifight config update <profile> --model …`,
 *  headless or interactive): when the edit changed the ACTIVE agent profile's
 *  model — the value the leaderboard label is derived from — push the new
 *  effective label. Best-effort; never throws. Skips when no bridge is
 *  configured on this machine, when the edit touched another agent slug, when
 *  the model did not actually change, or when a `declaredModel` pin overrides
 *  the profile model anyway (the effective label is then unchanged). */
export async function syncDeclaredModelAfterProfileEdit(opts: {
  readonly slug: string;
  readonly modelBefore: string | undefined;
  readonly modelAfter: string | undefined;
  readonly fetchImpl?: typeof fetch;
  readonly warn: (message: string) => void;
  readonly info?: (message: string) => void;
}): Promise<void> {
  if (opts.modelBefore === opts.modelAfter) return;
  let config: BridgeConfig;
  try {
    config = readBridgeConfig();
  } catch {
    return; // no agent on this machine → nothing to sync
  }
  if ((config.directAgentSlug ?? "default") !== opts.slug) return;
  if ((config.declaredModel ?? "").trim() !== "") return; // pinned: effective unchanged
  const result = await syncDeclaredModel(config, opts.fetchImpl ?? globalThis.fetch);
  if (!result.ok) {
    opts.warn(
      `could not sync the declared model to the platform (${result.error}) — it retries at the next bridge start`,
    );
    return;
  }
  opts.info?.(`Declared model synced: the leaderboard now shows "${result.value}".`);
}

async function readAPIError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => undefined)) as unknown;
  if (body && typeof body === "object") {
    const error = (body as Record<string, unknown>).error;
    if (typeof error === "string" && error.length > 0) return error;
  }
  return fallback;
}
