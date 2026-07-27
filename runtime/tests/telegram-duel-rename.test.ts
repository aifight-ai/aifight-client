// W6: challenges and renaming from the chat window, plus the token reader both
// the CLI and the bot share.

import { describe, expect, it } from "vitest";

import { extractChallengeToken, findChallengeTokenInText } from "../src/bridge/challenge-link";
import { createChallengeWatcher } from "../src/notify/telegram/challenge-watch";
import { createPanelHandler, type PanelRunner } from "../src/notify/telegram/panels";
import { defaultTelegramConfig } from "../src/notify/telegram/settings";
import { renderNotifyEvent } from "../src/notify/telegram/render";
import type { BridgeConfig, BridgeTelegramConfig } from "../src/bridge/config";
import type { TelegramApi, TelegramUpdate } from "../src/notify/telegram/api";

const CHAT = 4242;
const TOKEN = "dl_0123456789abcdef0123456789abcdef";

describe("challenge token reader", () => {
  it("takes a bare token or a challenge/duel URL", () => {
    expect(extractChallengeToken(TOKEN)).toBe(TOKEN);
    expect(extractChallengeToken(`  ${TOKEN}  `)).toBe(TOKEN);
    expect(extractChallengeToken(`https://aifight.ai/challenge/${TOKEN}`)).toBe(TOKEN);
    expect(extractChallengeToken(`https://aifight.ai/duel/${TOKEN}`)).toBe(TOKEN);
    expect(extractChallengeToken(`https://aifight.ai/challenge/${TOKEN.toUpperCase()}`)).toBe(TOKEN.toUpperCase());
  });

  it("rejects a forged or truncated token", () => {
    expect(extractChallengeToken("")).toBeNull();
    expect(extractChallengeToken("dl_short")).toBeNull();
    expect(extractChallengeToken("dl_0123456789abcdef0123456789abcdeZ")).toBeNull();
    expect(extractChallengeToken("https://aifight.ai/replay/abc")).toBeNull();
    expect(extractChallengeToken("https://evil.example/challenge/notatoken")).toBeNull();
    expect(extractChallengeToken("not a url at all")).toBeNull();
  });

  it("finds a link inside a forwarded sentence", () => {
    expect(findChallengeTokenInText(`beat this! https://aifight.ai/challenge/${TOKEN}`)).toBe(TOKEN);
    expect(findChallengeTokenInText(`(https://aifight.ai/challenge/${TOKEN})`)).toBe(TOKEN);
    expect(findChallengeTokenInText(`token is ${TOKEN}.`)).toBe(TOKEN);
    expect(findChallengeTokenInText("hello there")).toBeNull();
  });
});

// ── panel harness ────────────────────────────────────────────────────

interface Sent {
  readonly kind: "send" | "edit" | "answer";
  readonly text: string;
  readonly keyboard?: ReadonlyArray<ReadonlyArray<{ text: string; callback_data?: string; url?: string }>>;
}

function harness(opts: { fetchImpl?: typeof fetch; section?: Partial<BridgeTelegramConfig> } = {}) {
  const sent: Sent[] = [];
  const watched: Array<{ token: string; game: string }> = [];
  const renamed: string[] = [];
  let config: BridgeConfig = {
    version: 1,
    baseUrl: "https://aifight.ai",
    wsUrl: "wss://aifight.ai/api/ws",
    agentId: "agent-1",
    agentName: "PokerMind",
    apiKey: "sk-secret",
    runtimeType: "direct",
    runtimeLocalUrl: "direct://local",
    updatedAt: "2026-07-27T00:00:00.000Z",
  };
  let settings: BridgeTelegramConfig = { ...defaultTelegramConfig(CHAT), ...opts.section };

  const api = {
    sendMessage: async (p: { text: string; keyboard?: never }) => {
      sent.push({ kind: "send", text: p.text, ...(p.keyboard !== undefined ? { keyboard: p.keyboard } : {}) });
      return { message_id: sent.length, chat: { id: CHAT } };
    },
    editMessageText: async (p: { text: string; keyboard?: never }) => {
      sent.push({ kind: "edit", text: p.text, ...(p.keyboard !== undefined ? { keyboard: p.keyboard } : {}) });
    },
    answerCallbackQuery: async (p: { text?: string }) => {
      sent.push({ kind: "answer", text: p.text ?? "" });
    },
  } as unknown as TelegramApi;

  const runner: PanelRunner = {
    snapshot: () => ({ state: { phase: "idle" } }),
    connectionSnapshot: () => ({ state: "connected", connectedAt: Date.now() }),
    joinQueue: () => undefined,
    leaveQueue: () => undefined,
  };

  const handler = createPanelHandler({
    api,
    settings: () => settings,
    updateSettings: (next) => {
      settings = next;
    },
    config: () => config,
    updateConfig: (next) => {
      config = next;
    },
    runner,
    watchChallenge: (token, game) => watched.push({ token, game }),
    onRenamed: (name) => renamed.push(name),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  });

  return {
    handle: (u: TelegramUpdate) => handler.handleUpdate(u),
    sent,
    watched,
    renamed,
    config: () => config,
    buttons: () => {
      const last = [...sent].reverse().find((s) => s.keyboard !== undefined);
      return (last?.keyboard ?? []).flat().map((b) => b.callback_data ?? b.url ?? "");
    },
    lastText: () => [...sent].reverse().find((s) => s.kind !== "answer")?.text ?? "",
  };
}

function command(text: string): TelegramUpdate {
  return { update_id: 1, message: { message_id: 1, chat: { id: CHAT, type: "private" }, text } };
}

function tap(data: string): TelegramUpdate {
  return {
    update_id: 2,
    callback_query: {
      id: "cb",
      from: { id: CHAT },
      message: { message_id: 10, chat: { id: CHAT, type: "private" } },
      data,
    },
  };
}

function apiFetch(handlers: Record<string, () => Response>): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const text = String(url);
    const key = Object.keys(handlers).find((k) => text.includes(k));
    if (key === undefined) return new Response(JSON.stringify({ error: "unexpected call" }), { status: 500 });
    void init;
    return handlers[key]!();
  }) as unknown as typeof fetch;
}

describe("challenges from the chat", () => {
  it("creates one behind a confirmation and sends a forwardable message", async () => {
    const h = harness({
      fetchImpl: apiFetch({
        "/api/challenges": () =>
          new Response(JSON.stringify({ join_url: `https://aifight.ai/challenge/${TOKEN}` }), { status: 200 }),
      }),
    });

    await h.handle(command("/challenge"));
    expect(h.lastText()).toContain("challenge link");

    await h.handle(tap("v1:duel:ask_create:coup"));
    expect(h.lastText()).toContain("Create a Coup challenge link?");

    await h.handle(tap(h.buttons().find((b) => b.startsWith("v1:duel:create"))!));

    const share = h.sent.find((s) => s.text.includes("challenge/"));
    expect(share?.text).toContain(`https://aifight.ai/challenge/${TOKEN}`);
    expect(share?.text).toContain("one use");
    // ...and it is now watched so acceptance can be announced.
    expect(h.watched).toEqual([{ token: TOKEN, game: "coup" }]);
  });

  it("reports the server's refusal instead of pretending", async () => {
    const h = harness({
      fetchImpl: apiFetch({
        "/api/challenges": () => new Response(JSON.stringify({ error: "claim your agent first" }), { status: 403 }),
      }),
    });

    await h.handle(tap("v1:duel:ask_create:coup"));
    await h.handle(tap(h.buttons().find((b) => b.startsWith("v1:duel:create"))!));

    expect(h.lastText()).toContain("claim your agent first");
    expect(h.watched).toHaveLength(0);
  });

  it("offers to accept a link pasted into the chat", async () => {
    let accepted = "";
    const h = harness({
      fetchImpl: apiFetch({
        "/accept": () => {
          accepted = TOKEN;
          return new Response(JSON.stringify({ match_id: "m-1" }), { status: 200 });
        },
      }),
    });

    await h.handle(command(`a friend sent this: https://aifight.ai/challenge/${TOKEN}`));
    expect(h.lastText()).toContain("accept it?");
    expect(accepted).toBe(""); // nothing happened on the paste alone

    await h.handle(tap(h.buttons().find((b) => b.startsWith("v1:duel:accept"))!));

    expect(accepted).toBe(TOKEN);
    expect(h.lastText()).toContain("Accepted");
  });

  it("keeps the whole token inside Telegram's 64-byte callback limit", async () => {
    const h = harness();
    await h.handle(command(`https://aifight.ai/challenge/${TOKEN}`));
    const confirm = h.buttons().find((b) => b.startsWith("v1:duel:accept"))!;
    expect(confirm).toContain(TOKEN);
    expect(Buffer.byteLength(confirm, "utf8")).toBeLessThanOrEqual(64);
  });

  it("refuses a replayed accept button", async () => {
    let calls = 0;
    const h = harness({
      fetchImpl: apiFetch({
        "/accept": () => {
          calls += 1;
          return new Response(JSON.stringify({ match_id: "m-1" }), { status: 200 });
        },
      }),
    });

    await h.handle(command(TOKEN));
    const confirm = h.buttons().find((b) => b.startsWith("v1:duel:accept"))!;
    await h.handle(tap(confirm));
    await h.handle(tap(confirm));

    expect(calls).toBe(1);
  });

  it("passes the 425 hint through when the bridge is not online yet", async () => {
    const h = harness({
      fetchImpl: apiFetch({
        "/accept": () =>
          new Response(JSON.stringify({ error: "connect your WebSocket before calling accept" }), { status: 425 }),
      }),
    });

    await h.handle(command(TOKEN));
    await h.handle(tap(h.buttons().find((b) => b.startsWith("v1:duel:accept"))!));

    expect(h.lastText()).toContain("aifight service start");
  });
});

describe("rename from the chat", () => {
  const renameOk = () =>
    apiFetch({
      "/api/agents/me/name": () => new Response(JSON.stringify({ name: "Dark Knight", public_no: 42 }), { status: 200 }),
    });

  it("asks for the name, confirms it, then applies it", async () => {
    const h = harness({ fetchImpl: renameOk() });

    await h.handle(tap("v1:settings:ask_rename"));
    expect(h.lastText()).toContain("new display name");

    await h.handle(command("Dark Knight"));
    expect(h.lastText()).toContain("<b>Dark Knight</b>");

    await h.handle(tap(h.buttons().find((b) => b.startsWith("v1:settings:rename"))!));

    expect(h.config().agentName).toBe("Dark Knight");
    expect(h.renamed).toEqual(["Dark Knight"]);
    expect(h.lastText()).toContain("Display name is now Dark Knight");
  });

  it("rejects a name outside the server's own 2-50 character bounds", async () => {
    const h = harness({ fetchImpl: renameOk() });
    await h.handle(tap("v1:settings:ask_rename"));
    await h.handle(command("x"));
    expect(h.lastText()).toContain("2–50 characters");

    await h.handle(tap("v1:settings:ask_rename"));
    await h.handle(command("x".repeat(51)));
    expect(h.lastText()).toContain("2–50 characters");
    expect(h.config().agentName).toBe("PokerMind");
  });

  // Regression: the proposed name used to ride inside callback_data, which
  // Telegram caps at 64 bytes. A name the SERVER accepts (50 characters, or any
  // multi-byte one) blew that budget, the button could not be built, and the bot
  // answered a perfectly reasonable name with total silence.
  it("confirms a name too long to fit in a callback payload", async () => {
    const longName = "x".repeat(50);
    const h = harness({
      fetchImpl: apiFetch({
        "/api/agents/me/name": () => new Response(JSON.stringify({ name: longName }), { status: 200 }),
      }),
    });

    await h.handle(tap("v1:settings:ask_rename"));
    await h.handle(command(longName));
    const confirm = h.buttons().find((b) => b.startsWith("v1:settings:rename"));
    expect(confirm).toBeDefined();
    expect(Buffer.byteLength(confirm!, "utf8")).toBeLessThanOrEqual(64);

    await h.handle(tap(confirm!));
    expect(h.config().agentName).toBe(longName);
  });

  it("carries a name through that the codec's own separator would have split", async () => {
    const h = harness({
      fetchImpl: apiFetch({
        "/api/agents/me/name": () => new Response(JSON.stringify({ error: "name may only contain ASCII letters, numbers, spaces, periods, underscores, and hyphens" }), { status: 400 }),
      }),
    });

    await h.handle(tap("v1:settings:ask_rename"));
    await h.handle(command("Poker:Mind"));
    await h.handle(tap(h.buttons().find((b) => b.startsWith("v1:settings:rename"))!));

    // The server's refusal is the answer — not a button that quietly does nothing.
    expect(h.lastText()).toContain("ASCII letters");
    expect(h.config().agentName).toBe("PokerMind");
  });

  it("keeps the newest proposal when a stale confirm button is tapped", async () => {
    const h = harness({
      fetchImpl: apiFetch({
        "/api/agents/me/name": () => new Response(JSON.stringify({ name: "Second Name" }), { status: 200 }),
      }),
    });

    await h.handle(tap("v1:settings:ask_rename"));
    await h.handle(command("First Name"));
    const stale = h.buttons().find((b) => b.startsWith("v1:settings:rename"))!;

    await h.handle(tap("v1:settings:ask_rename"));
    await h.handle(command("Second Name"));
    const fresh = h.buttons().find((b) => b.startsWith("v1:settings:rename"))!;
    expect(fresh).not.toBe(stale);

    await h.handle(tap(stale));
    expect(h.config().agentName).toBe("PokerMind");

    await h.handle(tap(fresh));
    expect(h.config().agentName).toBe("Second Name");
  });

  it("surfaces a rename cooldown in the server's own words", async () => {
    const h = harness({
      fetchImpl: apiFetch({
        "/api/agents/me/name": () =>
          new Response(JSON.stringify({ error: "you can rename again in 3 days" }), { status: 429 }),
      }),
    });

    await h.handle(tap("v1:settings:ask_rename"));
    await h.handle(command("Dark Knight"));
    await h.handle(tap(h.buttons().find((b) => b.startsWith("v1:settings:rename"))!));

    expect(h.lastText()).toContain("rename again in 3 days");
    expect(h.config().agentName).toBe("PokerMind");
  });

  it("does not treat a name as a rename without the prompt", async () => {
    const h = harness({ fetchImpl: renameOk() });
    await h.handle(command("Dark Knight"));
    expect(h.config().agentName).toBe("PokerMind");
  });
});

// bridge.json is shared with the desktop app and the CLI, so a panel change has
// to write only the field it changed — merging a whole in-memory snapshot would
// revert whatever another client wrote in between.
describe("panel config writes are narrow", () => {
  it("saves only the fields the panel actually changed", async () => {
    const { startTelegramCompanion } = await import("../src/notify/telegram/companion");
    const writes: Array<Record<string, unknown>> = [];
    const api = {
      sendMessage: async () => ({ message_id: 1, chat: { id: CHAT } }),
      editMessageText: async () => undefined,
      answerCallbackQuery: async () => undefined,
    } as unknown as TelegramApi;

    const companion = startTelegramCompanion({
      config: {
        version: 1,
        baseUrl: "https://aifight.ai",
        wsUrl: "wss://aifight.ai/api/ws",
        agentId: "agent-1",
        agentName: "PokerMind",
        apiKey: "sk-secret",
        runtimeType: "direct",
        runtimeLocalUrl: "direct://local",
        autoDailyLimit: 2,
        telegramBotToken: "1234567:TEST",
        telegram: defaultTelegramConfig(CHAT),
        updatedAt: "2026-07-27T00:00:00.000Z",
      },
      apiFactory: () => api,
      poll: false,
      persistConfig: (next) => writes.push({ ...next }),
    });

    await companion!.handleUpdate(tap("v1:notify:results:daily"));
    await companion!.stop();

    expect(writes).toHaveLength(1);
    // The whole config is handed to the test seam, but agentName/autoDailyLimit
    // are untouched — only the telegram block moved.
    expect((writes[0]!.telegram as Record<string, unknown>).results).toBe("daily");
    expect(writes[0]!.agentName).toBe("PokerMind");
    expect(writes[0]!.autoDailyLimit).toBe(2);
  });
});

describe("challenge watcher", () => {
  interface Timer {
    fire: () => void;
  }

  function watcher(statuses: Array<Record<string, unknown> | null>) {
    const timers: Timer[] = [];
    const accepted: Array<{ game: string; guestName?: string }> = [];
    let i = 0;
    const fetchImpl = (async () => {
      const next = statuses[i++];
      if (next === null || next === undefined) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ duel: next }), { status: 200 });
    }) as unknown as typeof fetch;

    const w = createChallengeWatcher({
      baseUrl: "https://aifight.ai",
      fetchImpl,
      onAccepted: (info) => accepted.push(info),
      setTimer: (fn) => {
        const timer = { fire: fn };
        timers.push(timer);
        return { cancel: () => undefined };
      },
    });
    return { w, timers, accepted };
  }

  it("announces the acceptance, with the opponent's name", async () => {
    const h = watcher([
      { status: "pending" },
      { status: "in_match", game: "coup", guest_agent_name: "GPTShark" },
    ]);

    h.w.watch(TOKEN, "coup");
    h.timers[0]!.fire();
    await new Promise((r) => setTimeout(r, 5));
    expect(h.accepted).toHaveLength(0); // still pending, so it rescheduled

    h.timers[1]!.fire();
    await new Promise((r) => setTimeout(r, 5));

    expect(h.accepted).toEqual([{ game: "coup", guestName: "GPTShark" }]);
    expect(renderNotifyEvent("en", { kind: "challenge.accepted", game: "coup", guestName: "GPTShark" }, { agentName: "PokerMind" }).text)
      .toContain("GPTShark accepted your Coup challenge");
  });

  it("says nothing when the challenge simply expires", async () => {
    const h = watcher([{ status: "expired" }]);
    h.w.watch(TOKEN, "coup");
    h.timers[0]!.fire();
    await new Promise((r) => setTimeout(r, 5));
    expect(h.accepted).toHaveLength(0);
    expect(h.timers).toHaveLength(1); // ...and stops watching
  });

  it("keeps waiting through a failed check", async () => {
    const h = watcher([null, { status: "accepted", game: "coup" }]);
    h.w.watch(TOKEN, "coup");
    h.timers[0]!.fire();
    await new Promise((r) => setTimeout(r, 5));
    expect(h.timers).toHaveLength(2);

    h.timers[1]!.fire();
    await new Promise((r) => setTimeout(r, 5));
    expect(h.accepted).toEqual([{ game: "coup" }]);
  });

  it("watches one challenge once, and not too many at a time", () => {
    const h = watcher([]);
    h.w.watch(TOKEN, "coup");
    h.w.watch(TOKEN, "coup");
    expect(h.timers).toHaveLength(1);

    for (let i = 0; i < 10; i += 1) h.w.watch(`dl_${String(i).repeat(32).slice(0, 32)}`, "coup");
    expect(h.timers.length).toBeLessThanOrEqual(5);
  });

  it("drops everything on stop", () => {
    const h = watcher([{ status: "accepted" }]);
    h.w.watch(TOKEN, "coup");
    h.w.stop();
    h.timers[0]!.fire();
    expect(h.accepted).toHaveLength(0);
  });
});
