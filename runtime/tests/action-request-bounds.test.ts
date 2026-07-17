// R13-F03: server_action_request.schema.json carries generous-but-finite bounds
// (maxProperties / maxItems / maxLength) so a buggy or hostile server can't push
// an unbounded object/array/string through the validator.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetFrameHandlerCache,
  initFrameHandler,
  parseServerFrame,
} from "../src/wsclient/frame-handler";
import { WSSchemaError } from "../src/wsclient/errors";
import { loadSchema } from "../src/protocol/schemas";

const MATCH_ID = "00000000-0000-4000-8000-000000000002";

function actionRequestFrame(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "action_request",
    data: {
      match_id: MATCH_ID,
      state: {},
      legal_actions: [],
      players: [],
      timeout_ms: 300000,
      new_events: [],
      request_id: "ffffffff-0000-0000-0000-000000000001",
      ...overrides,
    },
  });
}

beforeEach(() => {
  __resetFrameHandlerCache();
  initFrameHandler();
});

afterEach(() => {
  __resetFrameHandlerCache();
});

describe("action_request resource bounds (R13-F03)", () => {
  it("accepts a minimal valid action_request (control)", () => {
    const parsed = parseServerFrame(actionRequestFrame());
    expect(parsed.type).toBe("action_request");
  });

  it("rejects an EMPTY request_id string (minLength — the client could never produce the REQUIRED echo)", () => {
    const frame = actionRequestFrame({ request_id: "" });
    expect(() => parseServerFrame(frame)).toThrow(/action_request/);
  });

  it("rejects an over-length request_id string (maxLength)", () => {
    const frame = actionRequestFrame({ request_id: "r".repeat(200) });
    expect(() => parseServerFrame(frame)).toThrowError(WSSchemaError);
  });

  it("rejects an over-limit legal_actions array (maxItems)", () => {
    // 513 items > the 512 maxItems bound. Even if the items also fail item
    // validation, the frame is still rejected — the bound is enforced.
    const frame = actionRequestFrame({ legal_actions: Array.from({ length: 513 }, () => ({ type: "fold" })) });
    expect(() => parseServerFrame(frame)).toThrowError(WSSchemaError);
  });

  it("the schema declares the finite bounds", () => {
    const schema = loadSchema("action_request") as {
      properties: { data: { properties: Record<string, Record<string, unknown>> } };
    };
    const props = schema.properties.data.properties;
    expect(props.state.maxProperties).toBeTypeOf("number");
    expect(props.legal_actions.maxItems).toBeTypeOf("number");
    expect(props.new_events.maxItems).toBeTypeOf("number");
    expect(props.event_history.maxItems).toBeTypeOf("number");
    expect(props.players.maxItems).toBeTypeOf("number");
    expect(props.request_id.maxLength).toBeTypeOf("number");
  });
});
