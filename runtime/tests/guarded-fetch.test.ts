import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { fetchNoFollow } from "../src/net/guarded-fetch";
import {
  clearAdapters,
  registerBuiltinAdapters,
  requireAdapter,
} from "../src/llm/adapter-registry";
import type { LLMProfile } from "../src/llm/adapters/types";

// R13 F-01: a credential-bearing outbound request must never follow a redirect
// to a different origin — that would ship the provider/platform API key to
// whatever host a 3xx Location names. fetchNoFollow refuses cross-origin
// redirects always, and same-origin redirects unless explicitly opted in.
//
// Verified with two real loopback servers: the "victim" (A) issues the
// redirect; the "attacker" (B) must receive ZERO requests and never see the key.

interface RequestRecord {
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
}

interface TestServer {
  readonly origin: string;
  readonly records: RequestRecord[];
  close(): Promise<void>;
}

const servers: TestServer[] = [];

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<TestServer> {
  const records: RequestRecord[] = [];
  const server = http.createServer((req, res) => {
    records.push({ url: req.url ?? "", headers: req.headers });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const ts: TestServer = {
    origin: `http://127.0.0.1:${port}`,
    records,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
  servers.push(ts);
  return ts;
}

function headersLeakKey(records: RequestRecord[], key: string): boolean {
  return records.some((r) =>
    Object.values(r.headers).some((v) =>
      Array.isArray(v) ? v.some((x) => x.includes(key)) : typeof v === "string" && v.includes(key),
    ),
  );
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  clearAdapters();
});

const KEY = "sk-REDIRECT-LEAK-KEY-0001";

describe("fetchNoFollow redirect guard (R13 F-01)", () => {
  it("refuses a cross-origin redirect and the attacker origin gets NO request", async () => {
    const attacker = await startServer((_req, res) => {
      res.writeHead(200);
      res.end("attacker-should-never-be-hit");
    });
    const victim = await startServer((_req, res) => {
      res.writeHead(307, { Location: `${attacker.origin}/steal` });
      res.end();
    });

    await expect(
      fetchNoFollow(`${victim.origin}/api`, { headers: { "x-api-key": KEY } }),
    ).rejects.toThrow(/cross-origin/i);

    expect(attacker.records.length).toBe(0);
    expect(headersLeakKey(attacker.records, KEY)).toBe(false);
    // The victim did receive the (key-bearing) initial request — that's expected.
    expect(victim.records.length).toBe(1);
  });

  it("refuses even a same-origin redirect by default (refuse-all)", async () => {
    const victim = await startServer((req, res) => {
      if (req.url === "/api") {
        res.writeHead(307, { Location: "/after" });
        res.end();
      } else {
        res.writeHead(200);
        res.end("followed");
      }
    });

    await expect(fetchNoFollow(`${victim.origin}/api`)).rejects.toThrow(/does not follow redirects/i);
    // Only the first hop happened; the redirect target was never requested.
    expect(victim.records.map((r) => r.url)).toEqual(["/api"]);
  });

  it("follows a bounded same-origin redirect when explicitly opted in", async () => {
    const victim = await startServer((req, res) => {
      if (req.url === "/api") {
        res.writeHead(307, { Location: "/after" });
        res.end();
      } else {
        res.writeHead(200);
        res.end("followed-ok");
      }
    });

    const res = await fetchNoFollow(
      `${victim.origin}/api`,
      { headers: { "x-api-key": KEY } },
      { allowSameOriginRedirects: true },
    );
    expect(await res.text()).toBe("followed-ok");
    expect(victim.records.map((r) => r.url)).toEqual(["/api", "/after"]);
    // Same-origin: the key legitimately stayed on the same host across the hop.
    expect(headersLeakKey(victim.records, KEY)).toBe(true);
  });

  it("still refuses cross-origin even with allowSameOriginRedirects", async () => {
    const attacker = await startServer((_req, res) => {
      res.writeHead(200);
      res.end("nope");
    });
    const victim = await startServer((_req, res) => {
      res.writeHead(302, { Location: `${attacker.origin}/steal` });
      res.end();
    });

    await expect(
      fetchNoFollow(
        `${victim.origin}/api`,
        { headers: { "x-api-key": KEY } },
        { allowSameOriginRedirects: true },
      ),
    ).rejects.toThrow(/cross-origin/i);
    expect(attacker.records.length).toBe(0);
  });

  it("passes a non-redirect response straight through", async () => {
    const victim = await startServer((_req, res) => {
      res.writeHead(200);
      res.end("hello");
    });
    const res = await fetchNoFollow(`${victim.origin}/api`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
  });

  it("refuses a redirect status with no Location header", async () => {
    const victim = await startServer((_req, res) => {
      res.writeHead(307);
      res.end();
    });
    await expect(fetchNoFollow(`${victim.origin}/api`)).rejects.toThrow(/no readable Location/i);
  });
});

function resolvedProfile(baseURL: string): LLMProfile {
  return {
    profileId: "p",
    displayName: "p",
    protocol: "anthropic_messages",
    model: "claude-test",
    apiKey: KEY,
    baseURL,
    temperature: null,
    maxTokens: 256,
    timeouts: { requestMs: 2000 },
    retries: { maxAttempts: 1 },
  };
}

describe("adapter refuses cross-origin redirect end-to-end (R13 F-01)", () => {
  it("anthropic adapter throws and the attacker origin never sees the key", async () => {
    const attacker = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text: "SHOULD-NOT-REACH" }] }));
    });
    const victim = await startServer((_req, res) => {
      res.writeHead(307, { Location: `${attacker.origin}/v1/messages` });
      res.end();
    });

    await registerBuiltinAdapters();
    const adapter = requireAdapter("anthropic_messages");

    await expect(
      adapter.generateDecision(
        { systemPrompt: "sys", userPrompt: "usr", maxTokens: 64, temperature: 0, responseFormat: "json" },
        resolvedProfile(victim.origin),
      ),
    ).rejects.toThrow();

    expect(attacker.records.length).toBe(0);
    expect(headersLeakKey(attacker.records, KEY)).toBe(false);
  });
});
