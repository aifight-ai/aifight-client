// Batch E / G3 — "documentation as test". Extracts the concrete `aifight config`
// commands from BOTH published skill entry points — public/skill.md (served at
// aifight.ai/skill.md) and skills/aifight/SKILL.md (the ClawHub copy) — and runs
// each one, so a future edit that drifts a flag name or profile-id convention
// (the class of bug that shipped `config set-key default`) fails CI instead of
// reaching users. It also asserts the two files stay in lockstep, so a fix
// applied to one entry point can't silently miss the other (the drift that left
// public/skill.md advertising `set-key default` and `--auto` as an alias after
// SKILL.md had already been corrected).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { run } from "../src/cli/main";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SKILL_PATHS: ReadonlyArray<readonly [string, string]> = [
  ["public/skill.md", path.join(REPO_ROOT, "public/skill.md")],
  ["skills/aifight/SKILL.md", path.join(REPO_ROOT, "skills/aifight/SKILL.md")],
];

let prevHome: string | undefined;
let tmpDir: string;

beforeEach(() => {
  prevHome = process.env.AIFIGHT_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aifight-skilldoc-"));
  process.env.AIFIGHT_HOME = tmpDir;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.AIFIGHT_HOME;
  else process.env.AIFIGHT_HOME = prevHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Join fenced shell lines (handling `\` continuations), skipping comments. */
function extractShellLines(md: string): string[] {
  const out: string[] = [];
  let inFence = false;
  let pending = "";
  for (const line of md.split("\n")) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      pending = "";
      continue;
    }
    if (!inFence) continue;
    const l = line.trim();
    if (l === "" || l.startsWith("#")) continue;
    if (l.endsWith("\\")) {
      pending += l.slice(0, -1).trim() + " ";
      continue;
    }
    out.push((pending + l).trim());
    pending = "";
  }
  return out;
}

/** Concrete `aifight config …` commands (drop a leading `printf … |` and any
 *  trailing inline comment, skip lines with <placeholder> / [placeholder]
 *  syntax). */
function extractConfigCommands(md: string): string[] {
  return extractShellLines(md)
    .map((l) => l.replace(/^printf[^|]*\|\s*/, ""))
    .map((l) => l.replace(/\s+#.*$/, "").trim())
    .filter((l) => l.startsWith("aifight config "))
    // Skip reference shorthand: <placeholder>, [placeholder], and a|b|c
    // alternation (a real `printf … |` pipe was already stripped above).
    .filter((l) => !l.includes("<") && !l.includes("[") && !l.includes("|"));
}

/** The YAML frontmatter block (between the first pair of `---` fences). */
function frontmatter(md: string): string {
  const m = md.match(/^---\n([\s\S]*?)\n---\n/);
  return m ? m[1] : "";
}

async function runCapture(argv: readonly string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(argv, { stdout: (s) => stdout.push(s), stderr: (s) => stderr.push(s) });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

describe.each(SKILL_PATHS)("%s config commands (doc-as-test)", (_label, skillPath) => {
  const md = fs.readFileSync(skillPath, "utf8");
  const commands = extractConfigCommands(md);

  it("finds the documented headless config examples", () => {
    // Guard against the extractor silently matching nothing (vacuous pass).
    expect(commands.length).toBeGreaterThanOrEqual(3);
    expect(commands.some((c) => c.includes("--protocol claude"))).toBe(true);
    expect(commands.some((c) => c.includes("--protocol compat"))).toBe(true);
  });

  it("every documented config command parses and runs without a usage error", async () => {
    for (const cmd of commands) {
      // aifight config … → argv without the program name.
      let argv = cmd.replace(/^aifight\s+/, "").split(/\s+/);
      // --key-stdin would read process.stdin; swap for an env source to test the
      // rest of the flags (the --key-stdin path itself is covered by unit tests).
      argv = argv.flatMap((t) => (t === "--key-stdin" ? ["--env", "DOCTEST_KEY"] : [t]));
      // Don't spend tokens on a live probe for a doc smoke-test.
      if ((argv[1] === "add" || argv[1] === "update") && !argv.includes("--no-test")) {
        argv.push("--no-test");
      }
      const { code, stderr } = await runCapture(argv);
      // Exit 2 = usage / unknown flag / unknown subcommand → the drift we guard against.
      expect(code, `\`${cmd}\` → exit ${code}\n${stderr}`).not.toBe(2);
      if (argv[1] === "add") {
        expect(code, `\`${cmd}\` should succeed with --no-test\n${stderr}`).toBe(0);
      }
    }
  });

  it("does not reinstate the fixed documentation bugs", () => {
    // The old broken headless instruction used a non-existent profile id.
    expect(md).not.toContain("set-key default");
    // --auto and --approved-local-setup are distinct flags, not aliases.
    expect(md).not.toMatch(/alias[^\n]*--approved-local-setup/);
    expect(md).not.toMatch(/--auto`?\s*\(alias/);
  });
});

describe("skill entry points stay in lockstep", () => {
  const [pub, clawhub] = SKILL_PATHS.map(([, p]) => fs.readFileSync(p, "utf8"));

  it("share the same shell blocks (no per-entry command drift)", () => {
    // If one entry point is fixed and the other is not, the extracted shell
    // blocks diverge here before the stale copy can reach users.
    expect(extractShellLines(pub!)).toEqual(extractShellLines(clawhub!));
  });

  it("have byte-identical YAML frontmatter", () => {
    expect(frontmatter(pub!)).toBe(frontmatter(clawhub!));
  });
});
