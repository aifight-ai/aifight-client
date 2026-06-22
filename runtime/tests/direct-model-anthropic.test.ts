import { describe, expect, it, vi } from "vitest";
import { createAnthropicClient } from "../src/decision/direct-model/anthropic";
import {
  DirectModelAbortedError,
  DirectModelHttpError,
  DirectModelInvalidResponseError,
  DirectModelNetworkError,
  DirectModelUnsupportedError,
  SNIPPET_MAX,
} from "../src/decision/direct-model/errors";

const APIKEY = "sk-ant-test-1234567890abcdef-do-not-leak";
const MODEL = "claude-opus-4-7";

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

function happyResponseBody(): string {
  return JSON.stringify({
    content: [{ type: "text", text: "hello world" }],
    usage: { input_tokens: 12, output_tokens: 7 },
  });
}

function happyResponse(): Response {
  return new Response(happyResponseBody(), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function withFetch(fn: () => Promise<Response>): typeof fetch {
  return vi.fn(async () => fn()) as unknown as typeof fetch;
}

function lastCall(fetchImpl: typeof fetch): FetchCall {
  const mock = fetchImpl as unknown as { mock: { calls: unknown[][] } };
  const call = mock.mock.calls.at(-1);
  if (!call) throw new Error("fetchImpl was never called");
  return { url: call[0] as string, init: call[1] as RequestInit };
}

function callCount(fetchImpl: typeof fetch): number {
  const mock = fetchImpl as unknown as { mock: { calls: unknown[][] } };
  return mock.mock.calls.length;
}

function makeClient(overrides: {
  fetchImpl?: typeof fetch;
  baseURL?: string;
  anthropicVersion?: string;
} = {}) {
  const fetchImpl = overrides.fetchImpl ?? withFetch(async () => happyResponse());
  const client = createAnthropicClient({
    apiKey: APIKEY,
    model: MODEL,
    baseURL: overrides.baseURL,
    anthropicVersion: overrides.anthropicVersion,
    fetchImpl,
  });
  return { fetchImpl, client };
}

describe("createAnthropicClient", () => {
  it("returns parsed text + tokens + latency + raw on happy path", async () => {
    const { client } = makeClient();
    const res = await client.generate({
      systemPrompt: "be concise",
      userPrompt: "say hi",
      maxTokens: 100,
    });
    expect(res.text).toBe("hello world");
    expect(res.inputTokens).toBe(12);
    expect(res.outputTokens).toBe(7);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    expect(res.latencyMs).toBeLessThan(60_000);
    expect(res.raw).toMatchObject({ content: [{ type: "text", text: "hello world" }] });
  });

  it("exposes provider and model on the client instance", () => {
    const { client } = makeClient();
    expect(client.provider).toBe("anthropic");
    expect(client.model).toBe(MODEL);
  });

  it("posts to default baseURL + /v1/messages with required headers", async () => {
    const { client, fetchImpl } = makeClient();
    await client.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 50 });
    const { url, init } = lastCall(fetchImpl);
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(APIKEY);
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("uses Anthropic body shape: top-level system, user message, max_tokens (NOT max_completion_tokens)", async () => {
    const { client, fetchImpl } = makeClient();
    await client.generate({
      systemPrompt: "be concise",
      userPrompt: "say hi",
      temperature: 0.7,
      maxTokens: 250,
    });
    const body = JSON.parse((lastCall(fetchImpl).init.body as string));
    expect(body.model).toBe(MODEL);
    expect(body.system).toBe("be concise");
    expect(body.messages).toEqual([{ role: "user", content: "say hi" }]);
    expect(body.max_tokens).toBe(250);
    expect(body.temperature).toBe(0.7);
    // Anthropic uses max_tokens; OpenAI is the one that needs
    // max_completion_tokens (rev2 拍板点 #18). Guard against accidental crossover.
    expect("max_completion_tokens" in body).toBe(false);
  });

  it("respects custom baseURL (with trailing slash) and anthropicVersion", async () => {
    const fetchImpl = withFetch(async () => happyResponse());
    const client = createAnthropicClient({
      apiKey: APIKEY,
      model: MODEL,
      baseURL: "https://custom.example/api/",
      anthropicVersion: "2099-12-31",
      fetchImpl,
    });
    await client.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 50 });
    const { url, init } = lastCall(fetchImpl);
    expect(url).toBe("https://custom.example/api/v1/messages");
    expect((init.headers as Record<string, string>)["anthropic-version"]).toBe("2099-12-31");
  });

  it("omits temperature from body when caller does not provide it", async () => {
    const { client, fetchImpl } = makeClient();
    await client.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 50 });
    const body = JSON.parse(lastCall(fetchImpl).init.body as string);
    expect("temperature" in body).toBe(false);
  });

  it("rejects empty apiKey, empty model, and non-positive maxTokens with DirectModelUnsupportedError", async () => {
    expect(() => createAnthropicClient({ apiKey: "", model: MODEL })).toThrow(
      DirectModelUnsupportedError,
    );
    expect(() => createAnthropicClient({ apiKey: APIKEY, model: "" })).toThrow(
      DirectModelUnsupportedError,
    );
    const { client } = makeClient();
    await expect(
      client.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 0 }),
    ).rejects.toThrow(DirectModelUnsupportedError);
    await expect(
      client.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: -1 }),
    ).rejects.toThrow(DirectModelUnsupportedError);
  });

  it("4xx response throws DirectModelHttpError with status, redacted bodySnippet, and no apiKey leak", async () => {
    // Body includes apiKey on purpose to verify redaction.
    const fetchImpl = withFetch(
      async () =>
        new Response(`{"error":{"message":"key ${APIKEY} not allowed","status":401}}`, {
          status: 401,
        }),
    );
    const client = createAnthropicClient({ apiKey: APIKEY, model: MODEL, fetchImpl });
    const err = await client
      .generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 50 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(DirectModelHttpError);
    expect(err.status).toBe(401);
    expect(err.provider).toBe("anthropic");
    expect(err.bodySnippet).toBeDefined();
    expect(err.bodySnippet).toContain("[REDACTED]");
    expect(err.bodySnippet).not.toContain(APIKEY);
    expect(err.message).not.toContain(APIKEY);
  });

  it("5xx response throws DirectModelHttpError with the server status preserved", async () => {
    const fetchImpl = withFetch(async () => new Response("server fail", { status: 503 }));
    const client = createAnthropicClient({ apiKey: APIKEY, model: MODEL, fetchImpl });
    const err = await client
      .generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 50 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(DirectModelHttpError);
    expect(err.status).toBe(503);
    expect(err.bodySnippet).toBe("server fail");
  });

  it("bodySnippet is capped at SNIPPET_MAX with a truncation marker (rev2 truncate-fix invariant)", async () => {
    const big = "x".repeat(5000);
    const fetchImpl = withFetch(async () => new Response(big, { status: 502 }));
    const client = createAnthropicClient({ apiKey: APIKEY, model: MODEL, fetchImpl });
    const err = await client
      .generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 50 })
      .catch((e) => e);
    expect(err.bodySnippet).toBeDefined();
    expect(err.bodySnippet.length).toBeLessThanOrEqual(SNIPPET_MAX);
    expect(err.bodySnippet).toContain("[truncated");
  });

  it("HttpError.cause carries the raw Response object (rev2 #19: cause is not redacted/stringified)", async () => {
    const fetchImpl = withFetch(async () => new Response("oops", { status: 503 }));
    const client = createAnthropicClient({ apiKey: APIKEY, model: MODEL, fetchImpl });
    const err = await client
      .generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 50 })
      .catch((e) => e);
    expect(err.cause).toBeInstanceOf(Response);
  });

  it("fetch throws (network) → DirectModelNetworkError with cause raw and message redacted", async () => {
    const cause = new Error(`ENOTFOUND api.anthropic.com (${APIKEY} echoed)`);
    const fetchImpl = withFetch(async () => {
      throw cause;
    });
    const client = createAnthropicClient({ apiKey: APIKEY, model: MODEL, fetchImpl });
    const err = await client
      .generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 50 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(DirectModelNetworkError);
    expect(err.cause).toBe(cause); // raw cause preserved (rev2 #19)
    expect(err.message).toContain("[REDACTED]");
    expect(err.message).not.toContain(APIKEY);
  });

  it("malformed JSON 2xx → DirectModelInvalidResponseError with responseSnippet", async () => {
    const fetchImpl = withFetch(async () => new Response("not json at all", { status: 200 }));
    const client = createAnthropicClient({ apiKey: APIKEY, model: MODEL, fetchImpl });
    const err = await client
      .generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 50 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(DirectModelInvalidResponseError);
    expect(err.responseSnippet).toBe("not json at all");
  });

  it("missing content[0].text → DirectModelInvalidResponseError", async () => {
    const fetchImpl = withFetch(
      async () =>
        new Response(JSON.stringify({ content: [{ type: "text" }] }), { status: 200 }),
    );
    const client = createAnthropicClient({ apiKey: APIKEY, model: MODEL, fetchImpl });
    await expect(
      client.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 50 }),
    ).rejects.toThrow(DirectModelInvalidResponseError);
  });

  it("content[0].type !== 'text' (e.g. tool_use) → DirectModelInvalidResponseError", async () => {
    const fetchImpl = withFetch(
      async () =>
        new Response(
          JSON.stringify({ content: [{ type: "tool_use", input: { x: 1 } }] }),
          { status: 200 },
        ),
    );
    const client = createAnthropicClient({ apiKey: APIKEY, model: MODEL, fetchImpl });
    await expect(
      client.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 50 }),
    ).rejects.toThrow(DirectModelInvalidResponseError);
  });

  it("usage missing → text returned, tokens undefined", async () => {
    const fetchImpl = withFetch(
      async () =>
        new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), {
          status: 200,
        }),
    );
    const client = createAnthropicClient({ apiKey: APIKEY, model: MODEL, fetchImpl });
    const res = await client.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 50 });
    expect(res.text).toBe("ok");
    expect(res.inputTokens).toBeUndefined();
    expect(res.outputTokens).toBeUndefined();
  });

  it("pre-aborted signal throws DirectModelAbortedError and never calls fetch", async () => {
    const fetchImpl = withFetch(async () => happyResponse());
    const client = createAnthropicClient({ apiKey: APIKEY, model: MODEL, fetchImpl });
    const ac = new AbortController();
    ac.abort(new Error("user cancel"));
    const err = await client
      .generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 50, signal: ac.signal })
      .catch((e) => e);
    expect(err).toBeInstanceOf(DirectModelAbortedError);
    expect(callCount(fetchImpl)).toBe(0);
  });

  it("mid-flight fetch AbortError surfaces as DirectModelAbortedError", async () => {
    const fetchImpl = withFetch(async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    });
    const client = createAnthropicClient({ apiKey: APIKEY, model: MODEL, fetchImpl });
    const ac = new AbortController();
    const promise = client.generate({
      systemPrompt: "s",
      userPrompt: "u",
      maxTokens: 50,
      signal: ac.signal,
    });
    ac.abort();
    await expect(promise).rejects.toBeInstanceOf(DirectModelAbortedError);
  });
});
