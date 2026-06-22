// Generated-types consumption verification — the OTHER M0.5 followup.
// These tests exist to prove a runtime file can import a type from
// protocol/tools/generated/types.ts (via its runtime/src/protocol/
// copy) and the TypeScript compiler actually validates usage. The
// `npm run check-types` step in build.sh is the primary enforcement;
// this test is a runtime sanity-check that the shape of what we
// construct is also what validators accept.

import { describe, expect, it } from "vitest";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import type {
  MsgWelcome,
  MsgGameStart,
  MsgGameStartDataTexasHoldem,
  MsgGameOver,
  TexasHoldemRules,
} from "../src/protocol/types";
import { loadAllSchemas, loadSchema } from "../src/protocol/schemas";
import { hello, RUNTIME_VERSION } from "../src/index";

// Build one ajv instance with the full schema tree preloaded so that
// cross-file `$ref`s resolve (every game_over schema refs
// common/game_result + common/player_identity, etc).
function makeAjv(): Ajv {
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  for (const [id, schema] of loadAllSchemas()) {
    ajv.addSchema(schema as object, id);
  }
  return ajv;
}

function validatorFor(ajv: Ajv, messageType: string): ValidateFunction {
  const schema = loadSchema(messageType) as { $id: string };
  const v = ajv.getSchema(schema.$id);
  if (!v) throw new Error(`no validator compiled for ${messageType}`);
  return v as ValidateFunction;
}

describe("generated types consumption", () => {
  it("MsgWelcome constructed from types.ts validates against welcome schema", () => {
    const welcome: MsgWelcome = {
      type: "welcome",
      data: {
        server_protocol_version: "v1.0.0",
        agent_id: "aaaaaaaa-0000-0000-0000-000000000001",
        agent_name: "TypedBot",
        server_time: "2026-04-24T00:00:00Z",
        games: ["texas_holdem", "liars_dice", "coup"],
      },
    };
    const validate = validatorFor(makeAjv(), "welcome");
    expect(validate(welcome)).toBe(true);
  });

  it("MsgGameStart is a per-game discriminated union (M0.5 P2-3 regression guard)", () => {
    // This test exists because json-schema-to-typescript once collapsed
    // MsgGameStart.data into {[k]: any}. The M0 P2-3 fix made it a
    // per-game union; if that regresses in a future codegen change,
    // `data.game === "texas_holdem"` would not narrow and the types
    // below would stop compiling. That's the intended failure mode.
    const rules: TexasHoldemRules = {
      name: "No-Limit Texas Hold'em",
      summary: "Standard no-limit hold'em with blinds.",
      available_actions: {
        fold: "Fold",
        check: "Check",
        call: "Call",
        raise: "Raise",
        allin: "All-in",
      },
      key_rules: ["Best 5 of 7 wins.", "Dealer button rotates clockwise."],
    };
    const data: MsgGameStartDataTexasHoldem = {
      match_id: "bbbbbbbb-0000-0000-0000-000000000001",
      game: "texas_holdem",
      rules,
      config: null,
      your_position: 0,
      your_player_id: "p0",
      players: [],
    };
    const sample: MsgGameStart = { type: "game_start", data };

    // Narrow via discriminator; should reach the texas_holdem branch.
    if (sample.data.game === "texas_holdem") {
      expect(sample.data.config).toBeNull();
      expect(sample.data.rules.name).toBe("No-Limit Texas Hold'em");
    } else {
      throw new Error("sample should have narrowed to texas_holdem");
    }
  });

  it("MsgGameOver data has session_id + (real) match_id fields", () => {
    const over: MsgGameOver = {
      type: "game_over",
      data: {
        match_id: "cccccccc-0000-0000-0000-000000000001",
        session_id: "bbbbbbbb-0000-0000-0000-000000000001",
        result: { payoffs: { p0: 10, p1: 0 }, winner: "p0", is_draw: false },
        players: [
          {
            agent_id: "aaaaaaaa-0000-0000-0000-000000000002",
            agent_name: "A",
            player_id: "p0",
            position: 0,
          },
          {
            agent_id: "aaaaaaaa-0000-0000-0000-000000000003",
            agent_name: "B",
            player_id: "p1",
            position: 1,
          },
        ],
      },
    };
    const validate = validatorFor(makeAjv(), "game_over");
    expect(validate(over)).toBe(true);
  });
});

describe("runtime self-test", () => {
  it("hello() reports consistent state", () => {
    const r = hello();
    expect(r.ok).toBe(true);
    expect(r.runtimeVersion).toBe(RUNTIME_VERSION);
    expect(r.messageTypeCount).toBe(18);
    expect(r.schemaCount).toBeGreaterThanOrEqual(43);
  });

  it("RUNTIME_VERSION matches package.json", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      fs.readFileSync(path.join(here, "..", "package.json"), "utf8"),
    ) as { version: string };
    expect(RUNTIME_VERSION).toBe(pkg.version);
  });
});
