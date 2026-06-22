// Schema loader — resolves and reads JSON Schema files from the
// `protocol/schema/**/*.schema.json` tree.
//
// Two layouts are supported, in order:
//   1. Packaged install (dist/schemas/ copied there by build.sh).
//      Used when the runtime has been `npm install`-ed from the
//      published tarball.
//   2. Repo-layout dev (../../../protocol/schema/ at the repo root).
//      Used when running directly from the source tree (`node
//      --experimental-strip-types` / vitest / `bun run src/index.ts`).
//
// The resolver is deterministic: it walks a fixed candidate list
// relative to the caller's `import.meta.url`. No network, no
// environment variables.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CANDIDATES = [
  // 1. Packaged: runtime/dist/schemas/ — this module lives at
  //    runtime/dist/index.mjs after esbuild, so a sibling `schemas/`
  //    directory is the bundled asset tree.
  "./schemas",
  // 2. Dev: runtime/src/protocol/schemas.ts → ../../../protocol/schema/
  "../../../protocol/schema",
  // 3. Dev fallback when tests run from runtime/tests/: two levels up
  "../../protocol/schema",
];

let cachedRoot: string | null = null;

export function findSchemasRoot(here: string = defaultHere()): string {
  if (cachedRoot) return cachedRoot;
  for (const rel of CANDIDATES) {
    const candidate = path.resolve(here, rel);
    if (isDir(candidate) && isDir(path.join(candidate, "messages"))) {
      cachedRoot = candidate;
      return cachedRoot;
    }
  }
  throw new Error(
    `@aifight/aifight: cannot locate protocol/schema tree. ` +
      `Searched relative to ${here}: ${CANDIDATES.join(", ")}. ` +
      `Run build.sh to populate dist/schemas/ before packaging.`,
  );
}

function defaultHere(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Cheap protocol message-type → schema-file mapping. Mirrors the
// replay-test-spec.md §4 dispatch table. Kept in sync by hand because
// there are only ~18 entries and the alternative (a generated manifest)
// adds a codegen step for very little gain.
const MESSAGE_TYPE_TO_FILE: Record<string, string> = {
  welcome: "messages/server_welcome.schema.json",
  queue_joined: "messages/server_queue_joined.schema.json",
  queue_left: "messages/server_queue_left.schema.json",
  match_confirm_request: "messages/server_match_confirm_request.schema.json",
  match_cancelled: "messages/server_match_cancelled.schema.json",
  game_start: "messages/server_game_start.schema.json",
  readiness_check: "messages/server_readiness_check.schema.json",
  action_request: "messages/server_action_request.schema.json",
  action_stale: "messages/server_action_stale.schema.json",
  event: "messages/server_event.schema.json",
  game_state: "messages/server_game_state.schema.json",
  game_over: "messages/server_game_over.schema.json",
  error: "messages/server_error.schema.json",
  join_queue: "messages/client_join_queue.schema.json",
  leave_queue: "messages/client_leave_queue.schema.json",
  match_confirm: "messages/client_match_confirm.schema.json",
  action: "messages/client_action.schema.json",
  runtime_status: "messages/client_runtime_status.schema.json",
};

export type MessageType = keyof typeof MESSAGE_TYPE_TO_FILE;

export function messageTypes(): readonly string[] {
  return Object.keys(MESSAGE_TYPE_TO_FILE);
}

export function loadSchema(messageType: string): unknown {
  const rel = MESSAGE_TYPE_TO_FILE[messageType];
  if (!rel) {
    throw new Error(
      `@aifight/aifight: unknown message type '${messageType}'. ` +
        `Known: ${Object.keys(MESSAGE_TYPE_TO_FILE).join(", ")}`,
    );
  }
  const root = findSchemasRoot();
  const fullPath = path.join(root, rel);
  const raw = fs.readFileSync(fullPath, "utf8");
  return JSON.parse(raw);
}

// Walk the entire schema tree and return every schema file's parsed
// content keyed by `$id`. Used to preload the ajv instance at startup
// so cross-file `$ref`s resolve without on-demand fetching.
export function loadAllSchemas(): Map<string, unknown> {
  const root = findSchemasRoot();
  const out = new Map<string, unknown>();
  walk(root, (file) => {
    if (!file.endsWith(".schema.json")) return;
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as { $id?: string };
    if (typeof parsed.$id === "string" && parsed.$id !== "") {
      out.set(parsed.$id, parsed);
    }
  });
  return out;
}

function walk(dir: string, visit: (file: string) => void): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else if (entry.isFile()) visit(full);
  }
}

// REST endpoint schema dispatch. Parallel to MESSAGE_TYPE_TO_FILE but
// scoped to the three REST schemas the runtime is allowed to reference
// per protocol/schema/rest/README.md. claim_{request,response} and
// agent_status_response are deliberately NOT listed here — they are
// M1-04/M1-05 territory. Adding them before then is scope creep.
const REST_NAME_TO_FILE: Record<string, string> = {
  register_request: "rest/register_request.schema.json",
  register_response: "rest/register_response.schema.json",
  error_response: "rest/error_response.schema.json",
};

export type RestSchemaName = keyof typeof REST_NAME_TO_FILE;

export function loadRestSchema(name: RestSchemaName): unknown {
  const rel = REST_NAME_TO_FILE[name];
  if (!rel) {
    throw new Error(
      `@aifight/aifight: unknown REST schema '${name}'. ` +
        `Known: ${Object.keys(REST_NAME_TO_FILE).join(", ")}`,
    );
  }
  const root = findSchemasRoot();
  const fullPath = path.join(root, rel);
  const raw = fs.readFileSync(fullPath, "utf8");
  return JSON.parse(raw);
}

// Reset the cached root — test-only hook so different tests can
// exercise different candidate paths. Not exported from index.ts.
export function __resetSchemasRootCache(): void {
  cachedRoot = null;
}
