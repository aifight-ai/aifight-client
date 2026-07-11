// Guarded outbound fetch for credential-bearing requests.
//
// Every adapter/bridge call that attaches a provider API key (or the platform
// API key) sends it in a request header. Node's default `redirect: "follow"`
// would transparently re-send those headers to whatever host a 3xx Location
// points at — so a compromised or misconfigured endpoint could exfiltrate the
// key by answering with a redirect to an attacker origin.
//
// fetchNoFollow drives redirect handling itself (redirect: "manual"):
//   - Cross-origin redirects are ALWAYS refused (throw) — the key must never
//     leave the configured endpoint's origin.
//   - Same-origin redirects are refused by default (POST decision/generation
//     calls never legitimately redirect). Callers that genuinely need to follow
//     a same-origin redirect (e.g. a GET model-discovery probe) can opt in with
//     { allowSameOriginRedirects: true }, bounded by maxRedirects.
//
// The original `init` (headers, body, signal, method) is preserved verbatim on
// every hop; only `redirect` is overridden.

export interface GuardedFetchOptions {
  /**
   * Allow following a bounded number of SAME-ORIGIN redirects. Default false
   * (refuse every redirect). Cross-origin redirects are refused regardless.
   */
  readonly allowSameOriginRedirects?: boolean;
  /** Max same-origin redirects to follow when allowed (default 3). */
  readonly maxRedirects?: number;
  /**
   * Fetch implementation to use. Defaults to globalThis.fetch. Callers that
   * already thread an injectable fetch (e.g. onboarding's env.fetchImpl) pass
   * it here so the guard wraps the SAME impl instead of bypassing it.
   */
  readonly fetchImpl?: typeof fetch;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * fetch that never follows a cross-origin redirect while carrying credentials.
 * See the module header for the threat model. Throws on any refused redirect;
 * returns the first non-redirect Response otherwise.
 */
export async function fetchNoFollow(
  url: string | URL,
  init: RequestInit = {},
  options: GuardedFetchOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is unavailable in this runtime");
  }

  const allowSameOrigin = options.allowSameOriginRedirects === true;
  const maxRedirects = options.maxRedirects ?? 3;

  // Override only the redirect mode; keep the caller's headers/body/signal.
  const guardedInit: RequestInit = { ...init, redirect: "manual" };

  let currentUrl = new URL(String(url));
  let followed = 0;

  for (;;) {
    const response = await fetchImpl(currentUrl, guardedInit);

    const isRedirect =
      REDIRECT_STATUSES.has(response.status) || response.type === "opaqueredirect";
    if (!isRedirect) return response;

    // An opaque-redirect (browser-style manual mode) hides the Location, so we
    // cannot verify the target — refuse rather than trust it.
    const location = response.type === "opaqueredirect" ? null : response.headers.get("location");
    if (!location) {
      throw new Error(
        `refusing redirect (HTTP ${response.status || "opaque"}) from ${currentUrl.origin} ` +
          `with no readable Location; provider credentials must not follow an unverifiable redirect`,
      );
    }

    let target: URL;
    try {
      target = new URL(location, currentUrl);
    } catch {
      throw new Error(
        `refusing redirect to malformed Location "${location}" from ${currentUrl.origin}`,
      );
    }

    if (target.origin !== currentUrl.origin) {
      throw new Error(
        `refusing cross-origin redirect from ${currentUrl.origin} to ${target.origin}; ` +
          `provider credentials must not leave the configured endpoint`,
      );
    }

    // Same-origin redirect from here on.
    if (!allowSameOrigin) {
      throw new Error(
        `refusing to follow redirect from ${currentUrl.origin} (HTTP ${response.status}); ` +
          `this request does not follow redirects`,
      );
    }
    if (followed >= maxRedirects) {
      throw new Error(
        `too many same-origin redirects (> ${maxRedirects}) starting from ${currentUrl.origin}`,
      );
    }
    followed += 1;
    currentUrl = target;
    // Loop and re-issue with the same guardedInit (headers/body/signal intact).
  }
}
