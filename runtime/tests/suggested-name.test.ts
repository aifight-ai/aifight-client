import { describe, expect, it } from "vitest";

import {
  _ADJECTIVES,
  _NOUNS,
  _isCleanWord,
  generateSuggestedName,
} from "../src/account/suggested-name";

describe("generateSuggestedName", () => {
  it("every adjective+noun combination is a valid, clean display name", () => {
    for (const adj of _ADJECTIVES) {
      for (const noun of _NOUNS) {
        const name = `${adj} ${noun}`;
        expect(name.length, name).toBeGreaterThanOrEqual(2);
        expect(name.length, name).toBeLessThanOrEqual(50);
        // ASCII letters + single internal space only (server charset rule).
        expect(name, name).toMatch(/^[A-Za-z]+ [A-Za-z]+$/);
        expect(_isCleanWord(name), `not clean: ${name}`).toBe(true);
      }
    }
  });

  it("produces 'Adjective Noun' from the curated lists", () => {
    // deterministic rand → first adjective + first noun
    const name = generateSuggestedName(() => 0);
    expect(name).toBe(`${_ADJECTIVES[0]} ${_NOUNS[0]}`);
  });

  it("returns varied names across calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateSuggestedName());
    // 10⁴ space → 200 draws should yield many distinct names.
    expect(seen.size).toBeGreaterThan(100);
  });
});
