// fetchReplayTail pages the public frames API of a FINISHED match. The paging
// contract mirrors the server: `from` is a ROW offset, pages are capped at 25,
// has_more says rows remain, and the public replay budget refills ~1 req/s —
// so a 429 pauses once and retries the same page.

import { describe, expect, it } from "vitest";

import { fetchReplayTail, replayIDFromPath } from "./replay-tail";

type Page = { status?: number; body?: unknown };

function fakeFetch(pages: Record<string, Page>, log: string[] = []) {
  return (url: string) => {
    log.push(url);
    const u = new URL(url);
    const key = `${u.searchParams.get("from")}`;
    const page = pages[key] ?? { status: 404 };
    return Promise.resolve({
      ok: (page.status ?? 200) >= 200 && (page.status ?? 200) < 300,
      status: page.status ?? 200,
      json: () => Promise.resolve(page.body),
    });
  };
}

describe("replayIDFromPath", () => {
  it("extracts the public id from the replay path, dropping query/hash", () => {
    expect(replayIDFromPath("/replay/replay_abc")).toBe("replay_abc");
    expect(replayIDFromPath("/replay/replay_abc?step=141")).toBe("replay_abc");
    expect(replayIDFromPath("replay_abc")).toBe("replay_abc");
    expect(replayIDFromPath("")).toBeNull();
    expect(replayIDFromPath("/")).toBeNull();
  });
});

describe("fetchReplayTail", () => {
  it("pages until has_more=false and concatenates all frames", async () => {
    const frames = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => ({ seq: a + i, type: "e" }));
    const log: string[] = [];
    const out = await fetchReplayTail(
      "https://x.test",
      "/replay/replay_abc",
      fakeFetch(
        {
          "0": { body: { frames: frames(0, 25), has_more: true } },
          "25": { body: { frames: frames(25, 41), has_more: false } },
        },
        log,
      ),
      0,
    );
    expect(out).toHaveLength(41);
    expect(out![40]!.seq).toBe(40);
    expect(log).toHaveLength(2);
    expect(log[0]).toContain("/api/replays/replay_abc/frames?from=0&limit=25");
  });

  it("retries the same page once on 429, then succeeds", async () => {
    let served429 = false;
    const impl = (url: string) => {
      const u = new URL(url);
      if (u.searchParams.get("from") === "0" && !served429) {
        served429 = true;
        return Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({}) });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ frames: [{ seq: 0, type: "e" }], has_more: false }),
      });
    };
    const out = await fetchReplayTail("https://x.test", "/replay/replay_abc", impl, 0);
    expect(out).toHaveLength(1);
  });

  it("gives up (null) on a second consecutive 429 rather than hammering", async () => {
    const impl = () => Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({}) });
    expect(await fetchReplayTail("https://x.test", "/replay/replay_abc", impl, 0)).toBeNull();
  });

  it("returns null on a hard error status or malformed body", async () => {
    expect(
      await fetchReplayTail("https://x.test", "/replay/gone", fakeFetch({ "0": { status: 404 } }), 0),
    ).toBeNull();
    expect(
      await fetchReplayTail(
        "https://x.test",
        "/replay/replay_abc",
        fakeFetch({ "0": { body: { nope: true } } }),
        0,
      ),
    ).toBeNull();
  });

  it("skips a fully-sanitized (empty) page instead of terminating early", async () => {
    const out = await fetchReplayTail(
      "https://x.test",
      "/replay/replay_abc",
      fakeFetch({
        "0": { body: { frames: [], has_more: true } }, // whole window dropped by sanitize
        "25": { body: { frames: [{ seq: 30, type: "e" }], has_more: false } },
      }),
      0,
    );
    expect(out).toHaveLength(1);
    expect(out![0]!.seq).toBe(30);
  });
});
