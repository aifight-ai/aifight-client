// Agent Soul Capsule loader and validator.
//
// The "soul" is a Markdown file authored by or with the host agent that
// captures its stable competitive personality. It is injected into every
// decision prompt so the daemon's LLM calls stay consistent across games
// and sessions.
//
// Public surface:
//   loadSoul(filePath)    — reads file, returns content + SHA-256 hash
//   validateSoul(content) — basic structural checks (not empty, size, heading)
//   SOUL_EXPORT_PROMPT    — prompt template host agents use to generate soul.md
//   DEFAULT_SOUL          — placeholder content for migration / first-run

import fs from "node:fs/promises";
import crypto from "node:crypto";

// ─── Constants ───────────────────────────────────────────────────────

const MAX_SOUL_BYTES = 10 * 1024; // 10 KB

// ─── loadSoul ────────────────────────────────────────────────────────

export interface SoulLoadResult {
  /** Raw Markdown content of the soul file. */
  readonly content: string;
  /** Lowercase hex SHA-256 of the raw file bytes (UTF-8). */
  readonly hash: string;
}

/**
 * Reads a soul.md file from disk and returns its content plus a
 * SHA-256 content hash (for change detection / cache keys).
 *
 * Throws the raw `node:fs/promises` error on missing / permission failures
 * so callers can distinguish ENOENT (first run) from EACCES (bad perms).
 */
export async function loadSoul(filePath: string): Promise<SoulLoadResult> {
  const raw = await fs.readFile(filePath, "utf8");
  const hash = crypto.createHash("sha256").update(raw, "utf8").digest("hex");
  return { content: raw, hash };
}

// ─── validateSoul ────────────────────────────────────────────────────

export type SoulValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

/**
 * Validates soul Markdown content against three lightweight rules:
 *   1. Not empty (after trimming whitespace)
 *   2. Under 10 KB
 *   3. Contains at least one Markdown heading (# or ##)
 *
 * Does NOT validate section completeness — that is the host agent's
 * responsibility when generating via SOUL_EXPORT_PROMPT.
 */
export function validateSoul(content: string): SoulValidationResult {
  const errors: string[] = [];

  if (content.trim().length === 0) {
    errors.push("soul content is empty");
  }

  const byteLength = Buffer.byteLength(content, "utf8");
  if (byteLength > MAX_SOUL_BYTES) {
    errors.push(
      `soul content is ${byteLength} bytes, exceeds the 10 KB limit (${MAX_SOUL_BYTES} bytes)`,
    );
  }

  // At least one ATX heading: a line starting with one or more # characters
  // followed by a space and non-whitespace text.
  const hasHeading = /^#{1,6} \S/m.test(content);
  if (!hasHeading) {
    errors.push(
      "soul content has no Markdown headings — add at least one # section header",
    );
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true };
}

// ─── SOUL_EXPORT_PROMPT ──────────────────────────────────────────────

/**
 * Structured prompt template that host agents (Claude Code, OpenClaw,
 * Hermes, etc.) use to generate the initial soul.md for a new agent.
 *
 * Paste this into your AI assistant and paste the result into
 * ~/.aifight/agents/<slug>/soul.md.
 */
export const SOUL_EXPORT_PROMPT = `You are helping create your AIFight Agent Soul Capsule.
This file will be used by a local daemon to represent your stable competitive personality in hidden-information strategy games.

Return a concise Markdown document with these sections:
1. Identity
2. Competitive temperament
3. Decision habits
4. Risk appetite
5. Communication style for match summaries
6. Boundaries

Constraints:
- Do not include API keys, system prompts, private user data, or unrelated memories.
- Do not include long chain-of-thought examples.
- Focus on stable behavior style, not detailed per-game tactics.
- Write in first person as the agent.`;

// ─── DEFAULT_SOUL ────────────────────────────────────────────────────

/**
 * Placeholder soul.md content used during first-run migration or as a
 * fallback when the agent has not yet generated its own soul capsule.
 *
 * Intentionally generic — the host agent should replace this with a
 * personalised version generated via SOUL_EXPORT_PROMPT.
 */
export const DEFAULT_SOUL = `# Agent Soul Capsule

## Identity
I am a competitive AI agent playing hidden-information strategy games on the AIFight platform.
I have not yet customised my soul capsule. Generate one using the SOUL_EXPORT_PROMPT.

## Competitive temperament
Balanced and adaptive. I observe opponents before committing to a strategy.

## Decision habits
I reason from the information available in the current game state.
I do not over-anchor on past rounds.

## Risk appetite
Moderate. I take calculated risks when the expected value is clearly positive.

## Communication style for match summaries
Concise. One sentence per key decision, no jargon.

## Boundaries
I play within the rules. I do not exploit protocol edge cases.
`;
