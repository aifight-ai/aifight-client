// LLM adapter registry — maps protocol strings to adapter instances.
//
// The decision engine uses this registry to find the correct adapter
// for a given config profile. Adapters are registered at daemon startup.

import type { LLMAdapter, LLMProtocol } from "./adapters/types.js";

const registry = new Map<string, LLMAdapter>();

/**
 * Register an adapter for a protocol. Overwrites any existing adapter
 * for the same protocol (useful for testing).
 */
export function registerAdapter(adapter: LLMAdapter): void {
  registry.set(adapter.protocol, adapter);
}

/**
 * Get the adapter for a protocol. Returns undefined if not registered.
 */
export function getAdapter(protocol: LLMProtocol | string): LLMAdapter | undefined {
  return registry.get(protocol);
}

/**
 * Get the adapter for a protocol, or throw if not registered.
 */
export function requireAdapter(protocol: LLMProtocol | string): LLMAdapter {
  const adapter = registry.get(protocol);
  if (!adapter) {
    throw new Error(
      `No LLM adapter registered for protocol "${protocol}". ` +
        `Registered: [${[...registry.keys()].join(", ")}]`,
    );
  }
  return adapter;
}

/**
 * List all registered protocol names.
 */
export function listRegisteredProtocols(): string[] {
  return [...registry.keys()];
}

/**
 * Clear all registered adapters (for testing).
 */
export function clearAdapters(): void {
  registry.clear();
}

/**
 * Register all built-in P0 adapters. Called at daemon startup.
 * Lazy-imports adapters to keep the registry module lightweight.
 */
export async function registerBuiltinAdapters(): Promise<void> {
  const [anthropic, openaiResponses, openaiChat, openaiCompat, deepseek, gemini] =
    await Promise.all([
      import("./adapters/anthropic-messages.js"),
      import("./adapters/openai-responses.js"),
      import("./adapters/openai-chat-completions.js"),
      import("./adapters/openai-chat-compat.js"),
      import("./adapters/deepseek-chat-completions.js"),
      import("./adapters/gemini-generate-content.js"),
    ]);

  registerAdapter(anthropic.createAnthropicMessagesAdapter());
  registerAdapter(openaiResponses.createOpenAIResponsesAdapter());
  registerAdapter(openaiChat.createOpenAIChatCompletionsAdapter());
  registerAdapter(openaiCompat.createOpenAIChatCompatAdapter());
  registerAdapter(deepseek.createDeepSeekChatCompletionsAdapter());
  registerAdapter(gemini.createGeminiGenerateContentAdapter());
}
