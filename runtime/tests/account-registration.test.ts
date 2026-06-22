// runtime/tests/account-registration.test.ts
//
// 9 unit test cases covering the error contract of registerAgent().
// All tests use a stubbed fetchImpl — zero real network. CI MUST be
// able to run this file offline.

import { describe, expect, it, vi } from "vitest";
import {
  registerAgent,
  RegisterNetworkError,
  RegisterHttpError,
  RegisterSchemaError,
  RegisterError,
} from "../src";

const BASE_URL = "https://beta.aifight.ai";

// Canonical valid 201 body. Built once, mutated per-test via
// structuredClone so one test's mutation cannot leak into another.
function validBody() {
  return {
    agent: {
      id: "aaaaaaaa-0000-0000-0000-000000000001",
      name: "m1-03-test",
      api_key: "ak_SUPERSECRET_DO_NOT_LEAK_0123456789",
      model: "",
      auto_confirm: false,
      webhook_url: "",
    },
    claim_url: "https://beta.aifight.ai/claim/ct_FAKE_CLAIM_TOKEN_000",
    claim_token: "ct_FAKE_CLAIM_TOKEN_000",
    important: "Save your api_key!",
  };
}

function mockResponse(status: number, body: string | object): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status });
}

function stubOk(body: object): typeof fetch {
  return vi.fn().mockResolvedValue(mockResponse(201, body)) as unknown as typeof fetch;
}

function stubStatus(status: number, body: string | object): typeof fetch {
  return vi
    .fn()
    .mockResolvedValue(mockResponse(status, body)) as unknown as typeof fetch;
}

function stubThrow(err: unknown): typeof fetch {
  return vi.fn().mockRejectedValue(err) as unknown as typeof fetch;
}

// Fetch stub that never resolves but honors AbortSignal — mimics the
// real Node fetch's cancellation behavior.
function stubHanging(): typeof fetch {
  return ((_url: unknown, init: { signal?: AbortSignal } = {}) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      if (signal) {
        if (signal.aborted) {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          },
          { once: true },
        );
      }
    });
  }) as unknown as typeof fetch;
}

describe("registerAgent", () => {
  it("1. happy path returns RegisterAgentResult with apiKey + claimToken", async () => {
    const body = validBody();
    const result = await registerAgent({
      baseUrl: BASE_URL,
      request: { name: "m1-03-test" },
      fetchImpl: stubOk(body),
    });

    expect(result.agentId).toBe(body.agent.id);
    expect(result.apiKey).toBe(body.agent.api_key);
    expect(result.claimToken).toBe(body.claim_token);
    expect(result.claimUrl).toBe(body.claim_url);
    expect(result.response).toEqual(body);
  });

  it("2. convenience fields point at response subfields (no typo)", async () => {
    const body = validBody();
    const result = await registerAgent({
      baseUrl: BASE_URL,
      request: { name: "m1-03-test" },
      fetchImpl: stubOk(body),
    });
    expect(result.apiKey).toBe(result.response.agent.api_key);
    expect(result.claimToken).toBe(result.response.claim_token);
    expect(result.agentId).toBe(result.response.agent.id);
    expect(result.claimUrl).toBe(result.response.claim_url);
  });

  it("3. HTTP 409 duplicate name → RegisterHttpError with preserved body.error", async () => {
    const serverBody = { error: "agent name already exists" };
    await expect(
      registerAgent({
        baseUrl: BASE_URL,
        request: { name: "already-taken" },
        fetchImpl: stubStatus(409, serverBody),
      }),
    ).rejects.toSatisfy((e) => {
      expect(e).toBeInstanceOf(RegisterHttpError);
      const he = e as RegisterHttpError;
      expect(he.kind).toBe("http");
      expect(he.status).toBe(409);
      expect(he.body).toEqual(serverBody);
      return true;
    });
  });

  it("4. HTTP 400 validation fail → RegisterHttpError", async () => {
    const serverBody = { error: "name must be at least 2 characters" };
    let caught: unknown = null;
    try {
      await registerAgent({
        baseUrl: BASE_URL,
        request: { name: "x" },
        fetchImpl: stubStatus(400, serverBody),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RegisterHttpError);
    const he = caught as RegisterHttpError;
    expect(he.status).toBe(400);
    expect(he.body).toEqual(serverBody);
  });

  it("5. HTTP 500 with non-JSON body → RegisterHttpError (body as string)", async () => {
    const htmlBody = "<html><body>500 Internal Server Error</body></html>";
    let caught: unknown = null;
    try {
      await registerAgent({
        baseUrl: BASE_URL,
        request: { name: "m1-03-test" },
        fetchImpl: stubStatus(500, htmlBody),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RegisterHttpError);
    const he = caught as RegisterHttpError;
    expect(he.status).toBe(500);
    expect(typeof he.body).toBe("string");
    expect(he.body).toBe(htmlBody);
  });

  it("6. fetch throws → RegisterNetworkError (cause preserved)", async () => {
    const fetchErr = new TypeError("fetch failed");
    let caught: unknown = null;
    try {
      await registerAgent({
        baseUrl: BASE_URL,
        request: { name: "m1-03-test" },
        fetchImpl: stubThrow(fetchErr),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RegisterNetworkError);
    expect(caught).toBeInstanceOf(RegisterError);
    const ne = caught as RegisterNetworkError;
    expect(ne.kind).toBe("network");
    expect(ne.cause).toBe(fetchErr);
    expect(ne.message).toMatch(/POST \/api\/agents\/register failed/);
  });

  it("7. 201 with schema-invalid JSON (missing api_key) → RegisterSchemaError", async () => {
    const bad = {
      agent: {
        id: "aaaaaaaa-0000-0000-0000-000000000001",
        name: "m1-03-test",
        // api_key deliberately omitted
        auto_confirm: false,
      },
      claim_url: "https://beta.aifight.ai/claim/ct_abc",
      claim_token: "ct_abc",
      important: "Save it!",
    };
    let caught: unknown = null;
    try {
      await registerAgent({
        baseUrl: BASE_URL,
        request: { name: "m1-03-test" },
        fetchImpl: stubOk(bad),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RegisterSchemaError);
    const se = caught as RegisterSchemaError;
    expect(se.kind).toBe("schema");
    expect(se.ajvErrors.length).toBeGreaterThan(0);
    const anyMentionsApiKey = se.ajvErrors.some(
      (err) =>
        (err.instancePath ?? "").includes("api_key") ||
        (err.message ?? "").includes("api_key"),
    );
    expect(anyMentionsApiKey).toBe(true);
  });

  it("8. timeout via composed AbortSignal → RegisterNetworkError", async () => {
    let caught: unknown = null;
    const started = Date.now();
    try {
      await registerAgent({
        baseUrl: BASE_URL,
        request: { name: "m1-03-test" },
        fetchImpl: stubHanging(),
        timeoutMs: 50,
      });
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - started;
    expect(caught).toBeInstanceOf(RegisterNetworkError);
    const ne = caught as RegisterNetworkError;
    expect(ne.message).toMatch(/timed out after 50ms/);
    // Fires quickly — allow generous slack for CI jitter but not seconds.
    expect(elapsed).toBeLessThan(1500);
  });

  it("9. schema-invalid 201 error does NOT leak api_key in message or ajv errors", async () => {
    const SECRET = "ak_THIS_SPECIFIC_STRING_MUST_NOT_APPEAR_IN_ERROR";
    const bad = {
      agent: {
        id: "aaaaaaaa-0000-0000-0000-000000000001",
        name: "m1-03-test",
        api_key: SECRET,
        auto_confirm: false,
      },
      // claim_url + claim_token deliberately omitted → schema fail
      important: "Save it!",
    };
    let caught: unknown = null;
    try {
      await registerAgent({
        baseUrl: BASE_URL,
        request: { name: "m1-03-test" },
        fetchImpl: stubOk(bad),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RegisterSchemaError);
    const se = caught as RegisterSchemaError;
    expect(se.message).not.toContain(SECRET);
    const serialized = JSON.stringify({
      message: se.message,
      ajvErrors: se.ajvErrors,
    });
    expect(serialized).not.toContain(SECRET);
  });
});
