// R14-F02 — the desktop no longer accepts a generic argv from the renderer; it
// accepts an ENUMERATED CliOp and MAIN builds a fixed argv template per kind,
// validating every interpolated value. These pin that argvForCliOp:
//   - emits the exact fixed argv per operation (parity with the old call sites),
//   - validates/normalizes each renderer-supplied value, and
//   - returns null (⇒ the CLI never runs) for anything malformed.
//
// Runs in node (vitest): argvForCliOp is a pure function — the CLI's run() is a
// lazy dynamic import inside runCliArgv, never reached here.

import { describe, expect, it } from "vitest";

import { argvForCliOp } from "./cli-host";
import type { CliOp } from "../shared/ipc";

describe("argvForCliOp — fixed argv templates", () => {
  it("emits the exact argv for each parameterless / boolean operation", () => {
    expect(argvForCliOp({ kind: "setup" })).toEqual(["setup", "--json"]);
    expect(argvForCliOp({ kind: "setup", replaceLocalIdentity: true })).toEqual([
      "setup",
      "--json",
      "--replace-local-identity",
    ]);
    expect(argvForCliOp({ kind: "status" })).toEqual(["status", "--json"]);
    expect(argvForCliOp({ kind: "sessionsList" })).toEqual(["sessions", "list", "--json"]);
    expect(argvForCliOp({ kind: "configReviewGet" })).toEqual(["config", "review", "--json"]);
  });

  it("connect: trims + validates the code; --replace-local-identity only when asked", () => {
    expect(argvForCliOp({ kind: "connect", code: "  ABCD-1234_ef  " })).toEqual([
      "connect",
      "ABCD-1234_ef",
      "--json",
    ]);
    expect(argvForCliOp({ kind: "connect", code: "abc123", replaceLocalIdentity: true })).toEqual([
      "connect",
      "abc123",
      "--replace-local-identity",
      "--json",
    ]);
  });

  it("connect: rejects empty, over-long, and codes with argv-splitting characters", () => {
    expect(argvForCliOp({ kind: "connect", code: "" })).toBeNull();
    expect(argvForCliOp({ kind: "connect", code: "   " })).toBeNull();
    expect(argvForCliOp({ kind: "connect", code: "a".repeat(129) })).toBeNull();
    expect(argvForCliOp({ kind: "connect", code: "has space" })).toBeNull();
    expect(argvForCliOp({ kind: "connect", code: "with/slash" })).toBeNull();
    expect(argvForCliOp({ kind: "connect", code: 42 as unknown as string })).toBeNull();
    // A leading dash must never be accepted: it would be parsed as a CLI flag
    // (e.g. forcing --replace-local-identity), not a positional pairing code.
    expect(argvForCliOp({ kind: "connect", code: "--replace-local-identity" })).toBeNull();
    expect(argvForCliOp({ kind: "connect", code: "-x" })).toBeNull();
    expect(argvForCliOp({ kind: "review", sessionId: "--regen", mode: "default" })).toBeNull();
    expect(argvForCliOp({ kind: "sessionsExport", sessionId: "-rf" })).toBeNull();
    expect(argvForCliOp({ kind: "configTest", slug: "default", profileId: "--profile" })).toBeNull();
  });

  it("challenge: accepts a conservative slug, rejects anything else", () => {
    expect(argvForCliOp({ kind: "challenge", game: "texas_holdem" })).toEqual([
      "challenge",
      "texas_holdem",
      "--json",
    ]);
    expect(argvForCliOp({ kind: "challenge", game: "Texas-Holdem" })).toBeNull(); // caps + dash
    expect(argvForCliOp({ kind: "challenge", game: "../etc" })).toBeNull(); // traversal
    expect(argvForCliOp({ kind: "challenge", game: "" })).toBeNull();
    expect(argvForCliOp({ kind: "challenge", game: "x".repeat(33) })).toBeNull();
  });

  it("accept: only http/https URLs within the length cap", () => {
    expect(argvForCliOp({ kind: "accept", url: "https://aifight.ai/challenge/tok" })).toEqual([
      "accept",
      "https://aifight.ai/challenge/tok",
      "--json",
    ]);
    expect(argvForCliOp({ kind: "accept", url: "http://localhost:8080/x" })).toEqual([
      "accept",
      "http://localhost:8080/x",
      "--json",
    ]);
    expect(argvForCliOp({ kind: "accept", url: "javascript:alert(1)" })).toBeNull();
    expect(argvForCliOp({ kind: "accept", url: "ftp://host/x" })).toBeNull();
    expect(argvForCliOp({ kind: "accept", url: "not a url" })).toBeNull();
    expect(argvForCliOp({ kind: "accept", url: "https://x/" + "a".repeat(2048) })).toBeNull();
  });

  it("configReviewSet: only the three enum modes", () => {
    expect(argvForCliOp({ kind: "configReviewSet", mode: "off" })).toEqual(["config", "review", "auto", "off"]);
    expect(argvForCliOp({ kind: "configReviewSet", mode: "losses_only" })).toEqual([
      "config",
      "review",
      "auto",
      "losses_only",
    ]);
    expect(argvForCliOp({ kind: "configReviewSet", mode: "everything" as never })).toBeNull();
  });

  it("configTest: validates slug + profileId", () => {
    expect(argvForCliOp({ kind: "configTest", slug: "default", profileId: "claude-1" })).toEqual([
      "config",
      "test",
      "default",
      "--profile",
      "claude-1",
      "--json",
    ]);
    expect(argvForCliOp({ kind: "configTest", slug: "BAD SLUG", profileId: "claude" })).toBeNull();
    expect(argvForCliOp({ kind: "configTest", slug: "default", profileId: "has space" })).toBeNull();
  });

  it("review: --json always; mode maps to the right optional flag", () => {
    expect(argvForCliOp({ kind: "review", sessionId: "s-1", mode: "default" })).toEqual([
      "review",
      "s-1",
      "--json",
    ]);
    expect(argvForCliOp({ kind: "review", sessionId: "s-1", mode: "regen" })).toEqual([
      "review",
      "s-1",
      "--json",
      "--regen",
    ]);
    expect(argvForCliOp({ kind: "review", sessionId: "s-1", mode: "no-generate" })).toEqual([
      "review",
      "s-1",
      "--json",
      "--no-generate",
    ]);
    expect(argvForCliOp({ kind: "review", sessionId: "../../etc/passwd", mode: "default" })).toBeNull();
  });

  it("sessionsExport: NO --json (matches CLI behavior); validates the id", () => {
    expect(argvForCliOp({ kind: "sessionsExport", sessionId: "demo-s1" })).toEqual([
      "sessions",
      "export",
      "demo-s1",
    ]);
    expect(argvForCliOp({ kind: "sessionsExport", sessionId: "has space" })).toBeNull();
  });

  it("rejects unknown kinds and non-object input (defensive)", () => {
    expect(argvForCliOp({ kind: "explode" } as unknown as CliOp)).toBeNull();
    expect(argvForCliOp(null as unknown as CliOp)).toBeNull();
    expect(argvForCliOp("setup" as unknown as CliOp)).toBeNull();
    expect(argvForCliOp({} as unknown as CliOp)).toBeNull();
  });
});
