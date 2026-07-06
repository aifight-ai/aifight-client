// runtime/src/llm/capabilities/validate-capabilities.ts
//
// Loads model-capabilities.json and provides validation helpers used at
// config-parse time to catch unsupported effort levels, missing base URLs,
// and protocol/model mismatches before any LLM call is issued.

import capabilitiesJson from "./model-capabilities.json";

// ─── Registry schema types ────────────────────────────────────────────────────

export interface ModelCapability {
  /** Regex pattern matched against the model string (e.g. "^claude-opus-4-7"). */
  pattern: string;
  /** Thinking modes the model accepts, e.g. ["adaptive"]. */
  thinkingModes?: string[];
  /** Effort levels accepted by this specific model (subset of protocol effortValues). */
  efforts?: string[];
  /** Per-model default effort override (falls back to protocol defaultEffort). */
  defaultEffort?: string;
  /** True if the model accepts a manual budget_tokens parameter. */
  supportsManualBudget?: boolean;
  /** False if the model ignores temperature even when the protocol supports it. */
  supportsTemperature?: boolean;
  /** True if temperature/top_p are silently ignored in thinking mode. */
  samplingIgnoredWhenThinking?: boolean;
  /** Maximum output tokens the model can produce. */
  maxOutputTokens: number;
  /** Protocol-specific thinking API parameter name, e.g. "thinkingLevel" | "thinkingBudget". */
  thinkingParam?: string;
  /**
   * True for reasoning-only models that have NO non-thinking mode (you cannot
   * turn thinking off). Default/omitted = thinking is optional — every current
   * model can disable it (Claude by omission, DeepSeek via thinking:disabled,
   * OpenAI via effort "none"). Set this only for a model that always reasons.
   */
  thinkingRequired?: boolean;
  /** Free-text notes for operators. Not used in validation logic. */
  notes?: string;
}

export interface ProtocolCapability {
  displayName: string;
  defaultBaseURL: string;
  supportsBaseURL: boolean;
  /** true | false | "ignored_when_thinking" */
  supportsTemperature: boolean | string;
  supportsJSONMode: boolean;
  supportsThinking: boolean;
  supportsReasoningSummary: boolean;
  /** Request parameter name for the token limit, e.g. "max_tokens". */
  maxTokensParam: string;
  /** All effort levels the protocol understands. */
  effortValues: string[];
  defaultEffort?: string;
  /** Optional effort remapping for protocols with a restricted effort vocabulary. */
  compatEffortMap?: Record<string, string>;
  models: ModelCapability[];
  notes?: string;
}

export interface CapabilityRegistry {
  schemaVersion: number;
  protocols: Record<string, ProtocolCapability>;
}

// ─── ThinkingConfig (caller-supplied) ────────────────────────────────────────

export interface ThinkingConfig {
  /** "adaptive" | "enabled" | "disabled" or protocol-specific value */
  mode?: string;
  /** Explicit budget_tokens (only for protocols/models that support manual budget). */
  budgetTokens?: number;
  /** "low" | "medium" | "high" | "xhigh" | "max" | "none" | "minimal" */
  effort?: string;
}

// ─── Load registry ────────────────────────────────────────────────────────────
//
// The registry is imported (and bundled inline by esbuild / vite) rather than
// read from disk at runtime, so it resolves correctly from the single-file
// `dist/bin.mjs` bundle — no sibling-asset copy needed, no __dirname games.

let _cached: CapabilityRegistry | undefined;

export function loadCapabilityRegistry(): CapabilityRegistry {
  if (_cached) return _cached;

  const parsed = capabilitiesJson as unknown as CapabilityRegistry;
  if (typeof parsed.schemaVersion !== "number" || !parsed.protocols) {
    throw new Error(
      `model-capabilities.json is malformed: missing schemaVersion or protocols`,
    );
  }

  _cached = parsed;
  return _cached;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function findModelEntry(
  modelId: string,
  protocol: ProtocolCapability
): ModelCapability | undefined {
  for (const entry of protocol.models) {
    if (new RegExp(entry.pattern).test(modelId)) return entry;
  }
  return undefined;
}

// ─── validateProfileAgainstCapabilities ──────────────────────────────────────

export function validateProfileAgainstCapabilities(
  protocol: string,
  model: string,
  thinking: ThinkingConfig | undefined,
  registry: CapabilityRegistry
): { ok: true } | { ok: false; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const proto = registry.protocols[protocol];
  if (!proto) {
    return {
      ok: false,
      errors: [
        `Unknown protocol "${protocol}". Known: ${Object.keys(registry.protocols).join(", ")}`,
      ],
      warnings: [],
    };
  }

  // Model match check (only warn when the protocol has model entries defined)
  let modelEntry: ModelCapability | undefined;
  if (proto.models.length > 0) {
    modelEntry = findModelEntry(model, proto);
    if (!modelEntry) {
      warnings.push(
        `Model "${model}" did not match any known pattern for protocol "${protocol}". ` +
          `Proceeding, but capabilities cannot be verified.`
      );
    }
  }

  // Thinking checks
  if (thinking !== undefined) {
    if (!proto.supportsThinking) {
      errors.push(
        `Protocol "${protocol}" does not support thinking, but a ThinkingConfig was provided.`
      );
    } else {
      // Effort validation
      if (thinking.effort !== undefined) {
        const resolvedEfforts =
          modelEntry?.efforts ?? proto.effortValues;
        if (
          resolvedEfforts.length > 0 &&
          !resolvedEfforts.includes(thinking.effort)
        ) {
          const mapped = proto.compatEffortMap?.[thinking.effort];
          if (mapped) {
            warnings.push(
              `Effort "${thinking.effort}" is not natively supported by "${protocol}" / "${model}". ` +
                `It will be remapped to "${mapped}" via compatEffortMap.`
            );
          } else {
            errors.push(
              `Effort "${thinking.effort}" is not valid for protocol "${protocol}" / model "${model}". ` +
                `Supported: ${resolvedEfforts.join(", ")}.`
            );
          }
        }
      }

      // Manual budget checks
      if (thinking.budgetTokens !== undefined) {
        if (modelEntry && modelEntry.supportsManualBudget === false) {
          errors.push(
            `Model "${model}" does not support manual budgetTokens. ` +
              `Use the effort field instead.`
          );
        } else if (!modelEntry) {
          warnings.push(
            `budgetTokens supplied but model "${model}" is unknown; ` +
              `manual budget support cannot be confirmed.`
          );
        }
      }

      // Temperature warning when ignored in thinking mode
      if (modelEntry?.samplingIgnoredWhenThinking) {
        warnings.push(
          `Protocol "${protocol}" / model "${model}": temperature and top_p are ` +
            `ignored when thinking mode is active.`
        );
      }

      // Model-level supportsTemperature=false
      if (modelEntry && modelEntry.supportsTemperature === false) {
        warnings.push(
          `Model "${model}" does not support temperature. Any temperature value will be dropped.`
        );
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }
  return { ok: true };
}

// ─── getDefaultBaseURL ────────────────────────────────────────────────────────

export function getDefaultBaseURL(
  protocol: string,
  registry: CapabilityRegistry
): string | undefined {
  const proto = registry.protocols[protocol];
  if (!proto) return undefined;
  return proto.defaultBaseURL || undefined;
}

// ─── mapEffortForProtocol ─────────────────────────────────────────────────────

export function mapEffortForProtocol(
  effort: string,
  protocol: string,
  registry: CapabilityRegistry
):
  | { mapped: string; warning?: string }
  | { error: string } {
  const proto = registry.protocols[protocol];
  if (!proto) {
    return { error: `Unknown protocol "${protocol}"` };
  }

  // Protocol has no effort concept
  if (proto.effortValues.length === 0) {
    return {
      error: `Protocol "${protocol}" does not use effort values.`,
    };
  }

  // Direct match
  if (proto.effortValues.includes(effort)) {
    return { mapped: effort };
  }

  // Compat remap
  const remapped = proto.compatEffortMap?.[effort];
  if (remapped) {
    return {
      mapped: remapped,
      warning:
        `Effort "${effort}" remapped to "${remapped}" for protocol "${protocol}" via compatEffortMap.`,
    };
  }

  return {
    error:
      `Effort "${effort}" is not valid for protocol "${protocol}". ` +
      `Supported: ${proto.effortValues.join(", ")}.`,
  };
}

// ─── resolveModelCapabilities ─────────────────────────────────────────────────
//
// A normalized, capability-aware view of one (protocol, model) pair. The
// interactive `aifight config` wizard and the probe use it so they only surface
// the knobs a given model actually has, and derive reasoning-friendly defaults
// from the registry instead of hardcoding them. Unknown protocols/models
// degrade gracefully to a conservative "plain chat model" view.

export interface ResolvedModelCapabilities {
  protocol: string;
  model: string;
  isKnownProtocol: boolean;
  isKnownModel: boolean;
  /** The protocol/model can reason at all. */
  supportsThinking: boolean;
  /** Thinking can be turned off (vs. a reasoning-only model that always thinks). */
  canDisableThinking: boolean;
  /** The model always reasons and offers no non-thinking mode. */
  thinkingAlwaysOn: boolean;
  /** Effort levels valid for this model (model.efforts ?? protocol.effortValues). */
  efforts: string[];
  /** Suggested default effort (model.defaultEffort ?? protocol.defaultEffort). */
  defaultEffort?: string;
  /** A temperature value is meaningful only when thinking is OFF and the model accepts it. */
  temperatureUsableWhenThinkingOff: boolean;
  /** temperature/top_p are silently ignored while thinking is active. */
  samplingIgnoredWhenThinking: boolean;
  /** Model output-token ceiling, if the registry knows it. */
  maxOutputTokens?: number;
  /** Canonical default base URL for the protocol (empty for compat protocols). */
  defaultBaseURL?: string;
}

/**
 * The maxTokens a high-reasoning effort needs so the model isn't truncated
 * mid-thought (docs/agent-bridge/TOKEN_BUDGET_SAFETY_SPEC.md D3). Only high /
 * xhigh / max efforts get a recommendation (that's where the "budget can be up
 * to the model ceiling" problem bites — e.g. Opus max needs 128000). The
 * recommended value is the model's output ceiling when known, else a generous
 * fallback for a model the registry doesn't list yet.
 *
 * Returns undefined when no recommendation applies (thinking off, or a
 * low/medium/default effort). Since output tokens are billed on use, not on the
 * cap, recommending the ceiling is free insurance against truncation.
 *
 * Shared by `config add/update` (headless), the interactive wizard, and the
 * desktop app, so all three agree on the number.
 */
export function recommendMaxTokens(input: {
  protocol: string;
  model: string;
  effort?: string;
  thinkingEnabled: boolean;
}): { recommended: number; ceilingKnown: boolean } | undefined {
  if (!input.thinkingEnabled) return undefined;
  const e = (input.effort ?? "").toLowerCase();
  if (e !== "high" && e !== "xhigh" && e !== "max") return undefined;
  const ceiling = resolveModelCapabilities(input.protocol, input.model).maxOutputTokens;
  return { recommended: ceiling ?? 65536, ceilingKnown: ceiling !== undefined };
}

export function resolveModelCapabilities(
  protocol: string,
  model: string,
  registry: CapabilityRegistry = loadCapabilityRegistry(),
): ResolvedModelCapabilities {
  const proto = registry.protocols[protocol];
  if (!proto) {
    // Unknown protocol → conservative generic view: a plain chat model with no
    // thinking and a usable temperature (the safe "some OpenAI-compatible
    // endpoint" assumption).
    return {
      protocol,
      model,
      isKnownProtocol: false,
      isKnownModel: false,
      supportsThinking: false,
      canDisableThinking: false,
      thinkingAlwaysOn: false,
      efforts: [],
      temperatureUsableWhenThinkingOff: true,
      samplingIgnoredWhenThinking: false,
    };
  }

  const entry = findModelEntry(model, proto);
  const supportsThinking = proto.supportsThinking === true;

  // Thinking is optional unless the registry explicitly marks the model
  // reasoning-only (thinkingRequired). Inferring from thinkingModes would be
  // wrong — Claude lists only ["adaptive"] yet can be disabled by omission.
  const thinkingRequired = entry?.thinkingRequired === true;
  const canDisableThinking = supportsThinking && !thinkingRequired;
  const thinkingAlwaysOn = supportsThinking && thinkingRequired;

  const efforts = (entry?.efforts ?? proto.effortValues ?? []).slice();
  const defaultEffort = entry?.defaultEffort ?? proto.defaultEffort;

  const protoTemp = proto.supportsTemperature; // true | false | "ignored_when_thinking"
  const samplingIgnoredWhenThinking =
    entry?.samplingIgnoredWhenThinking === true || protoTemp === "ignored_when_thinking";
  const modelTempOk = entry?.supportsTemperature !== false;
  const temperatureUsableWhenThinkingOff = protoTemp !== false && modelTempOk;

  return {
    protocol,
    model,
    isKnownProtocol: true,
    isKnownModel: entry !== undefined,
    supportsThinking,
    canDisableThinking,
    thinkingAlwaysOn,
    efforts,
    ...(defaultEffort !== undefined ? { defaultEffort } : {}),
    temperatureUsableWhenThinkingOff,
    samplingIgnoredWhenThinking,
    ...(entry?.maxOutputTokens !== undefined ? { maxOutputTokens: entry.maxOutputTokens } : {}),
    ...(proto.defaultBaseURL ? { defaultBaseURL: proto.defaultBaseURL } : {}),
  };
}
