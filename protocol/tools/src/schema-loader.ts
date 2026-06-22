// Shared AJV schema loader + registry used by validate-transcript.ts and lint.ts.
//
// Responsibilities:
//   - Walk protocol/schema/**/*.schema.json, read, addSchema keyed by $id
//   - Configure ajv (strict:false, allErrors:true) + ajv-formats
//   - Expose a map from WS message `type` to message schema $id

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import fs from "node:fs";
import path from "node:path";

export interface SchemaEntry {
  file: string;
  $id: string;
  schema: unknown;
}

export interface LoadedSchemas {
  ajv: Ajv;
  entries: SchemaEntry[];
  byId: Map<string, SchemaEntry>;
  messageTypeToId: Map<string, string>;
  getValidator(schemaId: string): ValidateFunction;
}

/**
 * Recursively enumerate *.schema.json under a directory.
 */
export function walkSchemas(root: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, ent.name);
    if (ent.isDirectory()) out.push(...walkSchemas(p));
    else if (ent.name.endsWith(".schema.json")) out.push(p);
  }
  return out;
}

/**
 * Load every schema under `schemaRoot`, register them with ajv, and return
 * the registry. Throws if a file is not valid JSON or lacks an $id.
 */
export function loadSchemas(schemaRoot: string): LoadedSchemas {
  const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);

  const files = walkSchemas(schemaRoot);
  const entries: SchemaEntry[] = [];
  const byId = new Map<string, SchemaEntry>();

  for (const f of files) {
    const raw = fs.readFileSync(f, "utf8");
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (e: any) {
      throw new Error(`JSON parse error in ${f}: ${e.message}`);
    }
    const id = parsed.$id;
    if (typeof id !== "string" || !id) {
      throw new Error(`Schema ${f} missing $id`);
    }
    if (byId.has(id)) {
      throw new Error(`Duplicate $id ${id} between ${byId.get(id)!.file} and ${f}`);
    }
    const entry: SchemaEntry = { file: f, $id: id, schema: parsed };
    entries.push(entry);
    byId.set(id, entry);
    ajv.addSchema(parsed, id);
  }

  // Derive message-type → schema-$id map from messages/<name>.schema.json.
  // We infer by filename: server_<type>.schema.json or client_<type>.schema.json.
  const messageTypeToId = new Map<string, string>();
  for (const e of entries) {
    const rel = path.relative(schemaRoot, e.file);
    const parts = rel.split(path.sep);
    if (parts[0] !== "messages") continue;
    const file = parts[parts.length - 1];
    // Strip server_/client_ prefix and .schema.json suffix.
    const base = file.replace(/\.schema\.json$/, "");
    let type = base.replace(/^(server_|client_)/, "");
    // Special case: payload.type for each message is usually `type` field's const.
    // Extract it from the schema to avoid filename assumptions.
    const s = e.schema as any;
    const typeConst = s?.properties?.type?.const;
    if (typeof typeConst === "string") {
      messageTypeToId.set(typeConst, e.$id);
    } else {
      messageTypeToId.set(type, e.$id);
    }
  }

  const getValidator = (schemaId: string): ValidateFunction => {
    const v = ajv.getSchema(schemaId);
    if (!v) throw new Error(`No compiled schema for $id=${schemaId}`);
    return v;
  };

  // Force-compile every schema up front so $ref resolution issues surface
  // here rather than at first use.
  for (const e of entries) {
    ajv.compile(e.schema as any);
  }

  return { ajv, entries, byId, messageTypeToId, getValidator };
}
