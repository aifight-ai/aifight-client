/**
 * config-schema.ts
 *
 * TypeScript interfaces, types, and validator for the AIFight daemon's
 * config.json file. Covers LLM provider configuration ONLY — no game
 * strategy, no personality settings.
 *
 * Design principles:
 *   - Protocol-first (not vendor-first): the same model can be reached via
 *     multiple protocols; the protocol field dictates wire format.
 *   - SecretRef indirection: API keys are never stored as raw strings.
 *   - Normalized reasoning/thinking config that maps onto every provider.
 *   - Per-game routing with a fallback profile.
 *   - No runtime dependencies beyond Node built-ins.
 */

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/** Wire-level protocol used to call the LLM provider. */
export type Protocol =
  | "anthropic_messages"
  | "openai_responses"
  | "openai_chat_completions"
  | "openai_chat_compat"
  | "deepseek_chat_completions"
  | "gemini_generate_content"
  | "gemini_openai_compat";

/** Reasoning/thinking effort level. "auto" lets the provider decide. */
export type ReasoningEffort =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "auto";

/** Games supported for per-game routing. */
export type GameType = "texas_holdem" | "liars_dice" | "coup";

/**
 * When the bridge auto-runs a post-match self-review (SELF_REVIEW_DESIGN.md D8).
 * "off" (default) never auto-runs — manual review stays available regardless.
 * "all" reviews every finished match; "losses_only" reviews only losses.
 */
export type SelfReviewAutoMode = "off" | "all" | "losses_only";

// ---------------------------------------------------------------------------
// SecretRef — API key indirection
// ---------------------------------------------------------------------------

/** Read the secret from an environment variable. */
export interface SecretRefEnv {
  type: "env";
  /** Name of the environment variable (e.g. "ANTHROPIC_API_KEY"). */
  name: string;
}

/** Read a specific key from a .env-style file. */
export interface SecretRefEnvFile {
  type: "env_file";
  /** Absolute or relative path to the env file. */
  path: string;
  /** Variable name inside the file. */
  name: string;
}

/** Read the entire file content as the secret. */
export interface SecretRefFile {
  type: "file";
  /** Absolute or relative path to the file. */
  path: string;
}

/** Read from the OS keychain (macOS Keychain, Windows Credential Manager, etc.). */
export interface SecretRefKeychain {
  type: "keychain";
  service: string;
  account: string;
}

/** Obtain the secret by running an external command (e.g. `op run`). */
export interface SecretRefCommand {
  type: "command";
  command: string;
  args?: string[];
  /** Milliseconds to wait for the command to exit. Defaults to 5000. */
  timeoutMs?: number;
}

export type SecretRef =
  | SecretRefEnv
  | SecretRefEnvFile
  | SecretRefFile
  | SecretRefKeychain
  | SecretRefCommand;

// ---------------------------------------------------------------------------
// Request-level parameters
// ---------------------------------------------------------------------------

export interface RequestConfig {
  /**
   * Sampling temperature. null means "use the provider default" (useful when
   * thinking/extended-thinking is active, since many providers require
   * temperature=1 in that mode).
   */
  temperature?: number | null;
  /**
   * Maximum output tokens per LLM call — the SOLE authority on decision output
   * length. Bounded only by the model's real output ceiling (to avoid a 400);
   * an unknown model's value is not clamped. No hidden per-decision budget
   * silently shrinks it.
   */
  maxTokens?: number;
  /**
   * Response format hint. "json" instructs the provider to return JSON where
   * supported; "text" is plain text.
   */
  responseFormat?: "json" | "text";
  /**
   * Streaming mode for protocols that support SSE (currently DeepSeek). "auto"
   * (default) lets the adapter stream large/reasoning outputs that would be
   * fragile over a non-streaming connection; "always"/"never" force it. Adapters
   * that don't support streaming ignore this.
   */
  stream?: "auto" | "always" | "never";
  /**
   * Output verbosity for providers that expose it (OpenAI Responses GPT-5.x →
   * text.verbosity). Ignored by protocols that don't support it.
   */
  verbosity?: "low" | "medium" | "high";
  /**
   * Model/provider-specific opt-in feature flags that are OFF by default (the UI
   * only surfaces the ones a given model supports, to avoid confusing others).
   * Known keys: `jsonObjectMode` — DeepSeek V4 strict json_object response_format
   * (requires the word "json" in the prompt; the adapter injects it if missing).
   */
  features?: Record<string, boolean>;
}

// ---------------------------------------------------------------------------
// Reasoning / thinking config
// ---------------------------------------------------------------------------

export interface ThinkingConfig {
  enabled: boolean;
  /**
   * "adaptive" — let the daemon decide per-request based on game complexity.
   * "always"   — always activate thinking.
   * "never"    — never activate thinking (overrides enabled=true).
   */
  mode?: "adaptive" | "always" | "never";
  /** Effort level passed to the provider (provider-specific mapping applied). */
  effort?: ReasoningEffort;
  /** Hard cap on reasoning/thinking tokens (provider-specific field name). */
  maxReasoningTokens?: number;
}

// ---------------------------------------------------------------------------
// Operational parameters
// ---------------------------------------------------------------------------

export interface TimeoutsConfig {
  /**
   * Per-call LLM request timeout in milliseconds — how long the app/CLI waits
   * for a single model call. User-settable; default 300000 (5 min), max 300000.
   * Purely client-side: the platform only enforces "submit a legal decision
   * within its turn deadline" and never reads this value. Set it shorter to fit
   * several retries inside a turn; set it to 300000 to let one call use the
   * whole turn.
   */
  requestMs?: number;
}

export interface RetriesConfig {
  /**
   * Number of retries on transient API errors (rate limit / 5xx / timeout /
   * network). 0 = no retry. Default 2. Exponential back-off is applied
   * internally on a fixed schedule (not user-tunable).
   */
  maxAttempts?: number;
}

// ---------------------------------------------------------------------------
// LLM Profile — one named provider configuration
// ---------------------------------------------------------------------------

export interface LLMProfile {
  /** Human-readable label shown in logs and the CLI. */
  displayName?: string;
  /** Wire protocol used to call this provider. */
  protocol: Protocol;
  /**
   * Provider base URL. Omit to use the protocol's canonical default
   * (e.g. https://api.anthropic.com for anthropic_messages).
   */
  baseURL?: string;
  /** Indirection to the API key — never a raw string. */
  apiKeyRef: SecretRef;
  /**
   * Model identifier in the provider's namespace
   * (e.g. "claude-opus-4-7", "gpt-4o", "deepseek-chat").
   */
  model: string;
  /** Sampling and format parameters. */
  request?: RequestConfig;
  /** Extended-thinking / reasoning configuration. */
  thinking?: ThinkingConfig;
  /** Network timeouts. */
  timeouts?: TimeoutsConfig;
  /** Retry policy on transient errors (429, 503, network). */
  retries?: RetriesConfig;
}

// ---------------------------------------------------------------------------
// Routing — map games → profiles
// ---------------------------------------------------------------------------

export interface RoutingConfig {
  /** Profile name used when no per-game route is configured. */
  default: string;
  /** Optional per-game overrides. Keys are GameType values. */
  byGame?: Partial<Record<GameType, string>>;
  /**
   * Profile name to fall back to when the primary profile fails (rate limit,
   * outage, budget exhaustion). Must differ from the profiles it backs up.
   */
  fallbackProfile?: string;
}

// ---------------------------------------------------------------------------
// Self-review (post-match LLM analysis) — see SELF_REVIEW_DESIGN.md
// ---------------------------------------------------------------------------

export interface SelfReviewConfig {
  /**
   * Auto-run mode (D8). "off" (default) never auto-runs; manual review is
   * always available regardless of this setting.
   */
  autoMode?: SelfReviewAutoMode;
  /**
   * Profile name (key into `profiles`) to use for the review call. Empty/unset
   * = reuse the profile the match used (routing). Point at a cheaper profile
   * (e.g. a Haiku route) to keep review cost down.
   */
  model?: string;
  /** Max agent turns to keep in the compressed review context (default 40). */
  maxTurns?: number;
}

// ---------------------------------------------------------------------------
// Top-level config shape
// ---------------------------------------------------------------------------

export interface LLMConfig {
  /** Schema version for forward compatibility. Currently must be 1. */
  schemaVersion: 1;
  /** Key into `profiles` that the daemon uses by default. */
  activeProfile: string;
  /** Map of profile name → profile definition. At least one entry required. */
  profiles: Record<string, LLMProfile>;
  /** Game-level routing rules. */
  routing: RoutingConfig;
  /** Post-match self-review behavior (optional; absent = feature off). */
  selfReview?: SelfReviewConfig;
  /**
   * Capture the model's reasoning/thinking text for each decision into the
   * LOCAL session log (decisions.jsonl) so replay and self-review can show
   * what the model was thinking. Default false. Purely local: the outgoing
   * action message has no field for reasoning text, so it never reaches the
   * platform. Where the provider supports it, enabling this asks for a
   * summary (Anthropic adaptive-thinking display, OpenAI Responses
   * reasoning.summary); DeepSeek reasoner output is stored truncated;
   * protocols without reasoning output record nothing.
   */
  captureReasoning?: boolean;
}

// ---------------------------------------------------------------------------
// Validation helpers (no external dependencies)
// ---------------------------------------------------------------------------

type ValidationResult =
  | { ok: true; config: LLMConfig }
  | { ok: false; errors: string[] };

const VALID_PROTOCOLS = new Set<string>([
  "anthropic_messages",
  "openai_responses",
  "openai_chat_completions",
  "openai_chat_compat",
  "deepseek_chat_completions",
  "gemini_generate_content",
  "gemini_openai_compat",
]);

const VALID_REASONING_EFFORTS = new Set<string>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "auto",
]);

const VALID_GAME_TYPES = new Set<string>(["texas_holdem", "liars_dice", "coup"]);

const VALID_SECRET_TYPES = new Set<string>([
  "env",
  "env_file",
  "file",
  "keychain",
  "command",
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// R13-F06: sane upper bounds so a copied/typo'd profile can't request an absurd
// token count, wait forever, or retry endlessly. Generous enough that no valid
// real-world config is rejected (the defaults sit far below these).
const MAX_REQUEST_MAX_TOKENS = 1_000_000;
// requestMs is a per-call client timeout; a turn is 300s, so waiting longer is
// pointless. Its own ceiling (not the old shared 600s) enforces "<= 300s".
const MAX_REQUEST_TIMEOUT_MS = 300_000; // 5 minutes
const MAX_RETRY_ATTEMPTS = 10;

/**
 * R13-F06: validate a present numeric config field is finite and within a
 * declared range (and optionally an integer / strictly positive). Rejects
 * NaN / Infinity / negatives / non-integers with a clear message instead of
 * letting a bad value silently drive request sizing, timeouts, or retries.
 * A `undefined` value is skipped (the field is optional).
 */
function validateBoundedNumber(
  value: unknown,
  path: string,
  errors: string[],
  opts: { readonly min: number; readonly max: number; readonly integer?: boolean; readonly exclusiveMin?: boolean },
): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(`${path}: must be a finite number`);
    return;
  }
  if (opts.integer === true && !Number.isInteger(value)) {
    errors.push(`${path}: must be an integer`);
    return;
  }
  const belowMin = opts.exclusiveMin === true ? value <= opts.min : value < opts.min;
  if (belowMin || value > opts.max) {
    const lower = opts.exclusiveMin === true ? `> ${opts.min}` : `>= ${opts.min}`;
    errors.push(`${path}: must be ${lower} and <= ${opts.max}`);
  }
}

function validateSecretRef(raw: unknown, path: string, errors: string[]): boolean {
  if (!isObject(raw)) {
    errors.push(`${path}: must be an object`);
    return false;
  }
  const { type } = raw;
  if (typeof type !== "string" || !VALID_SECRET_TYPES.has(type)) {
    errors.push(
      `${path}.type: must be one of [${[...VALID_SECRET_TYPES].join(", ")}], got ${JSON.stringify(type)}`
    );
    return false;
  }
  switch (type) {
    case "env":
      if (typeof raw.name !== "string" || raw.name.trim() === "") {
        errors.push(`${path}.name: required non-empty string for type "env"`);
      }
      break;
    case "env_file":
      if (typeof raw.path !== "string" || raw.path.trim() === "") {
        errors.push(`${path}.path: required non-empty string for type "env_file"`);
      }
      if (typeof raw.name !== "string" || raw.name.trim() === "") {
        errors.push(`${path}.name: required non-empty string for type "env_file"`);
      }
      break;
    case "file":
      if (typeof raw.path !== "string" || raw.path.trim() === "") {
        errors.push(`${path}.path: required non-empty string for type "file"`);
      }
      break;
    case "keychain":
    case "command":
      // F23/AIF-08: these backends are typed for the P1 roadmap but the
      // resolver does not implement them yet. Fail at config load with a
      // clear message instead of letting the bridge boot and then throw
      // "not implemented" at the first key resolution mid-match.
      errors.push(
        `${path}.type: "${type}" is not implemented yet — use one of [env, env_file, file]`,
      );
      break;
  }
  return errors.length === 0;
}

function validateProfile(raw: unknown, path: string, errors: string[]): void {
  if (!isObject(raw)) {
    errors.push(`${path}: must be an object`);
    return;
  }

  // protocol
  if (typeof raw.protocol !== "string" || !VALID_PROTOCOLS.has(raw.protocol)) {
    errors.push(
      `${path}.protocol: must be one of [${[...VALID_PROTOCOLS].join(", ")}], got ${JSON.stringify(raw.protocol)}`
    );
  }

  // model
  if (typeof raw.model !== "string" || raw.model.trim() === "") {
    errors.push(`${path}.model: required non-empty string`);
  }

  // apiKeyRef
  validateSecretRef(raw.apiKeyRef, `${path}.apiKeyRef`, errors);

  // baseURL (optional)
  if (raw.baseURL !== undefined) {
    if (typeof raw.baseURL !== "string") {
      errors.push(`${path}.baseURL: must be a string if present`);
    } else {
      validateProviderBaseURL(raw.baseURL, `${path}.baseURL`, errors);
    }
  }

  // displayName (optional)
  if (raw.displayName !== undefined && typeof raw.displayName !== "string") {
    errors.push(`${path}.displayName: must be a string if present`);
  }

  // request (optional)
  if (raw.request !== undefined) {
    if (!isObject(raw.request)) {
      errors.push(`${path}.request: must be an object if present`);
    } else {
      const req = raw.request;
      if (
        req.temperature !== undefined &&
        req.temperature !== null &&
        typeof req.temperature !== "number"
      ) {
        errors.push(`${path}.request.temperature: must be a number or null`);
      }
      if (req.temperature !== undefined && req.temperature !== null) {
        const t = req.temperature as number;
        if (t < 0 || t > 2) {
          errors.push(`${path}.request.temperature: must be in [0, 2]`);
        }
      }
      validateBoundedNumber(req.maxTokens, `${path}.request.maxTokens`, errors, {
        min: 1,
        max: MAX_REQUEST_MAX_TOKENS,
        integer: true,
      });
      if (
        req.responseFormat !== undefined &&
        req.responseFormat !== "json" &&
        req.responseFormat !== "text"
      ) {
        errors.push(`${path}.request.responseFormat: must be "json" or "text"`);
      }
      if (
        req.stream !== undefined &&
        req.stream !== "auto" &&
        req.stream !== "always" &&
        req.stream !== "never"
      ) {
        errors.push(`${path}.request.stream: must be "auto", "always", or "never"`);
      }
      if (
        req.verbosity !== undefined &&
        req.verbosity !== "low" &&
        req.verbosity !== "medium" &&
        req.verbosity !== "high"
      ) {
        errors.push(`${path}.request.verbosity: must be "low", "medium", or "high"`);
      }
      if (req.features !== undefined) {
        if (!isObject(req.features)) {
          errors.push(`${path}.request.features: must be an object of booleans if present`);
        } else {
          for (const [k, v] of Object.entries(req.features)) {
            if (typeof v !== "boolean") errors.push(`${path}.request.features.${k}: must be a boolean`);
          }
        }
      }
    }
  }

  // thinking (optional)
  if (raw.thinking !== undefined) {
    if (!isObject(raw.thinking)) {
      errors.push(`${path}.thinking: must be an object if present`);
    } else {
      const th = raw.thinking;
      if (typeof th.enabled !== "boolean") {
        errors.push(`${path}.thinking.enabled: required boolean`);
      }
      if (
        th.mode !== undefined &&
        th.mode !== "adaptive" &&
        th.mode !== "always" &&
        th.mode !== "never"
      ) {
        errors.push(`${path}.thinking.mode: must be "adaptive", "always", or "never"`);
      }
      if (
        th.effort !== undefined &&
        (typeof th.effort !== "string" || !VALID_REASONING_EFFORTS.has(th.effort as string))
      ) {
        errors.push(
          `${path}.thinking.effort: must be one of [${[...VALID_REASONING_EFFORTS].join(", ")}]`
        );
      }
      if (th.maxReasoningTokens !== undefined && typeof th.maxReasoningTokens !== "number") {
        errors.push(`${path}.thinking.maxReasoningTokens: must be a number if present`);
      }
    }
  }

  // timeouts (optional)
  if (raw.timeouts !== undefined) {
    if (!isObject(raw.timeouts)) {
      errors.push(`${path}.timeouts: must be an object if present`);
    } else {
      validateBoundedNumber(raw.timeouts.requestMs, `${path}.timeouts.requestMs`, errors, {
        min: 1,
        max: MAX_REQUEST_TIMEOUT_MS,
        integer: true,
      });
    }
  }

  // retries (optional)
  if (raw.retries !== undefined) {
    if (!isObject(raw.retries)) {
      errors.push(`${path}.retries: must be an object if present`);
    } else {
      validateBoundedNumber(raw.retries.maxAttempts, `${path}.retries.maxAttempts`, errors, {
        min: 0,
        max: MAX_RETRY_ATTEMPTS,
        integer: true,
      });
    }
  }

}

/** F40/R2-09: the provider API key is sent to this URL, so guard the obvious
 *  footguns — a copied/typo'd profile must not silently ship the key over
 *  plaintext HTTP or with credentials embedded in the URL. https: is always
 *  allowed; http: only to loopback/private hosts (self-hosted ollama, vLLM,
 *  LM Studio), or anywhere with AIFIGHT_ALLOW_INSECURE_PROVIDER_URL=1. */
function validateProviderBaseURL(value: string, path: string, errors: string[]): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    errors.push(`${path}: must be a valid URL, got ${JSON.stringify(value)}`);
    return;
  }
  if (url.username !== "" || url.password !== "") {
    errors.push(
      `${path}: must not embed credentials (user:pass@host) — the provider key is sent in request headers`,
    );
  }
  if (url.protocol === "https:") return;
  if (url.protocol === "http:") {
    if (isLoopbackOrPrivateHost(url.hostname)) return;
    if (process.env.AIFIGHT_ALLOW_INSECURE_PROVIDER_URL === "1") return;
    errors.push(
      `${path}: plain http would send your provider key unencrypted to ${url.hostname}. ` +
        `Use https, or set AIFIGHT_ALLOW_INSECURE_PROVIDER_URL=1 if this is an insecure self-hosted provider you trust`,
    );
    return;
  }
  errors.push(`${path}: must use https (or http to a loopback/private host), got ${url.protocol}//`);
}

function isLoopbackOrPrivateHost(hostname: string): boolean {
  // WHATWG URL keeps brackets on IPv6 literals ("[::1]").
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 127 || a === 10) return true; // loopback / RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local LAN devices
  return false;
}

function validateRouting(
  raw: unknown,
  profileNames: Set<string>,
  path: string,
  errors: string[]
): void {
  if (!isObject(raw)) {
    errors.push(`${path}: must be an object`);
    return;
  }

  // default profile
  if (typeof raw.default !== "string" || raw.default.trim() === "") {
    errors.push(`${path}.default: required non-empty string`);
  } else if (!profileNames.has(raw.default)) {
    errors.push(`${path}.default: references unknown profile "${raw.default}"`);
  }

  // byGame (optional)
  if (raw.byGame !== undefined) {
    if (!isObject(raw.byGame)) {
      errors.push(`${path}.byGame: must be an object if present`);
    } else {
      for (const [game, profileName] of Object.entries(raw.byGame)) {
        if (!VALID_GAME_TYPES.has(game)) {
          errors.push(
            `${path}.byGame: unknown game "${game}". Valid: [${[...VALID_GAME_TYPES].join(", ")}]`
          );
        }
        if (typeof profileName !== "string" || !(profileName as string).trim()) {
          errors.push(`${path}.byGame.${game}: must be a non-empty string profile name`);
        } else if (!profileNames.has(profileName as string)) {
          errors.push(`${path}.byGame.${game}: references unknown profile "${profileName}"`);
        }
      }
    }
  }

  // fallbackProfile (optional)
  if (raw.fallbackProfile !== undefined) {
    if (typeof raw.fallbackProfile !== "string" || raw.fallbackProfile.trim() === "") {
      errors.push(`${path}.fallbackProfile: must be a non-empty string if present`);
    } else if (!profileNames.has(raw.fallbackProfile)) {
      errors.push(
        `${path}.fallbackProfile: references unknown profile "${raw.fallbackProfile}"`
      );
    }
  }
}

function validateSelfReview(
  raw: unknown,
  profileNames: Set<string>,
  path: string,
  errors: string[],
): void {
  if (!isObject(raw)) {
    errors.push(`${path}: must be an object if present`);
    return;
  }
  if (
    raw.autoMode !== undefined &&
    raw.autoMode !== "off" &&
    raw.autoMode !== "all" &&
    raw.autoMode !== "losses_only"
  ) {
    errors.push(`${path}.autoMode: must be "off", "all", or "losses_only"`);
  }
  if (raw.model !== undefined) {
    if (typeof raw.model !== "string") {
      errors.push(`${path}.model: must be a string if present`);
    } else if (raw.model.trim() !== "" && !profileNames.has(raw.model)) {
      errors.push(`${path}.model: references unknown profile "${raw.model}"`);
    }
  }
  if (
    raw.maxTurns !== undefined &&
    (typeof raw.maxTurns !== "number" || !Number.isInteger(raw.maxTurns) || raw.maxTurns <= 0)
  ) {
    errors.push(`${path}.maxTurns: must be a positive integer if present`);
  }
}

// ---------------------------------------------------------------------------
// Public validator
// ---------------------------------------------------------------------------

/**
 * Validate an unknown value (typically from JSON.parse) as an LLMConfig.
 *
 * Returns `{ ok: true, config }` on success, or
 * `{ ok: false, errors }` with a list of human-readable messages on failure.
 *
 * Example:
 * ```ts
 * const raw = JSON.parse(fs.readFileSync("config.json", "utf8"));
 * const result = validateConfig(raw);
 * if (!result.ok) {
 *   console.error(result.errors.join("\n"));
 *   process.exit(1);
 * }
 * const config = result.config;
 * ```
 */
export function validateConfig(raw: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isObject(raw)) {
    return { ok: false, errors: ["config: must be a JSON object"] };
  }

  // schemaVersion
  if (raw.schemaVersion !== 1) {
    errors.push(`schemaVersion: must be 1, got ${JSON.stringify(raw.schemaVersion)}`);
  }

  // activeProfile
  if (typeof raw.activeProfile !== "string" || raw.activeProfile.trim() === "") {
    errors.push("activeProfile: required non-empty string");
  }

  // captureReasoning (optional)
  if (raw.captureReasoning !== undefined && typeof raw.captureReasoning !== "boolean") {
    errors.push("captureReasoning: must be a boolean if present");
  }

  // profiles
  if (!isObject(raw.profiles)) {
    errors.push("profiles: must be a non-empty object");
  } else {
    const profileNames = new Set(Object.keys(raw.profiles));
    if (profileNames.size === 0) {
      errors.push("profiles: must contain at least one profile");
    }
    for (const [name, profile] of Object.entries(raw.profiles)) {
      validateProfile(profile, `profiles.${name}`, errors);
    }

    // activeProfile must exist in profiles
    if (
      typeof raw.activeProfile === "string" &&
      raw.activeProfile.trim() !== "" &&
      !profileNames.has(raw.activeProfile)
    ) {
      errors.push(
        `activeProfile: references unknown profile "${raw.activeProfile}"`
      );
    }

    // routing
    if (raw.routing === undefined) {
      errors.push("routing: required field missing");
    } else {
      validateRouting(raw.routing, profileNames, "routing", errors);
    }

    // selfReview (optional) — model must reference a known profile
    if (raw.selfReview !== undefined) {
      validateSelfReview(raw.selfReview, profileNames, "selfReview", errors);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, config: raw as unknown as LLMConfig };
}

// ---------------------------------------------------------------------------
// DEFAULT_CONFIG — minimal valid configuration (Anthropic via env var)
// ---------------------------------------------------------------------------

/**
 * A minimal valid LLMConfig that uses Claude claude-sonnet-4-6 via the
 * Anthropic Messages API, reading the API key from the ANTHROPIC_API_KEY
 * environment variable. Suitable as a starter template or fallback.
 */
export const DEFAULT_CONFIG: LLMConfig = {
  schemaVersion: 1,
  activeProfile: "claude-default",
  profiles: {
    "claude-default": {
      displayName: "Claude Sonnet (default)",
      protocol: "anthropic_messages",
      baseURL: "https://api.anthropic.com",
      apiKeyRef: { type: "env", name: "ANTHROPIC_API_KEY" },
      model: "claude-sonnet-4-6",
      request: {
        temperature: null,
        maxTokens: 32000,
        responseFormat: "json",
        stream: "auto",
      },
      thinking: {
        enabled: true,
        mode: "always",
        effort: "high",
      },
      timeouts: {
        requestMs: 300000,
      },
      retries: {
        maxAttempts: 2,
      },
    },
  },
  routing: {
    default: "claude-default",
  },
};
