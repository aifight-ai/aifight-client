// Live model discovery: ask the PROVIDER which models exist, instead of shipping
// a hardcoded suggestion list that is stale the week after it is written (the
// desktop's datalist still suggested a model family two releases old when
// gpt-5.6-sol was already GA — see REASONING_CONFIG_UX_REDESIGN §3.5).
//
// Best-effort by design: every failure path returns null and the caller falls
// back to manual entry / static seeds. Never throws, never blocks a flow.
//
// Shared by CLI onboarding (`aifight setup`), `aifight config models`, and the
// desktop Models editor (over IPC from the Electron main process).

import type { Protocol } from "../profile/config-schema.js";
import { fetchNoFollow } from "../net/guarded-fetch.js";

export interface DiscoverEnv {
  /** Injectable fetch for tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export async function discoverModelsForProtocol(
  env: DiscoverEnv,
  input: { protocol: Protocol; baseURL: string; apiKey: string },
): Promise<string[] | null> {
  const fetchImpl = env.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return null;

  // OpenAI-style: { data: [{ id: "gpt-..." }, ...] }
  const parseIds = (json: unknown): string[] => {
    const out: string[] = [];
    const data = (json as { data?: unknown })?.data;
    if (Array.isArray(data)) {
      for (const m of data) {
        const id = (m as { id?: unknown })?.id;
        if (typeof id === "string") out.push(id);
      }
    }
    return out;
  };

  // Gemini: { models: [{ name: "models/gemini-..." }, ...] } — a DIFFERENT shape,
  // which is why this protocol used to be skipped entirely.
  const parseGemini = (json: unknown): string[] => {
    const out: string[] = [];
    const models = (json as { models?: unknown })?.models;
    if (Array.isArray(models)) {
      for (const m of models) {
        const name = (m as { name?: unknown })?.name;
        if (typeof name === "string") out.push(name.replace(/^models\//, ""));
      }
    }
    return out;
  };

  const attempt = async (
    url: string,
    headers: Record<string, string>,
    parse: (json: unknown) => string[],
  ): Promise<string[] | null> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      // Guard the credential-bearing discovery GET against redirect-based key
      // exfiltration. Model-discovery legitimately follows same-origin redirects
      // (e.g. /models → /v1/models), so allow a bounded few; cross-origin is
      // always refused. The injected fetchImpl is threaded through unchanged.
      const res = await fetchNoFollow(
        url,
        { method: "GET", headers, signal: ctrl.signal },
        { allowSameOriginRedirects: true, fetchImpl },
      );
      if (!res.ok) return null;
      const ids = parse(await res.json());
      return ids.length > 0 ? ids : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const base = input.baseURL.replace(/\/+$/, "");
  try {
    if (input.protocol === "anthropic_messages") {
      return await attempt(
        `${base}/v1/models`,
        { "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" },
        parseIds,
      );
    }
    if (
      input.protocol === "openai_responses" ||
      input.protocol === "openai_chat_completions" ||
      input.protocol === "openai_chat_compat" ||
      input.protocol === "deepseek_chat_completions"
    ) {
      const bearer = { Authorization: `Bearer ${input.apiKey}` };
      return (
        (await attempt(`${base}/models`, bearer, parseIds)) ??
        (await attempt(`${base}/v1/models`, bearer, parseIds))
      );
    }
    if (input.protocol === "gemini_generate_content") {
      // The canonical baseURL already ends in /v1beta; a bare host works too.
      const url = /\/v1beta$/.test(base) ? `${base}/models` : `${base}/v1beta/models`;
      return await attempt(url, { "x-goog-api-key": input.apiKey }, parseGemini);
    }
    return null;
  } catch {
    return null;
  }
}
