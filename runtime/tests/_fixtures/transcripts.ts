// M1-20 fixture loader for protocol/transcripts/**.
//
// Loads the M0-sealed golden transcripts (7 files, 117 messages) into
// memory once per vitest worker, deep-freezes the result so test cases
// cannot mutate the shared corpus, and exposes path-based + bulk
// accessors. Internal-only: NOT re-exported via runtime/src/index.ts
// (M1-20 Scope Fence).

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative, sep, posix } from "node:path";

export interface TranscriptEntry {
  readonly timestamp_ms: number;
  readonly direction: "server_to_client" | "client_to_server";
  readonly actor: string;
  readonly match_id?: string;
  readonly payload: Readonly<{ type: string; data?: unknown; [k: string]: unknown }>;
}

export type TranscriptCategory = "happy_path" | "edge_cases";

export interface LoadedTranscript {
  /** repo-relative POSIX path under protocol/transcripts/, e.g. "happy_path/texas_holdem_4player.jsonl". */
  readonly name: string;
  /** Absolute resolved path. */
  readonly absPath: string;
  readonly entries: readonly TranscriptEntry[];
  readonly bytes: number;
  readonly category: TranscriptCategory;
}

const HELPER_DIR = dirname(fileURLToPath(import.meta.url));
// runtime/tests/_fixtures/transcripts.ts → repo root = ../../..
export const TRANSCRIPTS_ROOT = resolve(HELPER_DIR, "..", "..", "..", "protocol", "transcripts");

const cache = new Map<string, LoadedTranscript>();

const VALID_CATEGORIES: ReadonlySet<string> = new Set<string>(["happy_path", "edge_cases"]);

/**
 * Load a single transcript by repo-relative path under protocol/transcripts/.
 *
 * @param relPath e.g. "happy_path/texas_holdem_4player.jsonl"
 * @throws Error if relPath traverses outside TRANSCRIPTS_ROOT, file
 *   missing, or any line is not valid JSON.
 */
export function loadTranscript(relPath: string): LoadedTranscript {
  const cached = cache.get(relPath);
  if (cached) return cached;

  // Path traversal guard: resolve under root, then verify the resulting
  // absolute path is still inside TRANSCRIPTS_ROOT. Catches both literal
  // ".." and absolute relPath inputs.
  const absPath = resolve(TRANSCRIPTS_ROOT, relPath);
  const rel = relative(TRANSCRIPTS_ROOT, absPath);
  if (rel === "" || rel.startsWith("..") || (sep !== posix.sep && rel.includes(".." + sep)) || rel.includes(".." + posix.sep)) {
    throw new Error(
      `loadTranscript: relPath escapes TRANSCRIPTS_ROOT. relPath='${relPath}', resolved='${absPath}', root='${TRANSCRIPTS_ROOT}'`,
    );
  }

  // Category is the first path segment (POSIX-normalised).
  const posixRel = rel.split(sep).join(posix.sep);
  const slash = posixRel.indexOf(posix.sep);
  if (slash <= 0) {
    throw new Error(
      `loadTranscript: relPath must include a category prefix (happy_path/ or edge_cases/). relPath='${relPath}'`,
    );
  }
  const categoryStr = posixRel.slice(0, slash);
  if (!VALID_CATEGORIES.has(categoryStr)) {
    throw new Error(
      `loadTranscript: unknown category '${categoryStr}' in relPath='${relPath}'. Valid: happy_path, edge_cases`,
    );
  }
  const category = categoryStr as TranscriptCategory;

  // readFileSync surfaces ENOENT with a useful message; we re-throw with
  // the absolute path so failures are diagnosable in vitest output.
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch (err) {
    throw new Error(
      `loadTranscript: failed to read '${absPath}': ${(err as Error).message}`,
    );
  }
  const bytes = Buffer.byteLength(raw, "utf8");

  // Split on \n, drop trailing empty line if file ends with newline.
  const lines = raw.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  if (lines.length === 0) {
    throw new Error(`loadTranscript: '${absPath}' is empty`);
  }

  const entries: TranscriptEntry[] = lines.map((line, idx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `loadTranscript: '${posixRel}' line ${idx + 1} is not valid JSON: ${(err as Error).message}`,
      );
    }
    return validateEntryShape(parsed, posixRel, idx + 1);
  });

  const result: LoadedTranscript = deepFreezeImpl({
    name: posixRel,
    absPath,
    entries,
    bytes,
    category,
  });

  cache.set(relPath, result);
  return result;
}

/**
 * Load every transcript under happy_path/ + edge_cases/.
 * Stable sort by (category, name) for deterministic test ordering.
 */
export function loadAllTranscripts(): readonly LoadedTranscript[] {
  const out: LoadedTranscript[] = [];
  for (const category of ["happy_path", "edge_cases"] as const) {
    const dir = resolve(TRANSCRIPTS_ROOT, category);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (err) {
      throw new Error(
        `loadAllTranscripts: failed to readdir '${dir}': ${(err as Error).message}`,
      );
    }
    names = names.filter((n) => n.endsWith(".jsonl")).sort();
    for (const n of names) {
      out.push(loadTranscript(`${category}/${n}`));
    }
  }
  return out;
}

/**
 * Test-only hook: clear the in-memory cache so a test can simulate
 * a fresh load. Not used in main production paths.
 */
export function __resetTranscriptsCache(): void {
  cache.clear();
}

function validateEntryShape(raw: unknown, file: string, line: number): TranscriptEntry {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `loadTranscript: '${file}' line ${line} is not a JSON object`,
    );
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.timestamp_ms !== "number" || !Number.isFinite(r.timestamp_ms)) {
    throw new Error(
      `loadTranscript: '${file}' line ${line} missing/invalid 'timestamp_ms' (got ${typeof r.timestamp_ms})`,
    );
  }
  if (r.direction !== "server_to_client" && r.direction !== "client_to_server") {
    throw new Error(
      `loadTranscript: '${file}' line ${line} invalid 'direction'='${String(r.direction)}'`,
    );
  }
  if (typeof r.actor !== "string" || r.actor === "") {
    throw new Error(
      `loadTranscript: '${file}' line ${line} missing/empty 'actor'`,
    );
  }
  if (r.match_id !== undefined && typeof r.match_id !== "string") {
    throw new Error(
      `loadTranscript: '${file}' line ${line} 'match_id' must be string when present (got ${typeof r.match_id})`,
    );
  }
  if (typeof r.payload !== "object" || r.payload === null || Array.isArray(r.payload)) {
    throw new Error(
      `loadTranscript: '${file}' line ${line} 'payload' is not a JSON object`,
    );
  }
  const payload = r.payload as Record<string, unknown>;
  if (typeof payload.type !== "string" || payload.type === "") {
    throw new Error(
      `loadTranscript: '${file}' line ${line} 'payload.type' missing/empty`,
    );
  }
  return r as unknown as TranscriptEntry;
}

function deepFreezeImpl<T>(x: T): T {
  if (x === null || typeof x !== "object" || Object.isFrozen(x)) return x;
  for (const key of Object.keys(x as object)) {
    deepFreezeImpl((x as Record<string, unknown>)[key]);
  }
  return Object.freeze(x);
}
