// Shared classification of a thrown in-match decision error into a small set of
// user-meaningful classes, plus the policy for whether an in-match retry can
// help. Duck-types the AdapterError fields (kind / retryable / status /
// retryAfterMs / tokenLimit / message) off ANY cause, so it also works for the
// plain errors thrown by the localhost runtimes (OpenClaw/Hermes), which have no
// `kind`. Sibling to token-limit.ts, same "prefer safe" ethos.
//
// See docs/agent-bridge/API_ERROR_CLASSIFICATION_SPEC.md (§3 D1/D2).

export type DecisionErrorClass =
  | "auth" // 401/403 — key rejected, retry can't help
  | "config" // 400/422/404/unsupported — bad request, retry can't help
  | "quota" // billing/credit/quota exhausted — retry can't help
  | "rate_limit" // 429 throttle — a backed-off retry may help
  | "server" // 5xx / overloaded — a backed-off retry may help
  | "timeout" // request timed out — a retry may help if budget remains
  | "network" // connection refused / DNS / reset — a retry may help
  | "content_filter" // model blocked its own output — resend re-blocks
  | "token_limit" // owned by the self-heal; terminal if it reaches here
  | "unknown"; // anything else — one conservative retry

export interface DecisionErrorInfo {
  readonly class: DecisionErrorClass;
  /** May an in-match, budget-bounded retry of the SAME request help? */
  readonly retryable: boolean;
  /** Provider-advised minimum wait before retrying (from Retry-After), if any. */
  readonly retryAfterMs?: number;
}

// Strong billing/quota signals in a 429 body → the account is out of budget, so
// a retry is futile. Kept strict on purpose (spec §6): a false "quota" gives up
// on a turn that a transient-throttle retry could have saved, so only clear
// billing wording downgrades a 429 from rate_limit to quota.
const QUOTA_RE =
  /insufficient_quota|exceeded your current quota|quota exceeded|out of credits?|credit balance|billing (hard limit|required)|payment required|not enough (balance|credits?)|account.*(suspended|deactivated)/i;

/**
 * Parse an HTTP `Retry-After` header into milliseconds. The value is either
 * delta-seconds ("120") or an HTTP-date; returns undefined when absent or
 * unparseable, and clamps a past date / present moment to 0.
 */
export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000; // delta-seconds
  const when = Date.parse(trimmed); // HTTP-date
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, when - Date.now());
}

// Native finish/stop/safety reasons that mean the model's OWN output was blocked
// by a content/safety filter. This is a 200 response, so it never reaches the
// HTTP-error path — the adapter must detect it while parsing. Resending the same
// prompt re-blocks, so `content_filter` is classified non-retryable.
const CONTENT_FILTER_REASONS: ReadonlySet<string> = new Set([
  "content_filter", // OpenAI chat / compat / deepseek finish_reason
  "refusal", // Anthropic stop_reason
  "safety", // Gemini finishReason
  "prohibited_content",
  "blocklist",
  "spii",
  "image_safety",
  "recitation", // Gemini copyright/recitation block — resend re-blocks
]);

/** True when a provider's native finish/stop reason means a content-filter block. */
export function isContentFilterReason(reason: unknown): boolean {
  return typeof reason === "string" && CONTENT_FILTER_REASONS.has(reason.toLowerCase());
}

interface DuckError {
  kind?: unknown;
  retryable?: unknown;
  tokenLimit?: unknown;
  retryAfterMs?: unknown;
  message?: unknown;
}

function duck(cause: unknown): DuckError {
  return typeof cause === "object" && cause !== null ? (cause as DuckError) : {};
}

/**
 * Classify a thrown decision error and state whether an in-match retry helps.
 * The retry DECISION uses the class, not the raw HTTP status — the adapters
 * already fold status → kind, and this keeps localhost-runtime errors working.
 */
export function classifyDecisionError(cause: unknown): DecisionErrorInfo {
  const e = duck(cause);
  const msg = typeof e.message === "string" ? e.message : "";
  const retryAfterMs =
    typeof e.retryAfterMs === "number" && Number.isFinite(e.retryAfterMs) && e.retryAfterMs >= 0
      ? e.retryAfterMs
      : undefined;
  const withRetryAfter = (info: DecisionErrorInfo): DecisionErrorInfo =>
    retryAfterMs !== undefined ? { ...info, retryAfterMs } : info;

  // token_limit is owned by the self-heal (raise the cap and retry there); if a
  // token-limit error still bubbles up to the transient loop it is terminal.
  if (e.tokenLimit === true) return { class: "token_limit", retryable: false };

  switch (e.kind) {
    case "auth_failed":
      return { class: "auth", retryable: false };
    case "invalid_request":
      // Some providers return a billing/quota problem as a 400 (e.g. Anthropic's
      // "credit balance is too low"). Label that quota ("top up") rather than a
      // config error ("check your model id") — both are non-retryable either way.
      if (QUOTA_RE.test(msg)) return { class: "quota", retryable: false };
      return { class: "config", retryable: false };
    case "model_not_found":
    case "unsupported":
      return { class: "config", retryable: false };
    case "budget_exceeded":
      return { class: "quota", retryable: false };
    case "content_filter":
      return { class: "content_filter", retryable: false };
    case "rate_limited":
      // A genuinely exhausted quota is futile to retry; a transient throttle is
      // worth a backed-off retry (honoring Retry-After when present).
      if (QUOTA_RE.test(msg)) return { class: "quota", retryable: false };
      return withRetryAfter({ class: "rate_limit", retryable: true });
    case "server_error":
      return withRetryAfter({ class: "server", retryable: true });
    case "timeout":
      return { class: "timeout", retryable: true };
    case "network":
      return { class: "network", retryable: true };
    case "aborted":
      // We aborted the call — almost always the turn deadline — so retrying just
      // re-aborts or blows the budget.
      return { class: "unknown", retryable: false };
    case "invalid_response":
      // A 2xx we couldn't parse; a fresh call might come back clean → one try.
      return { class: "unknown", retryable: true };
    default:
      // Non-adapter cause (localhost runtimes) or an unrecognized kind: one
      // conservative retry, matching the pre-classification behavior — unless the
      // error explicitly says it isn't retryable.
      if (e.retryable === false) return { class: "unknown", retryable: false };
      return { class: "unknown", retryable: true };
  }
}
