// runtime/tests/wsclient-frame-handler.test.ts
//
// M1-06 Step 3 — pure-function tests for the frame handler. No real
// WebSocket; no fixtures larger than what each case needs. Mirrors the
// "pure unit, no I/O" style of tests/account-registration.test.ts and
// tests/account-credentials.test.ts.
//
// Roy's required coverage (Step 3 spec):
//   1.  valid join_queue
//   2.  valid leave_queue without data
//   3.  valid action with match_id
//   4.  invalid outbound unknown type
//   5.  invalid outbound action missing match_id
//   6.  outbound server type welcome rejected
//   7.  valid inbound welcome
//   8.  valid inbound error
//   9.  Buffer frame parsed
//   10. malformed JSON rejected
//   11. unknown inbound type
//   12. known inbound type with invalid payload
//   13. inbound client type join_queue rejected

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  WSOutboundSchemaError,
  WSSchemaError,
  WSUnknownMessageError,
} from "../src/wsclient/errors";
import {
  __resetFrameHandlerCache,
  initFrameHandler,
  parseServerFrame,
  serializeClientMessage,
  type ServerMessageEnvelope,
} from "../src/wsclient/frame-handler";

// Stable fixture data — UUIDs and times use deterministic constants
// so failures point at the validator, not the fixture.
const AGENT_ID_UUID = "00000000-0000-4000-8000-000000000001";
const MATCH_ID_UUID = "00000000-0000-4000-8000-000000000002";
const SERVER_TIME_RFC3339 = "2026-04-25T13:58:00Z";

beforeEach(() => {
  // Defensive: ensure each test sees a fresh ajv. The singleton is
  // process-lifetime; resetting between tests keeps the suite robust
  // if a future addition mutates ajv state.
  __resetFrameHandlerCache();
  initFrameHandler();
});

afterEach(() => {
  __resetFrameHandlerCache();
});

// ─── Outbound (serializeClientMessage) ──────────────────────────────

describe("serializeClientMessage — outbound happy path", () => {
  it("case 1: valid join_queue serializes to a stable JSON string", () => {
    const out = serializeClientMessage({
      type: "join_queue",
      data: { game: "texas_holdem" },
    });
    expect(typeof out).toBe("string");
    const round = JSON.parse(out);
    expect(round).toEqual({
      type: "join_queue",
      data: { game: "texas_holdem" },
    });
  });

  it("case 2: valid leave_queue without data serializes (data is optional)", () => {
    const out = serializeClientMessage({ type: "leave_queue" });
    expect(typeof out).toBe("string");
    const round = JSON.parse(out);
    expect(round).toEqual({ type: "leave_queue" });
    // Sanity: did NOT inject a `data: null` or `data: undefined` field.
    expect("data" in round).toBe(false);
  });

  it("case 3: valid action with match_id serializes (match_id is REQUIRED uuid for action)", () => {
    const out = serializeClientMessage({
      type: "action",
      match_id: MATCH_ID_UUID,
      data: { type: "fold" },
      request_id: "ffffffff-0000-0000-0000-000000000001",
    });
    expect(typeof out).toBe("string");
    const round = JSON.parse(out);
    expect(round.type).toBe("action");
    expect(round.match_id).toBe(MATCH_ID_UUID);
    expect(round.data).toEqual({ type: "fold" });
    expect(round.request_id).toBe("ffffffff-0000-0000-0000-000000000001");
  });

  it("an action WITHOUT the request_id echo fails outbound schema validation (v1.2 enforcement 2026-07-16)", () => {
    expect(() =>
      serializeClientMessage({
        type: "action",
        match_id: MATCH_ID_UUID,
        data: { type: "fold" },
      } as never),
    ).toThrow(/action.*schema validation/);
  });

  it("action with usage metadata passes outbound schema validation (§7B-1, protocol v1.1)", () => {
    const out = serializeClientMessage({
      type: "action",
      match_id: MATCH_ID_UUID,
      data: { type: "fold" },
      request_id: "ffffffff-0000-0000-0000-000000000002",
      usage: {
        model: "claude-x",
        input_tokens: 1200,
        output_tokens: 80,
        reasoning_tokens: 512,
        cached_tokens: 900,
        cache_write_tokens: 30,
      },
    });
    const round = JSON.parse(out);
    expect(round.usage).toEqual({
      model: "claude-x",
      input_tokens: 1200,
      output_tokens: 80,
      reasoning_tokens: 512,
      cached_tokens: 900,
      cache_write_tokens: 30,
    });
  });

  it("action usage without a model name is rejected by outbound schema (guards forfeit risk)", () => {
    expect(() =>
      serializeClientMessage({
        type: "action",
        match_id: MATCH_ID_UUID,
        data: { type: "fold" },
        usage: { input_tokens: 10 },
      } as unknown as Parameters<typeof serializeClientMessage>[0]),
    ).toThrowError(WSOutboundSchemaError);
  });

  it("valid match_confirm with confirm_id serializes (sanity: covers the 4th client type)", () => {
    const out = serializeClientMessage({
      type: "match_confirm",
      data: { confirm_id: MATCH_ID_UUID },
    });
    const round = JSON.parse(out);
    expect(round.type).toBe("match_confirm");
    expect(round.data).toEqual({ confirm_id: MATCH_ID_UUID });
  });
});

describe("serializeClientMessage — outbound rejection", () => {
  it("case 4: unknown outbound type → WSOutboundSchemaError", () => {
    expect(() =>
      serializeClientMessage({
        type: "nonesuch",
        data: {},
      }),
    ).toThrowError(WSOutboundSchemaError);

    try {
      serializeClientMessage({ type: "nonesuch", data: {} });
    } catch (e) {
      expect(e).toBeInstanceOf(WSOutboundSchemaError);
      const err = e as WSOutboundSchemaError;
      expect(err.kind).toBe("outbound-schema");
      expect(err.messageType).toBe("nonesuch");
      // No ajv pass happened (we rejected before lookup), so ajvErrors
      // is empty — caller can distinguish "envelope-rejected before
      // schema run" from "ajv said no" by ajvErrors.length.
      expect(err.ajvErrors).toEqual([]);
      expect(err.message).toMatch(/unknown client message type/);
    }
  });

  it("case 5: action envelope missing match_id → WSOutboundSchemaError with ajv errors", () => {
    expect(() =>
      // Cast to bypass TS — we're simulating a runtime caller that
      // built an envelope from untyped JSON.
      serializeClientMessage({
        type: "action",
        data: { type: "fold" },
      } as unknown as Parameters<typeof serializeClientMessage>[0]),
    ).toThrowError(WSOutboundSchemaError);

    try {
      serializeClientMessage({
        type: "action",
        data: { type: "fold" },
      } as unknown as Parameters<typeof serializeClientMessage>[0]);
    } catch (e) {
      expect(e).toBeInstanceOf(WSOutboundSchemaError);
      const err = e as WSOutboundSchemaError;
      expect(err.messageType).toBe("action");
      // ajv must have surfaced at least one error pointing at the
      // missing required field.
      expect(err.ajvErrors.length).toBeGreaterThan(0);
      const joined = err.ajvErrors
        .map((a) => `${a.instancePath} ${a.message ?? ""}`)
        .join(" | ");
      expect(joined).toMatch(/match_id/);
    }
  });

  it("case 6: outbound server-only type 'welcome' rejected before ajv runs", () => {
    expect(() =>
      serializeClientMessage({
        type: "welcome",
        data: {
          server_protocol_version: "1.0.0",
          agent_id: AGENT_ID_UUID,
          agent_name: "test-bot",
          server_time: SERVER_TIME_RFC3339,
          games: ["texas_holdem"],
        },
      } as unknown as Parameters<typeof serializeClientMessage>[0]),
    ).toThrowError(WSOutboundSchemaError);

    try {
      serializeClientMessage({
        type: "welcome",
        data: {},
      } as unknown as Parameters<typeof serializeClientMessage>[0]);
    } catch (e) {
      expect(e).toBeInstanceOf(WSOutboundSchemaError);
      const err = e as WSOutboundSchemaError;
      expect(err.kind).toBe("outbound-schema");
      expect(err.messageType).toBe("welcome");
      expect(err.message).toMatch(/server-only message type/);
    }
  });
});

// ─── Inbound (parseServerFrame) ─────────────────────────────────────

describe("parseServerFrame — inbound happy path", () => {
  it("case 7: valid welcome parses round-trip", () => {
    const frame = JSON.stringify({
      type: "welcome",
      data: {
        server_protocol_version: "1.0.0",
        agent_id: AGENT_ID_UUID,
        agent_name: "test-bot",
        server_time: SERVER_TIME_RFC3339,
        games: ["texas_holdem", "liars_dice"],
      },
    });
    const parsed = parseServerFrame(frame);
    expect(parsed.type).toBe("welcome");
    const data = parsed.data as Record<string, unknown>;
    expect(data.server_protocol_version).toBe("1.0.0");
    expect(data.agent_id).toBe(AGENT_ID_UUID);
    expect(data.games).toEqual(["texas_holdem", "liars_dice"]);
  });

  it("case 8: valid error parses round-trip", () => {
    const frame = JSON.stringify({
      type: "error",
      data: { message: "matchmaking gate denied: daily limit reached" },
    });
    const parsed = parseServerFrame(frame);
    expect(parsed.type).toBe("error");
    const data = parsed.data as { message: string };
    expect(data.message).toMatch(/daily limit reached/);
  });

  it("case 9: Buffer frame parses identically to string", () => {
    const obj = {
      type: "welcome",
      data: {
        server_protocol_version: "1.0.0",
        agent_id: AGENT_ID_UUID,
        agent_name: "test-bot",
        server_time: SERVER_TIME_RFC3339,
        games: ["coup"],
      },
    };
    const fromString = parseServerFrame(JSON.stringify(obj));
    const fromBuffer = parseServerFrame(Buffer.from(JSON.stringify(obj), "utf8"));
    // Same envelope; both must succeed and parse to deep-equal data.
    expect(fromBuffer).toEqual(fromString);
    expect(fromBuffer.type).toBe("welcome");
    const data = fromBuffer.data as Record<string, unknown>;
    expect(data.games).toEqual(["coup"]);
  });
});

describe("parseServerFrame — inbound rejection", () => {
  it("case 10: malformed JSON → WSSchemaError(messageType=<unknown>)", () => {
    expect(() => parseServerFrame("not json {")).toThrowError(WSSchemaError);

    try {
      parseServerFrame("not json {");
    } catch (e) {
      expect(e).toBeInstanceOf(WSSchemaError);
      const err = e as WSSchemaError;
      expect(err.kind).toBe("schema");
      expect(err.messageType).toBe("<unknown>");
      expect(err.ajvErrors).toEqual([]);
      expect(err.message).toMatch(/malformed JSON/);
    }
  });

  it("non-object JSON (e.g. plain number) → WSSchemaError(messageType=<unknown>)", () => {
    expect(() => parseServerFrame("42")).toThrowError(WSSchemaError);
    try {
      parseServerFrame("42");
    } catch (e) {
      expect((e as WSSchemaError).messageType).toBe("<unknown>");
      expect((e as WSSchemaError).message).toMatch(/must be a JSON object/);
    }
  });

  it("missing `type` field → WSSchemaError(messageType=<unknown>)", () => {
    expect(() =>
      parseServerFrame(JSON.stringify({ data: {} })),
    ).toThrowError(WSSchemaError);
    try {
      parseServerFrame(JSON.stringify({ data: {} }));
    } catch (e) {
      expect((e as WSSchemaError).messageType).toBe("<unknown>");
      expect((e as WSSchemaError).message).toMatch(/string `type` field/);
    }
  });

  it("case 11: unknown inbound type → WSUnknownMessageError", () => {
    expect(() =>
      parseServerFrame(JSON.stringify({ type: "nonesuch", data: {} })),
    ).toThrowError(WSUnknownMessageError);

    try {
      parseServerFrame(JSON.stringify({ type: "nonesuch", data: {} }));
    } catch (e) {
      expect(e).toBeInstanceOf(WSUnknownMessageError);
      const err = e as WSUnknownMessageError;
      expect(err.kind).toBe("unknown-message");
      expect(err.messageType).toBe("nonesuch");
      expect(err.message).toMatch(/unknown server message type/);
    }
  });

  it("case 12: known inbound type with invalid payload → WSSchemaError with ajv errors", () => {
    // welcome but missing required fields (agent_id / agent_name / etc.)
    const frame = JSON.stringify({
      type: "welcome",
      data: { server_protocol_version: "1.0.0" /* missing rest */ },
    });
    expect(() => parseServerFrame(frame)).toThrowError(WSSchemaError);

    try {
      parseServerFrame(frame);
    } catch (e) {
      expect(e).toBeInstanceOf(WSSchemaError);
      const err = e as WSSchemaError;
      expect(err.kind).toBe("schema");
      expect(err.messageType).toBe("welcome");
      // ajv must surface at least one missing-required error.
      expect(err.ajvErrors.length).toBeGreaterThan(0);
      const joined = err.ajvErrors
        .map((a) => `${a.instancePath} ${a.message ?? ""}`)
        .join(" | ");
      // The schema requires agent_id / agent_name / server_time / games;
      // ajv reports the first missing one.
      expect(joined).toMatch(/agent_id|agent_name|server_time|games/);
    }
  });

  it("case 13: inbound client-only type 'join_queue' → WSUnknownMessageError (not allowed on inbound)", () => {
    expect(() =>
      parseServerFrame(
        JSON.stringify({ type: "join_queue", data: { game: "texas_holdem" } }),
      ),
    ).toThrowError(WSUnknownMessageError);

    try {
      parseServerFrame(
        JSON.stringify({ type: "join_queue", data: { game: "texas_holdem" } }),
      );
    } catch (e) {
      expect(e).toBeInstanceOf(WSUnknownMessageError);
      const err = e as WSUnknownMessageError;
      expect(err.messageType).toBe("join_queue");
      expect(err.message).toMatch(/client-only message type/);
    }
  });
});

// ─── Sanity: type-level shape ───────────────────────────────────────

describe("type-level surface", () => {
  it("ServerMessageEnvelope is structurally what parseServerFrame returns", () => {
    const frame = JSON.stringify({
      type: "error",
      data: { message: "test" },
    });
    const parsed: ServerMessageEnvelope = parseServerFrame(frame);
    // Compile-time and runtime: type / data / optional match_id present.
    expect(parsed.type).toBe("error");
    expect(parsed.data).toEqual({ message: "test" });
    // match_id absent on error in this fixture; should be undefined,
    // not throw on access.
    expect(parsed.match_id).toBeUndefined();
  });
});
