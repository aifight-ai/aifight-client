// D8.6 — graphical LLM config editor backend. The desktop is a STANDALONE app:
// a user installs it and configures direct-LLM mode entirely in the GUI, never
// touching the CLI. This host reads/writes the SAME agent config the CLI uses
// (agents/<slug>/config.json) through the runtime's own schema + helpers, so the
// two never disagree — and it stores pasted API keys to a 0600 file via the
// runtime's storeSecretFile (config.json keeps only a {type:"file"} reference,
// never the raw key; the key never travels through argv/shell history).
//
// All imported runtime modules are native-module-free (config-schema, secret-ref,
// profile-loader), so they're safe to import statically in the Electron main
// process (no sqlite eager-load trap).
//
// Strategy is NOT handled here — it lives as free-form Markdown managed by
// strategy-host.ts (strategy/global.md + strategy/games/<game>.md). This host
// owns only config.json (model routing + provider key refs).

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveAgentDir, ensureAgentDir } from "@aifight/aifight/profile/profile-loader";
import {
  validateConfig,
  type LLMConfig,
  type LLMProfile,
  type Protocol,
  type ReasoningEffort,
} from "@aifight/aifight/profile/config-schema";
import { storeSecretFile, checkSecretStatus } from "@aifight/aifight/profile/secret-ref";
import { recommendMaxTokens } from "@aifight/aifight/llm/capabilities/validate-capabilities";
import type {
  ConfigMutResult,
  ConfigProfileView,
  ConfigView,
  ProfileInput,
  ProtocolFamily,
} from "../shared/ipc";

const DEFAULT_SLUG = "default";
const KEY_DIRNAME = "keys";

const VALID_FAMILIES: ReadonlySet<string> = new Set([
  "anthropic",
  "openai_chat",
  "openai_responses",
  "gemini",
]);

/** Concrete runtime protocol → the 4-family bucket the UI shows. */
function familyOf(protocol: string): ProtocolFamily {
  if (protocol === "anthropic_messages") return "anthropic";
  if (protocol === "openai_responses") return "openai_responses";
  if (protocol === "gemini_generate_content") return "gemini";
  return "openai_chat"; // *_chat_completions / *_chat_compat / deepseek_chat_completions
}

/**
 * Resolve a family + model/endpoint to the concrete adapter protocol. The
 * "openai_chat" family auto-routes to the DeepSeek adapter (for its thinking/
 * streaming/reasoning_content handling) when the model/endpoint is DeepSeek, to
 * the canonical OpenAI chat adapter for api.openai.com, else the generic compat.
 */
function resolveConcreteProtocol(family: string, model: string, baseURL: string): string {
  if (family === "anthropic") return "anthropic_messages";
  if (family === "openai_responses") return "openai_responses";
  if (family === "gemini") return "gemini_generate_content";
  const m = model.toLowerCase();
  const b = baseURL.toLowerCase();
  if (m.startsWith("deepseek") || b.includes("deepseek")) return "deepseek_chat_completions";
  if (b === "" || b.includes("api.openai.com")) return "openai_chat_completions";
  return "openai_chat_compat";
}

const VALID_EFFORTS: ReadonlySet<string> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "auto",
]);

function coerceEffort(value: string | undefined): ReasoningEffort | undefined {
  return value !== undefined && VALID_EFFORTS.has(value) ? (value as ReasoningEffort) : undefined;
}

function coerceStream(value: string | undefined): "auto" | "always" | "never" {
  return value === "always" || value === "never" ? value : "auto";
}

function coerceVerbosity(value: string | undefined): "low" | "medium" | "high" | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

/** Keep only boolean-valued, true feature flags (drops false/garbage to keep config lean). */
function sanitizeFeatures(value: Record<string, boolean> | undefined): Record<string, boolean> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === true) out[k] = true;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  return safe.length > 0 ? safe : "profile";
}

/** The only directory the GUI itself writes key files into (setKey). */
function managedKeyDir(slug: string): string {
  return path.join(resolveAgentDir(slug), KEY_DIRNAME);
}

/**
 * R14-F06: a key ref is "managed" iff it is a file ref pointing inside this
 * agent's keys/ dir — i.e. a file the GUI itself created. Only managed files may
 * be deleted from the GUI; external file refs a user wired up by hand (CLI,
 * hand-edited config) are never rm'd, only unreferenced.
 */
function managedKeyPathOf(slug: string, ref: unknown): string | null {
  if (ref === null || typeof ref !== "object") return null;
  const r = ref as { type?: unknown; path?: unknown };
  if (r.type !== "file" || typeof r.path !== "string") return null;
  const resolved = path.resolve(r.path);
  const dir = path.resolve(managedKeyDir(slug));
  return resolved !== dir && resolved.startsWith(dir + path.sep) ? resolved : null;
}

/**
 * R14-F06: delete a managed key file and VERIFY it is gone. Returns null on
 * verified deletion, else an actionable description (the raw key is still on
 * disk — the caller must not report success).
 */
async function removeManagedKeyFile(keyPath: string): Promise<string | null> {
  try {
    await fs.rm(keyPath, { force: true });
  } catch (cause) {
    return `the key file could not be deleted and still exists at ${keyPath} (${describeError(cause)})`;
  }
  try {
    await fs.stat(keyPath);
    return `the key file still exists at ${keyPath} after deletion`;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    return `could not verify deletion of the key file at ${keyPath} (${describeError(cause)})`;
  }
}

async function readConfigOptional(slug: string): Promise<LLMConfig | null> {
  const configPath = path.join(resolveAgentDir(slug), "config.json");
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    return null; // not configured yet — the GUI handles this, no throw
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = validateConfig(parsed);
  return result.ok ? result.config : null;
}

async function writeConfig(slug: string, config: LLMConfig): Promise<void> {
  const result = validateConfig(config);
  if (!result.ok) throw new Error(`refusing to write invalid config: ${result.errors.join("; ")}`);
  await ensureAgentDir(slug);
  const dir = resolveAgentDir(slug);
  const configPath = path.join(dir, "config.json");
  // Unique temp name per write: IPC mutations can interleave at await points,
  // and two writers sharing one fixed ".tmp" can rename a torn file into place
  // (caught by the concurrency test). With unique temps, whichever rename lands
  // last wins wholesale — the visible file is always one complete write.
  const tmp = `${configPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
    await fs.rename(tmp, configPath);
  } catch (cause) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw cause;
  }
  // config.json is the only profile file. The GUI-only flow is fully playable
  // with just this — strategy is optional Markdown (strategy-host.ts), scaffolded
  // for new agents by `aifight setup`, and the runtime skips it when absent.
}

function emptyConfig(): LLMConfig {
  return {
    schemaVersion: 1,
    activeProfile: "",
    profiles: {},
    routing: { default: "" },
  };
}

/** Read the editable config view (no secrets — only key SOURCE + resolvability). */
/**
 * Recommend the maxTokens a chosen reasoning effort needs (token-budget guard,
 * TOKEN_BUDGET_SAFETY_SPEC D4). Maps the UI family → concrete protocol so the
 * ceiling lookup matches the runtime. Returns null when no recommendation
 * applies (thinking off, low/medium effort, unknown-but-no-effort model).
 */
export function recommendMaxTokensForFamily(input: {
  family: string;
  model: string;
  effort?: string;
  thinkingEnabled: boolean;
}): { recommended: number; ceilingKnown: boolean } | null {
  if (typeof input?.family !== "string" || typeof input?.model !== "string") return null;
  const protocol = resolveConcreteProtocol(input.family, input.model, "");
  const rec = recommendMaxTokens({
    protocol,
    model: input.model,
    ...(input.effort ? { effort: input.effort } : {}),
    thinkingEnabled: input.thinkingEnabled === true,
  });
  return rec ?? null;
}

export async function getConfig(slug: string = DEFAULT_SLUG): Promise<ConfigView> {
  const config = await readConfigOptional(slug);
  if (config === null) {
    return { configured: false, slug, activeProfile: "", routing: { default: "" }, profiles: [] };
  }
  const profiles: ConfigProfileView[] = [];
  for (const [id, def] of Object.entries(config.profiles)) {
    const status = await checkSecretStatus(def.apiKeyRef);
    profiles.push({
      id,
      displayName: def.displayName ?? id,
      family: familyOf(def.protocol),
      protocol: def.protocol,
      model: def.model,
      baseURL: def.baseURL ?? null,
      keySource: status.sourceDescription,
      keyResolvable: status.available,
      thinkingEnabled: def.thinking?.enabled ?? false,
      effort: def.thinking?.effort ?? null,
      temperature: def.request?.temperature ?? null,
      maxTokens: def.request?.maxTokens ?? 16000,
      stream: def.request?.stream ?? "auto",
      verbosity: def.request?.verbosity ?? null,
      features: def.request?.features ?? {},
    });
  }
  return {
    configured: true,
    slug,
    activeProfile: config.activeProfile,
    routing: { default: config.routing.default, byGame: config.routing.byGame },
    profiles,
  };
}

/** Create or update a profile (everything except the API key). Initializes config if absent. */
export async function saveProfile(slug: string, input: ProfileInput): Promise<ConfigMutResult> {
  if (!input || typeof input.profileId !== "string" || input.profileId.trim() === "") {
    return { ok: false, error: "profile id is required" };
  }
  if (!VALID_FAMILIES.has(input.family)) {
    return { ok: false, error: `unsupported protocol family: ${String(input.family)}` };
  }
  if (typeof input.model !== "string" || input.model.trim() === "") {
    return { ok: false, error: "model is required" };
  }

  try {
    const config = (await readConfigOptional(slug)) ?? emptyConfig();
    const id = input.profileId.trim();
    const existing = config.profiles[id];
    const model = input.model.trim();
    const baseURL = (input.baseURL ?? "").trim();
    const protocol = resolveConcreteProtocol(input.family, model, baseURL) as Protocol;
    const verbosity = coerceVerbosity(input.verbosity);
    const profile: LLMProfile = {
      displayName: (input.displayName && input.displayName.trim()) || id,
      protocol,
      model,
      // Preserve the existing key ref; new profiles start with an unset placeholder
      // until setKey writes a real {type:"file"} ref.
      apiKeyRef: existing?.apiKeyRef ?? { type: "env", name: "UNSET_API_KEY" },
      request: {
        temperature: input.temperature !== undefined ? input.temperature : existing?.request?.temperature ?? null,
        maxTokens:
          typeof input.maxTokens === "number" && input.maxTokens > 0
            ? input.maxTokens
            : existing?.request?.maxTokens ?? 16000,
        responseFormat: existing?.request?.responseFormat ?? "json",
        stream: coerceStream(input.stream ?? existing?.request?.stream),
        ...(verbosity ? { verbosity } : {}),
        ...((): { features?: Record<string, boolean> } => {
          const f = sanitizeFeatures(input.features) ?? existing?.request?.features;
          return f && Object.keys(f).length > 0 ? { features: f } : {};
        })(),
      },
      thinking: {
        enabled: Boolean(input.thinkingEnabled),
        mode: input.thinkingEnabled ? "always" : "never",
        ...((): { effort?: ReasoningEffort } => {
          const e = coerceEffort(input.effort);
          return e ? { effort: e } : {};
        })(),
      },
      timeouts: existing?.timeouts ?? { requestMs: 30000, connectMs: 10000 },
      retries: existing?.retries ?? { maxAttempts: 2, backoffMs: 500 },
      budgets: existing?.budgets ?? { maxCostUSDPerMatch: 1.0, maxOutputTokensPerDecision: 4096 },
    };
    if (baseURL.length > 0) profile.baseURL = baseURL; // else omit → protocol default

    config.profiles[id] = profile;
    if (config.profiles[config.activeProfile] === undefined) config.activeProfile = id;
    if (config.profiles[config.routing.default] === undefined) config.routing.default = id;

    await writeConfig(slug, config);
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: describeError(cause) };
  }
}

/** Store a pasted API key to a 0600 file and point the profile's apiKeyRef at it. */
export async function setKey(slug: string, profileId: unknown, rawKey: unknown): Promise<ConfigMutResult> {
  if (typeof profileId !== "string" || profileId.trim() === "") return { ok: false, error: "profile id is required" };
  if (typeof rawKey !== "string" || rawKey.trim() === "") return { ok: false, error: "API key is empty" };
  try {
    const config = await readConfigOptional(slug);
    if (config === null || config.profiles[profileId] === undefined) {
      return { ok: false, error: `profile not found: ${profileId}` };
    }
    const keyPath = path.join(resolveAgentDir(slug), KEY_DIRNAME, `${safeSegment(profileId)}.key`);
    await storeSecretFile(keyPath, rawKey.trim());
    config.profiles[profileId] = { ...config.profiles[profileId], apiKeyRef: { type: "file", path: keyPath } };
    await writeConfig(slug, config);
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: describeError(cause) };
  }
}

/** Remove a profile's pasted API key. R14-F06 hardening: the config is updated
 *  FIRST (atomic write — the app stops resolving the key even if the file rm
 *  below fails), then the managed 0600 key file is deleted and verified gone;
 *  a failed deletion returns an error naming the retained path instead of fake
 *  success. External file refs (not created by the GUI) are unreferenced but
 *  never deleted. */
export async function clearKey(slug: string, profileId: unknown): Promise<ConfigMutResult> {
  if (typeof profileId !== "string" || profileId.trim() === "") return { ok: false, error: "profile id is required" };
  try {
    const config = await readConfigOptional(slug);
    if (config === null || config.profiles[profileId] === undefined) {
      return { ok: false, error: `profile not found: ${profileId}` };
    }
    const managedPath = managedKeyPathOf(slug, config.profiles[profileId].apiKeyRef);
    config.profiles[profileId] = { ...config.profiles[profileId], apiKeyRef: { type: "env", name: "UNSET_API_KEY" } };
    await writeConfig(slug, config);
    if (managedPath !== null) {
      const failure = await removeManagedKeyFile(managedPath);
      if (failure !== null) {
        return { ok: false, error: `key reference removed, but ${failure} — delete the file manually` };
      }
    }
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: describeError(cause) };
  }
}

export async function setActive(slug: string, profileId: unknown): Promise<ConfigMutResult> {
  if (typeof profileId !== "string") return { ok: false, error: "profile id is required" };
  try {
    const config = await readConfigOptional(slug);
    if (config === null || config.profiles[profileId] === undefined) {
      return { ok: false, error: `profile not found: ${profileId}` };
    }
    config.activeProfile = profileId;
    await writeConfig(slug, config);
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: describeError(cause) };
  }
}

export async function setRoute(slug: string, game: unknown, profileId: unknown): Promise<ConfigMutResult> {
  if (typeof profileId !== "string") return { ok: false, error: "profile id is required" };
  try {
    const config = await readConfigOptional(slug);
    if (config === null || config.profiles[profileId] === undefined) {
      return { ok: false, error: `profile not found: ${profileId}` };
    }
    if (game === "default" || typeof game !== "string") {
      config.routing.default = profileId;
    } else {
      config.routing.byGame = { ...config.routing.byGame, [game]: profileId };
    }
    await writeConfig(slug, config);
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: describeError(cause) };
  }
}

export async function deleteProfile(slug: string, profileId: unknown): Promise<ConfigMutResult> {
  if (typeof profileId !== "string") return { ok: false, error: "profile id is required" };
  try {
    const config = await readConfigOptional(slug);
    if (config === null || config.profiles[profileId] === undefined) {
      return { ok: false, error: `profile not found: ${profileId}` };
    }
    // R14-F06: deleting a profile must not orphan its pasted key on disk.
    // Capture the managed key path before the profile row disappears.
    const managedPath = managedKeyPathOf(slug, config.profiles[profileId].apiKeyRef);
    delete config.profiles[profileId];
    const remaining = Object.keys(config.profiles);
    if (remaining.length === 0) return { ok: false, error: "cannot delete the only profile" };
    if (config.activeProfile === profileId) config.activeProfile = remaining[0]!;
    if (config.routing.default === profileId) config.routing.default = remaining[0]!;
    if (config.routing.byGame) {
      const byGame: Record<string, string> = {};
      for (const [g, p] of Object.entries(config.routing.byGame)) {
        if (p !== profileId) byGame[g] = p;
      }
      config.routing.byGame = byGame;
    }
    await writeConfig(slug, config);
    if (managedPath !== null) {
      const failure = await removeManagedKeyFile(managedPath);
      if (failure !== null) {
        return { ok: false, error: `profile deleted, but ${failure} — delete the file manually` };
      }
    }
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: describeError(cause) };
  }
}
