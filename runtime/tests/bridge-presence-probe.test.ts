// 重连重设计 2026-07-25 P3: the runner supplies the facade's ask-before-dial
// probe. These pin the URL derivation and the fail-to-null contract — a probe
// that throws or returns junk must read as "unavailable" (null), never as
// "seat free", because null keeps the facade on its cautious blind-dial
// cadence while a false "free" would authorize ripping a live holder off.

import { describe, test, expect } from "vitest";

import { presenceURLFromWSURL } from "../src/bridge/runner";

describe("presenceURLFromWSURL", () => {
  test("production shape", () => {
    expect(presenceURLFromWSURL("wss://aifight.ai/api/ws")).toBe(
      "https://aifight.ai/api/agents/me/presence",
    );
  });

  test("local dev shape keeps port and downgrades to http", () => {
    expect(presenceURLFromWSURL("ws://127.0.0.1:8080/api/ws")).toBe(
      "http://127.0.0.1:8080/api/agents/me/presence",
    );
  });

  test("query/hash are stripped", () => {
    expect(presenceURLFromWSURL("wss://aifight.ai/api/ws?x=1#y")).toBe(
      "https://aifight.ai/api/agents/me/presence",
    );
  });

  test("unexpected shapes → null (probe reports unavailable, not free)", () => {
    expect(presenceURLFromWSURL("not a url")).toBeNull();
    expect(presenceURLFromWSURL("https://aifight.ai/api/ws")).toBeNull(); // not a ws scheme
    expect(presenceURLFromWSURL("wss://aifight.ai/api/socket")).toBeNull(); // not */ws
  });
});
