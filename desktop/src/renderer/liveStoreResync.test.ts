// Renderer-reload resync (owner report 2026-08-03): a reload mid-match loses
// the reducer's game_start, after which every live frame is ignored and 观战
// falls back to demo while the match keeps running in the main process. The
// store now re-seeds itself from main's cached game_start (getLiveMatchSnapshot)
// and lets the armed feed poll catch the board up. These tests drive the store
// with a fake preload bridge.

import { beforeEach, describe, expect, it } from "vitest";

import { __resetLiveStoreForTest, ensureLiveStoreStarted, getLiveStoreState } from "./liveStore";
import type { AifightBridgeApi, MatchEventsPayload, ServerMessage } from "../shared/ipc";

type ServerListener = (msg: ServerMessage) => void;
type FeedListener = (payload: MatchEventsPayload) => void;

function gameStart(sessionId: string): ServerMessage {
  return {
    type: "game_start",
    data: {
      game: "texas_holdem",
      match_id: sessionId,
      your_player_id: "p0",
      players: [
        { player_id: "p0", name: "Player 1", position: 0 },
        { player_id: "p1", name: "Player 2", position: 1 },
      ],
    },
  };
}

/**
 * A minimal fake preload bridge. `snapshot === undefined` models an OLDER
 * preload with no getLiveMatchSnapshot at all (the degrade-quietly path);
 * null models "no live match".
 */
function fakeBridge(snapshot: ServerMessage | null | undefined): {
  api: AifightBridgeApi;
  server: ServerListener[];
  feed: FeedListener[];
} {
  const server: ServerListener[] = [];
  const feed: FeedListener[] = [];
  const api = {
    onServerMessage: (l: ServerListener) => {
      server.push(l);
      return () => {};
    },
    onTrace: () => () => {},
    onMatchEvents: (l: FeedListener) => {
      feed.push(l);
      return () => {};
    },
    ...(snapshot === undefined
      ? {}
      : { getLiveMatchSnapshot: () => Promise.resolve(snapshot) }),
  } as unknown as AifightBridgeApi;
  return { api, server, feed };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  __resetLiveStoreForTest();
});

describe("liveStore renderer-reload resync", () => {
  it("re-seeds the live match from main's cached game_start, then merges the feed", async () => {
    const { api, feed } = fakeBridge(gameStart("sess-1"));
    ensureLiveStoreStarted(api);
    await flush();

    expect(getLiveStoreState().match.sessionId).toBe("sess-1");
    expect(getLiveStoreState().match.match?.game).toBe("texas_holdem");

    // The armed poller's next full-history page rebuilds the board.
    feed[0]?.({
      sessionId: "sess-1",
      events: [{ type: "new_hand", seq: 1, data: {} } as never],
    });
    expect(getLiveStoreState().match.events.length).toBe(1);
  });

  it("lets a live game_start win the race against the snapshot", async () => {
    const { api, server } = fakeBridge(gameStart("stale-session"));
    ensureLiveStoreStarted(api);
    // A fresh match starts before the snapshot promise resolves — the live
    // stream is authoritative and the stale snapshot must be dropped.
    server[0]?.(gameStart("fresh-session"));
    await flush();

    expect(getLiveStoreState().match.sessionId).toBe("fresh-session");
  });

  it("stays empty when main reports no live match", async () => {
    const { api } = fakeBridge(null);
    ensureLiveStoreStarted(api);
    await flush();

    expect(getLiveStoreState().match.sessionId).toBeNull();
  });

  it("degrades quietly on an older preload without the snapshot API", async () => {
    const { api } = fakeBridge(undefined);
    ensureLiveStoreStarted(api);
    await flush();

    expect(getLiveStoreState().match.sessionId).toBeNull();
  });
});
