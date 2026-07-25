import { describe, expect, it, vi } from "vitest";

import { exchangePairingCode } from "../src/bridge/pairing";

describe("exchangePairingCode", () => {
  it("posts pairing code and returns local bridge config defaults", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({
        agent: {
          id: "agent-1",
          name: "alpha",
          api_key: "sk-new-agent-key",
          runtime_type: "openclaw",
        },
        ws_url: "wss://aifight.ai/api/ws",
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as unknown as typeof fetch;

    const cfg = await exchangePairingCode({
      pairingCode: " aifp_abc ",
      fetchImpl,
      now: () => new Date("2026-05-06T00:00:00Z"),
    });

    expect(fetchImpl).toHaveBeenCalledWith("https://aifight.ai/api/bridge/pair", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ pairing_code: "aifp_abc" }),
    }));
    // A legacy agent reporting runtime_type "openclaw" is coerced to direct-LLM.
    expect(cfg).toMatchObject({
      agentId: "agent-1",
      agentName: "alpha",
      apiKey: "sk-new-agent-key",
      runtimeType: "direct",
      runtimeLocalUrl: "direct://local",
      runtimeModel: "direct",
      updatedAt: "2026-05-06T00:00:00.000Z",
    });
  });

  it("surfaces server pairing errors without leaking request body", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "pairing_code expired" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    await expect(exchangePairingCode({ pairingCode: "aifp_expired", fetchImpl }))
      .rejects.toThrow("pairing_code expired");
  });

  it("refuses an unsafe ws_url (plaintext downgrade / cross-host)", async () => {
    const mkFetch = (wsUrl: string) =>
      vi.fn(async () =>
        new Response(JSON.stringify({
          agent: { id: "a", name: "n", api_key: "k", runtime_type: "direct" },
          ws_url: wsUrl,
        }), { status: 200, headers: { "Content-Type": "application/json" } }),
      ) as unknown as typeof fetch;

    // Plaintext downgrade against an https base must be rejected.
    await expect(exchangePairingCode({ pairingCode: "aifp_x", fetchImpl: mkFetch("ws://aifight.ai/api/ws") }))
      .rejects.toThrow(/unsafe WebSocket URL/);
    // Redirect to a different host (would leak the agent key) must be rejected.
    await expect(exchangePairingCode({ pairingCode: "aifp_x", fetchImpl: mkFetch("wss://evil.example/api/ws") }))
      .rejects.toThrow(/unsafe WebSocket URL/);
  });

  // The server awards the agent to the client kind this request declares. Send
  // the wrong one — or none from a client that has one — and the agent lands
  // with the other program on this machine, which then refuses this one.
  it("declares the claiming client kind, and omits the header when there is none", async () => {
    const okBody = JSON.stringify({
      agent: { id: "a", name: "n", api_key: "k", runtime_type: "direct" },
      ws_url: "wss://aifight.ai/api/ws",
    });
    const headersFor = async (clientKind?: "desktop" | "cli"): Promise<Record<string, string>> => {
      let seen: Record<string, string> = {};
      const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        seen = (init?.headers ?? {}) as Record<string, string>;
        return new Response(okBody, { status: 200, headers: { "Content-Type": "application/json" } });
      }) as unknown as typeof fetch;
      await exchangePairingCode({
        pairingCode: "aifp_abc",
        fetchImpl,
        ...(clientKind ? { clientKind } : {}),
      });
      return seen;
    };

    expect((await headersFor("desktop"))["X-AIFight-Client-Kind"]).toBe("desktop");
    expect((await headersFor("cli"))["X-AIFight-Client-Kind"]).toBe("cli");
    expect(await headersFor()).not.toHaveProperty("X-AIFight-Client-Kind");
  });
});
