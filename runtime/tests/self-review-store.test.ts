import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { LocalMatchSessionStore } from "../src/session/local-match-session-store";
import type { BridgeConfig } from "../src/bridge/config";
import type { MsgGameStart } from "../src/protocol/types";

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aifight-selfreview-store-"));
}

function bridgeConfig(): BridgeConfig {
  return {
    version: 1,
    baseUrl: "https://aifight.ai",
    wsUrl: "wss://aifight.ai/api/ws",
    agentId: "agent-1",
    agentName: "alpha",
    apiKey: "sk-local",
    runtimeType: "direct",
    runtimeLocalUrl: "direct://local",
    updatedAt: "2026-06-18T00:00:00.000Z",
  };
}

function gameStart(): MsgGameStart {
  return {
    type: "game_start",
    data: {
      match_id: "session-1",
      game: "coup",
      your_player_id: "p0",
      your_position: 0,
      players: [],
      rules: {},
      config: {},
    },
  } as unknown as MsgGameStart;
}

describe("LocalMatchSessionStore self-review round-trip", () => {
  it("writes, reads, exports the review and stamps self_review_at", () => {
    const home = tempHome();
    const store = new LocalMatchSessionStore({ runtimeHome: home, now: () => new Date("2026-06-18T01:00:00.000Z") });
    store.recordServerMessage(bridgeConfig(), gameStart());

    expect(store.readSelfReview("session-1")).toBeNull();

    const review = { schema: 1, report_text: "Solid play.", suggestion: null };
    expect(store.writeSelfReview("session-1", review)).toBe(true);

    expect(store.readSelfReview("session-1")).toMatchObject({ report_text: "Solid play." });

    const exported = store.exportSession("session-1");
    expect(exported?.selfReview).toMatchObject({ report_text: "Solid play." });

    const item = store.getSession("session-1");
    expect(item?.self_review_at).toBe("2026-06-18T01:00:00.000Z");
  });

  it("returns false when the session is unknown", () => {
    const home = tempHome();
    const store = new LocalMatchSessionStore({ runtimeHome: home });
    expect(store.writeSelfReview("missing", { schema: 1 })).toBe(false);
    expect(store.readSelfReview("missing")).toBeNull();
  });
});
