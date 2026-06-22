#!/usr/bin/env node
// validate-transcript.ts — validate one or more JSONL transcripts
// against protocol/schema/messages/*.schema.json.
//
// Usage:
//   validate-transcript [--schema-root <path>] <file.jsonl> [<file2.jsonl> ...]
//
// Exit code:
//   0  all messages valid
//   1  at least one transcript has at least one invalid message
//   2  cli / io / schema-load error

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchemas } from "./schema-loader.ts";

interface TranscriptEntry {
  timestamp_ms: number;
  direction: "server_to_client" | "client_to_server";
  actor: string;
  match_id?: string;
  payload: { type: string; [k: string]: unknown };
}

function parseArgs(argv: string[]): { schemaRoot: string; files: string[] } {
  const args = argv.slice(2);
  // Default schema-root: two levels up from this file (protocol/tools/src → protocol/schema)
  const here = path.dirname(fileURLToPath(import.meta.url));
  let schemaRoot = path.resolve(here, "..", "..", "schema");
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--schema-root") {
      schemaRoot = path.resolve(args[++i]);
    } else if (a === "--help" || a === "-h") {
      console.log("usage: validate-transcript [--schema-root <path>] <file.jsonl> [...]");
      process.exit(0);
    } else {
      files.push(a);
    }
  }
  if (files.length === 0) {
    console.error("error: no transcript files given");
    console.error("usage: validate-transcript [--schema-root <path>] <file.jsonl> [...]");
    process.exit(2);
  }
  return { schemaRoot, files };
}

// deriveMatchIDFromPayload mirrors internal/hub/transcript.go
// extractMatchID for the subset of fields anonymized transcripts carry.
// Returns "" when nothing can be extracted.
function deriveMatchIDFromPayload(type: string, payload: { [k: string]: unknown }): string {
  const data = (payload as { data?: unknown }).data;
  // For game_over the server prefers data.session_id for routing, and
  // the golden corpus follows the same convention.
  if (type === "game_over" && data && typeof data === "object") {
    const s = (data as { session_id?: unknown }).session_id;
    if (typeof s === "string" && s !== "") return s;
  }
  // Envelope-level match_id (present on c2s action, absent on s2c).
  const env = (payload as { match_id?: unknown }).match_id;
  if (typeof env === "string" && env !== "") return env;
  // data.match_id (present on s2c game_start / action_request / etc).
  if (data && typeof data === "object") {
    const d = (data as { match_id?: unknown }).match_id;
    if (typeof d === "string" && d !== "") return d;
  }
  return "";
}

function validateFile(
  file: string,
  schemas: ReturnType<typeof loadSchemas>,
): { pass: number; fail: number; errors: string[] } {
  const errors: string[] = [];
  let pass = 0;
  let fail = 0;

  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const lineNo = i + 1;

    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch (e: any) {
      fail++;
      errors.push(`  line ${lineNo}: malformed JSONL entry: ${e.message}`);
      continue;
    }

    const payload = entry.payload;
    if (!payload || typeof payload !== "object") {
      fail++;
      errors.push(`  line ${lineNo}: entry.payload missing or not an object`);
      continue;
    }
    const type = payload.type;
    if (typeof type !== "string") {
      fail++;
      errors.push(`  line ${lineNo}: payload.type missing or not a string`);
      continue;
    }
    const schemaId = schemas.messageTypeToId.get(type);
    if (!schemaId) {
      fail++;
      errors.push(`  line ${lineNo}: no schema registered for message type=${type}`);
      continue;
    }
    const validate = schemas.getValidator(schemaId);
    if (!validate(payload)) {
      fail++;
      const errs = (validate.errors || []).slice(0, 3).map(
        (e) => `${e.instancePath || "<root>"} ${e.message} (${e.keyword})`,
      );
      errors.push(`  line ${lineNo} (${type}): ${errs.join("; ")}`);
      continue;
    }

    // TranscriptEntry.match_id metadata check:
    // The server's transcript logger (internal/hub/transcript.go
    // extractMatchID) derives entry.match_id from either
    // payload.match_id (envelope) or payload.data.match_id. For
    // game_over it prefers payload.data.session_id. If the live
    // server cannot derive a match_id from the wire bytes, entry
    // .match_id is omitted (omitempty).
    //
    // A hand-crafted transcript that sets entry.match_id to a value
    // NOT derivable from its own payload is simulating a wire shape
    // the server would never produce — which pollutes downstream
    // conformance semantics (session-grouping, routing). Reject here.
    if (entry.match_id && entry.match_id !== "") {
      const derivable = deriveMatchIDFromPayload(type, payload);
      if (derivable === "") {
        fail++;
        errors.push(
          `  line ${lineNo} (${type}): entry.match_id=${JSON.stringify(entry.match_id)} but payload has no extractable match_id/session_id (the real server would omit this field)`,
        );
        continue;
      }
      if (derivable !== entry.match_id) {
        fail++;
        errors.push(
          `  line ${lineNo} (${type}): entry.match_id=${JSON.stringify(entry.match_id)} disagrees with payload-derived ${JSON.stringify(derivable)}`,
        );
        continue;
      }
    }
    pass++;
  }

  return { pass, fail, errors };
}

function main(): number {
  const { schemaRoot, files } = parseArgs(process.argv);

  let schemas: ReturnType<typeof loadSchemas>;
  try {
    schemas = loadSchemas(schemaRoot);
  } catch (e: any) {
    console.error(`Failed to load schemas from ${schemaRoot}: ${e.message}`);
    return 2;
  }

  let totalPass = 0;
  let totalFail = 0;
  let badFiles = 0;

  for (const f of files) {
    if (!fs.existsSync(f)) {
      console.error(`FAIL ${f}: file not found`);
      badFiles++;
      continue;
    }
    const { pass, fail, errors } = validateFile(f, schemas);
    totalPass += pass;
    totalFail += fail;
    const flag = fail === 0 ? "PASS" : "FAIL";
    console.log(`${flag} ${f}: ${pass}/${pass + fail} messages valid`);
    for (const e of errors) console.log(e);
    if (fail > 0) badFiles++;
  }

  console.log(
    `\nTotal: ${totalPass}/${totalPass + totalFail} messages valid across ${files.length} transcripts`,
  );
  return badFiles > 0 ? 1 : 0;
}

process.exit(main());
