// Zero-dep argv parser for the aifight CLI.
//
// Supports:
//   --flag value        --flag=value        --flag (boolean true)
//   -v / -h aliases for --version / --help only
//   --                  positional separator (no more flags after)
//
// One-pass scan: any flag declared in `spec` may appear anywhere in argv.
// Tokens that are not flags or flag values become positional in input order.
// Unknown flags push an error but do not abort parsing — the caller decides
// whether to surface a usage error (exit 2) or continue. Repeated flags
// follow last-wins semantics.
//
// Internal-only — not re-exported to the package root.

export type FlagValue = string | number | boolean;

export interface FlagSpec {
  readonly name: string;
  readonly type: "string" | "number" | "boolean";
  readonly required?: boolean;
  readonly default?: FlagValue;
  /**
   * When true, repeated occurrences of this string flag accumulate into a
   * single comma-joined value instead of last-wins. Used by `--feature`
   * (`--feature a=on --feature b=off` → "a=on,b=off"). The consuming handler
   * splits on comma. Only meaningful for `type: "string"`.
   */
  readonly repeatable?: boolean;
}

export interface ParsedArgv {
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, FlagValue>>;
  readonly errors: readonly string[];
}

const SHORT_ALIASES: Readonly<Record<string, string>> = {
  "-v": "version",
  "-h": "help",
};

// A "flag token" is anything that the parser would interpret as a flag
// in the main loop. Value-taking flags MUST NOT consume a flag token as
// their value, otherwise a typo like `--agent --json` silently swallows
// `--json` and skips its boolean parse (M1-17 Step 1b — Codex P2 fix).
//
// `--` literal is included (it starts with `--`); `--agent --` correctly
// emits a missing-value error and lets the next iteration set the
// positional separator. Plain negatives like `-1` are NOT flag tokens —
// `--limit -1` keeps working.
function isFlagToken(token: string): boolean {
  if (token.startsWith("--")) return true;
  return SHORT_ALIASES[token] !== undefined;
}

export function parseArgs(
  argv: readonly string[],
  spec: readonly FlagSpec[],
): ParsedArgv {
  const positional: string[] = [];
  const flags: Record<string, FlagValue> = {};
  const errors: string[] = [];

  const specMap = new Map<string, FlagSpec>();
  for (const s of spec) specMap.set(s.name, s);

  let separatorSeen = false;
  let i = 0;
  while (i < argv.length) {
    const token = argv[i]!;

    if (separatorSeen) {
      positional.push(token);
      i += 1;
      continue;
    }

    if (token === "--") {
      separatorSeen = true;
      i += 1;
      continue;
    }

    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      const name = eqIdx >= 0 ? token.slice(2, eqIdx) : token.slice(2);
      const inlineValue = eqIdx >= 0 ? token.slice(eqIdx + 1) : undefined;

      const s = specMap.get(name);
      if (!s) {
        errors.push(`unknown flag: --${name}`);
        i += 1;
        continue;
      }

      if (s.type === "boolean") {
        if (inlineValue === undefined) {
          flags[name] = true;
        } else if (inlineValue === "true") {
          flags[name] = true;
        } else if (inlineValue === "false") {
          flags[name] = false;
        } else {
          errors.push(`flag --${name} expects no value (got "${inlineValue}")`);
        }
        i += 1;
        continue;
      }

      let value: string;
      if (inlineValue !== undefined) {
        value = inlineValue;
        i += 1;
      } else {
        const nextToken = argv[i + 1];
        if (nextToken === undefined || isFlagToken(nextToken)) {
          errors.push(`flag --${name} requires a value`);
          i += 1;
          continue;
        }
        value = nextToken;
        i += 2;
      }

      if (s.type === "number") {
        if (!/^-?\d+(\.\d+)?$/.test(value)) {
          errors.push(`flag --${name} requires a number (got "${value}")`);
          continue;
        }
        flags[name] = Number(value);
        continue;
      }

      // Repeatable string flags accumulate (comma-joined) instead of last-wins,
      // so `--feature a=on --feature b=off` yields "a=on,b=off". Non-repeatable
      // flags keep last-wins.
      if (s.repeatable && typeof flags[name] === "string") {
        flags[name] = `${flags[name] as string},${value}`;
      } else {
        flags[name] = value;
      }
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      const aliasName = SHORT_ALIASES[token];
      if (!aliasName) {
        errors.push(`unknown flag: ${token}`);
        i += 1;
        continue;
      }
      const s = specMap.get(aliasName);
      if (!s || s.type !== "boolean") {
        errors.push(`unknown flag: ${token}`);
        i += 1;
        continue;
      }
      flags[aliasName] = true;
      i += 1;
      continue;
    }

    positional.push(token);
    i += 1;
  }

  for (const s of spec) {
    if (s.default !== undefined && flags[s.name] === undefined) {
      flags[s.name] = s.default;
    }
  }

  for (const s of spec) {
    if (s.required && flags[s.name] === undefined) {
      errors.push(`missing required flag: --${s.name}`);
    }
  }

  return { positional, flags, errors };
}
