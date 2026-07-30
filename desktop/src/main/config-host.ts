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

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveAgentDir, ensureAgentDir } from "@aifight/aifight/profile/profile-loader";
import {
  validateConfig,
  DEFAULT_MAX_TOKENS,
  type LLMConfig,
  type LLMProfile,
  type Protocol,
  type ReasoningEffort,
  STORABLE_REASONING_EFFORTS,
} from "@aifight/aifight/profile/config-schema";
import { storeSecretFile, checkSecretStatus, resolveSecret } from "@aifight/aifight/profile/secret-ref";
import { discoverModelsForProtocol } from "@aifight/aifight/llm/discover-models";
import {
  recommendMaxTokens,
  resolveModelCapabilities,
} from "@aifight/aifight/llm/capabilities/validate-capabilities";
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
 * Which concrete chat adapter (model, endpoint) actually IDENTIFIES, or null when
 * nothing in them does — a generic endpoint behind a corporate gateway looks the
 * same whatever is really on the other end.
 *
 * Split out from resolveConcreteProtocol because the two callers need opposite
 * things from a no-signal answer: a NEW profile has to land somewhere, so it takes
 * the generic compat adapter; an EXISTING profile already has an answer recorded,
 * and overwriting it with the fallback is how a DeepSeek profile reached through a
 * gateway silently became a plain compat profile (B3).
 */
function detectChatProtocol(model: string, baseURL: string): string | null {
  const m = model.toLowerCase();
  const b = baseURL.toLowerCase();
  if (m.startsWith("deepseek") || b.includes("deepseek")) return "deepseek_chat_completions";
  if (b === "" || b.includes("api.openai.com")) return "openai_chat_completions";
  return null;
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
  return detectChatProtocol(model, baseURL) ?? "openai_chat_compat";
}

/**
 * The protocol to STORE for a save, which is not always the one the heuristic
 * derives. The GUI edits four families while config.json records one of six
 * protocols, so every save re-derives the concrete one — and for the three that
 * share the openai_chat family that derivation can only ever DISCOVER an adapter
 * from a positive signal, never retain one. A DeepSeek profile written by the CLI
 * behind a gateway (model "v4-pro", no "deepseek" anywhere) therefore lost its
 * adapter to any unrelated edit — same endpoint afterwards, but none of DeepSeek's
 * thinking/reasoning_content handling, and nothing said so.
 *
 * So: re-derive when the user changed the family, or when (model, baseURL) actually
 * point somewhere; otherwise keep what is already recorded.
 */
function protocolForSave(
  family: string,
  model: string,
  baseURL: string,
  existingProtocol: string | undefined,
): string {
  const derived = resolveConcreteProtocol(family, model, baseURL);
  if (existingProtocol === undefined) return derived;
  if (familyOf(existingProtocol) !== family) return derived;
  return detectChatProtocol(model, baseURL) === null ? existingProtocol : derived;
}

// The storable set comes from the runtime schema, not a copy — a local duplicate
// silently drops any tier the copy predates (this one had no way to know about a
// value the schema would happily have accepted).
const VALID_EFFORTS: ReadonlySet<string> = new Set(STORABLE_REASONING_EFFORTS);

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

// R12 (2026-07-26): safeSegment is lossy ("gpt/mini" and "gpt_mini" collapse to
// the same segment; two equal-length CJK ids collapse to the same run of "_"),
// so a name derived from it alone is NOT injective — two profiles could share one
// key file, sending one profile's key to the other's endpoint or deleting a
// still-referenced key. Suffix a short hash of the RAW id to make the filename
// injective while keeping the human-readable prefix.
function keyFileName(profileId: string): string {
  const digest = createHash("sha256").update(profileId).digest("hex").slice(0, 8);
  return `${safeSegment(profileId)}-${digest}.key`;
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

// R12 (2026-07-26): distinguish "no config yet" (ENOENT) from "config.json is
// present but unreadable/corrupt/schema-invalid". The old readConfigOptional
// collapsed all three to null, which made getConfig report a corrupt config as
// "not configured" and let the next saveProfile rebuild from emptyConfig() and
// silently overwrite every other profile + routing shared with the CLI. Callers
// that must never overwrite (saveProfile) branch on this; the fail-closed
// mutators keep using readConfigOptional (both absent and invalid → null →
// "profile not found", which is safe — they never write emptyConfig()).
type ReadConfigState =
  | { state: "absent" }
  | { state: "invalid"; errors: string[] }
  | { state: "ok"; config: LLMConfig };

async function readConfigState(slug: string): Promise<ReadConfigState> {
  const configPath = path.join(resolveAgentDir(slug), "config.json");
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return { state: "absent" };
    return { state: "invalid", errors: [`config.json could not be read: ${describeError(cause)}`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return { state: "invalid", errors: [`config.json is not valid JSON: ${describeError(cause)}`] };
  }
  const result = validateConfig(parsed);
  if (!result.ok) return { state: "invalid", errors: result.errors };
  return { state: "ok", config: result.config };
}

async function readConfigOptional(slug: string): Promise<LLMConfig | null> {
  const s = await readConfigState(slug);
  return s.state === "ok" ? s.config : null;
}

/**
 * The ACTIVE profile's configured model id, synchronously and read-only — null
 * when there is no valid config or no active profile. BridgeHost uses this to
 * resolve the effective declared leaderboard model (declared-model feature,
 * owner decision 2026-07-30) inside its SYNC status-summary path, so it cannot
 * go through the async readConfigState. Never throws: a missing/invalid
 * config.json simply means "no local model answer", same as getConfig's
 * not-configured branch.
 */
export function activeProfileModelSync(slug: string): string | null {
  try {
    const raw = readFileSync(path.join(resolveAgentDir(slug), "config.json"), "utf8");
    const result = validateConfig(JSON.parse(raw));
    if (!result.ok) return null;
    const model = result.config.profiles[result.config.activeProfile]?.model;
    return typeof model === "string" && model.trim() !== "" ? model : null;
  } catch {
    return null;
  }
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
    // R12 (2026-07-26): fsync the tmp file before the rename. writeFile leaves
    // the bytes in the OS page cache; on power loss shortly after the rename the
    // metadata can commit before the data, leaving config.json zero-length/torn
    // on next boot — which readConfigState now flags as "invalid" (previously a
    // silent "unconfigured" wipe). Mirrors the runtime's durable single-user
    // writers (account/credentials.ts, device-id.ts) which write+fsync+close
    // before publishing.
    const fh = await fs.open(tmp, "w");
    try {
      await fh.writeFile(JSON.stringify(config, null, 2) + "\n", "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
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

/**
 * Surface the capability registry to the renderer so the Models editor offers the
 * effort tiers a model actually has, instead of a regex table maintained here.
 * An unlisted model yields the protocol-wide tier list with isKnownModel:false —
 * suggestions, not a whitelist, so a model newer than this build stays configurable.
 */
export function modelCapabilitiesForFamily(input: {
  family: string;
  model: string;
}): {
  efforts: string[];
  protocolEfforts: string[];
  storableEfforts: readonly string[];
  isKnownModel: boolean;
  defaultEffort?: string;
  thinkingModes: string[];
  thinkingAlwaysOn: boolean;
  thinkingDefaultOn: boolean;
  thinkingParam?: string;
  maxOutputTokens?: number;
} | null {
  if (typeof input?.family !== "string" || typeof input?.model !== "string") return null;
  const protocol = resolveConcreteProtocol(input.family, input.model, "");
  const caps = resolveModelCapabilities(protocol, input.model);
  return {
    efforts: caps.efforts,
    protocolEfforts: caps.protocolEfforts,
    storableEfforts: caps.storableEfforts,
    isKnownModel: caps.isKnownModel,
    ...(caps.defaultEffort !== undefined ? { defaultEffort: caps.defaultEffort } : {}),
    thinkingModes: caps.thinkingModes,
    thinkingAlwaysOn: caps.thinkingAlwaysOn,
    thinkingDefaultOn: caps.thinkingDefaultOn,
    ...(caps.thinkingParam !== undefined ? { thinkingParam: caps.thinkingParam } : {}),
    ...(caps.maxOutputTokens !== undefined ? { maxOutputTokens: caps.maxOutputTokens } : {}),
  };
}

/**
 * True when both URLs address the same origin (scheme + host + port). Origin is
 * the right granularity: it is exactly who receives the key on the wire, while
 * the path ("/v1" vs "/v1/") does not change that. An unparseable URL on either
 * side is never a match.
 */
function sameEndpointOrigin(a: string, b: string): boolean {
  const originOf = (u: string): string | null => {
    try {
      return new URL(u).origin.toLowerCase();
    } catch {
      return null;
    }
  };
  const left = originOf(a);
  return left !== null && left === originOf(b);
}

/**
 * Ask the provider which models exist, using the key pasted in the form (not yet
 * saved) or the profile's stored key. Best-effort — null means "no list, fall back
 * to seeds"; it never throws into the renderer.
 */
export async function discoverModelsForFamily(
  slug: string,
  input: { family: string; model: string; baseURL?: string; apiKey?: string; profileId?: string },
): Promise<{ models: string[] } | null> {
  if (typeof input?.family !== "string" || typeof input?.model !== "string") return null;
  const baseURLRaw = typeof input.baseURL === "string" ? input.baseURL.trim() : "";
  const protocol = resolveConcreteProtocol(input.family, input.model, baseURLRaw) as Protocol;
  const caps = resolveModelCapabilities(protocol, input.model);
  const baseURL = baseURLRaw !== "" ? baseURLRaw : (caps.defaultBaseURL ?? "");
  if (baseURL === "") return null;

  let apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (apiKey === "" && typeof input.profileId === "string" && input.profileId !== "") {
    const config = await readConfigOptional(slug);
    const profile = config?.profiles[input.profileId];
    const ref = profile?.apiKeyRef;
    if (profile && ref) {
      // SECURITY (codex-security 2026-07-29 C05): a STORED key only goes to the
      // endpoint its own profile is configured for.
      //
      // Both baseURL and profileId arrive from the renderer, so anything that can
      // send IPC could name a saved profile and any host it likes, and the main
      // process would helpfully decrypt that profile's key and post it there.
      // fetchNoFollow only blocks the redirects AFTER the first hop — the first
      // hop is the leak. (Renderer isolation is hard: contextIsolation, sandbox,
      // no nodeIntegration, loadFile, will-navigate + window-open interception.
      // So this is depth, not a live hole. It also costs nothing.)
      //
      // A key typed into the FORM is untouched by this — the user is testing an
      // endpoint they just named, and pointing their own key wherever they want
      // is the whole feature. Only the reuse of a key they cannot see is pinned.
      const storedBase = typeof profile.baseURL === "string" ? profile.baseURL.trim() : "";
      const allowedBase =
        storedBase !== ""
          ? storedBase
          : (resolveModelCapabilities(profile.protocol as Protocol, profile.model).defaultBaseURL ?? "");
      if (!sameEndpointOrigin(baseURL, allowedBase)) return null;
      try {
        apiKey = await resolveSecret(ref);
      } catch {
        return null; // stored key unreadable — the Test button is the diagnosis path
      }
    }
  }
  if (apiKey === "") return null;

  const models = await discoverModelsForProtocol({}, { protocol, baseURL, apiKey });
  return models !== null && models.length > 0 ? { models } : null;
}

export async function getConfig(slug: string = DEFAULT_SLUG): Promise<ConfigView> {
  const state = await readConfigState(slug);
  if (state.state !== "ok") {
    // R12: a present-but-invalid config surfaces an error so the UI can warn
    // ("config.json is invalid — fix or back it up") instead of silently showing
    // the fresh-setup flow, whose next save would overwrite the real file.
    return {
      configured: false,
      slug,
      activeProfile: "",
      routing: { default: "" },
      profiles: [],
      ...(state.state === "invalid"
        ? {
            error: state.errors.join("; "),
            configPath: path.join(resolveAgentDir(slug), "config.json"),
          }
        : {}),
    };
  }
  const config = state.config;
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
      maxReasoningTokens: def.thinking?.maxReasoningTokens ?? null,
      temperature: def.request?.temperature ?? null,
      maxTokens: def.request?.maxTokens ?? DEFAULT_MAX_TOKENS,
      requestTimeoutMs: def.timeouts?.requestMs ?? null,
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

// All config MUTATIONS run strictly one-at-a-time, in call order — the same
// FIFO discipline cli-host.ts applies to desktop CLI ops. Every mutator below
// is a read-modify-write on config.json; writeConfig's unique tmp + rename
// only prevents TORN files, not LOST UPDATES (two in-flight IPC mutations
// could interleave reads and let the older write land last). The renderer
// currently awaits each invoke in order, so this is defensive depth (审查 #10),
// not a live-bug fix.
let configMutationChain: Promise<unknown> = Promise.resolve();

/** Enqueue a config mutation on the strict FIFO chain. A failed task never
 *  breaks the chain for the next one. Exported for tests. */
export function enqueueConfigMutation<T>(task: () => Promise<T>): Promise<T> {
  const run = configMutationChain.then(task, task);
  configMutationChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Create or update a profile (everything except the API key). Initializes config if absent. */
export function saveProfile(slug: string, input: ProfileInput): Promise<ConfigMutResult> {
  return enqueueConfigMutation(() => saveProfileInner(slug, input));
}

async function saveProfileInner(slug: string, input: ProfileInput): Promise<ConfigMutResult> {
  if (!input || typeof input.profileId !== "string" || input.profileId.trim() === "") {
    return { ok: false, error: "profile id is required" };
  }
  if (!VALID_FAMILIES.has(input.family)) {
    return { ok: false, error: `unsupported protocol family: ${String(input.family)}` };
  }
  if (typeof input.model !== "string" || input.model.trim() === "") {
    return { ok: false, error: "model is required" };
  }

  const id = input.profileId.trim();
  // R12 (2026-07-26): reject prototype-chain names ("__proto__", "constructor",
  // "toString", …). `config.profiles[id] = profile` for such an id mutates the
  // object's prototype instead of creating an own property — validateConfig (own
  // keys only) still passes, so saveProfile returns ok:true with NO profile
  // created, and a paired setKey then orphans a plaintext key file nothing can
  // reference. Object.prototype own-names are exactly the dangerous set.
  if (Object.hasOwn(Object.prototype, id)) {
    return { ok: false, error: `invalid profile id: ${id}` };
  }

  try {
    // R12: never rebuild from emptyConfig() when config.json is present but
    // invalid — that would silently overwrite every other profile + routing.
    const state = await readConfigState(slug);
    if (state.state === "invalid") {
      return {
        ok: false,
        error: `config.json exists but is invalid (${state.errors.join("; ")}); fix or back it up before saving`,
      };
    }
    const config = state.state === "ok" ? state.config : emptyConfig();
    const existing = config.profiles[id];
    const model = input.model.trim();
    const baseURL = (input.baseURL ?? "").trim();
    const protocol = protocolForSave(input.family, model, baseURL, existing?.protocol) as Protocol;
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
            : existing?.request?.maxTokens ?? DEFAULT_MAX_TOKENS,
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
        // Manual thinking budget: explicit number sets, explicit null clears,
        // absent preserves — mirroring the temperature convention above.
        ...((): { maxReasoningTokens?: number } => {
          if (input.maxReasoningTokens === null) return {};
          if (typeof input.maxReasoningTokens === "number" && Number.isFinite(input.maxReasoningTokens) && input.maxReasoningTokens > 0) {
            return { maxReasoningTokens: Math.floor(input.maxReasoningTokens) };
          }
          const kept = existing?.thinking?.maxReasoningTokens;
          return typeof kept === "number" ? { maxReasoningTokens: kept } : {};
        })(),
        ...((): { effort?: ReasoningEffort } => {
          const e = coerceEffort(input.effort);
          return e ? { effort: e } : {};
        })(),
      },
      timeouts: {
        // Clamp into the runtime schema's [1ms, 300s] bounds: an out-of-range
        // value would save fine here but make profile loading reject the whole
        // config — the agent then silently fails to start.
        requestMs:
          typeof input.requestTimeoutMs === "number" && input.requestTimeoutMs > 0
            ? Math.min(Math.max(1, Math.round(input.requestTimeoutMs)), 300_000)
            : existing?.timeouts?.requestMs ?? 270000,
      },
      retries: existing?.retries ?? { maxAttempts: 2 },
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
export function setKey(slug: string, profileId: unknown, rawKey: unknown): Promise<ConfigMutResult> {
  return enqueueConfigMutation(() => setKeyInner(slug, profileId, rawKey));
}

async function setKeyInner(slug: string, profileId: unknown, rawKey: unknown): Promise<ConfigMutResult> {
  if (typeof profileId !== "string" || profileId.trim() === "") return { ok: false, error: "profile id is required" };
  if (typeof rawKey !== "string" || rawKey.trim() === "") return { ok: false, error: "API key is empty" };
  try {
    const config = await readConfigOptional(slug);
    if (config === null || !Object.hasOwn(config.profiles, profileId)) {
      return { ok: false, error: `profile not found: ${profileId}` };
    }
    // R12: reuse this profile's existing managed key file if it has one (a
    // re-paste overwrites in place, no orphan); otherwise derive an injective
    // name so two profiles with sanitize-colliding ids never share one file.
    const keyPath =
      managedKeyPathOf(slug, config.profiles[profileId].apiKeyRef) ??
      path.join(managedKeyDir(slug), keyFileName(profileId));
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
export function clearKey(slug: string, profileId: unknown): Promise<ConfigMutResult> {
  return enqueueConfigMutation(() => clearKeyInner(slug, profileId));
}

async function clearKeyInner(slug: string, profileId: unknown): Promise<ConfigMutResult> {
  if (typeof profileId !== "string" || profileId.trim() === "") return { ok: false, error: "profile id is required" };
  try {
    const config = await readConfigOptional(slug);
    if (config === null || !Object.hasOwn(config.profiles, profileId)) {
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

export function setActive(slug: string, profileId: unknown): Promise<ConfigMutResult> {
  return enqueueConfigMutation(() => setActiveInner(slug, profileId));
}

async function setActiveInner(slug: string, profileId: unknown): Promise<ConfigMutResult> {
  if (typeof profileId !== "string") return { ok: false, error: "profile id is required" };
  try {
    const config = await readConfigOptional(slug);
    if (config === null || !Object.hasOwn(config.profiles, profileId)) {
      return { ok: false, error: `profile not found: ${profileId}` };
    }
    config.activeProfile = profileId;
    await writeConfig(slug, config);
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: describeError(cause) };
  }
}

export function setRoute(slug: string, game: unknown, profileId: unknown): Promise<ConfigMutResult> {
  return enqueueConfigMutation(() => setRouteInner(slug, game, profileId));
}

async function setRouteInner(slug: string, game: unknown, profileId: unknown): Promise<ConfigMutResult> {
  if (typeof profileId !== "string") return { ok: false, error: "profile id is required" };
  try {
    const config = await readConfigOptional(slug);
    if (config === null || !Object.hasOwn(config.profiles, profileId)) {
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

export function deleteProfile(slug: string, profileId: unknown): Promise<ConfigMutResult> {
  return enqueueConfigMutation(() => deleteProfileInner(slug, profileId));
}

async function deleteProfileInner(slug: string, profileId: unknown): Promise<ConfigMutResult> {
  if (typeof profileId !== "string") return { ok: false, error: "profile id is required" };
  try {
    const config = await readConfigOptional(slug);
    if (config === null || !Object.hasOwn(config.profiles, profileId)) {
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
