import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const here = path.dirname(new URL(import.meta.url).pathname);
const codegen = path.resolve(here, "..", "src", "codegen.ts");

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", codegen, ...args],
    { encoding: "utf8" },
  );
  return { code: r.status ?? 0, stdout: r.stdout, stderr: r.stderr };
}

test("generates types from real schemas without errors", () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "codegen-"));
  const out = path.join(outDir, "types.ts");
  const r = run(["--out", out]);
  assert.equal(r.code, 0, `stderr=${r.stderr}`);
  assert.ok(fs.existsSync(out), "expected output file to exist");

  const body = fs.readFileSync(out, "utf8");
  assert.match(body, /AUTO-GENERATED/);
  assert.match(body, /export type WSMessage = /);
  assert.match(body, /MsgWelcome/);
  assert.match(body, /MsgGameStart/);
  assert.match(body, /MsgAction\b/);
  // Common envelopes (pre-rename) stay under their original title
  assert.match(body, /export interface Action\b/);
  assert.match(body, /export interface Event\b/);
});

test("output is deterministic (byte-identical across runs)", () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "codegen-"));
  const a = path.join(outDir, "a.ts");
  const b = path.join(outDir, "b.ts");
  assert.equal(run(["--out", a]).code, 0);
  assert.equal(run(["--out", b]).code, 0);
  const A = fs.readFileSync(a, "utf8");
  const B = fs.readFileSync(b, "utf8");
  assert.equal(A, B, "codegen must be deterministic — CI diff-check depends on this");
});

test("rejects unknown arg", () => {
  const r = run(["--whatever"]);
  assert.equal(r.code, 2);
});

test("MsgGameStart is a typed per-game discriminated union (not {[k]: any})", () => {
  // Regression guard: json-schema-to-typescript collapses the server_game_start
  // schema's allOf+if/then narrowing into `data: {[k: string]: any}`, which
  // defeats the whole point of the generated types for M1 runtime. The
  // codegen.ts hand-composed override MUST be present in the output.
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "codegen-"));
  const out = path.join(outDir, "types.ts");
  assert.equal(run(["--out", out]).code, 0);
  const body = fs.readFileSync(out, "utf8");

  // MsgGameStart must NOT be a single-property envelope whose `data`
  // collapses to an untyped index signature.
  assert.doesNotMatch(
    body,
    /export interface MsgGameStart \{[^}]*data:\s*\{\s*\[k: string\]: any;?\s*\}/,
    "MsgGameStart.data must not be {[k]: any} — see codegen.ts renderMsgGameStart",
  );

  // Required per-game variants and their union must appear.
  assert.match(body, /export interface MsgGameStartDataTexasHoldem extends MsgGameStartDataBase/);
  assert.match(body, /export interface MsgGameStartDataLiarsDice extends MsgGameStartDataBase/);
  assert.match(body, /export interface MsgGameStartDataCoup extends MsgGameStartDataBase/);
  assert.match(
    body,
    /export type MsgGameStartData =\s*\|\s*MsgGameStartDataTexasHoldem\s*\|\s*MsgGameStartDataLiarsDice\s*\|\s*MsgGameStartDataCoup/,
  );

  // Game discriminator must be a string literal, not generic `string`.
  assert.match(body, /game:\s*"texas_holdem"/);
  assert.match(body, /game:\s*"liars_dice"/);
  assert.match(body, /game:\s*"coup"/);

  // Rules type references must point at the per-game types generated
  // elsewhere in the same file (not `any`, not a placeholder).
  assert.match(body, /rules:\s*TexasHoldemRules/);
  assert.match(body, /rules:\s*LiarsDiceRules/);
  assert.match(body, /rules:\s*CoupRules/);

  // Texas Hold'em config is a real type; liars_dice/coup are object-or-null
  // (the schema allows object but server emits null — don't overnarrow).
  assert.match(body, /config:\s*TexasHoldemConfig \| null/);
});

test("MsgMatchCancelled is a per-reason discriminated union with opponent_disconnected + game/mode", () => {
  // Codex round-3 P1-B: the schema used to enum only
  // [confirmation_timeout, opponent_not_ready] and reject game/mode, but
  // hub.go:1611 sends opponent_disconnected + game + mode on mid-match
  // peer disconnect. If a future edit to the schema loses the
  // opponent_disconnected branch or the game/mode fields, runtime
  // type-checking will silently reject real server messages.
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "codegen-"));
  const out = path.join(outDir, "types.ts");
  assert.equal(run(["--out", out]).code, 0);
  const body = fs.readFileSync(out, "utf8");

  assert.match(body, /export interface MsgMatchCancelled/);
  assert.match(body, /reason:\s*"confirmation_timeout"/);
  assert.match(body, /reason:\s*"opponent_not_ready"/);
  assert.match(body, /reason:\s*"opponent_disconnected"/);
  // opponent_disconnected branch MUST carry game + mode as required.
  assert.match(
    body,
    /reason:\s*"opponent_disconnected"[\s\S]{0,400}game:\s*string[\s\S]{0,400}mode:\s*string/,
  );
});
