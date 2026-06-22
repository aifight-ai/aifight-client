import { describe, expect, it } from "vitest";

import { formatPublicNo } from "../src/account/public-no";

describe("formatPublicNo", () => {
  it("groups a 10-digit id as 3-3-4", () => {
    expect(formatPublicNo(1024384756)).toBe("102-438-4756");
    expect(formatPublicNo(9999999999)).toBe("999-999-9999");
  });

  it("returns empty string for missing values", () => {
    expect(formatPublicNo(undefined)).toBe("");
    expect(formatPublicNo(null)).toBe("");
  });

  it("returns out-of-range values undecorated", () => {
    expect(formatPublicNo(0)).toBe("0");
    expect(formatPublicNo(42)).toBe("42");
  });
});
