import { describe, expect, it, vi } from "vitest";

import { checkBridgeUpdate, evaluatePolicy } from "../src/bridge/update-check";

const policy = {
  minimumSupportedVersion: "0.1.0-alpha.1",
  recommendedVersion: "0.1.0",
  latestVersion: "0.1.0",
  updateCommand: "npm install -g @aifight/aifight@alpha",
};

describe("bridge update check", () => {
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

  it("fetches platform policy without sending secrets", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toBeUndefined();
      return new Response(JSON.stringify({
          minimum_supported_version: "0.1.0-alpha.1",
          recommended_version: "0.1.0-alpha.1",
          latest_version: "0.1.0-alpha.1",
          update_command: "npm install -g @aifight/aifight@alpha",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const result = await checkBridgeUpdate({
      baseUrl: "https://aifight.ai/",
      currentVersion: "0.1.0-alpha.1",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith("https://aifight.ai/api/bridge/version", expect.objectContaining({
      method: "GET",
    }));
    expect(result.status).toBe("current");
  });
});
