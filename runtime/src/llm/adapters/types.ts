// LLM adapter interface and shared types.
//
// Every provider adapter implements this contract. The daemon's
// decision engine dispatches through the adapter registry, never
// calling provider HTTP clients directly.
//
// Design principles:
// - Protocol-first, not vendor-first
// - Canonical reasoning config normalized before adapter receives it
// - Adapters validate and translate, never silently drop parameters
// - All secrets accessed via SecretRef, never raw strings

// ─── Canonical reasoning config ─────────────────────────────────────
// Normalized by the daemon before calling any adapter. Adapters must
// validate and map to provider-specific shapes.

export type ReasoningEffort =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "auto";

export interface CanonicalReasoningConfig {
  readonly enabled?: boolean | "auto";
  readonly mode?: "disabled" | "enabled" | "adaptive" | "auto";
  readonly effort?: ReasoningEffort;
  readonly budgetTokens?: number | null;
  readonly taskBudgetTokens?: number | null;
  readonly thinkingLevel?: "minimal" | "low" | "medium" | "high" | null;
  readonly thinkingBudget?: number | null;
  readonly display?: "omitted" | "summarized" | null;
  readonly summary?: "off" | "auto" | "concise" | "detailed" | null;
  readonly includeEncryptedReasoning?: boolean;
}

// ─── Supported protocols ────────────────────────────────────────────

export const SUPPORTED_PROTOCOLS = [
  "anthropic_messages",
  "openai_responses",
  "openai_chat_completions",
  "openai_chat_compat",
  "deepseek_chat_completions",
  "gemini_generate_content",
  "gemini_openai_compat",
] as const;

export type LLMProtocol = (typeof SUPPORTED_PROTOCOLS)[number];

// ─── Decision input (what the daemon sends to adapter) ──────────────

export interface DecisionInput {
  /** System prompt assembled from the agent's Markdown strategy + rules + context */
  readonly systemPrompt: string;
  /** User prompt with current state + legal actions + output contract */
  readonly userPrompt: string;
  /** Max output tokens for this decision */
  readonly maxTokens: number;
  /** Temperature (null = provider default) */
  readonly temperature: number | null;
  /** Canonical reasoning config (adapter translates to provider format) */
  readonly reasoning?: CanonicalReasoningConfig;
  /** Response format hint */
  readonly responseFormat?: "json" | "json_object" | "json_schema" | "text";
  /** Abort signal for timeout */
  readonly signal?: AbortSignal;
}

// ─── Decision output (what adapter returns) ─────────────────────────

export interface DecisionOutput {
  /** Raw text response from the model */
  readonly text: string;
  /**
   * Normalized stop signal. Only set when positively identified from the wire
   * response; ABSENT (undefined) when the provider omitted the field (e.g. some
   * OpenAI-compatible endpoints). Never guessed.
   */
  readonly stopReason?: "stop" | "max_tokens" | "other";
  /**
   * True when the output was cut short by the token limit — either
   * stopReason === "max_tokens", or empty text while reasoning tokens were
   * consumed (thinking ate the entire budget). Drives the "raise max tokens"
   * recommendation surfaced in the app cockpit and CLI.
   */
  readonly truncated?: boolean;
  /** Input tokens used */
  readonly inputTokens?: number;
  /** Output tokens used (includes reasoning tokens for some providers) */
  readonly outputTokens?: number;
  /** Reasoning/thinking tokens (if separately reported) */
  readonly reasoningTokens?: number;
  /** Cached tokens (if provider reports) */
  readonly cachedTokens?: number;
  /** Cache-write / cache-creation tokens (if provider reports separately) */
  readonly cacheWriteTokens?: number;
  /** Response latency in ms */
  readonly latencyMs: number;
  /** Short reasoning summary if provider supports it */
  readonly reasoningSummary?: string;
  /** Raw provider response (for debugging, usually redacted before storage) */
  readonly raw?: unknown;
  /** Provider-specific continuation state to preserve within this match session */
  readonly continuationState?: unknown;
}

// ─── Usage record ───────────────────────────────────────────────────

export interface UsageRecord {
  readonly protocol: string;
  readonly providerLabel: string;
  readonly model: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly cachedTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly estimatedCostUSD?: number;
  readonly latencyMs: number;
  readonly timestamp: string;
}

// ─── Probe result ───────────────────────────────────────────────────

export interface ProbeResult {
  readonly success: boolean;
  readonly latencyMs: number;
  readonly error?: string;
  readonly model: string;
  readonly protocol: string;
  /** Whether the model returned valid JSON when asked */
  readonly jsonValid?: boolean;
  /** Whether the probe response was cut short by the token limit. */
  readonly truncated?: boolean;
}

// ─── Validation result ──────────────────────────────────────────────

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: string[];
  readonly warnings: string[];
}

// ─── LLM Profile (resolved from config.json profile) ────────────────

export interface LLMProfile {
  readonly profileId: string;
  readonly displayName: string;
  readonly protocol: LLMProtocol;
  readonly baseURL: string;
  readonly model: string;
  readonly apiKey: string; // resolved from SecretRef at runtime
  readonly temperature: number | null;
  readonly maxTokens: number;
  readonly responseFormat?: string;
  /** Streaming mode for SSE-capable protocols (DeepSeek). Default "auto". */
  readonly stream?: "auto" | "always" | "never";
  /** Output verbosity for providers that expose it (OpenAI Responses text.verbosity). */
  readonly verbosity?: "low" | "medium" | "high";
  /** Model-specific opt-in feature flags (e.g. { jsonObjectMode: true } for DeepSeek). */
  readonly features?: Record<string, boolean>;
  readonly reasoning?: CanonicalReasoningConfig;
  readonly timeouts: {
    readonly requestMs: number;
  };
  readonly retries: {
    readonly maxAttempts: number;
  };
}

// ─── Adapter interface ──────────────────────────────────────────────

export interface LLMAdapter {
  /** Protocol this adapter handles */
  readonly protocol: LLMProtocol;

  /** Validate a profile against this adapter's capabilities */
  validateProfile(profile: LLMProfile): ValidationResult;

  /** Make a probe/test call to verify connectivity and JSON response */
  probe(profile: LLMProfile): Promise<ProbeResult>;

  /** Build and send a decision request, return parsed output */
  generateDecision(
    input: DecisionInput,
    profile: LLMProfile,
    continuationState?: unknown,
  ): Promise<DecisionOutput>;

  /** Estimate cost from a completed response */
  estimateUsage(output: DecisionOutput, profile: LLMProfile): UsageRecord;

  /** Redact sensitive data from raw provider response */
  redact(raw: unknown): unknown;
}

// ─── Adapter errors ─────────────────────────────────────────────────

export type AdapterErrorKind =
  | "auth_failed"       // 401/403
  | "rate_limited"      // 429
  | "model_not_found"   // 404 or model-specific error
  | "invalid_request"   // 400 — bad params
  | "server_error"      // 5xx
  | "timeout"           // request or connect timeout
  | "network"           // connection refused, DNS, etc.
  | "aborted"           // signal aborted
  | "invalid_response"  // response not parseable
  | "unsupported"       // feature not supported by this adapter
  | "budget_exceeded"   // cost cap hit
  | "content_filter"    // model's own output was blocked by a safety filter
  | "unknown";

export class AdapterError extends Error {
  override readonly name = "AdapterError";
  readonly kind: AdapterErrorKind;
  readonly protocol: string;
  readonly retryable: boolean;
  /**
   * True when a 4xx (usually 400) was positively identified as a max_tokens /
   * reasoning-budget / context-limit problem via response-body heuristics.
   * Kept as a flag rather than a new AdapterErrorKind so existing retryable /
   * switch logic is untouched. Drives the same "raise max tokens" surfacing as
   * DecisionOutput.truncated.
   */
  readonly tokenLimit: boolean;
  /** Numeric HTTP status when this came from an HTTP response (else undefined).
   *  Kept for messaging/telemetry — the retry decision uses `kind`, not this. */
  readonly status?: number;
  /** Provider-advised wait before retrying, in ms, parsed from `Retry-After`. */
  readonly retryAfterMs?: number;
  override readonly cause: unknown;

  constructor(
    kind: AdapterErrorKind,
    protocol: string,
    message: string,
    opts?: { retryable?: boolean; cause?: unknown; tokenLimit?: boolean; status?: number; retryAfterMs?: number },
  ) {
    super(message);
    this.kind = kind;
    this.protocol = protocol;
    this.retryable = opts?.retryable ?? isRetryableKind(kind);
    this.tokenLimit = opts?.tokenLimit ?? false;
    if (opts?.status !== undefined) this.status = opts.status;
    if (opts?.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
    this.cause = opts?.cause;
  }
}

function isRetryableKind(kind: AdapterErrorKind): boolean {
  return kind === "rate_limited" || kind === "server_error" || kind === "timeout" || kind === "network";
}
