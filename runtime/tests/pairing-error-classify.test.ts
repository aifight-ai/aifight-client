import { describe, expect, it } from "vitest";

import { classifyPairingError } from "../src/cli/commands/bridge-connect";

// Unit coverage for the pairing-exchange error classifier (T0b②④). The server
// (internal/auth ExchangeBridgePairing) and the runtime wrapper (bridge/pairing.ts)
// throw plain strings; this proves each collapses to the right refined code + copy,
// and that unknown causes keep their raw message verbatim.
describe("classifyPairingError", () => {
  it("maps the server 'invalid pairing_code' verdict", () => {
    const r = classifyPairingError("invalid pairing_code");
    expect(r.code).toBe("pairing_invalid");
    expect(r.message).toContain("aifp_");
  });

  it("maps the server 'pairing_code already used' verdict", () => {
    const r = classifyPairingError("pairing_code already used");
    expect(r.code).toBe("pairing_used");
    expect(r.message.toLowerCase()).toContain("already used");
  });

  it("maps the server 'pairing_code expired' verdict", () => {
    const r = classifyPairingError("pairing_code expired");
    expect(r.code).toBe("pairing_expired");
    expect(r.message).toContain("10 minutes");
  });

  it("maps the non-JSON HTTP fallback ('pairing failed with HTTP 500') to network", () => {
    const r = classifyPairingError("pairing failed with HTTP 500");
    expect(r.code).toBe("pairing_network");
    expect(r.message.toLowerCase()).toContain("internet connection");
  });

  it.each([
    "fetch failed",
    "TypeError: fetch failed",
    "getaddrinfo ENOTFOUND aifight.ai",
    "request to https://aifight.ai/api/bridge/pair failed, reason: connect ECONNREFUSED",
    "socket hang up",
  ])("maps a raw fetch network exception (%s) to network", (msg) => {
    expect(classifyPairingError(msg).code).toBe("pairing_network");
  });

  it("keeps an unrecognized cause as pairing_failed with the raw message verbatim", () => {
    const raw = "the server returned an unsafe WebSocket URL (ws://aifight.ai/api/ws); refusing to pair";
    const r = classifyPairingError(raw);
    expect(r.code).toBe("pairing_failed");
    expect(r.message).toBe(raw);
  });

  it("keeps a response-parse failure as pairing_failed (raw preserved)", () => {
    const r = classifyPairingError("pairing response missing agent");
    expect(r.code).toBe("pairing_failed");
    expect(r.message).toBe("pairing response missing agent");
  });

  it("does not let a 'used' code leak into the expired/invalid buckets", () => {
    // 'already used' must win even though the phrase is close to other verdicts.
    expect(classifyPairingError("pairing_code already used").code).toBe("pairing_used");
  });
});
