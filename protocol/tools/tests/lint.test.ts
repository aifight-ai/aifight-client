import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const here = path.dirname(new URL(import.meta.url).pathname);
const linter = path.resolve(here, "..", "src", "lint.ts");

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", linter, ...args],
    { encoding: "utf8" },
  );
  return { code: r.status ?? 0, stdout: r.stdout, stderr: r.stderr };
}

function mkTmpSchemaRoot(
  files: Record<string, Record<string, unknown>>,
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schema-lint-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, JSON.stringify(content, null, 2));
  }
  return root;
}

test("passes committed repo schemas", () => {
  const r = run([]);
  assert.equal(r.code, 0, `real schemas should lint clean; stdout=\n${r.stdout}`);
});

test("flags missing $id", () => {
  const root = mkTmpSchemaRoot({
    "messages/server_welcome.schema.json": {
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "welcome",
      description: "test",
      type: "object",
      additionalProperties: false,
      // no $id
    },
  });
  const r = run(["--schema-root", root]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\$id missing/);
});

test("flags wrong $schema dialect", () => {
  const root = mkTmpSchemaRoot({
    "messages/server_x.schema.json": {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://aifight.ai/protocol/v1/messages/server_x.schema.json",
      title: "x",
      description: "test",
      type: "object",
      additionalProperties: false,
    },
  });
  const r = run(["--schema-root", root]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /draft-07/);
});

test("flags bad $id pattern", () => {
  const root = mkTmpSchemaRoot({
    "messages/server_x.schema.json": {
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "https://example.com/foo.json",
      title: "x",
      description: "test",
      type: "object",
      additionalProperties: false,
    },
  });
  const r = run(["--schema-root", root]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\$id must match/);
});

test("flags dangling $ref", () => {
  const root = mkTmpSchemaRoot({
    "messages/server_x.schema.json": {
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "https://aifight.ai/protocol/v1/messages/server_x.schema.json",
      title: "x",
      description: "test",
      type: "object",
      additionalProperties: false,
      properties: {
        other: { $ref: "../does/not/exist.schema.json" },
      },
    },
  });
  const r = run(["--schema-root", root]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /does not exist/);
});

test("warns on missing description but still exits 0", () => {
  const root = mkTmpSchemaRoot({
    "messages/server_x.schema.json": {
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "https://aifight.ai/protocol/v1/messages/server_x.schema.json",
      title: "x",
      type: "object",
      additionalProperties: false,
    },
  });
  const r = run(["--schema-root", root]);
  assert.equal(r.code, 0, `warnings should not fail; stdout=\n${r.stdout}`);
  assert.match(r.stdout, /WARN/);
  assert.match(r.stdout, /description/);
});
