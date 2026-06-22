import { describe, expect, it, vi } from "vitest";
import { createOpenAIClient } from "../src/decision/direct-model/openai";
import {
  DirectModelAbortedError,
  DirectModelHttpError,
  DirectModelInvalidResponseError,
  DirectModelNetworkError,
  DirectModelUnsupportedError,
  SNIPPET_MAX,
} from "../src/decision/direct-model/errors";

const APIKEY = "sk-openai-test-1234567890abcdef-do-not-leak";
const MODEL = "gpt-5-mini";

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

function happyResponseBody(): string {
  return JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hello world" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
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
  organization?: string;
} = {}) {
  const fetchImpl = overrides.fetchImpl ?? withFetch(async () => happyResponse());
  const client = createOpenAIClient({
    apiKey: APIKEY,
    model: MODEL,
    baseURL: overrides.baseURL,
    organization: overrides.organization,
    fetchImpl,
  });
  return { fetchImpl, client };
}

describe("createOpenAIClient", () => {
  it("returns parsed text + tokens (prompt→input, completion→output) + latency + raw on happy path", async () => {
    const { client } = makeClient();
    const res = await client.generate({
      systemPrompt: "be concise",
      userPrompt: "say hi",
      maxTokens: 100,
    });
    expect(res.text).toBe("hello world");
    expect(res.inputTokens).toBe(12); // usage.prompt_tokens
    expect(res.outputTokens).toBe(7); // usage.completion_tokens
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    expect(res.latencyMs).toBeLessThan(60_000);
    expect(res.raw).toMatchObject({
      choices: [{ message: { content: "hello world" } }],
    });
  });

  it("exposes provider and model on the client instance", () => {
    const { client } = makeClient();
    expect(client.provider).toBe("openai");
    expect(client.model).toBe(MODEL);
  });

  it("posts to default baseURL + /chat/completions with Authorization Bearer + content-type (no Organization by default)", async () => {
    const { client, fetchImpl } = makeClient();
    await client.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 50 });
    const { url, init } = lastCall(fetchImpl);
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${APIKEY}`);
    expect(headers["content-type"]).toBe("application/json");
    expect("OpenAI-Organization" in headers).toBe(false);
  });

  it("uses OpenAI body shape: messages[system,user] + max_completion_tokens (NOT max_tokens, rev2 拍板点 #18)", async () => {
    const { client, fetchImpl } = makeClient();
    await client.generate({
      systemPrompt: "be concise",
      userPrompt: "say hi",
      temperature: 0.7,
      maxTokens: 250,
    });
    const body = JSON.parse(lastCall(fetchImpl).init.body as string);
    expect(body.model).toBe(MODEL);
    expect(body.messages).toEqual([
      { role: "system", content: "be concise" },
      { role: "user", content: "say hi" },
    ]);
    expect(body.max_completion_tokens).toBe(250);
    expect(body.temperature).toBe(0.7);
    // Rev2 #18: OpenAI uses max_completion_tokens explicitly. Anthropic
    // is the one that uses max_tokens. Guard against accidental crossover.
    expect("max_tokens" in body).toBe(false);
  });

  it("respects custom baseURL with trailing slash and composes URL correctly", async () => {
    const fetchImpl = withFetch(async () => happyResponse());
    const client = createOpenAIClient({
      apiKey: APIKEY,
      model: MODEL,
      baseURL: "https://my-proxy.example/v1/",
      fetchImpl,
    });
    await client.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 50 });
    expect(lastCall(fetchImpl).url).toBe("https://my-proxy.example/v1/chat/completions");
  });

  it("emits OpenAI-Organization header only when organization is provided", async () => {
    const { client, fetchImpl } = makeClient({ organization: "org-abc-123" });
    await client.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 50 });
    const headers = lastCall(fetchImpl).init.headers as Record<string, string>;
    expect(headers["OpenAI-Organization"]).toBe("org-abc-123");
  });

  it("omits temperature from body when caller does not provide it", async () => {
    const { client, fetchImpl } = makeClient();
    await client.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 50 });
    const body = JSON.parse(lastCall(fetchImpl).init.body as string);
    expect("temperature" in body).toBe(false);
  });

  it("rejects empty apiKey, empty model, and non-positive maxTokens with DirectModelUnsupportedError", async () => {
    expect(() => createOpenAIClient({ apiKey: "", model: MODEL })).toThrow(
      DirectModelUnsupportedError,
    );
    expect(() => createOpenAIClient({ apiKey: APIKEY, model: "" })).toThrow(
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

  it("4xx response throws DirectModelHttpError with status, redacted bodySnippet, no apiKey leak", async () => {
    const fetchImpl = withFetch(
      async () =>
        new Response(
          `{"error":{"message":"key ${APIKEY} not allowed","type":"invalid_request_error"}}`,
          { status: 401 },
        ),
    );
    const client = createOpenAIClient({ apiKey: APIKEY, model: MODEL, fetchImpl });
    const err = await client
      .generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 50 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(DirectModelHttpError);
    expect(err.status).toBe(401);
    expect(err.provider).toBe("openai");
    expect(err.bodySnippet).toContain("[REDACTED]");
    expect(err.bodySnippet).not.toContain(APIKEY);
    expect(err.message).not.toContain(APIKEY);
  });

  it("5xx response throws DirectModelHttpError with the server status preserved", async () => {
    const fetchImpl = withFetch(async () => new Response("server fail", { status: 503 }));
    const client = createOpenAIClient({ apiKey: APIKEY, model: MODEL, fetchImpl });
    const err = await client
      .generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 50 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(DirectModelHttpError);
    expect(err.status).toBe(503);
    expect(err.bodySnippet).toBe("server fail");
  });

  it("bodySnippet is capped at SNIPPET_MAX with truncation marker (rev2 truncate-fix invariant)", async () => {
    const big = "x".repeat(5000);
    const fetchImpl = withFetch(async () => new Response(big, { status: 502 }));
    const client = createOpenAIClient({ apiKey: APIKEY, model: MODEL, fetchImpl });
    const err = await client
      .generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 50 })
      .catch((e) => e);
    expect(err.bodySnippet.length).toBeLessThanOrEqual(SNIPPET_MAX);
    expect(err.bodySnippet).toContain("[truncated");
  });

  it("HttpError.cause carries raw Response object (rev2 #19: cause is not redacted/stringified)", async () => {
    const fetchImpl = withFetch(async () => new Response("oops", { status: 503 }));
    const client = createOpenAIClient({ apiKey: APIKEY, model: MODEL, fetchImpl });
    const err = await client
      .generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 50 })
      .catch((e) => e);
    expect(err.cause).toBeInstanceOf(Response);
  });

  it("fetch throws (network) → DirectModelNetworkError with cause raw and message redacted", async () => {
    const cause = new Error(`ENOTFOUND api.openai.com (${APIKEY} echoed)`);
    const fetchImpl = withFetch(async () => {
      throw cause;
    });
    const client = createOpenAIClient({ apiKey: APIKEY, model: MODEL, fetchImpl });
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
    const client = createOpenAIClient({ apiKey: APIKEY, model: MODEL, fetchImpl });
    const err = await client
      .generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 50 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(DirectModelInvalidResponseError);
    expect(err.responseSnippet).toBe("not json at all");
  });

  it("missing choices[0].message.content → DirectModelInvalidResponseError", async () => {
    const fetchImpl = withFetch(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { role: "assistant" } }] }), {
          status: 200,
        }),
    );
    const client = createOpenAIClient({ apiKey: APIKEY, model: MODEL, fetchImpl });
    await expect(
      client.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 50 }),
    ).rejects.toThrow(DirectModelInvalidResponseError);
  });

  it("empty choices array → DirectModelInvalidResponseError", async () => {
    const fetchImpl = withFetch(
      async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    );
    const client = createOpenAIClient({ apiKey: APIKEY, model: MODEL, fetchImpl });
    await expect(
      client.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 50 }),
    ).rejects.toThrow(DirectModelInvalidResponseError);
  });

  it("content not a string (e.g. tool_calls reply with content=null) → DirectModelInvalidResponseError", async () => {
    const fetchImpl = withFetch(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [{ id: "t1", type: "function", function: { name: "x", arguments: "{}" } }],
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const client = createOpenAIClient({ apiKey: APIKEY, model: MODEL, fetchImpl });
    await expect(
      client.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 50 }),
    ).rejects.toThrow(DirectModelInvalidResponseError);
  });

  it("usage missing → text returned, tokens undefined", async () => {
    const fetchImpl = withFetch(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
        }),
    );
    const client = createOpenAIClient({ apiKey: APIKEY, model: MODEL, fetchImpl });
    const res = await client.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 50 });
    expect(res.text).toBe("ok");
    expect(res.inputTokens).toBeUndefined();
    expect(res.outputTokens).toBeUndefined();
  });

  it("pre-aborted signal throws DirectModelAbortedError and never calls fetch", async () => {
    const fetchImpl = withFetch(async () => happyResponse());
    const client = createOpenAIClient({ apiKey: APIKEY, model: MODEL, fetchImpl });
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
    const client = createOpenAIClient({ apiKey: APIKEY, model: MODEL, fetchImpl });
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
