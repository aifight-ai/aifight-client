// Maps a config.json LLM profile (which holds a SecretRef) into the
// resolved LLMProfile the adapters consume (which holds a concrete apiKey
// and a guaranteed baseURL).
//
// Shared by `aifight config probe/test` and the direct-LLM runtime provider
// so both apply identical defaults — most importantly a protocol-canonical
// baseURL when the config omits one. Every adapter REQUIRES a baseURL
// (e.g. anthropic builds `${baseURL}/v1/messages`), and config.json makes
// baseURL optional, so without this fallback a "paste a key" profile would
// fail at request time.

import type {
  LLMProfile as ConfigLLMProfile,
  Protocol,
  ThinkingConfig,
} from "../profile/config-schema.js";
import type {
  LLMProfile as ResolvedLLMProfile,
  CanonicalReasoningConfig,
} from "./adapters/types.js";

/**
 * Canonical default endpoint per protocol, used when a profile omits a
 * baseURL. The OpenAI-compatible protocols have no shared default and must
 * set baseURL explicitly; they return "" here so the adapter surfaces a
 * clear "baseURL required" error.
 */
export function protocolDefaultBaseURL(protocol: Protocol | string): string {
  switch (protocol) {
    case "anthropic_messages":
      return "https://api.anthropic.com";
    case "openai_responses":
    case "openai_chat_completions":
      return "https://api.openai.com/v1";
    case "deepseek_chat_completions":
      return "https://api.deepseek.com";
    case "gemini_generate_content":
      return "https://generativelanguage.googleapis.com";
    case "openai_chat_compat":
    case "gemini_openai_compat":
    default:
      return "";
  }
}

/**
 * Resolve a config profile + already-resolved API key into the adapter
 * LLMProfile. Mirrors the mapping defaults used across the runtime; applies
 * a protocol-default baseURL when the profile omits one.
 */
export function resolveLLMProfile(
  profileId: string,
  def: ConfigLLMProfile,
  apiKey: string,
): ResolvedLLMProfile {
  return {
    profileId,
    displayName: def.displayName ?? profileId,
    protocol: def.protocol as ResolvedLLMProfile["protocol"],
    baseURL:
      def.baseURL && def.baseURL.length > 0
        ? def.baseURL
        : protocolDefaultBaseURL(def.protocol),
    model: def.model,
    apiKey,
    temperature: def.request?.temperature ?? null,
    maxTokens: def.request?.maxTokens ?? 16000,
    responseFormat: def.request?.responseFormat,
    ...(def.request?.stream !== undefined ? { stream: def.request.stream } : {}),
    ...(def.request?.verbosity !== undefined ? { verbosity: def.request.verbosity } : {}),
    ...(def.request?.features !== undefined ? { features: def.request.features } : {}),
    timeouts: {
      requestMs: def.timeouts?.requestMs ?? 300000,
    },
    retries: {
      maxAttempts: def.retries?.maxAttempts ?? 2,
    },
    // Map the config's thinking block into the canonical reasoning config so
    // the user's reasoning settings actually reach every adapter.
    reasoning: def.thinking ? mapThinkingToReasoning(def.thinking) : undefined,
  };
}

/** Map config.json ThinkingConfig → adapter CanonicalReasoningConfig. */
function mapThinkingToReasoning(t: ThinkingConfig): CanonicalReasoningConfig {
  const mode =
    t.mode === "always"
      ? "enabled"
      : t.mode === "never"
        ? "disabled"
        : t.mode === "adaptive"
          ? "adaptive"
          : undefined;
  return {
    enabled: t.enabled,
    ...(mode !== undefined ? { mode } : {}),
    ...(t.effort !== undefined ? { effort: t.effort } : {}),
    ...(t.maxReasoningTokens !== undefined ? { budgetTokens: t.maxReasoningTokens } : {}),
  };
}
