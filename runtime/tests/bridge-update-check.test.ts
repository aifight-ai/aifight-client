import { describe, expect, it, vi } from "vitest";

import { checkBridgeUpdate, evaluatePolicy } from "../src/bridge/update-check";

const policy = {
  minimumSupportedVersion: "0.1.0-alpha.1",
  recommendedVersion: "0.1.0",
  latestVersion: "0.1.0",
  updateCommand: "npm install -g @aifight/aifight",
};

const SERVER_URL = "https://aifight.ai/api/bridge/version";
const NPM_URL = "https://registry.npmjs.org/@aifight%2faifight/latest";

function policyResp(over: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    minimum_supported_version: "0.1.0-alpha.1",
    recommended_version: "0.1.0",
    latest_version: "0.1.0",
    update_command: "npm install -g @aifight/aifight",
    ...over,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function npmResp(version: unknown): Response {
  return new Response(JSON.stringify({ version }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

type Route = (() => Response) | "fail";

/** Route fetch by URL; an absent route (or "fail") rejects, like a dead endpoint. */
function fakeFetch(routes: { server?: Route; npm?: Route }): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    const route = url.startsWith(SERVER_URL) ? routes.server
      : url.startsWith("https://registry.npmjs.org/") ? routes.npm
      : undefined;
    if (route === undefined || route === "fail") throw new Error(`fetch failed: ${url}`);
    return route();
  }) as unknown as typeof fetch;
}

describe("bridge update check — server-only policy evaluation (fallback arm)", () => {
  it("marks prerelease clients below the recommended release", () => {
    const result = evaluatePolicy("0.1.0-alpha.1", policy);

    expect(result.status).toBe("update_recommended");
    expect(result.message).toContain("0.1.0 is recommended");
  });

  it("marks clients below the minimum as unsupported", () => {
    const result = evaluatePolicy("0.0.9", policy);

    expect(result.status).toBe("unsupported");
    expect(result.message).toContain("minimum supported version");
  });

  it("treats the server recommended version as the latest source in this arm", () => {
    const result = evaluatePolicy("0.1.0-alpha.1", policy);

    expect(result.latestVersion).toBe("0.1.0");
    expect(result.latestSource).toBe("server");
    expect(result.policy).toEqual(policy);
  });
});

describe("bridge update check — npm registry is the latest source", () => {
  it("npm ok + server ok: update_recommended names the npm latest, floor from the server", async () => {
    const result = await checkBridgeUpdate({
      baseUrl: "https://aifight.ai",
      currentVersion: "0.1.0-alpha.1",
      fetchImpl: fakeFetch({
        server: () => policyResp({ recommended_version: "0.1.0", latest_version: "0.1.0" }),
        npm: () => npmResp("0.1.0-beta.37"),
      }),
    });

    expect(result.status).toBe("update_recommended");
    expect(result.message).toContain("0.1.0-beta.37 is the latest on npm");
    expect(result.latestVersion).toBe("0.1.0-beta.37");
    expect(result.latestSource).toBe("npm");
    // The server policy still flows through for the floor + update command.
    expect(result.policy?.minimumSupportedVersion).toBe("0.1.0-alpha.1");
  });

  it("npm ok + server ok: below the server minimum is still unsupported", async () => {
    const result = await checkBridgeUpdate({
      baseUrl: "https://aifight.ai",
      currentVersion: "0.0.9",
      fetchImpl: fakeFetch({
        server: () => policyResp({ minimum_supported_version: "0.1.0" }),
        npm: () => npmResp("0.1.0"),
      }),
    });

    expect(result.status).toBe("unsupported");
    expect(result.message).toContain("minimum supported version 0.1.0");
  });

  it("npm ok + server ok: at the npm latest is current", async () => {
    const result = await checkBridgeUpdate({
      baseUrl: "https://aifight.ai",
      currentVersion: "0.1.0",
      fetchImpl: fakeFetch({
        server: () => policyResp(),
        npm: () => npmResp("0.1.0"),
      }),
    });

    expect(result.status).toBe("current");
    expect(result.message).toContain("up to date with npm");
  });

  it("npm FAIL + server ok: degrades to the server recommended version (old behavior)", async () => {
    const result = await checkBridgeUpdate({
      baseUrl: "https://aifight.ai",
      currentVersion: "0.1.0-alpha.1",
      fetchImpl: fakeFetch({
        server: () => policyResp({ recommended_version: "0.1.0" }),
        npm: "fail",
      }),
    });

    expect(result.status).toBe("update_recommended");
    expect(result.message).toContain("0.1.0 is recommended");
    expect(result.latestVersion).toBe("0.1.0");
    expect(result.latestSource).toBe("server");
  });

  it("npm ok + server FAIL: compares against npm only, never unsupported", async () => {
    // Even a hopelessly old client: without the server policy the floor cannot
    // be verified, so the strongest claim allowed is update_recommended.
    const result = await checkBridgeUpdate({
      baseUrl: "https://aifight.ai",
      currentVersion: "0.0.1",
      fetchImpl: fakeFetch({
        server: "fail",
        npm: () => npmResp("0.1.0-beta.37"),
      }),
    });

    expect(result.status).toBe("update_recommended");
    expect(result.message).toContain("0.1.0-beta.37 is the latest on npm");
    expect(result.message).toContain("minimum supported version unverified");
    expect(result.latestVersion).toBe("0.1.0-beta.37");
    expect(result.latestSource).toBe("npm");
    expect(result.policy).toBeUndefined();
  });

  it("npm ok + server FAIL: at the npm latest is current (still not unsupported)", async () => {
    const result = await checkBridgeUpdate({
      baseUrl: "https://aifight.ai",
      currentVersion: "0.1.0-beta.37",
      fetchImpl: fakeFetch({
        server: "fail",
        npm: () => npmResp("0.1.0-beta.37"),
      }),
    });

    expect(result.status).toBe("current");
    expect(result.message).toContain("up to date with npm");
  });

  it("both FAIL: unknown", async () => {
    const result = await checkBridgeUpdate({
      baseUrl: "https://aifight.ai",
      currentVersion: "0.1.0",
      fetchImpl: fakeFetch({ server: "fail", npm: "fail" }),
    });

    expect(result.status).toBe("unknown");
    expect(result.message).toContain("unavailable");
    expect(result.latestVersion).toBeUndefined();
  });

  it("an unparseable npm version counts as npm failure and falls back to the server", async () => {
    const result = await checkBridgeUpdate({
      baseUrl: "https://aifight.ai",
      currentVersion: "0.1.0-alpha.1",
      fetchImpl: fakeFetch({
        server: () => policyResp({ recommended_version: "0.1.0" }),
        npm: () => npmResp("latest"),
      }),
    });

    expect(result.status).toBe("update_recommended");
    expect(result.latestSource).toBe("server");
    expect(result.latestVersion).toBe("0.1.0");
  });

  it("an invalid server policy counts as server failure and uses npm only", async () => {
    const result = await checkBridgeUpdate({
      baseUrl: "https://aifight.ai",
      currentVersion: "0.1.0-alpha.1",
      fetchImpl: fakeFetch({
        server: () => new Response(JSON.stringify({ nope: true }), { status: 200 }),
        npm: () => npmResp("0.1.0"),
      }),
    });

    expect(result.status).toBe("update_recommended");
    expect(result.latestSource).toBe("npm");
    expect(result.policy).toBeUndefined();
  });

  it("both endpoints hanging: one timeout discipline, reported as timed out", async () => {
    const hanging = ((input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      })) as unknown as typeof fetch;

    const started = Date.now();
    const result = await checkBridgeUpdate({
      baseUrl: "https://aifight.ai",
      currentVersion: "0.1.0",
      fetchImpl: hanging,
      timeoutMs: 20,
    });

    expect(result.status).toBe("unknown");
    expect(result.message).toContain("timed out");
    // The two arms race in parallel: worst case is ONE timeout, not two.
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("fetches both endpoints without sending secrets", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toBeUndefined();
      const url = String(input);
      if (url.startsWith(SERVER_URL)) {
        return policyResp({
          minimum_supported_version: "0.1.0-alpha.1",
          recommended_version: "0.1.0-alpha.1",
          latest_version: "0.1.0-alpha.1",
        });
      }
      return npmResp("0.1.0-alpha.1");
    }) as unknown as typeof fetch;

    const result = await checkBridgeUpdate({
      baseUrl: "https://aifight.ai/",
      currentVersion: "0.1.0-alpha.1",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(SERVER_URL, expect.objectContaining({ method: "GET" }));
    expect(fetchImpl).toHaveBeenCalledWith(NPM_URL, expect.objectContaining({ method: "GET" }));
    expect(result.status).toBe("current");
  });
});
