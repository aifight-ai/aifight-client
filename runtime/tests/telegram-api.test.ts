// The Bot API client. Every case here is a stubbed fetch — no network, and no
// real bot token exists in this suite.
//
// The recurring assertion is that the token never escapes: it lives in the
// request URL path, so any error message that echoed the URL would leak it into
// logs, `aifight status` output, and support pastes.

import { describe, expect, it, vi } from "vitest";

import {
  TelegramApiError,
  createTelegramApi,
  escapeHtml,
  type TelegramUpdate,
} from "../src/notify/telegram/api";

const TOKEN = "1234567:TEST-bot-token-not-real-9zx";

interface StubCall {
  readonly method: string;
  readonly body: Record<string, unknown>;
}

/** Stub fetch that records each Bot API call and answers from `respond`. */
function stubFetch(respond: (method: string, body: Record<string, unknown>) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: StubCall[];
  urls: string[];
} {
  const calls: StubCall[] = [];
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const text = String(url);
    urls.push(text);
    const method = text.slice(text.lastIndexOf("/") + 1);
    const body = init?.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>);
    calls.push({ method, body });
    return respond(method, body);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, urls };
}

function ok(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function apiError(status: number, description: string, parameters?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ok: false, error_code: status, description, ...(parameters ? { parameters } : {}) }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("telegram api client", () => {
  it("calls the documented endpoint and returns the result", async () => {
    const stub = stubFetch(() => ok({ id: 42, is_bot: true, username: "pokermind_bot" }));
    const api = createTelegramApi({ token: TOKEN, fetchImpl: stub.fetchImpl });

    const me = await api.getMe();

    expect(me.username).toBe("pokermind_bot");
    expect(stub.urls[0]).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
  });

  it("sends HTML messages with an optional inline keyboard", async () => {
    const stub = stubFetch(() => ok({ message_id: 7, chat: { id: 99 } }));
    const api = createTelegramApi({ token: TOKEN, fetchImpl: stub.fetchImpl });

    await api.sendMessage({
      chatId: 99,
      text: "<b>hi</b>",
      keyboard: [[{ text: "Menu", callback_data: "v1:home:open" }]],
    });

    expect(stub.calls[0]!.method).toBe("sendMessage");
    expect(stub.calls[0]!.body).toMatchObject({
      chat_id: 99,
      text: "<b>hi</b>",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "Menu", callback_data: "v1:home:open" }]] },
    });
  });

  it("asks getUpdates only for the two update kinds it handles", async () => {
    const stub = stubFetch(() => ok([]));
    const api = createTelegramApi({ token: TOKEN, fetchImpl: stub.fetchImpl });

    await api.getUpdates({ offset: 51, timeoutSec: 50 });

    expect(stub.calls[0]!.body).toEqual({
      offset: 51,
      timeout: 50,
      allowed_updates: ["message", "callback_query"],
    });
  });

  it("classifies a bad token as auth (terminal) without echoing the token", async () => {
    const stub = stubFetch(() => apiError(404, "Not Found"));
    const api = createTelegramApi({ token: TOKEN, fetchImpl: stub.fetchImpl });

    const err = await api.getMe().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TelegramApiError);
    expect((err as TelegramApiError).kind).toBe("auth");
    expect((err as TelegramApiError).retriable).toBe(false);
    expect((err as TelegramApiError).message).not.toContain(TOKEN);
  });

  it("treats 401 the same as 404", async () => {
    const stub = stubFetch(() => apiError(401, "Unauthorized"));
    const api = createTelegramApi({ token: TOKEN, fetchImpl: stub.fetchImpl });
    await expect(api.getMe()).rejects.toMatchObject({ kind: "auth" });
  });

  it("reads retry_after off a 429", async () => {
    const stub = stubFetch(() => apiError(429, "Too Many Requests: retry after 3", { retry_after: 3 }));
    const api = createTelegramApi({ token: TOKEN, fetchImpl: stub.fetchImpl });

    const err = (await api.sendMessage({ chatId: 1, text: "x" }).catch((e: unknown) => e)) as TelegramApiError;

    expect(err.kind).toBe("rate_limit");
    expect(err.retryAfterMs).toBe(3000);
    expect(err.retriable).toBe(true);
  });

  it("classifies 5xx as retriable server trouble and 4xx as our own bad request", async () => {
    const server = createTelegramApi({ token: TOKEN, fetchImpl: stubFetch(() => apiError(502, "Bad Gateway")).fetchImpl });
    await expect(server.getMe()).rejects.toMatchObject({ kind: "server", retriable: true });

    const bad = createTelegramApi({
      token: TOKEN,
      fetchImpl: stubFetch(() => apiError(403, "Forbidden: bot was blocked by the user")).fetchImpl,
    });
    await expect(bad.sendMessage({ chatId: 1, text: "x" })).rejects.toMatchObject({ kind: "request", retriable: false });
  });

  it("rejects an ok:false body even on HTTP 200", async () => {
    const stub = stubFetch(
      () => new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 200 }),
    );
    const api = createTelegramApi({ token: TOKEN, fetchImpl: stub.fetchImpl });
    await expect(api.getMe()).rejects.toThrow(/chat not found/);
  });

  it("never leaks the token through a transport failure", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      throw new Error(`connect ECONNREFUSED for ${String(url)}`);
    }) as unknown as typeof fetch;
    const api = createTelegramApi({ token: TOKEN, fetchImpl });

    const err = (await api.getMe().catch((e: unknown) => e)) as TelegramApiError;

    expect(err.kind).toBe("network");
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain("1234567:");
  });

  it("times out a hung request as a retriable network failure", async () => {
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })) as unknown as typeof fetch;
    const api = createTelegramApi({ token: TOKEN, fetchImpl, timeoutMs: 20 });

    const err = (await api.getMe().catch((e: unknown) => e)) as TelegramApiError;

    expect(err.kind).toBe("network");
    expect(err.message).toMatch(/timed out/);
  });

  it("reports a caller abort as aborted, not as a failure", async () => {
    const controller = new AbortController();
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })) as unknown as typeof fetch;
    const api = createTelegramApi({ token: TOKEN, fetchImpl });

    const pending = api.getUpdates({ timeoutSec: 50, signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
  });

  it("parses the update shapes the companion consumes", async () => {
    const update: TelegramUpdate = {
      update_id: 5,
      callback_query: { id: "cb1", from: { id: 7 }, data: "v1:play:open", message: { message_id: 3, chat: { id: 7 } } },
    };
    const stub = stubFetch(() => ok([update]));
    const api = createTelegramApi({ token: TOKEN, fetchImpl: stub.fetchImpl });

    const updates = await api.getUpdates({ timeoutSec: 0 });

    expect(updates[0]!.callback_query?.data).toBe("v1:play:open");
  });
});

describe("escapeHtml", () => {
  it("neutralizes the three characters Telegram's HTML mode parses", () => {
    expect(escapeHtml('<b>x</b> & "y"')).toBe('&lt;b&gt;x&lt;/b&gt; &amp; "y"');
  });

  it("leaves ordinary agent names alone", () => {
    expect(escapeHtml("PokerMind")).toBe("PokerMind");
  });
});
