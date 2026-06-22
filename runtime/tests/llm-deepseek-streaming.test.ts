import { afterEach, describe, expect, it, vi } from "vitest";

import { clearAdapters, registerBuiltinAdapters, requireAdapter } from "../src/llm/adapter-registry";
import type { LLMProfile } from "../src/llm/adapters/types";

// DeepSeek long/reasoning generations are fragile over a non-streaming connection
// (TCP timeout; the API injects keep-alive empty lines). So the adapter switches
// to SSE streaming above max_tokens 4096 and reassembles the chunks. These tests
// lock that behavior: small request = non-streaming; large request = stream=true
// + the SSE deltas (content + reasoning_content) are reassembled correctly.

function resolved(over: Partial<LLMProfile> = {}): LLMProfile {
  return {
    profileId: "d",
    displayName: "d",
    protocol: "deepseek_chat_completions",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    apiKey: "k",
    temperature: null,
    maxTokens: 1024,
    timeouts: { requestMs: 1000, connectMs: 1000 },
    retries: { maxAttempts: 1, backoffMs: 0 },
    ...over,
  };
}

function stubJson(capture: (b: Record<string, unknown>) => void) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: unknown) => {
      capture(JSON.parse((init as { body: string }).body));
      const text = JSON.stringify({ choices: [{ message: { role: "assistant", content: "{}" } }], usage: {} });
      return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text } as unknown as Response;
    }),
  );
}

/** Build an SSE ReadableStream from raw chunk strings (chunk boundaries may split lines). */
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearAdapters();
});

describe("deepseek adapter: streaming for large max_tokens", () => {
  it("small max_tokens stays non-streaming", async () => {
    let captured: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        captured = JSON.parse((init as { body: string }).body);
        const text = JSON.stringify({
          choices: [{ message: { role: "assistant", content: '{"action":"check"}' } }],
          usage: { prompt_tokens: 3, completion_tokens: 4 },
        });
        return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text } as unknown as Response;
      }),
    );
    await registerBuiltinAdapters();
    const adapter = requireAdapter("deepseek_chat_completions");
    const out = await adapter.generateDecision(
      { systemPrompt: "s", userPrompt: "u", maxTokens: 2048, temperature: null, reasoning: { enabled: true, effort: "high" } },
      resolved(),
    );
    expect(captured.stream).toBeUndefined();
    expect(out.text).toBe('{"action":"check"}');
  });

  it("large max_tokens streams (stream=true) and reassembles content + reasoning", async () => {
    let captured: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        captured = JSON.parse((init as { body: string }).body);
        // Note: the 2nd content delta is split across two stream chunks to
        // exercise cross-chunk line buffering.
        const body = sseStream([
          'data: {"choices":[{"delta":{"reasoning_content":"weighing the odds"}}]}\n',
          'data: {"choices":[{"delta":{"content":"{\\"action\\":"}}]}\n',
          'data: {"choices":[{"delta":{"content":"\\"ra',
          'ise\\"}"}}]}\n',
          ': keep-alive\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":7,"completion_tokens_details":{"reasoning_tokens":3}}}\n',
          "data: [DONE]\n",
        ]);
        return { ok: true, status: 200, body } as unknown as Response;
      }),
    );
    await registerBuiltinAdapters();
    const adapter = requireAdapter("deepseek_chat_completions");
    const out = await adapter.generateDecision(
      { systemPrompt: "s", userPrompt: "u", maxTokens: 8000, temperature: null, reasoning: { enabled: true, effort: "max" } },
      resolved(),
    );
    expect(captured.stream).toBe(true);
    expect(captured.stream_options).toEqual({ include_usage: true });
    expect(out.text).toBe('{"action":"raise"}');
    expect(out.reasoningSummary).toBe("weighing the odds");
    expect(out.inputTokens).toBe(10);
    expect(out.outputTokens).toBe(7);
    expect(out.reasoningTokens).toBe(3);
  });

  it('stream="never" forces non-streaming even for large max_tokens', async () => {
    let captured: Record<string, unknown> = {};
    stubJson((b) => { captured = b; });
    await registerBuiltinAdapters();
    const adapter = requireAdapter("deepseek_chat_completions");
    const out = await adapter.generateDecision(
      { systemPrompt: "s", userPrompt: "u", maxTokens: 16000, temperature: null, reasoning: { enabled: true } },
      resolved({ stream: "never" }),
    );
    expect(captured.stream).toBeUndefined();
    expect(out.text).toBe("{}");
  });

  it('stream="always" streams even for small max_tokens', async () => {
    let captured: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        captured = JSON.parse((init as { body: string }).body);
        const body = sseStream(['data: {"choices":[{"delta":{"content":"{}"}}]}\n', "data: [DONE]\n"]);
        return { ok: true, status: 200, body } as unknown as Response;
      }),
    );
    await registerBuiltinAdapters();
    const adapter = requireAdapter("deepseek_chat_completions");
    const out = await adapter.generateDecision(
      { systemPrompt: "s", userPrompt: "u", maxTokens: 256, temperature: null, reasoning: { enabled: true } },
      resolved({ stream: "always", maxTokens: 256 }),
    );
    expect(captured.stream).toBe(true);
    expect(out.text).toBe("{}");
  });

  it("does NOT send response_format json_object by default (avoids DeepSeek 400)", async () => {
    let captured: Record<string, unknown> = {};
    stubJson((b) => { captured = b; });
    await registerBuiltinAdapters();
    const adapter = requireAdapter("deepseek_chat_completions");
    await adapter.generateDecision(
      { systemPrompt: "play poker", userPrompt: "your move", maxTokens: 1024, temperature: null, reasoning: { enabled: true } },
      resolved(),
    );
    expect(captured.response_format).toBeUndefined();
  });

  it('features.jsonObjectMode sets response_format + injects "json" when the prompt lacks it', async () => {
    let captured: Record<string, unknown> = {};
    stubJson((b) => { captured = b; });
    await registerBuiltinAdapters();
    const adapter = requireAdapter("deepseek_chat_completions");
    await adapter.generateDecision(
      { systemPrompt: "play poker", userPrompt: "your move", maxTokens: 1024, temperature: null, reasoning: { enabled: true } },
      resolved({ features: { jsonObjectMode: true } }),
    );
    expect(captured.response_format).toEqual({ type: "json_object" });
    const msgs = captured.messages as Array<{ content: string }>;
    expect(msgs.some((m) => /json/i.test(m.content))).toBe(true);
  });

  it("jsonObjectMode does not modify the prompt when it already mentions json", async () => {
    let captured: Record<string, unknown> = {};
    stubJson((b) => { captured = b; });
    await registerBuiltinAdapters();
    const adapter = requireAdapter("deepseek_chat_completions");
    await adapter.generateDecision(
      { systemPrompt: "Return a JSON action", userPrompt: "go", maxTokens: 1024, temperature: null, reasoning: { enabled: true } },
      resolved({ features: { jsonObjectMode: true } }),
    );
    const msgs = captured.messages as Array<{ content: string }>;
    expect(msgs[0].content).toBe("Return a JSON action"); // unchanged
  });
});
