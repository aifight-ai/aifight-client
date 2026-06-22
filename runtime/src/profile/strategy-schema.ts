/**
 * strategy-schema.ts
 *
 * TypeScript schema, types, validator, and default constant for the AIFight
 * daemon's strategy.json file.
 *
 * Scope: game-specific competitive tactics ONLY.
 * No LLM config, no model settings, no API keys.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RiskAppetite =
  | "very-low"
  | "low"
  | "medium-low"
  | "medium"
  | "medium-high"
  | "high"
  | "very-high";

export interface GlobalStrategy {
  /** Broad risk posture that governs all games. */
  riskAppetite: RiskAppetite;
  /** High-level objectives listed in priority order. */
  objectives: string[];
  /** Prose description of the preferred decision style. */
  decisionStyle: string;
  /** Fallback behaviour when the agent is uncertain or close to timeout. */
  fallbackStyle: string;
}

/**
 * Per-game strategy block.
 *
 * Every game entry must have a `riskAversion` number in [0, 1] and a
 * `profile` string summarising the overall approach.  All other keys are
 * game-specific prose fields and are allowed freely.
 */
export interface GameStrategy {
  /** One-line summary of the playing style for this game. */
  profile: string;
  /**
   * Risk-aversion scalar in [0, 1].
   * 0 = maximally aggressive, 1 = maximally conservative.
   */
  riskAversion: number;
  /** Any additional game-specific string fields (bidding, challenge, etc.). */
  [key: string]: string | number;
}

export interface StrategyMeta {
  createdBy: string;
  createdAt: string;       // ISO 8601
  lastUpdatedAt: string;   // ISO 8601
}

export interface Strategy {
  schemaVersion: 1;
  /** Monotonically increasing user-managed version for this strategy file. */
  version: number;
  /** Human-readable strategy name. */
  name: string;
  global: GlobalStrategy;
  /** Map of game ID (e.g. "texas_holdem") → per-game strategy. */
  games: Record<string, GameStrategy>;
  meta: StrategyMeta;
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

type ValidationResult =
  | { ok: true; strategy: Strategy }
  | { ok: false; errors: string[] };

const VALID_RISK_APPETITES = new Set<string>([
  "very-low",
  "low",
  "medium-low",
  "medium",
  "medium-high",
  "high",
  "very-high",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((item) => typeof item === "string");
}

/**
 * Validate a raw (parsed) JSON value as a Strategy.
 *
 * Returns a typed Strategy on success, or a list of human-readable error
 * messages on failure.  Does NOT throw.
 */
export function validateStrategy(raw: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isRecord(raw)) {
    return { ok: false, errors: ["Root value must be a JSON object."] };
  }

  // schemaVersion
  if (raw["schemaVersion"] !== 1) {
    errors.push(`schemaVersion must be 1 (got ${JSON.stringify(raw["schemaVersion"])}).`);
  }

  // version
  if (typeof raw["version"] !== "number" || !Number.isInteger(raw["version"]) || raw["version"] < 1) {
    errors.push("version must be a positive integer.");
  }

  // name
  if (typeof raw["name"] !== "string" || raw["name"].trim() === "") {
    errors.push("name must be a non-empty string.");
  }

  // global
  if (!isRecord(raw["global"])) {
    errors.push("global must be an object.");
  } else {
    const g = raw["global"];

    if (typeof g["riskAppetite"] !== "string" || !VALID_RISK_APPETITES.has(g["riskAppetite"] as string)) {
      errors.push(
        `global.riskAppetite must be one of: ${[...VALID_RISK_APPETITES].join(", ")}.`
      );
    }

    if (!isStringArray(g["objectives"]) || (g["objectives"] as string[]).length === 0) {
      errors.push("global.objectives must be a non-empty array of strings.");
    }

    if (typeof g["decisionStyle"] !== "string" || g["decisionStyle"].trim() === "") {
      errors.push("global.decisionStyle must be a non-empty string.");
    }

    if (typeof g["fallbackStyle"] !== "string" || g["fallbackStyle"].trim() === "") {
      errors.push("global.fallbackStyle must be a non-empty string.");
    }
  }

  // games
  if (!isRecord(raw["games"])) {
    errors.push("games must be an object.");
  } else {
    const games = raw["games"] as Record<string, unknown>;
    for (const [gameId, gameRaw] of Object.entries(games)) {
      if (!isRecord(gameRaw)) {
        errors.push(`games.${gameId} must be an object.`);
        continue;
      }

      if (typeof gameRaw["profile"] !== "string" || (gameRaw["profile"] as string).trim() === "") {
        errors.push(`games.${gameId}.profile must be a non-empty string.`);
      }

      const ra = gameRaw["riskAversion"];
      if (typeof ra !== "number" || ra < 0 || ra > 1) {
        errors.push(`games.${gameId}.riskAversion must be a number in [0, 1].`);
      }

      // Additional keys must be strings or numbers (no nested objects/arrays).
      for (const [k, v] of Object.entries(gameRaw)) {
        if (k === "profile" || k === "riskAversion") continue;
        if (typeof v !== "string" && typeof v !== "number") {
          errors.push(
            `games.${gameId}.${k} must be a string or number (got ${typeof v}).`
          );
        }
      }
    }
  }

  // meta
  if (!isRecord(raw["meta"])) {
    errors.push("meta must be an object.");
  } else {
    const m = raw["meta"];
    if (typeof m["createdBy"] !== "string" || (m["createdBy"] as string).trim() === "") {
      errors.push("meta.createdBy must be a non-empty string.");
    }
    if (typeof m["createdAt"] !== "string") {
      errors.push("meta.createdAt must be an ISO 8601 string.");
    }
    if (typeof m["lastUpdatedAt"] !== "string") {
      errors.push("meta.lastUpdatedAt must be an ISO 8601 string.");
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, strategy: raw as unknown as Strategy };
}

// ---------------------------------------------------------------------------
// Default strategy
// ---------------------------------------------------------------------------

export const DEFAULT_STRATEGY: Strategy = {
  schemaVersion: 1,
  version: 1,
  name: "default-disciplined-strategy",
  global: {
    riskAppetite: "medium-low",
    objectives: [
      "maximize long-term expected rating gain",
      "avoid illegal or timeout actions",
      "adapt to opponent behavior",
    ],
    decisionStyle: "probability-first with controlled aggression",
    fallbackStyle: "safe legal action when uncertain or under timeout",
  },
  games: {
    texas_holdem: {
      profile: "tight-aggressive with position awareness",
      preflop:
        "Play tight from early position; widen range in late position; avoid marginal all-ins.",
      postflop:
        "Use pot odds, board texture, and opponent aggression. Bluff selectively when story is coherent.",
      riskAversion: 0.35,
    },
    liars_dice: {
      profile: "Bayesian pressure with opponent tendency tracking",
      bidding:
        "Increase bids when posterior probability and table pressure support it.",
      challenge:
        "Challenge when bid probability falls below threshold adjusted by opponent bluff frequency.",
      riskAversion: 0.4,
    },
    coup: {
      profile: "memory-driven deception and challenge control",
      claims: "Make plausible claims and track contradictions.",
      challenge:
        "Challenge only when opponent history or impossible state strongly supports it.",
      riskAversion: 0.45,
    },
  },
  meta: {
    createdBy: "setup_wizard",
    createdAt: "2026-04-30T00:00:00Z",
    lastUpdatedAt: "2026-04-30T00:00:00Z",
  },
};
