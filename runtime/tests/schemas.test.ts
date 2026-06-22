// Schema-bundling verification — the single highest-risk thing
// M0.5 left unchecked. These tests exist to prove M1-01's asset
// layout actually works before we start building the rest of M1.

import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import {
  findSchemasRoot,
  loadAllSchemas,
  loadSchema,
  messageTypes,
} from "../src/protocol/schemas";

describe("schemas loader", () => {
  it("resolves a valid schemas root", () => {
    const root = findSchemasRoot();
    expect(root).toMatch(/protocol\/schema$|dist\/schemas$/);
  });

  it("exposes exactly 18 message types", () => {
    const types = messageTypes();
    expect(types).toHaveLength(18);
    expect(types).toContain("welcome");
    expect(types).toContain("game_over");
    expect(types).toContain("action");
    expect(types).toContain("action_stale");
    expect(types).toContain("readiness_check");
    expect(types).toContain("runtime_status");
  });

  it("loadSchema returns a parseable schema for every message type", () => {
    for (const t of messageTypes()) {
      const s = loadSchema(t) as { title?: unknown; type?: unknown };
      expect(typeof s).toBe("object");
      expect(s).not.toBeNull();
      // Every committed message schema has a "type": "object" at the
      // envelope level (it's the JSON object that goes on the wire).
      expect(s.type).toBe("object");
    }
  });

  it("loadSchema throws on unknown type", () => {
    expect(() => loadSchema("not_a_message_type")).toThrow(/unknown message type/);
  });

  it("loadAllSchemas returns ≥43 committed schemas", () => {
    const all = loadAllSchemas();
    // plan §4.8 exit criterion: ≥25 schemas; current = 43.
    expect(all.size).toBeGreaterThanOrEqual(43);
  });

  it("every loaded schema has a canonical $id prefix", () => {
    const all = loadAllSchemas();
    for (const id of all.keys()) {
      expect(id).toMatch(/^https:\/\/aifight\.ai\/protocol\/v1\//);
    }
  });

  it("ajv can compile every loaded schema with cross-file refs resolved", () => {
    // End-to-end: register every schema by $id with ajv, then compile each.
    // If asset bundling is broken (missing file, wrong path, truncated
    // copy), this fails loudly here instead of silently at runtime.
    const ajv = new Ajv({ strict: false });
    addFormats(ajv);
    const all = loadAllSchemas();
    for (const [id, schema] of all) {
      ajv.addSchema(schema as object, id);
    }
    // Trigger compilation for every message-type schema. Cross-refs to
    // common/**, games/** resolve via the preloaded ajv instance.
    for (const t of messageTypes()) {
      const s = loadSchema(t) as { $id?: string };
      expect(s.$id).toBeTypeOf("string");
      expect(() => ajv.getSchema(s.$id!) ?? ajv.compile(s as object)).not.toThrow();
    }
  });

  it("welcome validator accepts a real welcome payload shape", () => {
    const ajv = new Ajv({ strict: false });
    addFormats(ajv);
    const welcome = loadSchema("welcome") as object;
    const validate = ajv.compile(welcome);
    const sample = {
      type: "welcome",
      data: {
        server_protocol_version: "v1.0.0",
        agent_id: "aaaaaaaa-0000-0000-0000-000000000001",
        agent_name: "TestBot",
        server_time: "2026-04-24T00:00:00Z",
        games: ["texas_holdem"],
      },
    };
    expect(validate(sample)).toBe(true);
  });
});
