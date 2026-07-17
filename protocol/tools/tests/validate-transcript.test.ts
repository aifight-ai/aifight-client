import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const here = path.dirname(new URL(import.meta.url).pathname);
const validator = path.resolve(here, "..", "src", "validate-transcript.ts");

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", validator, ...args],
    { encoding: "utf8" },
  );
  return { code: r.status ?? 0, stdout: r.stdout, stderr: r.stderr };
}

function mkTmpTranscript(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-transcript-"));
  const f = path.join(dir, "t.jsonl");
  fs.writeFileSync(f, contents);
  return f;
}

test("accepts a minimal welcome message", () => {
  const welcome = {
    timestamp_ms: 1,
    direction: "server_to_client",
    actor: "aaaaaaaa-0000-0000-0000-000000000001",
    payload: {
      type: "welcome",
      data: {
        server_protocol_version: "v1.0.0",
        agent_id: "11111111-1111-1111-1111-111111111111",
        agent_name: "test",
        server_time: "2026-04-23T00:00:00Z",
        games: ["texas_holdem"],
      },
    },
  };
  const f = mkTmpTranscript(JSON.stringify(welcome) + "\n");
  const r = run([f]);
  assert.equal(r.code, 0, `expected pass, got stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stdout, /1\/1 messages valid/);
});

test("rejects welcome missing required server_protocol_version", () => {
  const bad = {
    timestamp_ms: 1,
    direction: "server_to_client",
    actor: "aaaaaaaa-0000-0000-0000-000000000001",
    payload: {
      type: "welcome",
      data: {
        agent_id: "11111111-1111-1111-1111-111111111111",
        agent_name: "test",
        server_time: "2026-04-23T00:00:00Z",
        games: ["texas_holdem"],
      },
    },
  };
  const f = mkTmpTranscript(JSON.stringify(bad) + "\n");
  const r = run([f]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /server_protocol_version|required/);
});

test("rejects unknown message type", () => {
  const weird = {
    timestamp_ms: 1,
    direction: "server_to_client",
    actor: "aaaaaaaa-0000-0000-0000-000000000001",
    payload: { type: "not_a_real_type", data: {} },
  };
  const f = mkTmpTranscript(JSON.stringify(weird) + "\n");
  const r = run([f]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /no schema registered/);
});

test("malformed JSONL line is fatal for that line only", () => {
  const good = {
    timestamp_ms: 1,
    direction: "server_to_client",
    actor: "aaaaaaaa-0000-0000-0000-000000000001",
    payload: {
      type: "welcome",
      data: {
        server_protocol_version: "v1.0.0",
        agent_id: "11111111-1111-1111-1111-111111111111",
        agent_name: "test",
        server_time: "2026-04-23T00:00:00Z",
        games: [],
      },
    },
  };
  const content = JSON.stringify(good) + "\n{not json\n";
  const f = mkTmpTranscript(content);
  const r = run([f]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /1\/2 messages valid/);
  assert.match(r.stdout, /malformed JSONL/);
});

test("no files argument → exit 2", () => {
  const r = run([]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no transcript files given/);
});

test("rejects entry.match_id on a payload where server cannot derive one", () => {
  // The real server's extractMatchID returns "" for match_confirm_request
  // because its data has no match_id / session_id. A transcript that
  // nonetheless sets entry.match_id is simulating an impossible wire
  // shape — flag it.
  const bad = {
    timestamp_ms: 1,
    direction: "server_to_client",
    actor: "aaaaaaaa-0000-0000-0000-000000000001",
    match_id: "bbbbbbbb-0000-0000-0000-000000000001",
    payload: {
      type: "match_confirm_request",
      data: {
        confirm_id: "dddddddd-0000-0000-0000-000000000001",
        game: "texas_holdem",
        mode: "ranked",
        players: 2,
        timeout_ms: 30000,
      },
    },
  };
  const f = mkTmpTranscript(JSON.stringify(bad) + "\n");
  const r = run([f]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /no extractable match_id/);
});

test("rejects entry.match_id that disagrees with payload-derived value", () => {
  // Payload.data.match_id = bbbb-0001 but entry.match_id = bbbb-0002.
  // The server's transcript logger cannot produce this split.
  const bad = {
    timestamp_ms: 1,
    direction: "server_to_client",
    actor: "aaaaaaaa-0000-0000-0000-000000000001",
    match_id: "bbbbbbbb-0000-0000-0000-000000000002",
    payload: {
      type: "action_request",
      data: {
        match_id: "bbbbbbbb-0000-0000-0000-000000000001",
        state: {},
        legal_actions: [{ type: "check" }],
        players: [],
        timeout_ms: 180000,
        new_events: null,
        request_id: "ffffffff-0000-0000-0000-000000000001",
      },
    },
  };
  const f = mkTmpTranscript(JSON.stringify(bad) + "\n");
  const r = run([f]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /disagrees with payload-derived/);
});

test("accepts entry.match_id that matches data.session_id for game_over", () => {
  // The §5.1 invariant — envelope routes by data.session_id on game_over.
  const good = {
    timestamp_ms: 1,
    direction: "server_to_client",
    actor: "aaaaaaaa-0000-0000-0000-000000000001",
    match_id: "bbbbbbbb-0000-0000-0000-000000000001",
    payload: {
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
    },
  };
  const f = mkTmpTranscript(JSON.stringify(good) + "\n");
  const r = run([f]);
  assert.equal(r.code, 0, `expected pass; stdout=\n${r.stdout}`);
});

test("accepts all committed golden transcripts", () => {
  const root = path.resolve(here, "..", "..", "transcripts");
  const files: string[] = [];
  for (const sub of ["happy_path", "edge_cases"]) {
    const d = path.join(root, sub);
    if (!fs.existsSync(d)) continue;
    for (const n of fs.readdirSync(d)) {
      if (n.endsWith(".jsonl")) files.push(path.join(d, n));
    }
  }
  assert.ok(files.length >= 1, "expected at least one committed transcript");
  const r = run(files);
  assert.equal(r.code, 0, `committed transcripts must pass; stdout=\n${r.stdout}`);
});
