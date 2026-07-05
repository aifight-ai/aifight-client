// The dashboard's pure decision helpers. The >threshold confirmation is the
// owner's token-burn guard rail — pin its boundary so a refactor can't silently
// widen what "needs a second confirmation" means.

import { describe, expect, it } from "vitest";

import { CAP_CONFIRM_THRESHOLD, capNeedsConfirm, divisionOf, fmtTimePoint, formatTokens } from "./views/PlayView";

describe("capNeedsConfirm", () => {
  it("threshold is 10 (change deliberately, with the CLI mirror)", () => {
    expect(CAP_CONFIRM_THRESHOLD).toBe(10);
  });
  it("0 / default / threshold pass without confirmation", () => {
    expect(capNeedsConfirm(0)).toBe(false);
    expect(capNeedsConfirm(2)).toBe(false);
    expect(capNeedsConfirm(10)).toBe(false);
  });
  it("above the threshold requires confirmation", () => {
    expect(capNeedsConfirm(11)).toBe(true);
    expect(capNeedsConfirm(50)).toBe(true);
  });
});

describe("formatTokens", () => {
  it("compacts large counts", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(412)).toBe("412");
    expect(formatTokens(41_200)).toBe("41.2k");
    expect(formatTokens(6_421_337)).toBe("6.4M");
    expect(formatTokens(2_100_000_000)).toBe("2.1B");
  });
});

describe("divisionOf", () => {
  it("mirrors the website ladder", () => {
    expect(divisionOf(null, 100)).toBe("provisional");
    expect(divisionOf(1700, 3)).toBe("provisional"); // <5 games
    expect(divisionOf(1400, 20)).toBe("bronze");
    expect(divisionOf(1500, 20)).toBe("silver");
    expect(divisionOf(1600, 20)).toBe("gold");
    expect(divisionOf(1700, 20)).toBe("diamond");
    expect(divisionOf(1800, 20)).toBe("master");
    expect(divisionOf(1950, 20)).toBe("champion");
  });
});

describe("fmtTimePoint", () => {
  const now = new Date("2026-07-02T20:00:00");
  it("same day → time only; same year → MM-DD + time; else full date", () => {
    expect(fmtTimePoint("2026-07-02T14:35:00", "en", now)).toBe("14:35");
    const juneFirst = fmtTimePoint("2026-06-01T09:05:00", "en", now);
    expect(juneFirst).toContain("09:05");
    expect(juneFirst).toMatch(/06|01/); // month-day present, locale-ordered
    expect(juneFirst).not.toContain("2026");
    expect(fmtTimePoint("2025-12-31T23:59:00", "en", now)).toContain("2025");
  });
  it("tolerates missing / broken timestamps", () => {
    expect(fmtTimePoint(undefined, "en", now)).toBe("");
    expect(fmtTimePoint("not-a-date", "en", now)).toBe("");
  });
});
