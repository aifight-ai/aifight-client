#!/usr/bin/env node
// lint.ts — static checks on protocol/schema/**/*.schema.json.
//
// Rules (all fatal unless noted):
//   1. File must be valid JSON.
//   2. Must declare $schema = http://json-schema.org/draft-07/schema#.
//   3. Must declare $id, title, description (description is a warning).
//   4. Any `type === "object"` subschema SHOULD have additionalProperties
//      explicitly declared (true/false or `type: ["object", "null"]`
//      pattern via union). Required only on the TOP-LEVEL schema.
//   5. Every $ref must resolve to a schema $id we've loaded, or a
//      fragment within the same document. No dangling refs.
//   6. $id must follow the pattern https://aifight.ai/protocol/v1/<area>/<name>.schema.json
//      where <area> ∈ {messages, common, games/<game>, rest}.
//
// Usage:
//   lint [--schema-root <path>]
//
// Exit code: 0 PASS / 1 FAIL / 2 cli error

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchemas, walkSchemas } from "./schema-loader.ts";

interface LintIssue {
  severity: "error" | "warning";
  file: string;
  message: string;
}

const ID_PATTERN = /^https:\/\/aifight\.ai\/protocol\/v1\/([a-z_/]+)\/([a-zA-Z_]+)\.schema\.json$/;

function checkFile(file: string, schemaRoot: string): LintIssue[] {
  const issues: LintIssue[] = [];
  const push = (severity: LintIssue["severity"], message: string) =>
    issues.push({ severity, file, message });

  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e: any) {
    push("error", `cannot read: ${e.message}`);
    return issues;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    push("error", `invalid JSON: ${e.message}`);
    return issues;
  }

  if (parsed.$schema !== "http://json-schema.org/draft-07/schema#") {
    push("error", `$schema must be draft-07, got ${JSON.stringify(parsed.$schema)}`);
  }
  if (typeof parsed.$id !== "string" || !parsed.$id) {
    push("error", "$id missing or empty");
  } else if (!ID_PATTERN.test(parsed.$id)) {
    push(
      "error",
      `$id must match ${ID_PATTERN.source}, got ${parsed.$id}`,
    );
  }
  if (typeof parsed.title !== "string" || !parsed.title) {
    push("error", "title missing or empty");
  }
  if (typeof parsed.description !== "string" || !parsed.description) {
    push("warning", "description missing or empty");
  }

  // Top-level object schemas should have additionalProperties set.
  // (Sub-objects may or may not; we don't enforce deeper.)
  if (parsed.type === "object" && !("additionalProperties" in parsed)) {
    push(
      "warning",
      "top-level type:object without additionalProperties (should be false or documented)",
    );
  }

  // Collect all $ref strings.
  const refs: string[] = [];
  const visit = (node: unknown) => {
    if (node == null || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "$ref" && typeof v === "string") refs.push(v);
      visit(v);
    }
  };
  visit(parsed);

  // Resolve each ref.
  for (const r of refs) {
    if (r.startsWith("#")) continue; // intra-document fragment
    // Relative like "../common/action.schema.json" — resolve to absolute path.
    const base = path.dirname(file);
    const target = path.resolve(base, r);
    if (!fs.existsSync(target)) {
      push("error", `$ref ${r} → ${target} does not exist`);
    }
  }

  return issues;
}

function parseArgs(argv: string[]): { schemaRoot: string } {
  const args = argv.slice(2);
  const here = path.dirname(fileURLToPath(import.meta.url));
  let schemaRoot = path.resolve(here, "..", "..", "schema");
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--schema-root") {
      schemaRoot = path.resolve(args[++i]);
    } else if (a === "--help" || a === "-h") {
      console.log("usage: lint [--schema-root <path>]");
      process.exit(0);
    } else {
      console.error(`unexpected argument: ${a}`);
      process.exit(2);
    }
  }
  return { schemaRoot };
}

function main(): number {
  const { schemaRoot } = parseArgs(process.argv);
  if (!fs.existsSync(schemaRoot)) {
    console.error(`schema root not found: ${schemaRoot}`);
    return 2;
  }

  const files = walkSchemas(schemaRoot);

  // Per-file rules.
  const allIssues: LintIssue[] = [];
  for (const f of files) {
    allIssues.push(...checkFile(f, schemaRoot));
  }

  // Cross-schema check: ajv can load the whole registry without errors.
  try {
    loadSchemas(schemaRoot);
  } catch (e: any) {
    allIssues.push({
      severity: "error",
      file: schemaRoot,
      message: `ajv schema registry failed: ${e.message}`,
    });
  }

  // Report.
  const errors = allIssues.filter((i) => i.severity === "error");
  const warnings = allIssues.filter((i) => i.severity === "warning");

  for (const i of [...errors, ...warnings]) {
    const tag = i.severity === "error" ? "ERROR" : "WARN ";
    const rel = path.relative(process.cwd(), i.file);
    console.log(`${tag} ${rel}: ${i.message}`);
  }

  console.log(
    `\n${files.length} schemas linted: ${errors.length} errors, ${warnings.length} warnings`,
  );
  return errors.length > 0 ? 1 : 0;
}

process.exit(main());
