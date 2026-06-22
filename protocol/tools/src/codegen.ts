#!/usr/bin/env node
// codegen.ts — generate TypeScript types from protocol/schema/*.schema.json.
//
// Output: protocol/tools/generated/types.ts (single consolidated file).
// M1 / M2 (runtime, openclaw-plugin) will copy this file into their own
// package's src/protocol/types.ts — see P0-10.md "方案 A".
//
// Stability: the generator is deterministic given a fixed schema set.
// CI (P0-13) will `pnpm run codegen` and assert no diff against the
// committed generated file, so any schema edit must be accompanied by
// a regenerated types.ts commit.
//
// Usage:
//   codegen [--schema-root <path>] [--out <path>]
//
// Exit code: 0 ok / 1 failure / 2 cli / io error

import { compile, type Options } from "json-schema-to-typescript";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { walkSchemas } from "./schema-loader.ts";

function parseArgs(argv: string[]): { schemaRoot: string; outPath: string } {
  const args = argv.slice(2);
  const here = path.dirname(fileURLToPath(import.meta.url));
  let schemaRoot = path.resolve(here, "..", "..", "schema");
  let outPath = path.resolve(here, "..", "generated", "types.ts");
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--schema-root") schemaRoot = path.resolve(args[++i]);
    else if (a === "--out") outPath = path.resolve(args[++i]);
    else if (a === "--help" || a === "-h") {
      console.log("usage: codegen [--schema-root <path>] [--out <path>]");
      process.exit(0);
    } else {
      console.error(`unexpected argument: ${a}`);
      process.exit(2);
    }
  }
  return { schemaRoot, outPath };
}

/**
 * Derive a stable, PascalCase type name from a schema's $id. Pattern:
 *   https://aifight.ai/protocol/v1/<area>/<name>.schema.json
 * → <Area><Name> (path segments camelcased, joined).
 *
 * Examples:
 *   messages/server_welcome.schema.json   → MsgServerWelcome
 *   common/action.schema.json             → CommonAction
 *   games/texas_holdem/state.schema.json  → GameTexasHoldemState
 *   rest/register_request.schema.json     → RestRegisterRequest
 */
function typeNameFromId($id: string): string {
  const m = /^https:\/\/aifight\.ai\/protocol\/v1\/(.+)\.schema\.json$/.exec($id);
  if (!m) throw new Error(`unrecognized $id: ${$id}`);
  const parts = m[1].split("/");
  const pascal = (s: string) =>
    s.split(/[_-]/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
  const prefixMap: Record<string, string> = {
    messages: "Msg",
    common: "Common",
    games: "Game",
    rest: "Rest",
  };
  const area = parts[0];
  const prefix = prefixMap[area] ?? pascal(area);
  const rest = parts.slice(1).map(pascal).join("");
  return prefix + rest;
}

// renderMsgGameStart hand-composes the MsgGameStart type. The schema
// validates fine under ajv, but json-schema-to-typescript collapses
// the `data` object's `allOf + if/then` narrowing into
// `{[k: string]: any}`, deleting every typed field. This renderer
// yields a proper discriminated union on `data.game` that references
// the per-game `GameXxxRules` / `GameTexasHoldemConfig` types already
// generated from games/**/rules.schema.json upstream.
//
// The docstring is extracted from the schema so an edit to the schema's
// `description` surfaces verbatim in the generated interface.
function renderMsgGameStart(parsed: any): string {
  const doc = typeof parsed.description === "string" ? parsed.description : "";
  const commentLine =
    doc === "" ? "" : "\n/**\n" + doc.split("\n").map((l: string) => ` * ${l}`).join("\n") + "\n */\n";
  return (
    `export interface MsgGameStartDataPlayer {\n` +
    `  position: number;\n` +
    `  name: string;\n` +
    `  player_id: string;\n` +
    `}\n` +
    `\n` +
    `export interface MsgGameStartDataBase {\n` +
    `  match_id: string;\n` +
    `  your_position: number;\n` +
    `  your_player_id: string;\n` +
    `  players: MsgGameStartDataPlayer[];\n` +
    `  strategy_prompt?: string;\n` +
    `}\n` +
    `\n` +
    `export interface MsgGameStartDataTexasHoldem extends MsgGameStartDataBase {\n` +
    `  game: "texas_holdem";\n` +
    `  rules: TexasHoldemRules;\n` +
    `  config: TexasHoldemConfig | null;\n` +
    `}\n` +
    `\n` +
    `export interface MsgGameStartDataLiarsDice extends MsgGameStartDataBase {\n` +
    `  game: "liars_dice";\n` +
    `  rules: LiarsDiceRules;\n` +
    `  config: { [k: string]: unknown } | null;\n` +
    `}\n` +
    `\n` +
    `export interface MsgGameStartDataCoup extends MsgGameStartDataBase {\n` +
    `  game: "coup";\n` +
    `  rules: CoupRules;\n` +
    `  config: { [k: string]: unknown } | null;\n` +
    `}\n` +
    `\n` +
    `export type MsgGameStartData =\n` +
    `  | MsgGameStartDataTexasHoldem\n` +
    `  | MsgGameStartDataLiarsDice\n` +
    `  | MsgGameStartDataCoup;\n` +
    `${commentLine}` +
    `export interface MsgGameStart {\n` +
    `  type: "game_start";\n` +
    `  data: MsgGameStartData;\n` +
    `  match_id?: string;\n` +
    `}`
  );
}

async function main(): Promise<number> {
  const { schemaRoot, outPath } = parseArgs(process.argv);
  if (!fs.existsSync(schemaRoot)) {
    console.error(`schema root not found: ${schemaRoot}`);
    return 2;
  }

  const files = walkSchemas(schemaRoot).sort();

  const baseOpts: Partial<Options> = {
    bannerComment: "",
    style: { singleQuote: false, semi: true },
    declareExternallyReferenced: false,
    additionalProperties: false,
    $refOptions: {
      resolve: { external: true },
    },
    unknownAny: false,
  };

  const parts: string[] = [];
  parts.push(
    `// AUTO-GENERATED by protocol/tools/src/codegen.ts`,
    `// DO NOT EDIT this file by hand; run the codegen script to regenerate.`,
    `// Source: protocol/schema/**/*.schema.json  (see protocol/README.md)`,
    ``,
  );

  const pascalCase = (s: string) =>
    s
      .replace(/[^a-zA-Z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ""))
      .replace(/^(.)/, (m) => m.toUpperCase());

  // server_game_start.schema.json uses `allOf + if/then` to narrow
  // `rules` and `config` by `game`. json-schema-to-typescript degenerates
  // the conditional into `data: {[k: string]: any}`, losing all typing
  // on the single most important entry-point message for a runtime.
  // We compile it normally (so it still appears in the WSMessage union
  // and the emitted file stays self-contained) but replace its body with
  // a hand-composed discriminated union over the three games using the
  // per-game types that *are* generated correctly from games/**.
  const SERVER_GAME_START_REL = path.join("messages", "server_game_start.schema.json");

  for (const f of files) {
    const raw = fs.readFileSync(f, "utf8");
    const parsed = JSON.parse(raw);
    const id = parsed.$id as string;
    const name = typeNameFromId(id);
    const rel = path.relative(schemaRoot, f);

    // Rewrite the title so json-schema-to-typescript emits a unique type
    // name per schema. common/action.title == "Action" collides with
    // messages/client_action.title == "action" → both become `Action`
    // without disambiguation. Force messages/* to `Msg<Title>` and leave
    // other areas using the original title (which is already unique).
    const area = rel.split(path.sep)[0];
    if (area === "messages" && typeof parsed.title === "string") {
      parsed.title = "Msg" + pascalCase(parsed.title);
    }

    if (rel === SERVER_GAME_START_REL) {
      parts.push(`// ─── ${rel} (hand-composed per-game union; see codegen.ts) ───`);
      parts.push(renderMsgGameStart(parsed));
      parts.push("");
      continue;
    }

    let ts: string;
    try {
      // cwd must be the directory of THIS file so relative $refs like
      // "../common/action.schema.json" resolve from the schema's own
      // location, not from schemaRoot.
      ts = await compile(parsed, name, { ...baseOpts, cwd: path.dirname(f) });
    } catch (e: any) {
      console.error(`FAIL compile ${rel}: ${e.message}`);
      return 1;
    }
    parts.push(`// ─── ${rel} ───`);
    parts.push(ts.trim());
    parts.push("");
  }

  // Emit a discriminated union of all server→client + client→server message
  // envelopes, keyed on `type`. Names match the `Msg<Title>` rewrite above.
  //     function handle(msg: WSMessage) { switch (msg.type) { case "welcome": ... } }
  const msgTypeNames: string[] = [];
  for (const f of files) {
    const rel = path.relative(schemaRoot, f);
    const parts2 = rel.split(path.sep);
    if (parts2[0] !== "messages") continue;
    const parsed = JSON.parse(fs.readFileSync(f, "utf8"));
    const title = parsed.title;
    if (typeof title === "string" && title) {
      msgTypeNames.push("Msg" + pascalCase(title));
    }
  }
  if (msgTypeNames.length > 0) {
    parts.push(`// ─── Discriminated union of every WebSocket message envelope ───`);
    parts.push(`export type WSMessage = ${msgTypeNames.join(" | ")};`);
    parts.push("");
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, parts.join("\n"));

  console.log(
    `codegen: wrote ${outPath} (${files.length} schemas, ${msgTypeNames.length} message envelopes)`,
  );
  return 0;
}

main().then((c) => process.exit(c));
