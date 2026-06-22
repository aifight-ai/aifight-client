// M1-12 decision: shared types for DecisionRequest / DecisionResponse /
// StrategyProfile / GameType / LegalAction.
//
// Authoritative TS implementation of plan §5.5 (DecisionRequest /
// DecisionResponse / DecisionProvider) + §5.6 (StrategyProfile).
// M1-12 prompt-builder consumes DecisionRequest and emits
// (systemPrompt, userPrompt) for the M1-11 direct-model client;
// M1-14 decision/provider.ts assembles DecisionRequest from
// AgentDecisionContext + strategyProfile + decisionBudgetMs and
// emits DecisionResponse. M1-13 fallback policy consumes only
// LegalAction / DecisionRequest types — never parses LLM output
// (rev3 锁:parser + parse-invalid + retry budget 一律 M1-14).
//
// This module is types-only: no runtime symbols, no fetch, no IO.
// Importers should use `import type { ... } from "./types"`.
//
// Internal-only — not re-exported from runtime/src/index.ts. M1-14
// provider.ts decides the package public surface (M1-12 拍板点 #13).

import type {
  Action,
  CoupRules,
  Event,
  LiarsDiceRules,
  PlayerInfo,
  TexasHoldemRules,
} from "../protocol/types";

// ─── Game type discriminator ────────────────────────────────────────

export type GameType = "texas_holdem" | "liars_dice" | "coup";

// ─── Game-specific rules union ──────────────────────────────────────
//
// Discriminated union mirroring server_game_start.data per game (see
// protocol/types.ts MsgGameStartDataTexasHoldem / LiarsDice / Coup).
// DecisionRequest.rules is typed as the union of the variant payload
// (`GameRules["rules"]`) — caller (M1-14) must guarantee `rules`
// matches `game`.

export type GameRules =
  | { readonly game: "texas_holdem"; readonly rules: TexasHoldemRules }
  | { readonly game: "liars_dice"; readonly rules: LiarsDiceRules }
  | { readonly game: "coup"; readonly rules: CoupRules };

// ─── Legal action alias ─────────────────────────────────────────────
//
// Alias for action_request.data.legal_actions[*]; same shape as the
// common Action envelope (protocol/types.ts:16). Per-game narrowing
// (TexasHoldemAction / LiarsDiceAction / CoupAction) is documented
// in protocol/common/action.schema.json — M1-12 treats LegalAction
// as the permissive envelope and lets prompt-builder render the
// `type` + `data` fields per game-specific param hint.

export type LegalAction = Action;

// ─── Strategy profile (plan §5.6) ───────────────────────────────────
//
// Loaded from ~/.aifight/runtime/agents/<name>/strategy.json by
// M1-14 / scheduler. M1-12 prompt-builder consumes:
//   - systemPrompt — user-controlled persona / strategy text
//   - gameSpecific[game].extraPrompt — per-game adjunct
// `temperature` / `maxTokens` are透 by M1-14 to direct-model client
// (M1-12 拍板点 #12). API key is NOT in this profile — sourced from
// keychain / env var per plan §5.7 layer 2.

export interface GameSpecificProfile {
  readonly extraPrompt?: string;
  /**
   * [0..1] risk-aversion hyperparameter. Information-only for M1-12;
   * consumed by M1-14 (rev3 锁:M1-13 fallback 也不读).
   */
  readonly riskAversion?: number;
}

export interface StrategyProfile {
  readonly name: string;
  readonly version: number;
  readonly provider: "anthropic" | "openai";
  readonly model: string;
  readonly systemPrompt: string;
  readonly temperature?: number;
  readonly maxTokens: number;
  readonly costCapUSDPerMatch?: number;
  readonly gameSpecific?: Partial<Record<GameType, GameSpecificProfile>>;
}

// ─── Decision request (plan §5.5) ───────────────────────────────────
//
// Assembled by M1-14 decision/provider.ts from:
//   - AgentDecisionContext (M1-09 agents/agent.ts) — actionRequest envelope
//   - StrategyProfile loaded from disk
//   - decisionBudgetMs derived from action_request.timeout_ms minus safety margin
//
// M1-12 buildPrompt(req) consumes the full request; M1-13 fallback
// consumes game / legalActions / publicState (typed as unknown —
// fallback uses its own per-game narrowing). The `rules` field is
// typed as the union of game-specific rules variants — caller (M1-14)
// must guarantee `rules` matches `game`.

export interface DecisionRequest {
  readonly game: GameType;
  readonly matchId: string;
  readonly playerId: string;
  /**
   * Game-specific rules from server_game_start.data.rules. Caller
   * must ensure shape matches the `game` discriminator
   * (TexasHoldemRules / LiarsDiceRules / CoupRules per
   * protocol/types.ts MsgGameStartDataTexasHoldem / LiarsDice / Coup).
   */
  readonly rules: GameRules["rules"];
  readonly legalActions: readonly LegalAction[];
  /**
   * Game-specific state from action_request.data.state. Protocol-
   * level shape is opaque (`state: {}` per messages/server_action_
   * request.schema.json); narrowing is per-game. M1-12 prompt-
   * builder dispatches on `game` and treats this as the per-game
   * state shape (TexasHoldemState / LiarsDiceState / CoupState).
   */
  readonly publicState: unknown;
  /**
   * Reserved for future private-narrowed fields. Server currently
   * embeds your_hand / your_dice / your_cards / coins inside
   * publicState; this slot stays optional unknown for forward
   * compatibility (M1-12 Risks #4).
   */
  readonly privateState?: unknown;
  readonly players: readonly PlayerInfo[];
  /**
   * Incremental events since the player's last action_request
   * (action_request.data.new_events). Caller MUST normalize null →
   * [] before constructing DecisionRequest (M1-12 Risks #11; protocol
   * spec allows `new_events: null` on first action_request).
   */
  readonly recentEvents: readonly Event[];
  readonly strategyProfile: StrategyProfile;
  readonly turnTimeoutMs: number;
  readonly decisionBudgetMs: number;
}

// ─── Decision response (plan §5.5) ──────────────────────────────────
//
// Emitted by M1-14 decision/provider.ts after parser + validate +
// (optional) retry/fallback. M1-12 does NOT construct this — only
// describes the expected LLM output JSON shape in the prompt
// (M1-12 拍板点 #6: `{"action", "data", "summary"}`). M1-14 maps
// that JSON to DecisionResponse.action / params / summary, and adds
// providerMetadata from the M1-11 direct-model client response.

export interface DecisionResponseProviderMetadata {
  readonly provider: string;
  readonly model: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUSD?: number;
  readonly latencyMs: number;
  readonly retries?: number;
  readonly fallback?: boolean;
}

export interface DecisionResponse {
  readonly action: string;
  readonly params?: Record<string, unknown>;
  readonly summary?: string;
  readonly providerMetadata: DecisionResponseProviderMetadata;
}
