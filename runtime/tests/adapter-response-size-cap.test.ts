// codex-security 2026-07-29 C13: a provider response may not decide how much
// memory the bridge allocates.
//
// Every adapter used to read the whole body — text()/json(), or DeepSeek's
// `content += delta` SSE loop — with no ceiling at all. The bridge is a single
// process serving every agent and every live match on the machine, so one
// runaway or hostile response used to be an OOM kill for all of them, silently.
//
// What these pin: past the ceiling the call fails as an ordinary AdapterError
// (the process survives, the log says why), and — the part that actually matters
// — the excess is never allocated in the first place.

import { afterEach, describe, it, expect, vi } from "vitest";

import {
  readTextCapped,
  readErrorBodyCapped,
  maxResponseBytes,
  DEFAULT_MAX_RESPONSE_BYTES,
} from "../src/llm/adapters/response-limit";
import { AdapterError, type LLMProfile } from "../src/llm/adapters/types";
import { clearAdapters, registerBuiltinAdapters, requireAdapter } from "../src/llm/adapter-registry";

const PROTOCOL = "test_protocol";

/** A body that keeps producing chunks forever — the shape we cannot survive unbounded. */
function endlessBody(chunkBytes = 64 * 1024): { stream: ReadableStream<Uint8Array>; produced: () => number } {
  let produced = 0;
  const chunk = new Uint8Array(chunkBytes).fill(0x61); // 'a'
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      produced += chunkBytes;
      controller.enqueue(chunk);
    },
  });
  return { stream, produced: () => produced };
}

function makeResponse(stream: ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Response {
  return new Response(stream, { status: 200, headers });
}

describe("response byte ceiling", () => {
  it("defaults to 32 MiB and ignores junk overrides rather than uncapping", () => {
    expect(DEFAULT_MAX_RESPONSE_BYTES).toBe(32 * 1024 * 1024);
    expect(maxResponseBytes({})).toBe(DEFAULT_MAX_RESPONSE_BYTES);
    expect(maxResponseBytes({ AIFIGHT_LLM_MAX_RESPONSE_BYTES: "1048576" })).toBe(1048576);
    for (const junk of ["", "   ", "0", "-1", "abc", "1.5", "Infinity"]) {
      expect(maxResponseBytes({ AIFIGHT_LLM_MAX_RESPONSE_BYTES: junk })).toBe(DEFAULT_MAX_RESPONSE_BYTES);
    }
  });

  it("passes a body that fits straight through", async () => {
    const body = JSON.stringify({ hello: "world" });
    const text = await readTextCapped(new Response(body, { status: 200 }), PROTOCOL, 1024);
    expect(text).toBe(body);
  });

  it("stops reading an endless stream instead of growing with it", async () => {
    const { stream, produced } = endlessBody(64 * 1024);
    const limit = 512 * 1024;

    const err = await readTextCapped(makeResponse(stream), PROTOCOL, limit).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).kind).toBe("invalid_response");
    expect((err as AdapterError).message).toMatch(/too large/i);
    // The real assertion: it gave up NEAR the ceiling. Without the cap this
    // stream never ends, so any bound at all here is the fix working.
    expect(produced()).toBeLessThanOrEqual(limit + 64 * 1024);
  });

  it("refuses an oversized body before reading a byte when content-length says so", async () => {
    const chunk = 64 * 1024;
    const { stream, produced } = endlessBody(chunk);
    const response = makeResponse(stream, { "content-length": String(100 * 1024 * 1024) });

    // The size in the message is the DECLARED 100 MiB, which we could only know
    // from the header — reading would have stopped at the first chunk and said
    // "over 65536". So this pins that the refusal happened before the read.
    await expect(readTextCapped(response, PROTOCOL, 1024)).rejects.toThrow(
      /too large: 104857600 bytes exceeds/i,
    );
    // Out of an endless supply, at most the single chunk the Response buffered on
    // its own was ever produced — the read loop never ran.
    expect(produced()).toBeLessThanOrEqual(chunk);
  });

  it("caps error bodies too, but never throws — the HTTP status already decided", async () => {
    const { stream, produced } = endlessBody(16 * 1024);
    const limit = 64 * 1024;

    const text = await readErrorBodyCapped(makeResponse(stream), limit);

    expect(text.length).toBeGreaterThan(0);
    expect(produced()).toBeLessThanOrEqual(limit + 16 * 1024);
  });

  it("survives a body-less response shape without pretending it read something", async () => {
    const fake = {
      headers: { get: () => null },
      body: null,
      text: async () => "plain",
    } as unknown as Response;
    expect(await readTextCapped(fake, PROTOCOL, 1024)).toBe("plain");
    expect(await readErrorBodyCapped(fake, 1024)).toBe("plain");
  });
});

// ─── End-to-end through the real adapters ────────────────────────────
//
// These run against the ACTUAL default ceiling (32 MiB), so they read ~32 MiB of
// in-memory chunks each. That is the point: the same body without the cap has no
// end at all.

function resolved(partial: Partial<LLMProfile> & Pick<LLMProfile, "protocol" | "baseURL" | "model">): LLMProfile {
  return {
    profileId: "p",
    displayName: "p",
    apiKey: "sk-test",
    temperature: null,
    maxTokens: 64,
    timeouts: { requestMs: 60_000 },
    retries: { maxAttempts: 1 },
    ...partial,
  };
}

const DECIDE = {
  systemPrompt: "sys",
  userPrompt: "usr",
  maxTokens: 64,
  temperature: 0,
  responseFormat: "json",
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
  clearAdapters();
});

describe("adapters refuse an unbounded provider response", () => {
  it("a non-streaming 200 body that never ends fails the call, not the process", async () => {
    const { stream, produced } = endlessBody(256 * 1024);
    vi.stubGlobal("fetch", vi.fn(async () => makeResponse(stream)));
    await registerBuiltinAdapters();

    const err = await requireAdapter("anthropic_messages")
      .generateDecision(
        DECIDE,
        resolved({
          protocol: "anthropic_messages" as LLMProfile["protocol"],
          baseURL: "https://api.anthropic.com",
          model: "test-model",
        }),
      )
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).kind).toBe("invalid_response");
    expect((err as AdapterError).message).toMatch(/too large/i);
    // Bounded — an endless body used to be bounded only by available memory.
    expect(produced()).toBeLessThan(DEFAULT_MAX_RESPONSE_BYTES + 4 * 1024 * 1024);
  }, 120_000);

  it("deepseek streaming: endless SSE deltas fail the call, and NOT as a retryable network blip", async () => {
    // Well-formed deltas, forever — the exact shape that used to grow `content`
    // until the OS killed the bridge.
    let produced = 0;
    const frame = new TextEncoder().encode(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "x".repeat(64 * 1024) } }] })}\n`,
    );
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += frame.byteLength;
        controller.enqueue(frame);
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => makeResponse(stream)));
    await registerBuiltinAdapters();

    const err = await requireAdapter("deepseek_chat_completions")
      .generateDecision(
        DECIDE,
        resolved({
          protocol: "deepseek_chat_completions" as LLMProfile["protocol"],
          baseURL: "https://api.deepseek.com",
          model: "deepseek-reasoner",
          stream: "always",
        }),
      )
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).message).toMatch(/ceiling/i);
    // Not re-labelled "network" by the stream's catch — that would both lie and
    // invite a retry that re-reads the same runaway stream.
    expect((err as AdapterError).kind).toBe("invalid_response");
    expect((err as AdapterError).retryable).toBe(false);
    expect(produced).toBeLessThan(DEFAULT_MAX_RESPONSE_BYTES + 4 * 1024 * 1024);
  }, 120_000);
});
