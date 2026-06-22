// M1-11 direct-model: shared types for direct LLM HTTP clients.
//
// Provider-specific factories (anthropic.ts in Step 2, openai.ts in
// Step 3) implement DirectModelClient with a uniform shape so M1-14
// decision/provider.ts can dispatch by strategyProfile.provider
// without runtime branching on instance type.
//
// This module is types-only: no runtime symbols, no fetch, no IO.
// Importers should use `import type { ... } from "./types"`.

export type DirectModelProviderName = "anthropic" | "openai";

export interface DirectModelGenerateRequest {
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly temperature?: number;
  readonly maxTokens: number;
  readonly signal?: AbortSignal;
}

export interface DirectModelGenerateResponse {
  readonly text: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly latencyMs: number;
  readonly raw: unknown;
}

export interface DirectModelClient {
  readonly provider: DirectModelProviderName;
  readonly model: string;
  generate(req: DirectModelGenerateRequest): Promise<DirectModelGenerateResponse>;
}
