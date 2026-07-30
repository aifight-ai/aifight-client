// The styled help (owner ask 2026-07-30: "beautify the CLI comprehensively,
// including the -h/--help commands"). One data source renders both the
// colored TTY version and the plain piped/--json one; these tests pin the
// layout, the coverage (every known command), and both color modes — with
// color assertions built through the ansi helper, never literal escapes.

import { describe, expect, it } from "vitest";

import { createAnsi, stripAnsi } from "../src/cli/ansi";
import { renderGlobalHelp, styleSubcommandUsage } from "../src/cli/help";
import { KNOWN_COMMANDS, run } from "../src/cli/main";
import { RUNTIME_VERSION } from "../src/index";

const PLAIN = createAnsi({ enabled: false });
const COLOR = createAnsi({ enabled: true });

async function runCapture(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

describe("global help layout (plain mode)", () => {
  const help = renderGlobalHelp(PLAIN);

  it("leads with the slim one-line header: name, tagline, version", () => {
    const first = help.split("\n")[0]!;
    expect(first).toBe(`AIFight CLI — AI fights AI. Bring yours. · v${RUNTIME_VERSION}`);
  });

  it("covers every known command — nothing dropped in the redesign", () => {
    expect(KNOWN_COMMANDS).toHaveLength(25);
    for (const cmd of KNOWN_COMMANDS) {
      expect(help, `aifight ${cmd}`).toContain(`aifight ${cmd}`);
    }
    // `run` used to be missing from the global help; it is listed now.
    expect(help).toMatch(/^ {2}aifight run +Advanced: run the outbound Bridge/m);
  });

  it("aligns every description to one second column", () => {
    const lines = help.split("\n");
    const descColumn = (usagePrefix: string, descPrefix: string): number => {
      const line = lines.find((l) => l.startsWith(`  ${usagePrefix} `) && l.includes(descPrefix));
      expect(line, usagePrefix).toBeDefined();
      return line!.indexOf(descPrefix);
    };
    const a = descColumn("aifight setup", "Guided setup:");
    const b = descColumn("aifight connect <PAIRING_CODE>", "Authorize this machine");
    const c = descColumn("--approved-local-setup", "setup only:");
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("keeps the group structure and the footer", () => {
    for (const title of [
      "First run (set up this machine):",
      "Play:",
      "Tune your agent (adjust any time):",
      "Manage this machine:",
      "Global flags:",
    ]) {
      expect(help).toContain(title);
    }
    expect(help).toContain("Supported games for manual matches: texas_holdem, liars_dice, coup");
    expect(help).toContain("Challenge games in this release: texas_holdem, liars_dice, coup");
    // Plain mode is genuinely plain: no SGR codes at all.
    expect(help).not.toContain("\x1b[");
  });
});

describe("global help colors (forced on)", () => {
  const help = renderGlobalHelp(COLOR);

  it("is the same layout underneath the color", () => {
    expect(stripAnsi(help)).toBe(renderGlobalHelp(PLAIN));
  });

  it("styles header bold, group titles yellow, commands cyan, flags dim", () => {
    expect(help).toContain(COLOR.bold(`AIFight CLI — AI fights AI. Bring yours. · v${RUNTIME_VERSION}`));
    expect(help).toContain(COLOR.yellow("Play:"));
    expect(help).toContain(COLOR.cyan("aifight setup"));
    expect(help).toContain(COLOR.dim("--json"));
  });

  it("still covers every known command once the codes are stripped", () => {
    const plain = stripAnsi(help);
    for (const cmd of KNOWN_COMMANDS) {
      expect(plain, `aifight ${cmd}`).toContain(`aifight ${cmd}`);
    }
  });
});

describe("subcommand help styling", () => {
  const usage = [
    "Usage: aifight start [game] [N]",
    "  Request manual ranked match(es) through the running Bridge.",
    "  --live: ask the RUNNING bridge for realtime state.",
  ].join("\n");

  it("passes through byte-identical when colors are off", () => {
    expect(styleSubcommandUsage(usage, PLAIN)).toBe(usage);
  });

  it("bolds Usage:, cyans the command, dims the flags when colored", () => {
    const styled = styleSubcommandUsage(usage, COLOR);
    expect(styled).toContain(COLOR.bold("Usage:"));
    expect(styled).toContain(COLOR.cyan("aifight start"));
    expect(styled).toContain(COLOR.dim("--live"));
    // Visible text unchanged.
    expect(stripAnsi(styled)).toBe(usage);
  });
});

describe("help through the CLI funnel", () => {
  it("`aifight --help --json` stays machine-readable: JSON envelope, no color codes", async () => {
    const r = await runCapture(["--help", "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as { help: string };
    expect(parsed.help).toContain("aifight setup");
    expect(parsed.help).toContain("aifight run");
    expect(parsed.help).not.toContain("\x1b[");
  });

  it("bare non-TTY invocation prints the grouped help (the scriptable path)", async () => {
    // process.stdin/stdout are not TTYs under the test runner, so a bare run
    // takes the non-interactive path — which must stay plain and complete.
    const r = await runCapture([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`AIFight CLI — AI fights AI. Bring yours. · v${RUNTIME_VERSION}`);
    expect(r.stdout).not.toContain("\x1b[");
  });

  it("`aifight <cmd> --help` keeps working and stays plain off-TTY", async () => {
    const r = await runCapture(["start", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage: aifight start [game] [N]");
    expect(r.stdout).not.toContain("\x1b[");
  });
});
