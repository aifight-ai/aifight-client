// M1-14 decision provider facade.
//
// Composes the M1-12 prompt-builder, M1-11 direct-model HTTP clients,
// M1-14 per-game LLM action parsers, retry budget, and M1-13 fallback
// dispatch into the plan §5.5 `DecisionProvider` interface. The first
// concrete implementation is `createDirectModelProvider` (factory).
//
// Authoritative location of the `DecisionProvider` /
// `DirectModelProviderOptions` / concrete `DecisionProviderError` /
// `DecisionProviderErrorKind` symbols (M1-14 TED rev3 lock — they MUST
// NOT be defined in `./types`, which is M1-12 sealed). The
// `DirectModelProviderName` union lives in `./direct-model/types`
// (M1-11 sealed); this file only `import type` + `export type`
// re-exports it so callers have a single surface origin.

import { fallbackTexasHoldem } from "../games/texas_holdem/fallback";
import { fallbackLiarsDice } from "../games/liars_dice/fallback";
import { fallbackCoup } from "../games/coup/fallback";
import { parseTexasHoldemAction } from "../games/texas_holdem/action-parser";
import { parseLiarsDiceAction } from "../games/liars_dice/action-parser";
import { parseCoupAction } from "../games/coup/action-parser";
import { buildPrompt } from "./prompt-builder";
import { createAnthropicClient } from "./direct-model/anthropic";
import { createOpenAIClient } from "./direct-model/openai";
import {
  DirectModelAbortedError,
  DirectModelHttpError,
  DirectModelInvalidResponseError,
  DirectModelNetworkError,
  DirectModelUnsupportedError,
} from "./direct-model/errors";
import type {
  DirectModelClient,
  DirectModelGenerateResponse,
  DirectModelProviderName,
} from "./direct-model/types";
import type { ParseResult } from "./parser-types";
import type {
  CoupState,
  LiarsDiceState,
  TexasHoldemState,
} from "../protocol/types";
import type {
  DecisionRequest,
  DecisionResponse,
  GameType,
  LegalAction,
} from "./types";

// Re-export the M1-11 sealed provider-name union so consumers reach it
// through `./decision/provider` instead of the M1-11 internal path.
// Step 3 (root re-export) wires it through to `@aifight/aifight`.
export type { DirectModelProviderName } from "./direct-model/types";

// ─── DecisionProvider interface (plan §5.5) ─────────────────────────

export interface DecisionProvider {
  readonly name: string;
  decide(req: DecisionRequest): Promise<DecisionResponse>;
  healthCheck(): Promise<boolean>;
}

// ─── factory options ────────────────────────────────────────────────

export interface DirectModelProviderOptions {
  /** Identifier for this provider instance. plan §5.5
   *  DecisionProvider.name. */
  readonly name: string;
  /** Returns API key for the given (provider, model). Caller decides
   *  the source (env / keychain / file per plan §5.7 layer 2). Must be
   *  synchronous so the factory itself stays sync. Returning an empty
   *  string causes `decide()` to throw a fatal_unsupported error and
   *  `healthCheck()` to return false. */
  readonly apiKeyResolver: (
    provider: DirectModelProviderName,
    model: string,
  ) => string;
  /** Override for the direct-model client factories (testing). When
   *  omitted, defaults to the M1-11 `createAnthropicClient` /
   *  `createOpenAIClient`. */
  readonly clientFactory?: {
    readonly anthropic?: typeof createAnthropicClient;
    readonly openai?: typeof createOpenAIClient;
  };
  /** Default 2. Total LLM calls = 1 + retryBudget. */
  readonly retryBudget?: number;
  /** Default 500. Max chars of raw LLM output threaded into the
   *  corrective re-prompt. */
  readonly parseRetryHintCharCap?: number;
  /** Override for transport. Passed through to the client factory. */
  readonly fetchImpl?: typeof fetch;
  /** Explicit healthCheck target. When omitted, `healthCheck()`
   *  returns false (catch-all consistent with the
   *  `Promise<boolean>` contract). M1-14 rev3 锁:无 profile → false。 */
  readonly healthCheckProfile?: {
    readonly provider: DirectModelProviderName;
    readonly model: string;
  };
}

// ─── DecisionProviderError (concrete, 4 fatal kinds) ────────────────

export type DecisionProviderErrorKind =
  // HTTP 4xx non-429 — API key / model bug; daemon should surface,
  // not silently fallback.
  | "fatal_http"
  // signal aborted / decisionBudgetMs exhausted / caller cancel.
  | "fatal_aborted"
  // opts validation / apiKey empty / direct-model client builder
  // rejected the synchronous opts.
  | "fatal_unsupported"
  // req shape wrong (decisionBudgetMs <= 0, game not in enum,
  // legalActions empty during fallback dispatch, Coup phase=done, etc).
  | "fatal_caller_bug";

export class DecisionProviderError extends Error {
  override readonly name = "DecisionProviderError";
  readonly kind: DecisionProviderErrorKind;
  override readonly cause: unknown;

  constructor(
    kind: DecisionProviderErrorKind,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.kind = kind;
    this.cause = cause;
  }
}

// ─── factory ────────────────────────────────────────────────────────

const DEFAULT_RETRY_BUDGET = 2;
const DEFAULT_RETRY_HINT_CHAR_CAP = 500;

export function createDirectModelProvider(
  opts: DirectModelProviderOptions,
): DecisionProvider {
  const retryBudget = opts.retryBudget ?? DEFAULT_RETRY_BUDGET;
  const retryHintCharCap =
    opts.parseRetryHintCharCap ?? DEFAULT_RETRY_HINT_CHAR_CAP;

  // M1-14 Step 2b: validate option shape at construction time.
  // Reject retryBudget < 0 / non-integer / NaN — otherwise a value
  // like -1 would skip every LLM attempt and silently jump straight
  // to fallback. parseRetryHintCharCap must be a positive integer
  // because it propagates into per-game parsers as the rawSnippet
  // truncation length.
  if (
    !Number.isFinite(retryBudget) ||
    !Number.isInteger(retryBudget) ||
    retryBudget < 0
  ) {
    throw new DecisionProviderError(
      "fatal_caller_bug",
      `retryBudget must be a non-negative integer (got ${String(opts.retryBudget)})`,
    );
  }
  if (
    !Number.isFinite(retryHintCharCap) ||
    !Number.isInteger(retryHintCharCap) ||
    retryHintCharCap <= 0
  ) {
    throw new DecisionProviderError(
      "fatal_caller_bug",
      `parseRetryHintCharCap must be a positive integer (got ${String(opts.parseRetryHintCharCap)})`,
    );
  }

  const clients = new Map<string, DirectModelClient>();

  function resolveClient(
    provider: DirectModelProviderName,
    model: string,
  ): DirectModelClient {
    const key = `${provider}:${model}`;
    const cached = clients.get(key);
    if (cached) return cached;

    let apiKey: string;
    try {
      apiKey = opts.apiKeyResolver(provider, model);
    } catch (cause) {
      // Step 2b: wrap a throwing apiKeyResolver — never raw-leak the
      // caller's error to upstream catchers (which expect a
      // DecisionProviderError surface). Original throw is preserved
      // in `cause`.
      throw new DecisionProviderError(
        "fatal_unsupported",
        `apiKeyResolver threw for ${provider}:${model}`,
        cause,
      );
    }
    if (typeof apiKey !== "string" || !apiKey) {
      throw new DecisionProviderError(
        "fatal_unsupported",
        `apiKeyResolver returned empty key for ${provider}:${model}`,
      );
    }

    let client: DirectModelClient;
    try {
      if (provider === "anthropic") {
        const create = opts.clientFactory?.anthropic ?? createAnthropicClient;
        client = create({ apiKey, model, fetchImpl: opts.fetchImpl });
      } else {
        const create = opts.clientFactory?.openai ?? createOpenAIClient;
        client = create({ apiKey, model, fetchImpl: opts.fetchImpl });
      }
    } catch (cause) {
      if (cause instanceof DirectModelUnsupportedError) {
        throw new DecisionProviderError(
          "fatal_unsupported",
          cause.message,
          cause,
        );
      }
      // Step 2b: any other throw out of clientFactory (caller-injected
      // mock that misbehaves, future M1-11 contract drift, etc.) gets
      // wrapped as fatal_caller_bug rather than leaked raw. The raw
      // throw stays accessible via `cause` for debugging.
      throw new DecisionProviderError(
        "fatal_caller_bug",
        `clientFactory.${provider} threw unexpected error`,
        cause,
      );
    }

    clients.set(key, client);
    return client;
  }

  async function decide(req: DecisionRequest): Promise<DecisionResponse> {
    if (
      typeof req.decisionBudgetMs !== "number" ||
      !Number.isFinite(req.decisionBudgetMs) ||
      req.decisionBudgetMs <= 0
    ) {
      throw new DecisionProviderError(
        "fatal_caller_bug",
        "decisionBudgetMs must be a positive finite number",
      );
    }
    if (!isSupportedGame(req.game)) {
      throw new DecisionProviderError(
        "fatal_caller_bug",
        `unsupported game: ${String(req.game)}`,
      );
    }

    const ac = new AbortController();
    const timer = setTimeout(() => {
      ac.abort();
    }, req.decisionBudgetMs);
    try {
      return await runDecideLoop(req, ac.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  async function runDecideLoop(
    req: DecisionRequest,
    signal: AbortSignal,
  ): Promise<DecisionResponse> {
    if (signal.aborted) {
      throw new DecisionProviderError(
        "fatal_aborted",
        "decisionBudgetMs already elapsed before decide started",
      );
    }

    const client = resolveClient(
      req.strategyProfile.provider,
      req.strategyProfile.model,
    );
    const built = buildPrompt(req);

    let lastReason: string | undefined;
    let lastRawSnippet: string | undefined;
    let cumulativeLatencyMs = 0;
    let lastResponse: DirectModelGenerateResponse | undefined;

    for (let attempt = 0; attempt <= retryBudget; attempt++) {
      if (signal.aborted) {
        throw new DecisionProviderError(
          "fatal_aborted",
          "decisionBudgetMs elapsed mid-attempt",
        );
      }

      const finalUserPrompt =
        attempt === 0
          ? built.userPrompt
          : built.userPrompt +
            "\n\n" +
            formatRetryHint(
              attempt,
              lastReason,
              lastRawSnippet,
              retryHintCharCap,
            );

      let response: DirectModelGenerateResponse;
      try {
        response = await client.generate({
          systemPrompt: built.systemPrompt,
          userPrompt: finalUserPrompt,
          temperature: req.strategyProfile.temperature,
          maxTokens: req.strategyProfile.maxTokens,
          signal,
        });
      } catch (cause) {
        if (isFatalDirectModelError(cause)) {
          throw wrapFatalDirectModelError(cause);
        }
        if (isRetriableDirectModelError(cause)) {
          lastReason = `direct_model_${cause.kind}`;
          lastRawSnippet = extractSnippetFromError(cause);
          continue;
        }
        // Unknown throwable that isn't a DirectModelError. Treat as
        // caller bug — wrapping prevents leaking arbitrary objects to
        // upstream catchers.
        throw new DecisionProviderError(
          "fatal_caller_bug",
          "client.generate threw unexpected error",
          cause,
        );
      }

      cumulativeLatencyMs += response.latencyMs;
      lastResponse = response;

      const parsed = parseAction(
        req.game,
        response.text,
        req.legalActions,
        retryHintCharCap,
      );
      if (parsed.kind === "ok") {
        return buildOkResponse(req, parsed, response, cumulativeLatencyMs, attempt);
      }
      lastReason = `parse_${parsed.reason}`;
      lastRawSnippet = parsed.rawSnippet;
    }

    // retry budget exhausted — dispatch M1-13 fallback.
    let fallbackAction: LegalAction;
    try {
      fallbackAction = chooseFallback(req);
    } catch (cause) {
      throw new DecisionProviderError(
        "fatal_caller_bug",
        cause instanceof Error
          ? `fallback dispatch failed: ${cause.message}`
          : "fallback dispatch failed",
        cause,
      );
    }

    return {
      action: fallbackAction.type,
      params: toDecisionParams(fallbackAction.data),
      summary: `(fallback: ${lastReason ?? "unknown"})`,
      providerMetadata: {
        provider: req.strategyProfile.provider,
        model: req.strategyProfile.model,
        inputTokens: lastResponse?.inputTokens,
        outputTokens: lastResponse?.outputTokens,
        latencyMs: cumulativeLatencyMs,
        retries: retryBudget,
        fallback: true,
      },
    };
  }

  async function healthCheck(): Promise<boolean> {
    if (!opts.healthCheckProfile) return false;
    try {
      const client = resolveClient(
        opts.healthCheckProfile.provider,
        opts.healthCheckProfile.model,
      );
      await client.generate({
        systemPrompt: "ping",
        userPrompt: "respond with the word OK",
        maxTokens: 10,
      });
      return true;
    } catch {
      return false;
    }
  }

  return { name: opts.name, decide, healthCheck };
}

// ─── internal helpers ───────────────────────────────────────────────

function buildOkResponse(
  req: DecisionRequest,
  parsed: Extract<ParseResult, { kind: "ok" }>,
  response: DirectModelGenerateResponse,
  cumulativeLatencyMs: number,
  attempt: number,
): DecisionResponse {
  const params = toDecisionParams(parsed.action.data);
  const base = {
    action: parsed.action.type,
    providerMetadata: {
      provider: req.strategyProfile.provider,
      model: req.strategyProfile.model,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      latencyMs: cumulativeLatencyMs,
      retries: attempt,
      fallback: false,
    },
  };

  if (params !== undefined && parsed.summary !== undefined) {
    return { ...base, params, summary: parsed.summary };
  }
  if (params !== undefined) {
    return { ...base, params };
  }
  if (parsed.summary !== undefined) {
    return { ...base, summary: parsed.summary };
  }
  return base;
}

function isSupportedGame(game: GameType): boolean {
  return game === "texas_holdem" || game === "liars_dice" || game === "coup";
}

function parseAction(
  game: GameType,
  rawText: string,
  legalActions: readonly LegalAction[],
  rawSnippetCap: number,
): ParseResult {
  // Step 2b: thread the caller-configured rawSnippet cap into the
  // per-game parser. Without this, parsers default to 500 chars and
  // a configured cap > 500 would silently downgrade — `formatRetryHint`
  // does not lengthen what the parser already cropped.
  switch (game) {
    case "texas_holdem":
      return parseTexasHoldemAction(rawText, legalActions, rawSnippetCap);
    case "liars_dice":
      return parseLiarsDiceAction(rawText, legalActions, rawSnippetCap);
    case "coup":
      return parseCoupAction(rawText, legalActions, rawSnippetCap);
  }
}

function chooseFallback(req: DecisionRequest): LegalAction {
  switch (req.game) {
    case "texas_holdem":
      return fallbackTexasHoldem({
        publicState: req.publicState as TexasHoldemState,
        legalActions: req.legalActions,
        yourPlayerId: req.playerId,
      });
    case "liars_dice":
      return fallbackLiarsDice({
        publicState: req.publicState as LiarsDiceState,
        legalActions: req.legalActions,
        yourPlayerId: req.playerId,
      });
    case "coup":
      return fallbackCoup({
        publicState: req.publicState as CoupState,
        legalActions: req.legalActions,
        yourPlayerId: req.playerId,
      });
  }
}

/**
 * Convert a `LegalAction.data` (protocol opaque `{}`) into the
 * `DecisionResponse.params` shape (`Record<string, unknown> | undefined`).
 *
 * Reference equality holds for plain non-array objects — server-provided
 * `LegalAction.data` flows through unchanged so callers can compare with
 * `===`. Null / undefined / arrays / primitives map to undefined.
 */
function toDecisionParams(
  data: unknown,
): Record<string, unknown> | undefined {
  if (data === null || data === undefined) return undefined;
  if (typeof data !== "object") return undefined;
  if (Array.isArray(data)) return undefined;
  return data as Record<string, unknown>;
}

type RetriableDirectModelError =
  | DirectModelInvalidResponseError
  | DirectModelNetworkError
  | DirectModelHttpError;

function isRetriableDirectModelError(
  cause: unknown,
): cause is RetriableDirectModelError {
  if (cause instanceof DirectModelInvalidResponseError) return true;
  if (cause instanceof DirectModelNetworkError) return true;
  if (cause instanceof DirectModelHttpError) {
    return cause.status === 429 || cause.status >= 500;
  }
  return false;
}

function isFatalDirectModelError(
  cause: unknown,
): cause is
  | DirectModelAbortedError
  | DirectModelUnsupportedError
  | DirectModelHttpError {
  if (cause instanceof DirectModelAbortedError) return true;
  if (cause instanceof DirectModelUnsupportedError) return true;
  if (cause instanceof DirectModelHttpError) {
    return !(cause.status === 429 || cause.status >= 500);
  }
  return false;
}

function wrapFatalDirectModelError(
  cause:
    | DirectModelAbortedError
    | DirectModelUnsupportedError
    | DirectModelHttpError,
): DecisionProviderError {
  if (cause instanceof DirectModelAbortedError) {
    return new DecisionProviderError("fatal_aborted", cause.message, cause);
  }
  if (cause instanceof DirectModelUnsupportedError) {
    return new DecisionProviderError("fatal_unsupported", cause.message, cause);
  }
  return new DecisionProviderError("fatal_http", cause.message, cause);
}

function extractSnippetFromError(cause: unknown): string | undefined {
  if (cause instanceof DirectModelHttpError) return cause.bodySnippet;
  if (cause instanceof DirectModelInvalidResponseError) {
    return cause.responseSnippet;
  }
  return undefined;
}

function formatRetryHint(
  attempt: number,
  reason: string | undefined,
  rawSnippet: string | undefined,
  charCap: number,
): string {
  const lines: string[] = [];
  lines.push(`Retry attempt ${attempt}: previous output failed validation.`);
  if (reason) lines.push(`Reason: ${reason}.`);
  if (rawSnippet !== undefined && rawSnippet !== "") {
    const truncated =
      rawSnippet.length > charCap ? rawSnippet.slice(0, charCap) : rawSnippet;
    lines.push(
      `Previous output (truncated to ${charCap} chars): ${truncated}`,
    );
  }
  lines.push(
    "Please retry. Respond with a single JSON object exactly matching the schema in the system prompt.",
  );
  return lines.join("\n");
}
