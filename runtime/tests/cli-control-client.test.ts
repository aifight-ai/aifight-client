// M1-17 Step 2 — control-client test matrix (Group 3, case 22-40 + 1
// extra retry-reread RuntimeFilesError-wrap regression case).
//
// Mock fetch + injectable tokenSource/portSource. No real HTTP, no real
// daemon. Each test constructs its own client with the fetchImpl + sources
// it needs.

import { describe, it, expect, vi } from "vitest";

import {
  createControlClient,
  ControlClientError,
  isControlErrorBody,
  isControlErrorCode,
  type ControlErrorCodeLocal,
} from "../src/cli/control-client";
import { RuntimeFilesError } from "../src/cli/runtime-files";

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

interface FetchHarness {
  readonly calls: FetchCall[];
  readonly fetchImpl: typeof fetch;
}

function captureFetch(
  responder: (call: FetchCall) => Promise<Response> | Response,
): FetchHarness {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return responder({ url: String(input), init });
  };
  return { calls, fetchImpl };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(status = 204): Response {
  return new Response(null, { status });
}

function envelope(code: ControlErrorCodeLocal, message: string, details?: Record<string, unknown>): unknown {
  if (details === undefined) return { error: { code, message } };
  return { error: { code, message, details } };
}

describe("control-client (M1-17 Group 3)", () => {
  it("case 22: createControlClient is lazy — sources are not invoked at construction", () => {
    const tokenSource = vi.fn<() => string>(() => {
      throw new RuntimeFilesError("token_missing", "/no/path", "missing");
    });
    const portSource = vi.fn<() => number>(() => {
      throw new RuntimeFilesError("port_missing", "/no/path", "missing");
    });
    const { fetchImpl } = captureFetch(() => jsonResponse({}));
    expect(() => createControlClient({ tokenSource, portSource, fetchImpl })).not.toThrow();
    expect(tokenSource).not.toHaveBeenCalled();
    expect(portSource).not.toHaveBeenCalled();
  });

  it("case 23: happy GET 200 → parsed JSON body returned", async () => {
    const { fetchImpl } = captureFetch(() => jsonResponse({ ok: true, agents: [] }));
    const client = createControlClient({
      tokenSource: () => "tok",
      portSource: () => 12345,
      fetchImpl,
    });
    const body = await client.get<{ ok: boolean; agents: unknown[] }>("/v1/agents");
    expect(body.ok).toBe(true);
    expect(body.agents).toEqual([]);
  });

  it("case 24: POST body=undefined → no Content-Type, no payload", async () => {
    const harness = captureFetch(() => emptyResponse(204));
    const client = createControlClient({
      tokenSource: () => "tok",
      portSource: () => 12345,
      fetchImpl: harness.fetchImpl,
    });
    await client.post("/v1/agents/alpha/leave");
    expect(harness.calls.length).toBe(1);
    const init = harness.calls[0]!.init!;
    expect(init.body).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBeUndefined();
    expect(headers.Authorization).toBe("Bearer tok");
  });

  it("case 25: POST body={...} → Content-Type: application/json + JSON payload", async () => {
    const harness = captureFetch(() => emptyResponse(204));
    const client = createControlClient({
      tokenSource: () => "tok",
      portSource: () => 12345,
      fetchImpl: harness.fetchImpl,
    });
    await client.post("/v1/agents/alpha/join", { game: "texas_holdem" });
    const init = harness.calls[0]!.init!;
    expect(init.body).toBe('{"game":"texas_holdem"}');
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("case 26: POST body=null (literal) → Content-Type + 'null' payload", async () => {
    const harness = captureFetch(() => emptyResponse(204));
    const client = createControlClient({
      tokenSource: () => "tok",
      portSource: () => 12345,
      fetchImpl: harness.fetchImpl,
    });
    await client.post("/v1/agents/alpha/schedule", null);
    const init = harness.calls[0]!.init!;
    expect(init.body).toBe("null");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("case 27: 401 + files unchanged → ControlClientError(auth_failed) (no retry)", async () => {
    const tokenSource = vi.fn(() => "tok");
    const portSource = vi.fn(() => 12345);
    const fetchImpl = vi.fn(async () => emptyResponse(401));
    const client = createControlClient({ tokenSource, portSource, fetchImpl });
    const err = await client.get("/v1/health").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlClientError);
    expect((err as ControlClientError).kind).toBe("auth_failed");
    // 1 first call + 1 retry attempt (because reread invocation happens; it's
    // the unchanged-values branch that throws auth_failed without re-fetch)
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Sources invoked twice: once for first request, once for reread
    expect(tokenSource).toHaveBeenCalledTimes(2);
    expect(portSource).toHaveBeenCalledTimes(2);
  });

  it("case 28: 401 + files changed → reread + retry once + 200 + onLog rebootstrap", async () => {
    let portCalls = 0;
    const tokenSource = vi.fn(() => "tok-stable");
    const portSource = vi.fn(() => {
      portCalls++;
      return portCalls === 1 ? 11111 : 22222;
    });
    let fetchCalls = 0;
    const fetchImpl: typeof fetch = vi.fn(async () => {
      fetchCalls++;
      if (fetchCalls === 1) return emptyResponse(401);
      return jsonResponse({ ok: true });
    });
    const onLog = vi.fn();
    const client = createControlClient({
      tokenSource,
      portSource,
      fetchImpl,
      onLog,
    });
    const body = await client.get<{ ok: boolean }>("/v1/health");
    expect(body.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onLog).toHaveBeenCalledWith({
      code: "rebootstrap",
      message: "rebootstrap reason=401",
    });
  });

  it("case 29: 401 + files changed + second 401 → ControlClientError(auth_failed)", async () => {
    let portCalls = 0;
    const tokenSource = vi.fn(() => "tok-stable");
    const portSource = vi.fn(() => {
      portCalls++;
      return portCalls === 1 ? 11111 : 22222;
    });
    const fetchImpl = vi.fn(async () => emptyResponse(401));
    const client = createControlClient({
      tokenSource,
      portSource,
      fetchImpl,
    });
    const err = await client.get("/v1/health").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlClientError);
    expect((err as ControlClientError).kind).toBe("auth_failed");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("case 30: ECONNREFUSED-style fetch failure → daemon_unreachable", async () => {
    const fetchImpl: typeof fetch = vi.fn(() =>
      Promise.reject(new TypeError("fetch failed: ECONNREFUSED")),
    );
    const client = createControlClient({
      tokenSource: () => "tok",
      portSource: () => 12345,
      fetchImpl,
    });
    const err = await client.get("/v1/health").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlClientError);
    expect((err as ControlClientError).kind).toBe("daemon_unreachable");
  });

  it("case 31: tokenSource throws RuntimeFilesError(token_missing) at lazy invoke → daemon_unreachable", async () => {
    const tokenSource = vi.fn(() => {
      throw new RuntimeFilesError("token_missing", "/path/token", "ENOENT");
    });
    const client = createControlClient({
      tokenSource,
      portSource: () => 12345,
      fetchImpl: vi.fn(),
    });
    const err = await client.get("/v1/health").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlClientError);
    expect((err as ControlClientError).kind).toBe("daemon_unreachable");
    // Raw RuntimeFilesError MUST NOT escape — the only error class crossing
    // the boundary is ControlClientError (rev3 fix #1).
    expect(err).not.toBeInstanceOf(RuntimeFilesError);
  });

  it("case 32: portSource throws RuntimeFilesError(port_corrupt) at lazy invoke → runtime_files_corrupt", async () => {
    const portSource = vi.fn(() => {
      throw new RuntimeFilesError("port_corrupt", "/path/port", "out of range");
    });
    const client = createControlClient({
      tokenSource: () => "tok",
      portSource,
      fetchImpl: vi.fn(),
    });
    const err = await client.get("/v1/health").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlClientError);
    expect((err as ControlClientError).kind).toBe("runtime_files_corrupt");
    expect(err).not.toBeInstanceOf(RuntimeFilesError);
  });

  it("case 32b: 401 retry reread RuntimeFilesError also wraps (no raw RuntimeFilesError escapes)", async () => {
    // First call: tokenSource succeeds. fetch returns 401 → reread.
    // Reread: tokenSource throws token_corrupt. Wrap → runtime_files_corrupt.
    let tokenCalls = 0;
    const tokenSource = vi.fn(() => {
      tokenCalls++;
      if (tokenCalls === 1) return "first-tok";
      throw new RuntimeFilesError("token_corrupt", "/path/token", "got corrupt during reread");
    });
    const portSource = vi.fn(() => 12345);
    const fetchImpl = vi.fn(async () => emptyResponse(401));
    const client = createControlClient({ tokenSource, portSource, fetchImpl });
    const err = await client.get("/v1/health").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlClientError);
    expect((err as ControlClientError).kind).toBe("runtime_files_corrupt");
    expect(err).not.toBeInstanceOf(RuntimeFilesError);
    // Only one fetch call happened — the second was preempted by the reread throw
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("case 33: AbortController abort on baseTimeoutMs → request_timeout", async () => {
    const hangingFetch: typeof fetch = (_input, init) => {
      return new Promise((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (sig) {
          sig.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    };
    const client = createControlClient({
      tokenSource: () => "tok",
      portSource: () => 12345,
      fetchImpl: hangingFetch,
      baseTimeoutMs: 30,
    });
    const err = await client.get("/v1/health").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlClientError);
    expect((err as ControlClientError).kind).toBe("request_timeout");
  });

  it(
    "case 33b: Step 2b — timeout covers body stream too (hanging body → request_timeout, no hang)",
    async () => {
      // Server-style stall: respond fast with headers, then hang the body
      // stream forever. Per Codex P2 fix: baseTimeoutMs MUST cover the
      // body read, not only the fetch headers phase. Without the fix,
      // this test would hang and only end via the vitest test-level
      // timeout below; with the fix, the client aborts at ~30 ms and
      // throws ControlClientError("request_timeout").
      const fetchImpl: typeof fetch = (_input, init) => {
        const sig = init?.signal as AbortSignal | undefined;
        const stream = new ReadableStream({
          start(controller) {
            if (sig) {
              sig.addEventListener("abort", () => {
                const err = new Error("body aborted");
                err.name = "AbortError";
                controller.error(err);
              });
            }
            // Intentionally never enqueue or close — response.text() will
            // wait until our abort listener errors the stream.
          },
        });
        return Promise.resolve(new Response(stream, { status: 200 }));
      };
      const client = createControlClient({
        tokenSource: () => "tok",
        portSource: () => 12345,
        fetchImpl,
        baseTimeoutMs: 30,
      });
      const err = await client.get("/v1/health").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ControlClientError);
      expect((err as ControlClientError).kind).toBe("request_timeout");
    },
    1000,
  );

  it("case 34: 4xx with valid envelope (8 non-401 codes) → server_error + serverCode", async () => {
    // The 9th code "unauthorized" naturally pairs with HTTP 401, which the
    // client routes to `auth_failed` via the reread + retry path (cases
    // 27-29). The server_error path is for the OTHER 8 codes only — every
    // 4xx/5xx that is not 401 returns straight to the caller as server_error
    // carrying the parsed serverCode.
    const pairs: ReadonlyArray<readonly [ControlErrorCodeLocal, number]> = [
      ["not_found", 404],
      ["method_not_allowed", 405],
      ["bad_request", 400],
      ["unsupported_media_type", 415],
      ["payload_too_large", 413],
      ["not_implemented", 501],
      ["service_unavailable", 503],
      ["internal_error", 500],
    ];
    for (const [code, status] of pairs) {
      const { fetchImpl } = captureFetch(() =>
        jsonResponse(envelope(code, `${code} happened`), status),
      );
      const client = createControlClient({
        tokenSource: () => "tok",
        portSource: () => 12345,
        fetchImpl,
      });
      const err = await client.get(`/v1/probe-${code}`).catch((e: unknown) => e);
      expect(err, `code ${code}`).toBeInstanceOf(ControlClientError);
      expect((err as ControlClientError).kind, `code ${code}`).toBe("server_error");
      expect((err as ControlClientError).serverCode, `code ${code}`).toBe(code);
      expect((err as ControlClientError).status, `code ${code}`).toBe(status);
    }
  });

  it("case 35: 5xx with valid envelope → server_error", async () => {
    const { fetchImpl } = captureFetch(() =>
      jsonResponse(envelope("internal_error", "boom"), 500),
    );
    const client = createControlClient({
      tokenSource: () => "tok",
      portSource: () => 12345,
      fetchImpl,
    });
    const err = await client.get("/v1/health").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlClientError);
    expect((err as ControlClientError).kind).toBe("server_error");
    expect((err as ControlClientError).serverCode).toBe("internal_error");
    expect((err as ControlClientError).status).toBe(500);
  });

  it("case 36: 4xx with non-JSON body → transport_unparseable", async () => {
    const { fetchImpl } = captureFetch(
      () =>
        new Response("<html>nginx 502</html>", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        }),
    );
    const client = createControlClient({
      tokenSource: () => "tok",
      portSource: () => 12345,
      fetchImpl,
    });
    const err = await client.get("/v1/health").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlClientError);
    expect((err as ControlClientError).kind).toBe("transport_unparseable");
  });

  it("case 37: 4xx JSON but unknown error.code (server adds 10th code) → transport_unparseable", async () => {
    const { fetchImpl } = captureFetch(() =>
      jsonResponse({ error: { code: "future_code", message: "hi" } }, 400),
    );
    const client = createControlClient({
      tokenSource: () => "tok",
      portSource: () => 12345,
      fetchImpl,
    });
    const err = await client.get("/v1/health").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlClientError);
    expect((err as ControlClientError).kind).toBe("transport_unparseable");
  });

  it("case 38: 4xx body without error.code → transport_unparseable", async () => {
    const { fetchImpl } = captureFetch(() =>
      jsonResponse({ message: "no envelope here" }, 400),
    );
    const client = createControlClient({
      tokenSource: () => "tok",
      portSource: () => 12345,
      fetchImpl,
    });
    const err = await client.get("/v1/health").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlClientError);
    expect((err as ControlClientError).kind).toBe("transport_unparseable");
  });

  it("case 39: Bearer header injection on every request", async () => {
    const harness = captureFetch(() => jsonResponse({}));
    const client = createControlClient({
      tokenSource: () => "secret-tok-abc123",
      portSource: () => 12345,
      fetchImpl: harness.fetchImpl,
    });
    await client.get("/v1/a");
    await client.get("/v1/b");
    await client.post("/v1/c", { x: 1 });
    expect(harness.calls.length).toBe(3);
    for (const c of harness.calls) {
      const headers = c.init!.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer secret-tok-abc123");
    }
  });

  it("case 40: cache — multiple requests do not re-invoke tokenSource until 401 retry triggers", async () => {
    const tokenSource = vi.fn(() => "tok");
    const portSource = vi.fn(() => 12345);
    let firstDone = false;
    const fetchImpl: typeof fetch = vi.fn(async () => {
      // First two: 200; third: 401 → reread (changed=false because sources
      // return same values) → throw auth_failed without retry fetch.
      if (!firstDone) {
        firstDone = true;
        return jsonResponse({});
      }
      return jsonResponse({});
    });
    const client = createControlClient({ tokenSource, portSource, fetchImpl });
    await client.get("/v1/a");
    await client.get("/v1/b");
    await client.get("/v1/c");
    expect(tokenSource).toHaveBeenCalledTimes(1);
    expect(portSource).toHaveBeenCalledTimes(1);
    // Now trigger a 401 → reread invokes both sources again
    const fetchImpl2 = vi.fn(async () => emptyResponse(401));
    // Reuse same sources but with a fresh fetch behavior
    const client2 = createControlClient({
      tokenSource,
      portSource,
      fetchImpl: fetchImpl2,
    });
    await client2.get("/v1/d").catch(() => undefined);
    // client2 first invoke + reread = 2 more invocations on top of previous
    // 1 → total 3.
    expect(tokenSource).toHaveBeenCalledTimes(3);
    expect(portSource).toHaveBeenCalledTimes(3);
  });

  // ── Local guard sanity (rev2 fix #2) ────────────────────────────────

  it("isControlErrorCode returns true only for the locked 9-code set", () => {
    const all: ControlErrorCodeLocal[] = [
      "unauthorized",
      "not_found",
      "method_not_allowed",
      "bad_request",
      "unsupported_media_type",
      "payload_too_large",
      "not_implemented",
      "service_unavailable",
      "internal_error",
    ];
    for (const c of all) expect(isControlErrorCode(c)).toBe(true);
    expect(isControlErrorCode("future_code")).toBe(false);
    expect(isControlErrorCode(undefined)).toBe(false);
    expect(isControlErrorCode(123)).toBe(false);
  });

  it("isControlErrorBody requires {error: {code, message}} with valid 9-code", () => {
    expect(isControlErrorBody({ error: { code: "not_found", message: "x" } })).toBe(true);
    expect(isControlErrorBody({ error: { code: "future_code", message: "x" } })).toBe(false);
    expect(isControlErrorBody({ error: { code: "not_found" } })).toBe(false);
    expect(isControlErrorBody({ error: null })).toBe(false);
    expect(isControlErrorBody(null)).toBe(false);
    expect(isControlErrorBody("string")).toBe(false);
  });
});
