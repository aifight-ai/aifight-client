import { afterAll, describe, expect, it } from "vitest";

import { localizeServerError } from "./errors";
import i18n from "./i18n";

// T0b②④ — the desktop "Connect an existing agent" flow runs the CLI with --json and
// surfaces the error envelope ({"error":{"code":..,"message":..}}) through
// localizeServerError. These lock the pairing-specific split (refined code OR raw
// server phrase) to the right localized key in BOTH languages, and confirm an
// unrecognized pairing_failed still falls back to the existing auth copy.

/** The exact stderr shape the CLI emits in --json mode (jsonErrorEnvelope). */
function envelope(code: string, message: string): string {
  return JSON.stringify({ error: { code, message } });
}

afterAll(async () => {
  await i18n.changeLanguage("en");
});

describe("localizeServerError — pairing split (EN)", () => {
  it("pairing_invalid envelope → errors.pairingInvalid", async () => {
    await i18n.changeLanguage("en");
    const out = localizeServerError(
      envelope("pairing_invalid", "Pairing failed: that pairing code wasn't recognized. Copy the entire code — including the aifp_ prefix — and try again."),
    );
    expect(out).toBe(i18n.t("errors.pairingInvalid"));
    expect(out).toContain("aifp_");
  });

  it("pairing_expired envelope → errors.pairingExpired", async () => {
    await i18n.changeLanguage("en");
    const out = localizeServerError(
      envelope("pairing_expired", "Pairing failed: that pairing code has expired. Pairing codes last 10 minutes — generate a fresh one on your Dashboard and use it right away."),
    );
    expect(out).toBe(i18n.t("errors.pairingExpired"));
    expect(out).toContain("10 minutes");
  });

  it("pairing_used envelope → errors.pairingUsed", async () => {
    await i18n.changeLanguage("en");
    const out = localizeServerError(envelope("pairing_used", "Pairing failed: that pairing code was already used. Each code works only once — generate a new one on your Dashboard."));
    expect(out).toBe(i18n.t("errors.pairingUsed"));
  });

  it("pairing_network envelope → errors.pairingNetwork", async () => {
    await i18n.changeLanguage("en");
    const out = localizeServerError(envelope("pairing_network", "Pairing failed: couldn't reach AIFight. Check your internet connection and try again."));
    expect(out).toBe(i18n.t("errors.pairingNetwork"));
  });

  it("recognizes a RAW server string too (old server / non-JSON path)", async () => {
    await i18n.changeLanguage("en");
    expect(localizeServerError("pairing_code expired")).toBe(i18n.t("errors.pairingExpired"));
    expect(localizeServerError("pairing_code already used")).toBe(i18n.t("errors.pairingUsed"));
    expect(localizeServerError("invalid pairing_code")).toBe(i18n.t("errors.pairingInvalid"));
    expect(localizeServerError("pairing failed with HTTP 500")).toBe(i18n.t("errors.pairingNetwork"));
  });

  it("an unrecognized pairing_failed falls back to the existing auth copy", async () => {
    await i18n.changeLanguage("en");
    const out = localizeServerError(
      envelope("pairing_failed", "the server returned an unsafe WebSocket URL (ws://aifight.ai/api/ws); refusing to pair"),
    );
    expect(out).toBe(i18n.t("errors.auth"));
  });

  it("a genuine (non-pairing) 401 still maps to errors.auth — not hijacked", async () => {
    await i18n.changeLanguage("en");
    expect(localizeServerError("unauthorized (401)")).toBe(i18n.t("errors.auth"));
  });
});

describe("localizeServerError — pairing split (ZH)", () => {
  it("pairing_expired → zh errors.pairingExpired", async () => {
    await i18n.changeLanguage("zh");
    const out = localizeServerError(envelope("pairing_expired", "Pairing failed: that pairing code has expired."));
    expect(out).toBe(i18n.t("errors.pairingExpired"));
    expect(out).toContain("10 分钟");
  });

  it("pairing_used → zh errors.pairingUsed", async () => {
    await i18n.changeLanguage("zh");
    expect(localizeServerError(envelope("pairing_used", "already used"))).toBe(i18n.t("errors.pairingUsed"));
  });

  it("pairing_invalid → zh errors.pairingInvalid (mentions aifp_)", async () => {
    await i18n.changeLanguage("zh");
    const out = localizeServerError(envelope("pairing_invalid", "invalid"));
    expect(out).toBe(i18n.t("errors.pairingInvalid"));
    expect(out).toContain("aifp_");
  });

  it("pairing_network → zh errors.pairingNetwork", async () => {
    await i18n.changeLanguage("zh");
    expect(localizeServerError(envelope("pairing_network", "network"))).toBe(i18n.t("errors.pairingNetwork"));
  });
});
