// Shared helpers for the headless `aifight config` commands (add / update /
// models / remove / clear-key). Kept separate from config.ts so the pure
// helpers — protocol alias resolution, the four-part error formatter, the
// did-you-mean suggester, and typed flag getters — are unit-testable without a
// TTY or filesystem.
//
// Design authority: docs/agent-bridge/CLI_LLM_CONFIG_COMMANDS_SPEC.md
//   D2  protocol aliases
//   D13 four-part error standard (problem / valid values / example / next step)
//   D14 did-you-mean (Levenshtein ≤ 2)

import { CommandError } from "../shared.js";
import type {
  LLMProfile,
  Protocol,
  ReasoningEffort,
  SecretRef,
} from "../../profile/config-schema.js";

// ─── D2: protocol aliases ────────────────────────────────────────────
//
// The four friendly aliases match the interactive wizard's provider menu
// (ONBOARD_PROVIDERS). Their canonical protocol names are accepted too, plus
// the remaining schema-valid protocol names as a power-user pass-through — the
// config validator accepts those regardless, so blocking them here would only
// force a hand-edit of config.json.

/** Friendly alias → canonical protocol. Shown first in errors (the common path). */
export const PROTOCOL_ALIASES: Readonly<Record<string, Protocol>> = {
  claude: "anthropic_messages",
  gpt: "openai_responses",
  compat: "openai_chat_compat",
  gemini: "gemini_generate_content",
};

/** Which provider each friendly alias targets (for the D13 error listing). */
const ALIAS_PROVIDER_HINT: Readonly<Record<string, string>> = {
  claude: "Anthropic Claude",
  gpt: "OpenAI GPT (Responses API)",
  compat: "OpenAI-compatible: DeepSeek / GLM / Minimax / Qwen / …",
  gemini: "Google Gemini",
};

/** All canonical protocol names the config schema accepts. */
const CANONICAL_PROTOCOLS: ReadonlySet<Protocol> = new Set<Protocol>([
  "anthropic_messages",
  "openai_responses",
  "openai_chat_completions",
  "openai_chat_compat",
  "deepseek_chat_completions",
  "gemini_generate_content",
  "gemini_openai_compat",
]);

/** The alias whose canonical name equals a compat protocol (needs base-url + model). */
export function protocolRequiresBaseURLAndModel(protocol: Protocol): boolean {
  // These protocols have no canonical default base URL / default model — the
  // user must supply both (D3). openai_chat_compat and gemini_openai_compat are
  // both "point me at any compatible endpoint" protocols.
  return protocol === "openai_chat_compat" || protocol === "gemini_openai_compat";
}

/** One human line listing the friendly protocol choices for D13 errors. */
export function protocolChoicesHint(): string {
  const lines = Object.keys(PROTOCOL_ALIASES).map(
    (alias) => `    ${alias.padEnd(8)}${ALIAS_PROVIDER_HINT[alias] ?? ""}`,
  );
  return ["Valid --protocol values:", ...lines, "  (canonical protocol names are also accepted)"].join("\n");
}

/**
 * Resolve a `--protocol` value (alias or canonical name) to a canonical
 * Protocol. Returns undefined for an unrecognized value (caller builds the
 * D13 error, optionally with a did-you-mean).
 */
export function resolveProtocol(input: string): Protocol | undefined {
  const key = input.trim().toLowerCase();
  if (key in PROTOCOL_ALIASES) return PROTOCOL_ALIASES[key];
  if (CANONICAL_PROTOCOLS.has(key as Protocol)) return key as Protocol;
  return undefined;
}

/** Candidate strings a mistyped --protocol is matched against (for did-you-mean). */
export function protocolSuggestionPool(): string[] {
  return [...Object.keys(PROTOCOL_ALIASES), ...CANONICAL_PROTOCOLS];
}

// ─── shared help: copy-pasteable examples (§8.3) ─────────────────────

/** Example block appended to `config --help` and the config usage string, so a
 *  headless agent has ready-to-copy commands for the common flows. */
export const CONFIG_EXAMPLES: readonly string[] = [
  "Examples:",
  "  # DeepSeek / GLM / Qwen (OpenAI-compatible) — base URL + model required:",
  "  aifight config add deepseek --protocol compat \\",
  "      --base-url https://api.deepseek.com/v1 --model deepseek-chat --env DEEPSEEK_API_KEY",
  "  # Claude — shortest path (official base URL + default model):",
  "  aifight config add claude --protocol claude --env ANTHROPIC_API_KEY",
  "  # Pipe the key instead of naming an env var (raw key never in argv):",
  '  printf %s "$OPENAI_API_KEY" | aifight config add gpt --protocol gpt --key-stdin',
  "  # List a provider's models, then switch:",
  "  aifight config models deepseek",
  "  aifight config update deepseek --model deepseek-v4-pro",
  "  # Manage:",
  "  aifight config clear-key deepseek     # delete the stored key file (profile stays)",
  "  aifight config remove deepseek        # delete the profile",
];

// ─── D13: four-part error ────────────────────────────────────────────

export interface RichErrorParts {
  /** What went wrong (the CommandError message). */
  readonly problem: string;
  /** Valid values or expected format (one or more lines). */
  readonly valid?: string;
  /** One copy-pasteable correct command. */
  readonly example?: string;
  /** The next step to take. */
  readonly next?: string;
}

/**
 * Build a CommandError whose hint carries the D13 four-part guidance. The
 * main.ts funnel prints `message` then the hint lines (human mode) or emits a
 * JSON error envelope with `{ hint }` (JSON mode).
 */
export function configError(code: string, parts: RichErrorParts): CommandError {
  const hint: string[] = [];
  if (parts.valid) hint.push(parts.valid);
  if (parts.example) hint.push(`Example: ${parts.example}`);
  if (parts.next) hint.push(parts.next);
  return new CommandError(code, parts.problem, hint.length > 0 ? { hint: hint.join("\n") } : {});
}

// ─── D14: did-you-mean (Levenshtein ≤ 2) ─────────────────────────────

/** Classic iterative Levenshtein distance (small inputs, no need to optimize). */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

/**
 * Closest candidate within `maxDistance` edits, or undefined. Ties resolve to
 * the first candidate in list order.
 */
export function suggestClosest(
  input: string,
  candidates: readonly string[],
  maxDistance = 2,
): string | undefined {
  let best: string | undefined;
  let bestD = maxDistance + 1;
  const needle = input.trim().toLowerCase();
  for (const c of candidates) {
    const d = levenshtein(needle, c.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

// ─── D12: --feature parsing ──────────────────────────────────────────

/**
 * Parse the (comma-joined) `--feature` flag value into a boolean map. Accepts
 * `key=on|off|true|false` items. Returns an error string on any malformed item
 * so the caller can raise a D13 error. An empty/undefined input yields `{}`.
 */
export function parseFeatureFlags(
  raw: string | undefined,
): { ok: true; features: Record<string, boolean> } | { ok: false; error: string } {
  const features: Record<string, boolean> = {};
  if (raw === undefined || raw.trim() === "") return { ok: true, features };
  for (const item of raw.split(",")) {
    const part = item.trim();
    if (part === "") continue;
    const eq = part.indexOf("=");
    if (eq <= 0) {
      return { ok: false, error: `"${part}" — expected key=on|off` };
    }
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim().toLowerCase();
    if (key === "") return { ok: false, error: `"${part}" — empty feature key` };
    if (val === "on" || val === "true") features[key] = true;
    else if (val === "off" || val === "false") features[key] = false;
    else return { ok: false, error: `"${part}" — value must be on|off (got "${val}")` };
  }
  return { ok: true, features };
}

// ─── D1: shared LLM profile builder ──────────────────────────────────
//
// The single source of truth for the SHAPE of an LLM profile (defaults for
// responseFormat / timeouts / retries, and the thinking block).
// Both the interactive wizard (onboard-llm.ts profileFor) and the headless
// `config add`/`update` commands build profiles through this, so a profile
// configured either way is byte-identical.

export interface ProfileBuildSettings {
  /** Reasoning on/off. */
  readonly thinkingEnabled: boolean;
  /** Reasoning effort (only meaningful when thinking is on and the model exposes levels). */
  readonly effort?: ReasoningEffort;
  /** Output-token ceiling. */
  readonly maxTokens: number;
  /** Per-call LLM request timeout in ms (user-settable). Omit → default 270000. */
  readonly requestTimeoutMs?: number;
  /** SSE streaming preference. */
  readonly stream: "auto" | "always" | "never";
  /** null = omit temperature (provider default). */
  readonly temperature: number | null;
  /** OpenAI Responses output verbosity (omitted when undefined). */
  readonly verbosity?: "low" | "medium" | "high";
  /** Model-specific opt-in feature flags (omitted when empty). */
  readonly features?: Record<string, boolean>;
}

/**
 * Build an LLMProfile from normalized inputs. Keep this identical in output to
 * what the wizard produced historically when verbosity/features are absent —
 * the wizard's `profileFor` now delegates here.
 */
export function buildLLMProfile(input: {
  readonly displayName: string;
  readonly protocol: Protocol;
  readonly baseURL?: string;
  readonly apiKeyRef: SecretRef;
  readonly model: string;
  readonly settings: ProfileBuildSettings;
}): LLMProfile {
  const s = input.settings;
  const thinking: NonNullable<LLMProfile["thinking"]> = s.thinkingEnabled
    ? { enabled: true, mode: "always", ...(s.effort ? { effort: s.effort } : {}) }
    : { enabled: false, mode: "never" };
  const hasFeatures = s.features !== undefined && Object.keys(s.features).length > 0;
  return {
    displayName: input.displayName,
    protocol: input.protocol,
    ...(input.baseURL ? { baseURL: input.baseURL } : {}),
    apiKeyRef: input.apiKeyRef,
    model: input.model,
    request: {
      temperature: s.temperature,
      maxTokens: s.maxTokens,
      responseFormat: "json",
      stream: s.stream,
      ...(s.verbosity ? { verbosity: s.verbosity } : {}),
      ...(hasFeatures ? { features: s.features } : {}),
    },
    thinking,
    timeouts: { requestMs: s.requestTimeoutMs ?? 270000 },
    retries: { maxAttempts: 2 },
  };
}

// ─── typed flag getters ──────────────────────────────────────────────

type Flags = Readonly<Record<string, string | number | boolean>>;

export function stringFlag(flags: Flags, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

export function boolFlag(flags: Flags, name: string): boolean {
  return flags[name] === true;
}

export function numberFlag(flags: Flags, name: string): number | undefined {
  const v = flags[name];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Parse a tri-state on/off flag value (string form), returning undefined if absent. */
export function onOffFlag(
  flags: Flags,
  name: string,
): { ok: true; value?: boolean } | { ok: false; error: string } {
  const v = stringFlag(flags, name);
  if (v === undefined) return { ok: true };
  const low = v.toLowerCase();
  if (low === "on" || low === "true") return { ok: true, value: true };
  if (low === "off" || low === "false") return { ok: true, value: false };
  return { ok: false, error: `must be on|off (got "${v}")` };
}
